/**
 * Fixture-driven tests: real doom-loop transcripts must be caught; healthy
 * sessions must not be.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoopDetector } from "../extensions/detector.ts";
import { createController } from "../extensions/controller.ts";
import {
  textLoop,
  textLoopBuildProgram,
  growingTextLoop,
  growingTextLoopSpaced,
  regexRepeatLoop,
  toolLoopGhRunView,
  toolLoopGrepSameFile,
  healthySession,
  codemodeNestedLoop,
  codemodeErrorRetryLoop,
  codemodeCrossScriptRepeat,
  codemodeHealthyBatch,
  type NestedFixture,
} from "./fixtures.ts";

describe("fixtures: verbatim text loops (controller path)", () => {
  for (const fixture of [textLoop, textLoopBuildProgram]) {
    it(`steers then aborts: ${fixture.name}`, () => {
      const c = createController();
      let steered = false;
      let aborted = false;
      for (const message of fixture.messages) {
        const outcome = c.onMessageEnd("assistant", [{ type: "text", text: message }]);
        if (outcome === null) continue;
        if (outcome.action === "steer") steered = true;
        else aborted = true;
      }
      assert.ok(steered, "the verbatim loop must steer first");
      if (fixture.messages.length >= 4) assert.ok(aborted, "escalates to abort as it persists");
    });
  }
});

describe("fixtures: identical tool calls (controller path)", () => {
  for (const fixture of [toolLoopGhRunView, toolLoopGrepSameFile]) {
    it(`blocks: ${fixture.name}`, () => {
      const c = createController();
      let blocked = false;
      fixture.calls.forEach((call, i) => {
        const outcome = c.onToolCall(call.tool, call.args, `call-${i}`);
        if (outcome !== null) blocked = true;
        c.onToolResult(call.tool, `call-${i}`, false);
      });
      assert.ok(blocked, "the identical-call loop must be blocked");
    });
  }
});

describe("fixtures: growing self-concatenation loops (within-message signal)", () => {
  for (const fixture of [growingTextLoop, growingTextLoopSpaced, regexRepeatLoop]) {
    it(`steers then aborts: ${fixture.name}`, () => {
      const c = createController();
      let steered = false;
      let aborted = false;
      for (const message of fixture.messages) {
        const outcome = c.onMessageEnd("assistant", [{ type: "text", text: message }]);
        if (outcome === null) continue;
        if (outcome.action === "steer") steered = true;
        else aborted = true;
      }
      assert.ok(steered, "the growing self-concatenation loop must steer first");
      if (fixture.messages.length >= 4) assert.ok(aborted, "escalates to abort as it persists");
    });
  }
});

describe("fixtures: healthy session is not flagged", () => {
  it("varied reads/edits with progress produce no block", () => {
    const c = createController();
    let blocked = 0;
    healthySession.calls.forEach((call, i) => {
      const outcome = c.onToolCall(call.tool, call.args, `call-${i}`);
      if (outcome !== null) blocked++;
      c.onToolResult(call.tool, `call-${i}`, false);
    });
    assert.equal(blocked, 0, "a healthy session must not trip the detector");
  });
});

describe("fixtures: mixed sessions", () => {
  it("a loop that briefly makes progress still gets caught when it returns to the loop", () => {
    const c = createController();
    // Two distinct reads (progress), then the gh-run-view loop resumes.
    c.onToolCall("read", { path: "a.ts" }, "1");
    c.onToolCall("read", { path: "b.ts" }, "2");
    let blocked = false;
    toolLoopGhRunView.calls.forEach((call, i) => {
      const outcome = c.onToolCall(call.tool, call.args, `loop-${i}`);
      if (outcome !== null) blocked = true;
      c.onToolResult(call.tool, `loop-${i}`, false);
    });
    assert.ok(blocked, "the resumed loop must still be blocked");
  });

  it("failing the same tool 3x then retrying is blocked with the failure reason", () => {
    const c = createController();
    // Different commands each time — isolates the failure-streak signal.
    const cmds = ["npm test", "npm run lint", "npm run build"];
    for (let i = 0; i < 3; i++) {
      assert.equal(c.onToolCall("bash", { command: cmds[i] }, `t${i}`), null);
      c.onToolResult("bash", `t${i}`, true);
    }
    const outcome = c.onToolCall("bash", { command: "npm test" }, "t3");
    assert.ok(outcome !== null && /failed 3 consecutive times/.test(outcome.reason));
  });
});

describe("fixtures: detector-level sanity", () => {
  it("detector directly flags the text-loop fixture", () => {
    const d = new LoopDetector();
    let hit = false;
    for (const m of textLoop.messages) {
      if (d.checkText(m).isOk()) hit = true;
    }
    assert.ok(hit);
  });

  it("detector directly blocks the grep fixture", () => {
    const d = new LoopDetector();
    let blocked = false;
    for (const call of toolLoopGrepSameFile.calls) {
      if (d.check(call.tool, call.args).isOk()) blocked = true;
      d.record(call.tool, call.args);
    }
    assert.ok(blocked);
  });
});

/**
 * Drive a nested codemode fixture through the controller exactly as pi ≥ 0.99
 * delivers it: nested `tool_call` events carry `parentToolCallId` (children
 * of one codemode call), blocked children get no real result event, and
 * executed children end with a `tool_result`.
 */
