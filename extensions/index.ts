/**
 * anti-doom-loop — pi extension that detects and breaks agent doom loops.
 *
 * Cheap models sometimes repeat the same cheap tool call (grep, read, ls)
 * without progress, silently burning tokens. This extension watches every
 * tool call and blocks loops before they cost anything:
 *
 *  - identical (tool, args) repeated `PI_ANTI_LOOP_REPEATS` times (default 3)
 *    in the last `PI_ANTI_LOOP_WINDOW` calls → block with an instructive reason
 *  - near-identical same-tool args (≥ 55% shared whitespace tokens, union ≥ 5)
 *    count toward the same threshold — sleep-wrapped polls, flag/pattern/tail
 *    drift that exact identity misses by construction
 *  - the same tool failing `PI_ANTI_LOOP_FAILS` consecutive times (default 3)
 *    → block with a "stop retrying, fix the root cause" reason
 *  - the model repeating text: verbatim, near-identical (token similarity),
 *    or a sentence repeated inside ONE message → steer first, abort as
 *    escalation, then a bounded auto-resume so work continues
 *
 * Per-block escape hatch: the agent calls `loop_ack` to clear the repeat it was
 * just blocked on, when the reason lives in its head rather than the arguments.
 *
 * Off switches, most to least specific:
 *  - `{ "antiDoomLoop": { "enabled": false } }` in `~/.pi/agent/settings.json`
 *    (global) or `<cwd>/.pi/settings.json` (project; project wins, and pi only
 *    honors it for a trusted project). Read live on every prompt.
 *  - `PI_ANTI_LOOP_DISABLE=1` (environment, for CI and automation).
 *  - `/loopcheck suspend` / `/loopcheck resume` for the current session.
 *
 * Escalation (message loops): detection #1 steers the agent mid-run; #2
 * aborts the turn and queues one fresh-resume directive; #3+ aborts for real
 * and hands control back to the user. Tool-call blocks hand the model an
 * instructive reason (that is the steer); re-issuing the exact same blocked
 * call aborts the turn.
 *
 * Counters reset on every user prompt (`message_end` with `role:"user"`), so
 * a task legitimately repeated later in the session is never a false positive.
 * Run restarts (auto-continue, steers/resumes, async-result drains) do NOT
 * reset — hosts emit `before_agent_start` on every run start, and resetting
 * there wiped counters between the iterations of cross-run loops.
 *
 * All logic lives in `controller.ts` (pure, pi-free, unit-tested); this file
 * is a thin adapter wiring it to pi's event loop. The pi API is consumed
 * structurally so the wiring stays testable and import-light.
 */
import {
  createController,
  type AntiLoopController,
  type CommandCtxLite,
  type CtxLite,
  type MessageContent,
  type MessageEndEventLite,
  type ToolCallEventLite,
  type ToolResultEventLite,
} from "./controller.ts";
import { readOptions, settingsEnabled, type AntiDoomSettings, type ToolInput } from "./detector.ts";
import { Type, type Static, type TSchema } from "typebox";

/** What an event handler hands back to pi: a tool-call block decision, or nothing.
 * Mirrors pi's own `ExtensionHandler<E, R>` contract (`Promise<R | void> | R | void`)
 * narrowed to this extension's result; handlers stay synchronous here.
 */
export type PiHandlerResult = { block: true; reason: string } | undefined;

/** The subset of pi's ExtensionAPI this extension uses (structural). */
export interface PiLike {
  on<E = unknown, C = unknown>(
    event: string,
    handler: (event: E, ctx: C) => PiHandlerResult | void,
  ): void;
  registerCommand(
    name: string,
    opts: {
      description?: string;
      handler: (args: string, ctx: CommandCtxLite) => Promise<void> | void;
    },
  ): void;
  sendMessage?(
    content: { customType?: string; content?: string; display?: boolean },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): void;
  /** Effective settings, global deep-merged with project (project wins). */
  getSettings?(): AntiDoomSettings;
  /**
   * Register a tool the model can call. Structural on purpose: pi validates
   * arguments against `parameters` before `execute`, so this declares only the
   * members this extension reads.
   */
  registerTool?(definition: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: TSchema;
    execute(toolCallId: string, params: AckParams): ToolResult;
  }): void;
}

