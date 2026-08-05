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
  it("fires once at the 3rd identical message, then stays silent until reset", () => {
    const d = new LoopDetector(opts);
    assert.ok(d.checkText("Let me fetch the merge ref:").isErr());
    assert.ok(d.checkText("Let me fetch the merge ref:").isErr());
    const hit = d.checkText("Let me fetch the merge ref:");
    assert.ok(hit.isOk());
    if (hit.isOk()) {
      assert.match(hit.value.reason, /identical text 3 times/);
      assert.match(hit.value.reason, /aborted/);
    }
    assert.ok(d.checkText("Let me fetch the merge ref:").isErr(), "fires only once per run");
  });

  it("whitespace drift does not hide a verbatim loop", () => {
    const d = new LoopDetector(opts);
    d.checkText("Read the region:");
    d.checkText("Read  the   region:");
    assert.ok(d.checkText(" Read the region: ").isOk());
  });

  it("a different message breaks the streak", () => {
    const d = new LoopDetector(opts);
    d.checkText("A");
    d.checkText("A");
    d.checkText("B");
    d.checkText("A");
    assert.ok(d.checkText("A").isErr(), "only 2 consecutive As after the break");
    assert.ok(d.checkText("A").isOk(), "3 consecutive As after the break fire");
  });

  it("blank text is ignored", () => {
    const d = new LoopDetector(opts);
    d.checkText("");
    d.checkText("   ");
    assert.ok(d.checkText("").isErr());
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
