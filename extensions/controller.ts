/**
 * Controller — the extension's event logic as a pure, pi-free module.
 *
 * `index.ts` is a thin adapter that wires these methods to pi's event loop;
 * tests drive this controller directly with plain objects. Same behavior,
 * no pi dependency (only `better-result` via the detector).
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
}

export interface AntiLoopController {
  /** Returns a block decision for a tool call, or null to let it run. */
  onToolCall(toolName: string, input: unknown, toolCallId: string): ToolCallOutcome | null;
  /** Record a finished tool result (blocked calls' results are ignored). */
  onToolResult(toolName: string, toolCallId: string, isError: boolean): void;
  /** Detect verbatim assistant-text loops; returns an abort reason or null. */
  onMessageEnd(role: string, content: unknown): TextLoopOutcome | null;
  /** Full reset (session start, user prompt, /loopcheck reset). */
  reset(): void;
  /** Human-readable status with thresholds + counters for /loopcheck. */
  status(): string;
}

export function createController(opts: LoopOptions = readOptions()): AntiLoopController {
  let detector = new LoopDetector(opts);
  const blockedIds = new Set<string>();

  return {
    onToolCall(toolName, input, toolCallId) {
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
      if (role !== "assistant") return null;
      const text = extractText(content);
      if (!text) return null;
      const hit = detector.checkText(text);
      return hit.isOk() ? { reason: hit.value.reason } : null;
    },

    reset() {
      detector = new LoopDetector(opts);
      blockedIds.clear();
    },

    status() {
      const o = detector.opts;
      return (
        `anti-doom-loop: repeats>=${o.repeatThreshold}/window ${o.windowSize}, ` +
        `fails>=${o.failThreshold}, text>=${o.textRepeatThreshold}. ${detector.summary()}`
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
