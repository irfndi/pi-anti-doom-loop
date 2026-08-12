/**
 * Unit tests for the pure detector (extensions/detector.ts).
 * Runner: node:test (Node 22.18+ runs TS natively).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LoopDetector,
  canonical,
  signature,
  normalizeText,
  truncate,
  repeatedSegment,
  tokenSimilarity,
  readOptions,
  DEFAULT_OPTIONS,
  type LoopOptions,
} from "../extensions/detector.ts";

const opts: LoopOptions = {
  repeatThreshold: 3,
  failThreshold: 3,
  windowSize: 10,
  textRepeatThreshold: 3,
};

describe("identical-call detection", () => {
  it("blocks the 3rd identical call, escalates on re-issue", () => {
    const d = new LoopDetector(opts);
    assert.ok(d.check("bash", { command: "grep foo" }).isErr());
    d.record("bash", { command: "grep foo" });
    assert.ok(d.check("bash", { command: "grep foo" }).isErr());
    d.record("bash", { command: "grep foo" });

    const hit = d.check("bash", { command: "grep foo" });
    assert.ok(hit.isOk());
    if (hit.isOk()) {
      assert.equal(hit.value.escalate, false);
      assert.match(hit.value.reason, /identical arguments 3 times/);
    }
    // Re-issuing the same call after a block escalates (blockedBySig counter).
    const again = d.check("bash", { command: "grep foo" });
    assert.ok(again.isOk() && again.value.escalate);
  });

  it("does not block different arguments", () => {
    const d = new LoopDetector(opts);
    for (const path of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
      assert.ok(d.check("read", { path }).isErr(), `read ${path} must pass`);
      d.record("read", { path });
    }
    // One repeated path: the 2nd read passes, the 3rd blocks.
    assert.ok(d.check("read", { path: "a.ts" }).isErr(), "2nd read of a.ts must pass");
    d.record("read", { path: "a.ts" });
    assert.ok(d.check("read", { path: "a.ts" }).isOk(), "3rd read of a.ts must block");
  });

  it("ignores key order in arguments", () => {
    assert.equal(
      signature("read", { a: 1, b: { c: 2 } }),
      signature("read", { b: { c: 2 }, a: 1 }),
    );
  });

  it("evicts stale repeats beyond the window", () => {
    const d = new LoopDetector(opts);
    for (let i = 0; i < opts.windowSize; i++) d.record("bash", { command: `cmd ${i}` });
    assert.ok(d.check("bash", { command: "cmd 0" }).isErr(), "evicted repeat does not count");
  });
});

describe("consecutive-failure detection", () => {
  it("blocks after failThreshold consecutive same-tool errors", () => {
    const d = new LoopDetector(opts);
    d.recordResult("bash", true);
    d.recordResult("bash", true);
    d.recordResult("bash", true);
    const hit = d.check("bash", { command: "npm test" });
    assert.ok(hit.isOk());
    if (hit.isOk()) assert.match(hit.value.reason, /failed 3 consecutive times/);
  });

  it("an interleaved success breaks the streak", () => {
    const d = new LoopDetector(opts);
    d.recordResult("bash", true);
    d.recordResult("bash", false);
    d.recordResult("bash", true);
    d.recordResult("bash", true);
    assert.ok(d.check("bash", { command: "npm test" }).isErr());
  });

  it("a different tool's failure does not count against this tool", () => {
    const d = new LoopDetector(opts);
    d.recordResult("bash", true);
    d.recordResult("read", true);
    d.recordResult("bash", true);
    assert.ok(d.check("bash", { command: "npm test" }).isErr(), "not 3 consecutive bash errors");
  });
});

describe("verbatim text detection", () => {
  it("fires at the 3rd identical message and every message after while the streak holds", () => {
    const d = new LoopDetector(opts);
    assert.ok(d.checkText("Let me fetch the merge ref:").isErr());
    assert.ok(d.checkText("Let me fetch the merge ref:").isErr());
    const hit = d.checkText("Let me fetch the merge ref:");
    assert.ok(hit.isOk());
    if (hit.isOk()) {
      assert.match(hit.value.reason, /identical text 3 times within the last/);
    }
    // While the streak holds, every subsequent identical message also fires
    assert.ok(
      d.checkText("Let me fetch the merge ref:").isOk(),
      "4th identical message still fires",
    );
    assert.ok(
      d.checkText("Let me fetch the merge ref:").isOk(),
      "5th identical message still fires",
    );
    d.reset();
    assert.ok(d.checkText("Let me fetch the merge ref:").isErr(), "reset clears the streak");
  });

  it("whitespace drift does not hide a verbatim loop", () => {
    const d = new LoopDetector(opts);
    d.checkText("Read the region:");
    d.checkText("Read  the   region:");
    assert.ok(d.checkText(" Read the region: ").isOk());
  });

  it("window semantics: recurrence within the window fires, not just consecutive", () => {
    const d = new LoopDetector(opts);
    d.checkText("A");
    d.checkText("B"); // different message
    d.checkText("A"); // 2nd A in window
    assert.ok(d.checkText("C").isErr(), "2 recurrences in the window must not fire");
    assert.ok(d.checkText("A").isOk(), "3rd recurrence in the window fires");
  });
  it("detects a rotating near-identical command cycle", () => {
    const d = new LoopDetector(opts);
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
  });

  it("blank text is ignored", () => {
    const d = new LoopDetector(opts);
    d.checkText("");
    d.checkText("   ");
    assert.ok(d.checkText("").isErr());
  });
});

describe("within-message self-repetition (repeatedSegment)", () => {
  it("fires when a long sentence repeats 3+ times inside one message", () => {
    const msg = "Let me view the failing test context in the CI log:".repeat(3);
    const chunk = repeatedSegment(normalizeText(msg), 3);
    assert.equal(chunk, "Let me view the failing test context in the CI log");
  });

  it("handles dot-separated repeats", () => {
    const msg =
      "Let me check the CI failure output. Let me check the CI failure output. Let me check the CI failure output.";
    assert.equal(repeatedSegment(normalizeText(msg), 3), "Let me check the CI failure output");
  });

  it("handles whitespace drift between repeats", () => {
    const msg =
      "Let me view the failing test context in the CI log: Let me view the failing test context in the CI log: Let me view the failing test context in the CI log:";
    assert.equal(
      repeatedSegment(normalizeText(msg), 3),
      "Let me view the failing test context in the CI log",
    );
  });

  it("fires at 4 repeats", () => {
    const msg = "Let me view the failing test context in the CI log:".repeat(4);
    assert.equal(
      repeatedSegment(normalizeText(msg), 3),
      "Let me view the failing test context in the CI log",
    );
  });

  it("does not fire on a single sentence", () => {
    assert.equal(repeatedSegment("Let me view the failing test context in the CI log:", 3), null);
  });

  it("does not fire on two repeats (emphasis, not a loop)", () => {
    const msg = "Let me view the failing test context in the CI log:".repeat(2);
    assert.equal(repeatedSegment(normalizeText(msg), 3), null);
  });

  it("does not fire on short segments (pasted logs with one-word lines)", () => {
    assert.equal(repeatedSegment("Error. Error. Error.", 3), null, "segments < MIN_REPEAT_CHUNK");
    assert.equal(repeatedSegment("Read. Read. Read. Read.", 3), null);
  });

  it("does not fire on distinct sentences", () => {
    const msg = "Open the file. Read the tests. Run the suite. Check the output.";
    assert.equal(repeatedSegment(msg, 3), null);
  });
});

describe("within-message detection through checkText", () => {
  it("aborts on the growing self-concatenation pattern even though messages differ", () => {
    const d = new LoopDetector(opts);
    const s = "Let me view the failing test context in the CI log";
    // Each message grows by one copy: verbatim streak never forms.
    assert.ok(d.checkText(s + ":").isErr());
    assert.ok(d.checkText((s + ":").repeat(2)).isErr(), "2 repeats inside one message: not yet");
    const hit = d.checkText((s + ":").repeat(3));
    assert.ok(hit.isOk(), "3 repeats inside one message: fire");
    if (hit.isOk()) {
      assert.match(hit.value.reason, /within a single message/);
    }
    // While the condition holds, subsequent messages fire too (escalation).
    assert.ok(d.checkText((s + ":").repeat(4)).isOk(), "4x-repeat message also fires");
  });

  it("fires even when the first message already contains the repetition", () => {
    const d = new LoopDetector(opts);
    const hit = d.checkText("Let me view the failing test context in the CI log:".repeat(3));
    assert.ok(hit.isOk(), "first message with 3 repeats fires immediately");
  });
});

describe("near-identical text (tokenSimilarity)", () => {
  it("returns high similarity for lightly rephrased sentences", () => {
    const a = "Let me re-download the log and inspect the failing test";
    const b = "Let me re-download the log and examine the failing assertion";
    assert.ok(tokenSimilarity(a, b) >= 0.5, `similarity too low: ${tokenSimilarity(a, b)}`);
    assert.equal(tokenSimilarity(a, a), 1);
  });

  it("returns low similarity for unrelated sentences", () => {
    const s = tokenSimilarity(
      "Open the file and read the tests",
      "Deploy the service to production now",
    );
    assert.ok(s < 0.3, `expected low similarity, got ${s}`);
  });

  it("ignores short tokens and case", () => {
    assert.equal(
      tokenSimilarity("Go now!", "Go now!"),
      0,
      "tokens shorter than 3 chars are ignored",
    );
    assert.equal(tokenSimilarity("Read THE File", "read the file"), 1);
  });

  it("fires a streak on near-identical consecutive messages", () => {
    const d = new LoopDetector(opts);
    const variants = [
      "Let me re-download the log and inspect the failing test",
      "Let me re-download the log and examine the failing assertion",
      "Let me re-download the run log and inspect the failing test's assertion",
    ];
    assert.ok(d.checkText(variants[0]).isErr());
    assert.ok(d.checkText(variants[1]).isErr(), "2nd similar message: streak 2");
    const hit = d.checkText(variants[2]);
    assert.ok(hit.isOk(), "3rd similar message fires");
    if (hit.isOk()) assert.match(hit.value.reason, /identical or near-identical text 3 times/);
  });

  it("a genuinely different message resets the similarity streak", () => {
    const d = new LoopDetector(opts);
    d.checkText("Let me re-download the log and inspect the failing test");
    d.checkText("Let me re-download the log and examine the failing assertion");
    d.checkText("The build passed and all tests are green now");
    d.checkText("Let me re-download the log and inspect the failing test");
    assert.ok(
      d.checkText("Let me re-download the log and examine the failing assertion").isErr(),
      "streak reset by the different message",
    );
  });
});

describe("options", () => {
  it("clamps thresholds below 2 back to defaults (would brick the agent)", () => {
    const clamped = readOptions({
      PI_ANTI_LOOP_REPEATS: "1",
      PI_ANTI_LOOP_FAILS: "0",
      PI_ANTI_LOOP_TEXT_REPEATS: "-2",
    });
    assert.equal(clamped.repeatThreshold, DEFAULT_OPTIONS.repeatThreshold);
    assert.equal(clamped.failThreshold, DEFAULT_OPTIONS.failThreshold);
    assert.equal(clamped.textRepeatThreshold, DEFAULT_OPTIONS.textRepeatThreshold);
  });

  it("accepts 2 as the minimum", () => {
    assert.equal(readOptions({ PI_ANTI_LOOP_REPEATS: "2" }).repeatThreshold, 2);
  });

  it("falls back on non-numeric values", () => {
    assert.equal(
      readOptions({ PI_ANTI_LOOP_WINDOW: "abc" }).windowSize,
      DEFAULT_OPTIONS.windowSize,
    );
    assert.equal(readOptions({ PI_ANTI_LOOP_WINDOW: "" }).windowSize, DEFAULT_OPTIONS.windowSize);
  });
});

describe("helpers", () => {
  it("canonical handles primitives, arrays, nesting", () => {
    assert.equal(canonical(null), "null");
    assert.equal(canonical(42), "42");
    assert.equal(canonical("a b"), '"a b"');
    assert.equal(canonical([1, { a: 2 }]), '[1,{"a":2}]');
    assert.equal(canonical({ a: [1, { b: 2 }] }), '{"a":[1,{"b":2}]}');
  });

  it("normalizeText collapses whitespace", () => {
    assert.equal(normalizeText("  a \n b\t c  "), "a b c");
  });

  it("truncate keeps short text and ellipsizes long text", () => {
    assert.equal(truncate("short", 80), "short");
    assert.equal(truncate("abcdef", 3), "abc…");
  });
});
