/**
 * Pure loop-detection logic — no pi imports, so it is runnable/testable
 * standalone (`node extensions/detector.ts` self-check at the bottom).
 *
 * Detects two "doom loop" signatures, both scoped to a sliding window so a
 * genuinely repeated task spread over time never trips it:
 *
 *  1. The same tool called with identical arguments `repeatThreshold` times
 *     (the classic "grep the same file 10 times" loop).
 *  2. The same tool failing `failThreshold` consecutive times (blind retry
 *     of a flaky/ungrounded operation).
 */
import assert from "node:assert/strict";
import { Result } from "better-result";

export interface LoopOptions {
  /** Identical (tool, args) occurrences that trigger a block. */
  repeatThreshold: number;
  /** Consecutive same-tool errors that trigger a block. */
  failThreshold: number;
  /** How many recent calls/results are inspected for repetition. */
  windowSize: number;
  /** Consecutive verbatim assistant messages that trigger an abort. */
  textRepeatThreshold: number;
}

export const DEFAULT_OPTIONS: LoopOptions = {
  repeatThreshold: 3,
  failThreshold: 3,
  windowSize: 10,
  textRepeatThreshold: 3,
};

export function readOptions(env: Record<string, string | undefined> = process.env): LoopOptions {
  // ponytail: min 2 — a threshold of 1 would block every tool call / abort on
  // the first message, bricking the agent (deepsec finding).
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 2 ? n : fallback;
  };
  return {
    repeatThreshold: num("PI_ANTI_LOOP_REPEATS", DEFAULT_OPTIONS.repeatThreshold),
    failThreshold: num("PI_ANTI_LOOP_FAILS", DEFAULT_OPTIONS.failThreshold),
    windowSize: num("PI_ANTI_LOOP_WINDOW", DEFAULT_OPTIONS.windowSize),
    textRepeatThreshold: num("PI_ANTI_LOOP_TEXT_REPEATS", DEFAULT_OPTIONS.textRepeatThreshold),
  };
}

