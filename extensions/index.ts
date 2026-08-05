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
 *
 * Blocking hands control back to the model once. If the model re-issues the
 * exact same blocked call, the turn is aborted (escalation).
 *
 * Counters reset on every user prompt, so a task legitimately repeated later
 * in the session is never a false positive. Disable with PI_ANTI_LOOP_DISABLE=1.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LoopDetector, readOptions } from "./detector";

export default function (pi: ExtensionAPI): void {
  if (process.env.PI_ANTI_LOOP_DISABLE === "1") return;

  let detector = new LoopDetector(readOptions());
  let configTxt = settingsTxt(detector);
  const blockedIds = new Set<string>();

  pi.on("session_start", () => reset());

  // Fresh counters per user prompt: only the loop happening *right now* counts.
  pi.on("before_agent_start", () => reset());

  pi.on("tool_call", (event, ctx) => {
    const decision = detector.check(event.toolName, event.input);
    if (decision.isErr()) {
      detector.record(event.toolName, event.input);
      return;
    }
    const block = decision.value;
    blockedIds.add(event.toolCallId);
    if (block.escalate) {
      ctx.ui.notify("Anti-doom-loop: identical call blocked again — aborting turn", "error");
      ctx.abort();
    }
    return { block: true, reason: block.reason };
  });

  // Blocked calls never ran, so their (error) result must not count as a failure.
  pi.on("tool_result", (event) => {
    if (blockedIds.has(event.toolCallId)) {
      blockedIds.delete(event.toolCallId);
      return;
    }
    detector.recordResult(event.toolName, event.isError === true);
  });

  // Text-only doom loops (model re-emits the same sentence with no tool calls)
  // never reach tool_call. Detect verbatim assistant repeats and abort the run.
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join(" ");
    if (!text) return;
    const hit = detector.checkText(text);
    if (hit.isOk()) {
      ctx.ui.notify(`Anti-doom-loop: ${hit.value.reason}`, "error");
      ctx.abort();
    }
  });

  pi.registerCommand("loopcheck", {
    description: "Anti-doom-loop status; `/loopcheck reset` clears counters",
    handler: async (args, ctx) => {
      if (args.trim().toLowerCase() === "reset") {
        reset();
        ctx.ui.notify("Anti-doom-loop: counters reset", "info");
        return;
      }
      ctx.ui.notify(`${configTxt}. ${detector.summary()}`, "info");
    },
  });

  function reset(): void {
    detector = new LoopDetector(readOptions());
    configTxt = settingsTxt(detector);
    blockedIds.clear();
  }
}

function settingsTxt(d: LoopDetector): string {
  const o = d.opts;
  return `anti-doom-loop: repeats>=${o.repeatThreshold}/window ${o.windowSize}, fails>=${o.failThreshold}`;
}
