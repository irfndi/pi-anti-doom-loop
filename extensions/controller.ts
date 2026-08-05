/**
 * Controller — the extension's event logic as a pure, pi-free module.
 *
 * `index.ts` is a thin adapter that wires these methods to pi's event loop;
 * tests drive this controller directly with plain objects. Same behavior,
 * no pi dependency (only `better-result` via the detector).
 *
 * Escalation ladder for message loops:
 *   detection #1 → steer  (inject guidance, let the agent continue)
 *   detection #2 → abort + resume (stop the run, queue one fresh directive)
 *   detection #3+ → abort for real (hand back to the user)
 * The resume budget is session-scoped: `reset()` (per user prompt) keeps it,
 * a fresh session (new controller) starts over.
 */
import { LoopDetector, readOptions } from "./detector.ts";
import type { LoopOptions } from "./detector.ts";

/** Minimal shapes of the pi events the controller consumes (structural). */
export interface ToolCallEventLite {
  toolName: string;
  toolCallId: string;
  input: unknown;
}
export interface ToolResultEventLite {
  toolName: string;
  toolCallId: string;
  isError: boolean;
}
export interface MessageEndEventLite {
  message: { role: string; content?: unknown };
}
export interface CtxLite {
  ui: { notify(message: string, level: string): void };
  abort(): void;
}
export interface CommandCtxLite {
  ui: { notify(message: string, level: string): void };
}

export interface ToolCallOutcome {
  block: true;
  reason: string;
  /** True when this exact call was blocked before — caller should abort the turn. */
  escalate: boolean;
}

export interface TextLoopOutcome {
  reason: string;
  action: "steer" | "abort";
  /** When aborting: also queue a single fresh-resume directive (bounded). */
  resume: boolean;
}

/** How many auto-resumes per session before we hand control back for real. */
export const RESUME_BUDGET = 1;

export interface AntiLoopController {
  /** Returns a block decision for a tool call, or null to let it run. */
  onToolCall(toolName: string, input: unknown, toolCallId: string): ToolCallOutcome | null;
  /** Record a finished tool result (blocked calls' results are ignored). */
  onToolResult(toolName: string, toolCallId: string, isError: boolean): void;
  /** Detect assistant-text loops; returns a steer/abort decision or null. */
  onMessageEnd(role: string, content: unknown): TextLoopOutcome | null;
  /** Full reset (session start, user prompt, /loopcheck reset). */
  reset(): void;
  /** Suspend detection until the next reset (escape hatch for intentional repetition). */
  suspend(): void;
  resume(): void;
  isSuspended(): boolean;
  /** Human-readable status with thresholds + counters for /loopcheck. */
  status(): string;
}

export function createController(opts: LoopOptions = readOptions()): AntiLoopController {
  let detector = new LoopDetector(opts);
  const blockedIds = new Set<string>();
  let steered = false;
  let resumes = 0;
  let steers = 0;
  let aborts = 0;
  let suspended = false;

  return {
    onToolCall(toolName, input, toolCallId) {
      if (suspended) return null;
      const decision = detector.check(toolName, input);
      if (decision.isErr()) {
        detector.record(toolName, input);
        return null;
      }
      blockedIds.add(toolCallId);
      const block = decision.value;
      return { block: true, reason: block.reason, escalate: block.escalate };
    },

    onToolResult(toolName, toolCallId, isError) {
      // Blocked calls never ran, so their (error) result must not count as a
      // consecutive failure.
      if (blockedIds.has(toolCallId)) {
        blockedIds.delete(toolCallId);
        return;
      }
      detector.recordResult(toolName, isError);
    },

    onMessageEnd(role, content) {
      if (suspended) return null;
      if (role !== "assistant") return null;
      const text = extractText(content);
      if (!text) return null;
      const hit = detector.checkText(text);
      if (!hit.isOk()) return null;

      const reason = hit.value.reason;
      if (!steered) {
        steered = true;
        steers++;
        return { reason, action: "steer", resume: false };
      }
      if (resumes < RESUME_BUDGET) {
        resumes++;
        aborts++;
        return { reason, action: "abort", resume: true };
      }
      aborts++;
      return { reason, action: "abort", resume: false };
    },

    reset() {
      detector = new LoopDetector(opts);
      blockedIds.clear();
      steered = false;
      suspended = false;
      // resumes/steers/aborts are intentionally NOT reset here: they are
      // session-scoped so a stuck model cannot cycle steer→abort forever and
      // /loopcheck can report lifetime counters.
    },

    suspend() {
      suspended = true;
    },

    resume() {
      suspended = false;
    },

    isSuspended() {
      return suspended;
    },

    status() {
      const o = detector.opts;
      const s = suspended ? ", suspended" : "";
      return (
        `anti-doom-loop: repeats>=${o.repeatThreshold}/window ${o.windowSize}, ` +
        `fails>=${o.failThreshold}, text>=${o.textRepeatThreshold}. ${detector.summary()} ` +
        `steers=${steers} aborts=${aborts}${s}`
      );
    },
  };
}

/** Join the text content blocks of an assistant message. */
export function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      typeof c === "object" && c !== null && c.type === "text" && typeof c.text === "string"
        ? c.text
        : "",
    )
    .join(" ");
}
