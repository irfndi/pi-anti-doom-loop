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
 *  - the model re-emitting the same assistant text verbatim
 *    `PI_ANTI_LOOP_TEXT_REPEATS` times (default 3) → abort the run
 *
 * Blocking hands control back to the model once. If the model re-issues the
 * exact same blocked call, the turn is aborted (escalation).
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
  type MessageEndEventLite,
  type ToolCallEventLite,
  type ToolResultEventLite,
} from "./controller.ts";
import { readOptions } from "./detector.ts";

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
}

export default function (pi: PiLike): void {
  if (process.env.PI_ANTI_LOOP_DISABLE === "1") return;

  let controller: AntiLoopController = createController(readOptions());

  pi.on("session_start", () => reset());

  // Fresh counters per user prompt: only the loop happening *right now* counts.
  pi.on("before_agent_start", () => reset());

  pi.on("tool_call", (event: ToolCallEventLite, ctx: CtxLite) => {
    const outcome = controller.onToolCall(event.toolName, event.input, event.toolCallId);
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

  // Text-only doom loops (model re-emits the same sentence with no tool calls)
  // never reach tool_call. Detect verbatim assistant repeats and abort the run.
  pi.on("message_end", (event: MessageEndEventLite, ctx: CtxLite) => {
    const outcome = controller.onMessageEnd(event.message.role, event.message.content);
    if (outcome === null) return;
    ctx.ui.notify(`Anti-doom-loop: ${outcome.reason}`, "error");
    ctx.abort();
  });

  pi.registerCommand("loopcheck", {
    description: "Anti-doom-loop status; `/loopcheck reset` clears counters",
    handler: async (args: string, ctx: CommandCtxLite) => {
      if (args.trim().toLowerCase() === "reset") {
        reset();
        ctx.ui.notify("Anti-doom-loop: counters reset", "info");
        return;
      }
      ctx.ui.notify(controller.status(), "info");
    },
  });

  function reset(): void {
    controller = createController(readOptions());
  }
}