function runNested(fixture: NestedFixture) {
  const c = createController();
  let blocked = 0;
  let escalated = false;
  for (const e of fixture.events) {
    const outcome = c.onToolCall(e.tool, e.args, e.id, e.parent);
    if (outcome !== null) {
      blocked++;
      if (outcome.escalate) escalated = true;
      continue; // blocked children never execute → no result event
    }
    c.onToolResult(e.tool, e.id, e.isError === true, e.parent);
  }
  return { c, blocked, escalated };
}

describe("fixtures: codemode nested loops (controller path)", () => {
  it(`blocks in-script: ${codemodeNestedLoop.name}`, () => {
    const { blocked } = runNested(codemodeNestedLoop);
    assert.ok(blocked >= 1, "the in-script poll loop must block");
  });

  it(`blocks the retry: ${codemodeErrorRetryLoop.name}`, () => {
    const { blocked } = runNested(codemodeErrorRetryLoop);
    assert.ok(blocked >= 1, "the identical retry after an error must block");
  });

  it(`escalates: ${codemodeCrossScriptRepeat.name}`, () => {
    const { blocked, escalated } = runNested(codemodeCrossScriptRepeat);
    assert.ok(blocked >= 2, "both scripts must block");
    assert.ok(escalated, "the cross-script repeat must escalate");
  });

  it(`never blocks: ${codemodeHealthyBatch.name}`, () => {
    const { blocked } = runNested(codemodeHealthyBatch);
    assert.equal(blocked, 0, "the recommended batch pattern must not block");
  });

  it("a nested block steers the model even when the script swallows the error", () => {
    const { c } = runNested(codemodeNestedLoop);
    // The script ignores the thrown block error and returns normally; the
    // assistant message looks healthy — the armed one-shot steer must fire.
    const outcome = c.onMessageEnd("assistant", [{ type: "text", text: "All reads completed." }]);
    assert.ok(outcome !== null && outcome.action === "steer" && outcome.nested === true);
  });

  it("a 2× in-script loop blocks nested but would pass as top-level calls", () => {
    // The error-retry fixture is exactly 2 identical calls: nested, the 2×
    // in-script rule blocks the 2nd; the same 2 calls as TOP-LEVEL calls stay
    // under the 3× threshold — proving the nested path is what caught it.
    const c = createController();
    let topLevelBlocks = 0;
    codemodeErrorRetryLoop.events.forEach((e, i) => {
      if (c.onToolCall(e.tool, e.args, `top-${i}`) !== null) topLevelBlocks++;
    });
    assert.equal(topLevelBlocks, 0, "2 identical top-level calls must not block (3× rule)");
    const { blocked } = runNested(codemodeErrorRetryLoop);
    assert.ok(blocked >= 1, "the same 2 calls inside one script must block (2× rule)");
  });
});