/** Keys sorted recursively so {a:1,b:2} and {b:2,a:1} share a signature. */
export function canonical(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
  const obj = input as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

export function signature(toolName: string, input: unknown): string {
  return `${toolName}:${canonical(input)}`;
}

export interface BlockDecision {
  /** Reason shown to the LLM as the (blocked) tool result. */
  reason: string;
  /** True when this exact call was already blocked before — caller should abort the turn. */
  escalate: boolean;
}

/**
 * Call `check` in `tool_call` (before executing). If it returns a decision,
 * block the call. Call `record` only for calls that were NOT blocked, and
 * `recordResult` in `tool_result` for executed calls.
 */
export class LoopDetector {
  readonly opts: LoopOptions;
  private recentSigs: string[] = [];
  private recentResults: { tool: string; error: boolean }[] = [];
  private blockedBySig = new Map<string, number>();
  private recentTexts: string[] = [];
  private lastText: string | null = null;
  private textStreak = 0;
  private textFired = false;

  constructor(opts: LoopOptions = DEFAULT_OPTIONS) {
    this.opts = opts;
  }

  check(toolName: string, input: unknown): Result<BlockDecision, undefined> {
    const sig = signature(toolName, input);
    const repeats = this.recentSigs.filter((s) => s === sig).length;
    const total = repeats + 1; // including this call
    const fails = this.consecutiveFails(toolName);

    if (total < this.opts.repeatThreshold && fails < this.opts.failThreshold)
      return Result.err(undefined);

    const reasons: string[] = [];
    if (total >= this.opts.repeatThreshold) {
      reasons.push(
        `"${toolName}" was called with identical arguments ${total} times in the last ${this.opts.windowSize} tool calls with no change`,
      );
    }
    if (fails >= this.opts.failThreshold) {
      reasons.push(`"${toolName}" failed ${fails} consecutive times`);
    }

    const blockedCount = (this.blockedBySig.get(sig) ?? 0) + 1;
    this.blockedBySig.set(sig, blockedCount);

    return Result.ok({
      reason:
        reasons.join("; ") +
        `. BLOCKED by anti-doom-loop — you appear to be looping. Change your approach, use a different tool, or ask the user.`,
      escalate: blockedCount > 1,
    });
  }

  record(toolName: string, input: unknown): void {
    this.recentSigs.push(signature(toolName, input));
    if (this.recentSigs.length > this.opts.windowSize) this.recentSigs.shift();
  }

  recordResult(toolName: string, error: boolean): void {
    this.recentResults.push({ tool: toolName, error });
    if (this.recentResults.length > this.opts.windowSize) this.recentResults.shift();
  }

  /**
   * Consecutive verbatim assistant text (whitespace-normalized). Fires once
   * per run when the streak reaches textRepeatThreshold, then stays silent
   * until reset — message_end cannot return a block, so the caller aborts.
   * $
   * Detects the text-only loop shape (model re-emits the same sentence
   * forever, e.g. goal-function loops) that identical-tool-call detection
   * never sees. Liquid.ai's Antidoom mines loops as 'a section repeats at
   * least four times'; we use 3 and no length floor because at runtime each
   * repetition already burns tokens.
   */
  checkText(text: string): Result<{ reason: string }, undefined> {
    const norm = normalizeText(text);
    if (!norm) return Result.err(undefined); // blank text is not a loop signal

    // Within-message self-repetition: the model pastes the same sentence
    // `textRepeatThreshold`+ times inside ONE message (growing loops like
    // "…X:…X:…X"). Liquid.ai's loop definition — a section repeats at least N
    // times. No streak needed: the message itself is the loop.
    const chunk = repeatedSegment(norm, this.opts.textRepeatThreshold);
    if (chunk !== null) {
      return Result.ok({
        reason:
          `Assistant message repeats "${truncate(chunk, 60)}" ${this.opts.textRepeatThreshold}+ times ` +
          `within a single message. You appear to be in a loop.`,
      });
    }

    // Cross-message window repeat: the same text reappearing
    // textRepeatThreshold times within the recent-text window. Catches text
    // CYCLES ("Run. GO." / "GO." / "Let me run. GO." …) that never form a
    // 3-consecutive streak and are too short for repeatedSegment. Mirrors the
    // tool-signature window in check().
    const windowCount = this.recentTexts.filter((t) => t === norm).length + 1;
    this.recentTexts.push(norm);
    if (this.recentTexts.length > this.opts.windowSize) this.recentTexts.shift();
    if (windowCount >= this.opts.textRepeatThreshold) {
      return Result.ok({
        reason:
          `Assistant sent identical text ${windowCount} times within the last ${this.opts.windowSize} messages ` +
          `("${truncate(norm, 80)}"). You appear to be in a loop.`,
      });
    }

    // Cross-message streak: consecutive assistant texts that are identical
    // OR near-identical (token-overlap similarity). Catches loops where the
    // model slightly rephrases each turn ("inspect the failing test" →
    // "examine the failing assertion") so exact matching never fires.
    const similar =
      norm === this.lastText ||
      (this.lastText !== null && tokenSimilarity(norm, this.lastText) >= TEXT_SIMILARITY_THRESHOLD);
    this.textStreak = similar ? this.textStreak + 1 : 1;
    this.lastText = norm;
    if (this.textStreak >= this.opts.textRepeatThreshold) {
      return Result.ok({
        reason:
          `Assistant replied with identical or near-identical text ${this.textStreak} times in a row ` +
          `("${truncate(norm, 80)}"). You appear to be in a loop.`,
      });
    }
    return Result.err(undefined);
  }

  /** Trail of results that are errors of this same tool (consecutive). */
  private consecutiveFails(toolName: string): number {
    let n = 0;
    for (let i = this.recentResults.length - 1; i >= 0; i--) {
      const r = this.recentResults[i];
      if (!r.error || r.tool !== toolName) break;
      n++;
    }
    return n;
  }

  reset(): void {
    this.recentSigs = [];
    this.recentResults = [];
    this.blockedBySig.clear();
    this.recentTexts = [];
    this.lastText = null;
    this.textStreak = 0;
    this.textFired = false;
  }

  summary(): string {
    const blocked = [...this.blockedBySig.values()].reduce((a, b) => a + b, 0);
    const text = this.textStreak > 1 ? `, text streak ${this.textStreak}` : "";
    return `window: ${this.recentSigs.length}/${this.opts.windowSize} calls, ${this.recentResults.length} results, blocked ${blocked} time(s)${text}`;
  }
}

/** Collapse runs of whitespace so formatting drift never hides a verbatim loop. */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** First `max` chars of a single-line string, with an ellipsis. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Minimum length of a segment worth treating as a repeated loop chunk. */
export const MIN_REPEAT_CHUNK = 16;

/** Jaccard similarity threshold for "near-identical" consecutive texts. */
export const TEXT_SIMILARITY_THRESHOLD = 0.55;

/**
 * Token-set Jaccard similarity of two texts (case/whitespace-insensitive).
 * Short tokens (< 3 chars: "a", "me", "to") are ignored to reduce noise.
 * Returns 0..1; 1 = identical token sets.
 */
export function tokenSimilarity(a: string, b: string): number {
  const tokenize = (s: string) => {
    return new Set(
      normalizeText(s)
        .toLowerCase()
        .split(/\s+/g)
        .filter((w) => w.length >= 3 && /^[a-z0-9_-]+$/.test(w)),
    );
  };
  const as = tokenize(a);
  const bs = tokenize(b);
  if (as.size === 0 || bs.size === 0) return 0;
  let inter = 0;
  for (const t of as) if (bs.has(t)) inter++;
  return inter / (as.size + bs.size - inter);
}

/**
 * Returns the first sentence-ish segment that repeats `threshold` times
 * within a single normalized message, or null.
 *
 * Catches growing doom loops where the model self-concatenates the same
 * sentence ("…X:…X:…X") — the pattern that evaded cross-message verbatim
 * detection in production (each message differs, so no streak forms).
 * Short segments (< MIN_REPEAT_CHUNK) are ignored so pasted logs with
 * repeated one-word lines never false-positive.
 */
export function repeatedSegment(normalized: string, threshold: number): string | null {
  const segments = normalized
    .split(/(?<=[.:!?])\s*/)
    .map((s) => s.trim().replace(/[.:!?]+$/, ""))
    .filter((s) => s.length >= MIN_REPEAT_CHUNK);
  const counts = new Map<string, number>();
  for (const seg of segments) {
    const n = (counts.get(seg) ?? 0) + 1;
    if (n >= threshold) return seg;
    counts.set(seg, n);
  }
  return null;
}

// --- self-check (runs under `node extensions/detector.ts`, skipped when loaded by pi) ---
if (import.meta.main) {
  const opts: LoopOptions = {
    repeatThreshold: 3,
    failThreshold: 3,
    windowSize: 10,
    textRepeatThreshold: 3,
  };
  const d: LoopDetector = new LoopDetector(opts);

  // 1. identical calls: 2 pass, 3rd is blocked; retry of a blocked call escalates
  assert.ok(d.check("bash", { command: "grep foo bar.ts" }).isErr(), "1st call passes");
  d.record("bash", { command: "grep foo bar.ts" });
  assert.ok(d.check("bash", { command: "grep foo bar.ts" }).isErr(), "2nd call passes");
  d.record("bash", { command: "grep foo bar.ts" });
  const hit = d.check("bash", { command: "grep foo bar.ts" });
  assert.ok(hit.isOk(), "3rd identical call should block");
  if (hit.isOk()) {
    assert.equal(hit.value.escalate, false, "first block does not escalate");
    assert.match(hit.value.reason, /identical arguments 3 times/);
  }
  // LLM ignores the block and retries the exact same call: escalate
  const hit2 = d.check("bash", { command: "grep foo bar.ts" });
  assert.ok(hit2.isOk() && hit2.value.escalate, "retry of a blocked call should escalate");

  // 2. different arguments are not a loop
  d.reset();
  assert.ok(d.check("read", { path: "a.ts" }).isErr());
  d.record("read", { path: "a.ts" });
  assert.ok(d.check("read", { path: "b.ts" }).isErr());
  d.record("read", { path: "b.ts" });
  assert.ok(d.check("read", { path: "a.ts" }).isErr(), "arg order/counter: only same args count");

  // 3. key order does not matter
  assert.equal(signature("read", { a: 1, b: 2 }), signature("read", { b: 2, a: 1 }));

  // 4. consecutive same-tool failures trigger a block
  d.reset();
  d.recordResult("bash", true);
  d.recordResult("bash", true);
  d.recordResult("bash", true);
  const failHit = d.check("bash", { command: "npm test" });
  assert.ok(failHit.isOk(), "3 consecutive failures should block");
  if (failHit.isOk()) assert.match(failHit.value.reason, /failed 3 consecutive times/);

  // 5. an interleaved success breaks the failure streak
  d.reset();
  d.recordResult("bash", true);
  d.recordResult("bash", false);
  d.recordResult("bash", true);
  d.recordResult("bash", true);
  assert.ok(d.check("bash", { command: "npm test" }).isErr(), "success breaks the streak");

  // 6. window eviction: stale repeats no longer count
  d.reset();
  for (let i = 0; i < opts.windowSize; i++) d.record("bash", { command: `cmd ${i}` });
  assert.ok(d.check("bash", { command: "cmd 0" }).isErr(), "evicted repeats do not count");

  // 7. verbatim assistant text loop: fires at the 3rd identical message and
  //    every message after while the streak holds (controller escalates)
  d.reset();
  assert.ok(d.checkText("Now update buildProgram.").isErr(), "1st text passes");
  assert.ok(d.checkText("Now update buildProgram.").isErr(), "2nd text passes");
  const textHit = d.checkText("Now update buildProgram.");
  assert.ok(textHit.isOk(), "3rd identical text should fire");
  if (textHit.isOk()) {
    assert.match(textHit.value.reason, /identical text 3 times within the last/);
  }
  assert.ok(
    d.checkText("Now update buildProgram.").isOk(),
    "4th identical text still fires (escalation)",
  );
  d.reset();
  assert.ok(d.checkText("Now update buildProgram.").isErr(), "reset clears the streak");
  // 8. whitespace drift does not hide a verbatim loop
  d.reset();
  d.checkText("Read the region:");
  d.checkText("Read  the   region:");
  const wsHit = d.checkText(" Read the region: ");
  assert.ok(wsHit.isOk(), "whitespace-normalized repeats should fire");

  // 9. window semantics: < textRepeatThreshold recurrences in the window do
  //    NOT fire, even with other messages interleaved; the 3rd recurrence does.
  d.reset();
  d.checkText("A");
  d.checkText("B"); // different message
  d.checkText("A"); // 2nd A in window
  assert.ok(d.checkText("C").isErr(), "2 As in the window must not fire");
  assert.ok(d.checkText("A").isOk(), "3rd A in the window fires");

  // 10. empty/blank text is ignored as a loop signal
  d.reset();
  d.checkText("");
  d.checkText("   ");
  assert.ok(d.checkText("").isErr(), "blank text must not fire");
  // 11. text CYCLES: a small set of short near-identical commands rotating
  //     ("Let me run. GO." / "Run. GO." / "GO.") never forms a consecutive
  //     streak, but the same text reappears >= threshold within the window.
  d.reset();
  const cycle = [
    "Let me run. GO.",
    "Run. GO.",
    "GO.",
    "Run. GO.",
    "GO.",
    "Let me run. GO.",
    "Run. GO.",
    "GO.",
    "Run. GO.",
    "GO.",
    "Let me run. GO.",
  ];
  let fired = false;
  for (const m of cycle) if (d.checkText(m).isOk()) fired = true;
  assert.ok(fired, "rotating near-identical cycle must fire");

  // 12. threshold 1 is clamped away (would brick the agent)
  const clamped = readOptions({
    PI_ANTI_LOOP_REPEATS: "1",
    PI_ANTI_LOOP_FAILS: "0",
    PI_ANTI_LOOP_TEXT_REPEATS: "-2",
  });
  assert.equal(clamped.repeatThreshold, 3, "1 falls back to default");
  assert.equal(clamped.failThreshold, 3, "0 falls back to default");
  assert.equal(clamped.textRepeatThreshold, 3, "negative falls back to default");
  const two = readOptions({ PI_ANTI_LOOP_REPEATS: "2" });
  assert.equal(two.repeatThreshold, 2, "2 is the minimum accepted");

  console.log("detector self-check: all assertions passed");
}
