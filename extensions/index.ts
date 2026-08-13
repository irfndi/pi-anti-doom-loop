/**
 * anti-doom-loop — pi extension that detects and breaks agent doom loops.
 *
 * Cheap models sometimes repeat the same cheap tool call (grep, read, ls)
 * without progress, silently burning tokens. This extension watches every
 * tool call and blocks loops before they cost anything:
 *
 *  - identical (tool, args) repeated `PI_ANTI_LOOP_REPEATS` times (default 3)
 *    in the last `PI_ANTI_LOOP_WINDOW` calls → block with an instructive reason
 *  - the same tool failing `PI_ANTI_LOOP_FAILS` consecutive times (default 3)
 *    → block with a "stop retrying, fix the root cause" reason
 *  - the model repeating text: verbatim, near-identical (token similarity),
 *    or a sentence repeated inside ONE message → steer first, abort as
 *    escalation, then a bounded auto-resume so work continues
 *
 * Escalation (message loops): detection #1 steers the agent mid-run; #2
 * aborts the turn and queues one fresh-resume directive; #3+ aborts for real
 * and hands control back to the user. Tool-call blocks hand the model an
 * instructive reason (that is the steer); re-issuing the exact same blocked
 * call aborts the turn.
 *
 * Counters reset on every user prompt, so a task legitimately repeated later
 * in the session is never a false positive. Disable with PI_ANTI_LOOP_DISABLE=1.
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
import { readOptions, type ToolInput } from "./detector.ts";

/** The subset of pi's ExtensionAPI this extension uses (structural). */
export interface PiLike {
  on<E = unknown, C = unknown>(event: string, handler: (event: E, ctx: C) => unknown): void;
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
}

/** Injected on the first loop detection — steer the agent back on track. */
const STEER_TEXT =
  "Anti-doom-loop steering: you are repeating the same action or text without making progress. " +
  "Stop. Re-read the actual error output, pick ONE different action, and execute it. " +
  "If you are stuck, ask the user instead of retrying.";

/** Queued once after an abort so the work can continue with a fresh approach. */
const RESUME_TEXT =
  "Anti-doom-loop: the previous run was aborted because it looped. " +
  "Start over with a genuinely different approach: do not repeat the previous investigation steps. " +
  "Re-read the task, choose one new action, execute it, then report results.";

export default function (pi: PiLike): void {
  if (process.env.PI_ANTI_LOOP_DISABLE === "1") return;

  let controller: AntiLoopController = createController(readOptions());

  pi.on("session_start", () => reset());

  // Fresh counters per user prompt: only the loop happening *right now* counts.
  // Internal reset keeps session-scoped steers/aborts/resume budget.
  pi.on("before_agent_start", () => controller.reset());

  pi.on("tool_call", (event: ToolCallEventLite, ctx: CtxLite) => {
    // The pi event delivers untyped tool arguments; decode them into the
    // ToolInput domain type at this I/O boundary before the controller sees them.
    const outcome = controller.onToolCall(
      event.toolName,
      event.input as ToolInput,
      event.toolCallId,
    );
    if (outcome === null) return;
    if (outcome.escalate) {
      ctx.ui.notify("Anti-doom-loop: identical call blocked again — aborting turn", "error");
      ctx.abort();
    }
    return { block: true, reason: outcome.reason };
  });

  pi.on("tool_result", (event: ToolResultEventLite) => {
    controller.onToolResult(event.toolName, event.toolCallId, event.isError === true);
  });

  // Text-only doom loops (model re-emits/rephrases the same thing with no
  // tool calls) never reach tool_call. Steer first, abort as escalation,
  // then a bounded auto-resume so the work continues.
  pi.on("message_end", (event: MessageEndEventLite, ctx: CtxLite) => {
    // Decode the untyped message content into MessageContent at this boundary.
    const outcome = controller.onMessageEnd(
      event.message.role,
      event.message.content as MessageContent,
    );
    if (outcome === null) return;

    if (outcome.action === "steer") {
      ctx.ui.notify(`Anti-doom-loop: ${outcome.reason}`, "warning");
      pi.sendMessage?.(
        { customType: "anti-doom-loop", content: STEER_TEXT, display: true },
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
    controller = createController(readOptions());
  }
}