/** `loop_ack` parameters: just the reason. The detector already knows the call. */
const ACK_PARAMS = Type.Object({
  why: Type.String({
    description:
      "Why repeating the blocked call is intentional, for example 'waiting for the deploy to finish before re-running the test'",
  }),
});

/** Arguments `loop_ack` receives after pi validates them against ACK_PARAMS. */
type AckParams = Static<typeof ACK_PARAMS>;

/** The shape every tool result has: text the model reads, plus details. */
interface ToolResult {
  content: { type: "text"; text: string }[];
  details: { acknowledged: boolean; toolName?: string };
}

/** Injected on the first loop detection — steer the agent back on track. */
const STEER_TEXT =
  "Anti-doom-loop steering: you are repeating the same action or text without making progress. " +
  "Stop. Re-read the actual error output, pick ONE different action, and execute it. " +
  "If you are stuck, ask the user instead of retrying.";

/** Steer delivered after a codemode script swallowed a nested block: the script
 * got the block reason as a tool error, but only its return reaches the model. */
const NESTED_STEER_TEXT =
  "Anti-doom-loop steering: a codemode script repeated identical tool calls inside itself. " +
  "Inside a script, call each tool once, store the result in a variable, and reuse it — " +
  "never poll or retry the same call in a loop. If the calls keep failing, stop and ask the user.";

/** Queued once after an abort so the work can continue with a fresh approach. */
const RESUME_TEXT =
  "Anti-doom-loop: the previous run was aborted because it looped. " +
  "Start over with a genuinely different approach: do not repeat the previous investigation steps. " +
  "Re-read the task, choose one new action, execute it, then report results.";

/** Uniform `loop_ack` result: the text the model reads, plus machine-readable details. */
function ackResult(acknowledged: boolean, text: string, toolName?: string): ToolResult {
  return { content: [{ type: "text", text }], details: { acknowledged, toolName } };
}

