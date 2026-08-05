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
  toolLoopGhRunView,
  toolLoopGrepSameFile,
  healthySession,
} from "./fixtures.ts";

describe("fixtures: verbatim text loops (controller path)", () => {
  for (const fixture of [textLoop, textLoopBuildProgram]) {
    it(`catches: ${fixture.name}`, () => {
      const c = createController();
      let aborted = false;
      for (const message of fixture.messages) {
        const outcome = c.onMessageEnd("assistant", [{ type: "text", text: message }]);
        if (outcome !== null) aborted = true;
      }
      assert.ok(aborted, "the verbatim loop must trigger an abort");
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
  for (const fixture of [growingTextLoop, growingTextLoopSpaced]) {
    it(`catches: ${fixture.name}`, () => {
      const c = createController();
      let aborted = false;
      for (const message of fixture.messages) {
        const outcome = c.onMessageEnd("assistant", [{ type: "text", text: message }]);
        if (outcome !== null) aborted = true;
      }
      assert.ok(aborted, "the growing self-concatenation loop must trigger an abort");
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
