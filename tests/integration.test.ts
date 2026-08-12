/**
 * Integration tests — the extension wiring end-to-end without pi.
 *
 * Two layers:
 *  1. controller.ts driven with plain objects (the event logic).
 *  2. index.ts default export driven through a fake `PiLike` — capturing the
 *     registered `pi.on` handlers and invoking them with realistic events,
 *     asserting blocks, escalations, aborts, resets and the /loopcheck command.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createController, extractText } from "../extensions/controller.ts";
import indexDefault from "../extensions/index.ts";
import type { PiLike } from "../extensions/index.ts";

function makeFakePi() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<
    string,
    { description?: string; handler: (args: string, ctx: any) => unknown }
  >();
  const sent: Array<{ content: any; options?: any }> = [];
  const pi: PiLike = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, opts) {
      commands.set(name, opts);
    },
    sendMessage(content, options) {
      sent.push({ content, options });
    },
  };
  return {
    pi,
    handlers,
    commands,
    sent,
    fire: (event: string, e: any, c: any = {}) => {
      const h = handlers.get(event);
      assert.ok(h, `no handler registered for ${event}`);
      return h(e, c);
    },
  };
}

const fakeCtx = () => ({
  ui: { notify: (_msg: string, _level: string) => {} },
  abort: () => {},
});

describe("controller: tool-call lifecycle", () => {
  it("blocks identical calls and skips the blocked result in failure counting", () => {
    const c = createController();
    // Two identical allowed calls.
    assert.equal(c.onToolCall("bash", { command: "grep foo" }, "c1"), null);
    c.onToolResult("bash", "c1", false);
    assert.equal(c.onToolCall("bash", { command: "grep foo" }, "c2"), null);
    c.onToolResult("bash", "c2", false);
    // Third identical call blocks.
    const outcome = c.onToolCall("bash", { command: "grep foo" }, "c3");
    assert.ok(outcome !== null && outcome.block === true);
    // The blocked call's result (even error) must not count as a failure.
    c.onToolResult("bash", "c3", true);
    assert.equal(
      c.onToolCall("bash", { command: "other" }, "c3b"),
      null,
      "different command is not blocked (blocked error not counted)",
    );
    // A fresh identical signature still blocks via repeat counting, and the
    // blocked error did not create a 3-failure streak.
    assert.ok(c.onToolCall("bash", { command: "grep foo" }, "c4") !== null, "still blocked");
  });

  it("blocked-result exclusion matters: without it, one blocked error would seed the failure streak", () => {
    const c = createController();
    // Three DIFFERENT commands failing (repeat signal never fires) — the
    // next bash call must block by the failure streak, not by repetition.
    const cmds = ["npm test", "npm run lint", "npm run build"];
    for (let i = 0; i < 3; i++) {
      assert.equal(c.onToolCall("bash", { command: cmds[i] }, `t${i}`), null);
      c.onToolResult("bash", `t${i}`, true);
    }
    const outcome = c.onToolCall("bash", { command: "npm test" }, "t3");
    assert.ok(outcome !== null && /failed 3 consecutive times/.test(outcome.reason));
  });
});

describe("controller: message lifecycle", () => {
  it("returns an abort reason for a verbatim assistant loop", () => {
    const c = createController();
    const msg = (t: string) => [{ type: "text", text: t }];
    assert.equal(c.onMessageEnd("assistant", msg("Let me fetch the merge ref:")), null);
    assert.equal(c.onMessageEnd("assistant", msg("Let me fetch the merge ref:")), null);
    const hit = c.onMessageEnd("assistant", msg("Let me fetch the merge ref:"));
    assert.ok(hit !== null && /identical text 3 times/.test(hit.reason));
  });

  it("ignores non-assistant roles and non-text content", () => {
    const c = createController();
    assert.equal(c.onMessageEnd("user", [{ type: "text", text: "x" }]), null);
    assert.equal(c.onMessageEnd("toolResult", [{ type: "text", text: "x" }]), null);
    assert.equal(c.onMessageEnd("assistant", [{ type: "image", data: "..." }]), null);
    assert.equal(c.onMessageEnd("assistant", "not-an-array"), null);
  });

  it("extractText joins text blocks and skips non-text", () => {
    assert.equal(
      extractText([
        { type: "text", text: "a" },
        { type: "image", data: "x" },
        { type: "text", text: "b" },
      ]),
      "a  b",
    );
    assert.equal(extractText(null), "");
    assert.equal(extractText([{ type: "text", text: 42 }]), "");
  });
});

describe("controller: steer → abort → bounded resume", () => {
  it("first detection steers, second aborts with resume, third aborts for real", () => {
    const c = createController();
    const msg = (t: string) => [{ type: "text", text: t }];
    const loop = "Let me fetch the merge ref:";
    const fire = () => c.onMessageEnd("assistant", msg(loop));

    fire();
    fire();
    const steer = fire();
    assert.ok(steer, "third identical message must detect");
    assert.equal(steer?.action, "steer", "first detection steers");
    assert.equal(steer?.resume, false);
    assert.match(steer?.reason ?? "", /identical text 3 times within the last/);

    const abort1 = fire();
    assert.equal(abort1?.action, "abort");
    assert.equal(abort1?.resume, true, "first abort queues a resume");

    const abort2 = fire();
    assert.equal(abort2?.action, "abort");
    assert.equal(abort2?.resume, false, "resume budget spent");
  });

  it("reset clears the steer flag but keeps the resume budget (session-scoped)", () => {
    const c = createController();
    const msg = (t: string) => [{ type: "text", text: t }];
    const loop = "Let me fetch the merge ref:";
    const fire = () => c.onMessageEnd("assistant", msg(loop));

    // consume the budget
    fire();
    fire();
    fire(); // steer
    fire(); // abort + resume (budget now spent)

    c.reset(); // new user prompt — steer flag cleared, budget kept

    fire();
    fire();
    const steerAgain = fire();
    assert.equal(steerAgain?.action, "steer", "reset re-arms the steer flag");
    const abortAgain = fire();
    assert.equal(abortAgain?.action, "abort");
    assert.equal(abortAgain?.resume, false, "budget not restored by reset");
  });
});

describe("controller: counters + suspend", () => {
  it("status reports steers and aborts for the session", () => {
    const c = createController();
    const msg = (t: string) => [{ type: "text", text: t }];
    const loop = "Let me fetch the merge ref:";
    const fire = () => c.onMessageEnd("assistant", msg(loop));
    fire();
    fire();
    fire(); // steer
    fire(); // abort
    fire(); // abort
    const s = c.status();
    assert.match(s, /steers=1/);
    assert.match(s, /aborts=2/);
  });

  it("suspend disables detection until reset", () => {
    const c = createController();
    const msg = (t: string) => [{ type: "text", text: t }];
    const loop = "Let me fetch the merge ref:";
    // build a streak so detection would fire
    c.onMessageEnd("assistant", msg(loop));
    c.onMessageEnd("assistant", msg(loop));
    c.onMessageEnd("assistant", msg(loop)); // steer
    c.onMessageEnd("assistant", msg(loop)); // abort

    c.suspend();
    assert.ok(c.isSuspended());
    assert.match(c.status(), /suspended/);
    assert.equal(c.onMessageEnd("assistant", msg(loop)), null, "suspended: no detection");
    assert.equal(
      c.onToolCall("bash", { command: "grep foo" }, "c1"),
      null,
      "suspended: no tool blocking",
    );

    c.resume();
    assert.ok(!c.isSuspended());
    // streak persists after resume — next message still detects
    const hit = c.onMessageEnd("assistant", msg(loop));
    assert.ok(hit !== null, "resumed: detection active again");

    c.reset(); // next prompt clears suspend
    c.suspend();
    c.reset();
    assert.ok(!c.isSuspended(), "reset clears the suspend flag");
  });
});

describe("controller: reset", () => {
  it("clears streaks and blocked ids", () => {
    const c = createController();
    c.onToolCall("bash", { command: "grep foo" }, "c1");
    c.onToolCall("bash", { command: "grep foo" }, "c2");
    assert.ok(c.onToolCall("bash", { command: "grep foo" }, "c3") !== null);
    c.reset();
    assert.equal(
      c.onToolCall("bash", { command: "grep foo" }, "c4"),
      null,
      "reset clears repeat window",
    );
    // Blocked id bookkeeping cleared too: a late result for a pre-reset id
    // must not throw or corrupt state.
    c.onToolResult("bash", "c3", true);
    assert.equal(c.onToolCall("bash", { command: "grep foo" }, "c5"), null);
  });

  it("status exposes thresholds and counters", () => {
    const c = createController();
    const s = c.status();
    assert.match(s, /repeats>=3\/window 10/);
    assert.match(s, /fails>=3/);
    assert.match(s, /text>=3/);
    assert.match(s, /window: 0\/10 calls/);
  });
});

describe("index.ts adapter (fake PiLike)", () => {
  it("wires tool_call → block with reason, escalate → abort", () => {
    const { pi, fire } = makeFakePi();
    indexDefault(pi);

    const ctx = fakeCtx();
    const aborts: string[] = [];
    const withAbort = { ...ctx, abort: () => aborts.push("abort") };

    fire(
      "tool_call",
      { toolName: "bash", toolCallId: "1", input: { command: "grep foo" } },
      withAbort,
    );
    fire(
      "tool_call",
      { toolName: "bash", toolCallId: "2", input: { command: "grep foo" } },
      withAbort,
    );
    const r = fire(
      "tool_call",
      { toolName: "bash", toolCallId: "3", input: { command: "grep foo" } },
      withAbort,
    ) as { block: true; reason: string } | undefined;
    assert.ok(r, "third identical call must be blocked");
    if (r) {
      assert.equal(r.block, true);
      assert.match(r.reason, /identical arguments 3 times/);
    }
    assert.equal(aborts.length, 0, "first block must not abort");

    // Re-issue → escalate → abort fires.
    const r2 = fire(
      "tool_call",
      { toolName: "bash", toolCallId: "4", input: { command: "grep foo" } },
      withAbort,
    ) as { block: true; reason: string } | undefined;
    assert.ok(r2 && r2.block === true, "re-issue is still blocked");
    assert.equal(aborts.length, 1, "escalation aborts the turn");
  });

  it("wires message_end → steer first, then abort + bounded resume", () => {
    const { pi, fire, sent } = makeFakePi();
    indexDefault(pi);
    const aborts: string[] = [];
    const ctx = { ...fakeCtx(), abort: () => aborts.push("abort") };
    const msg = (t: string) => [{ type: "text", text: t }];
    const loop = "Let me fetch the merge ref:";
    const fireMsg = () =>
      fire("message_end", { message: { role: "assistant", content: msg(loop) } }, ctx);

    fireMsg(); // streak 1 — nothing
    fireMsg(); // streak 2 — nothing
    fireMsg(); // streak 3 — STEER (no abort, agent continues)
    assert.equal(aborts.length, 0, "first detection steers, does not abort");
    assert.equal(sent.length, 1, "a steer message was sent");
    assert.equal(sent[0].options?.deliverAs, "steer");
    assert.equal(sent[0].options?.triggerTurn, true);

    fireMsg(); // streak 4 — ABORT + resume
    assert.equal(aborts.length, 1, "persistent loop aborts");
    assert.equal(sent.length, 2, "a resume directive is queued after the abort");
    assert.equal(sent[1].options?.deliverAs, "followUp");

    fireMsg(); // streak 5 — abort for real (resume budget spent)
    assert.equal(aborts.length, 2, "looping after resume aborts again");
    assert.equal(sent.length, 2, "no second resume — budget is bounded");
  });

  it("resets counters on before_agent_start", () => {
    const { pi, fire } = makeFakePi();
    indexDefault(pi);
    const ctx = fakeCtx();
    fire("tool_call", { toolName: "bash", toolCallId: "1", input: { command: "grep foo" } }, ctx);
    fire("tool_call", { toolName: "bash", toolCallId: "2", input: { command: "grep foo" } }, ctx);
    fire("before_agent_start", {}, ctx);
    const r = fire(
      "tool_call",
      { toolName: "bash", toolCallId: "3", input: { command: "grep foo" } },
      ctx,
    );
    assert.equal(r, undefined, "after reset the same call passes again");
  });

  it("registers the /loopcheck command with status, reset, suspend, resume", async () => {
    const { pi, commands } = makeFakePi();
    indexDefault(pi);
    const cmd = commands.get("loopcheck");
    assert.ok(cmd, "/loopcheck must be registered");

    const notices: string[] = [];
    const ctx = { ui: { notify: (m: string) => notices.push(m) } };

    await cmd!.handler("", ctx as any);
    assert.match(notices[0], /anti-doom-loop: repeats>=3/);
    assert.match(notices[0], /steers=0 aborts=0/);

    await cmd!.handler("suspend", ctx as any);
    assert.match(notices[1], /suspended/);

    await cmd!.handler("resume", ctx as any);
    assert.match(notices[2], /resumed/);

    await cmd!.handler("reset", ctx as any);
    assert.match(notices[3], /counters reset/);
  });
});