export default function (pi: PiLike): void {
  // Env switch is checked per prompt too, so a long session honors a restartless
  // change and CI can set it after load.
  const envDisabled = (): boolean => process.env.PI_ANTI_LOOP_DISABLE === "1";
  const settingsOff = (): boolean => {
    const settings = pi.getSettings?.();
    return settings !== undefined && !settingsEnabled(settings);
  };
  let controller: AntiLoopController = createController(readOptions());

  pi.on("session_start", () => {
    controller = createController(readOptions());
  });

  pi.on("tool_call", (event: ToolCallEventLite, ctx: CtxLite) => {
    if (envDisabled() || settingsOff()) return;
    // SAFETY: pi delivers JSON-safe tool arguments, which is exactly the ToolInput domain.
    // Decode them into the ToolInput domain type at this I/O boundary before the controller sees them.
    const outcome = controller.onToolCall(
      event.toolName,
      event.input as ToolInput,
      event.toolCallId,
      event.parentToolCallId,
    );
    if (outcome === null) return;
    if (outcome.escalate) {
      ctx.ui.notify("Anti-doom-loop: identical call blocked again — aborting turn", "error");
      ctx.abort();
    }
    return { block: true, reason: outcome.reason };
  });

  pi.on("tool_result", (event: ToolResultEventLite) => {
    // Skip while off: results of an off period must not seed a failure streak
    // that fires the moment detection comes back on.
    if (envDisabled() || settingsOff()) return;
    controller.onToolResult(
      event.toolName,
      event.toolCallId,
      event.isError === true,
      event.parentToolCallId,
    );
  });

  // Text-only doom loops (model re-emits/rephrases the same thing with no
  // tool calls) never reach tool_call. Steer first, abort as escalation,
  // then a bounded auto-resume so work continues.
  pi.on("message_end", (event: MessageEndEventLite, ctx: CtxLite) => {
    // Fresh counters per genuine user prompt: only the loop happening *right
    // now* counts (session-scoped steers/aborts/resume budget survive).
    // Deliberately NOT on `before_agent_start`: hosts emit that on every run
    // start — auto-continue turns, steers/resumes, advisor cards, and queued
    // async-result drains — which wiped counters between the iterations of
    // cross-run doom loops, so they never reached the repeat threshold.
    // `role:"user"` input messages are emitted with the run's input messages
    // (agent-core `emitInputMessages`) on omp and pi alike.
    if (event.message.role === "user") {
      reset();
      return;
    }
    if (envDisabled() || settingsOff()) return;
    // SAFETY: pi delivers message content as JSON-safe blocks matching MessageContent.
    // Decode the untyped message content into MessageContent at this boundary.
    const outcome = controller.onMessageEnd(
      event.message.role,
      event.message.content as MessageContent,
    );
    if (outcome === null) return;

    if (outcome.action === "steer") {
      const text = outcome.nested ? NESTED_STEER_TEXT : STEER_TEXT;
      ctx.ui.notify(`Anti-doom-loop: ${outcome.reason}`, "warning");
      pi.sendMessage?.(
        { customType: "anti-doom-loop", content: text, display: true },
        { deliverAs: "steer", triggerTurn: true },
      );
      return;
    }

    ctx.ui.notify(`Anti-doom-loop: ${outcome.reason}`, "error");
    ctx.abort();
    if (outcome.resume) {
      pi.sendMessage?.(
        { customType: "anti-doom-loop", content: RESUME_TEXT, display: true },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }
  });

  // The agent's own escape hatch. A blocked call names it, and a stated reason
  // the arguments cannot carry is the one thing only the agent knows.
  pi.registerTool?.({
    name: "loop_ack",
    label: "Acknowledge intentional repeat",
    description:
      "Allow the repeated tool call that anti-doom-loop just blocked, when the repeat is " +
      "intentional (polling a job, waiting on a deploy, re-running a flaky step). Say why, and " +
      "that call is cleared from the loop window so the retry is allowed. Only repeat blocks can " +
      "be acknowledged; a block for repeated failures cannot — fix the failure instead.",
    promptSnippet: "loop_ack — allow one loop-blocked repeat with a stated reason",
    promptGuidelines: [
      "When anti-doom-loop blocks a call and the repeat is intentional (waiting on an external change, polling a job), call loop_ack with the reason instead of re-arguing the call.",
      "Never call loop_ack to get past a block caused by repeated failures: fix the failure or ask the user.",
    ],
    parameters: ACK_PARAMS,
    execute(_toolCallId, params) {
      const outcome = controller.acknowledge();
      if (!outcome.acked) {
        return ackResult(false, `Not acknowledged: ${outcome.reason}`);
      }
      return ackResult(
        true,
        `Acknowledged (${params.why}). ${outcome.toolName} is cleared from the loop window — ` +
          `retry it now. Two acknowledgements per tool per prompt are allowed, a third is not.`,
        outcome.toolName,
      );
    },
  });

  pi.registerCommand("loopcheck", {
    description: "Anti-doom-loop status; `/loopcheck reset` clears counters",
    handler: async (args: string, ctx: CommandCtxLite) => {
      const arg = args.trim().toLowerCase();
      if (arg === "reset") {
        reset();
        ctx.ui.notify("Anti-doom-loop: counters reset", "info");
        return;
      }
      if (arg === "suspend") {
        controller.suspend();
        ctx.ui.notify("Anti-doom-loop: suspended until the next prompt", "info");
        return;
      }
      if (arg === "resume") {
        controller.resume();
        ctx.ui.notify("Anti-doom-loop: resumed", "info");
        return;
      }
      ctx.ui.notify(controller.status(), "info");
    },
  });

  function reset(): void {
    // Keep the controller: the auto-resume budget is session-scoped.
    controller.reset();
  }
}
