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
import type { PiLike, PiHandlerResult } from "../extensions/index.ts";
import type { CommandCtxLite } from "../extensions/controller.ts";

function makeFakePi() {
  const handlers = new Map<string, (event: any, ctx: any) => PiHandlerResult | void>();
  const commands = new Map<
    string,
    { description?: string; handler: (args: string, ctx: CommandCtxLite) => Promise<void> | void }
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

  it("aborts on duplicate identical tool calls batched in ONE assistant message", () => {
    const c = createController();
    const spam = (n: number, command = "true") =>
      Array.from({ length: n }, () => ({ type: "toolCall", name: "bash", arguments: { command } }));
    const hit = c.onMessageEnd("assistant", spam(3));
    assert.ok(hit !== null && hit.action === "abort" && !hit.resume);
    assert.match(hit!.reason, /identical "bash" calls/);
  });

  it("allows parallel calls with distinct args or below-threshold duplicates", () => {
    const c = createController();
    const distinct = [
      { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
      { type: "toolCall", name: "read", arguments: { path: "b.ts" } },
      { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
    ];
    assert.equal(c.onMessageEnd("assistant", distinct), null);
    const two = [
      { type: "toolCall", name: "bash", arguments: { command: "true" } },
      { type: "toolCall", name: "bash", arguments: { command: "true" } },
    ];
    assert.equal(c.onMessageEnd("assistant", two), null);
  });

  it("ignores non-assistant roles and non-text content", () => {
    const c = createController();
    assert.equal(c.onMessageEnd("user", [{ type: "text", text: "x" }]), null);
    assert.equal(c.onMessageEnd("toolResult", [{ type: "text", text: "x" }]), null);
    assert.equal(c.onMessageEnd("assistant", [{ type: "image" }]), null);
    assert.equal(c.onMessageEnd("assistant", []), null);
  });

  it("extractText joins text blocks and skips non-text", () => {
    assert.equal(
      extractText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]),
      "a  b",
    );
    assert.equal(extractText([]), "");
    assert.equal(extractText([{ type: "image" }]), "");
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
    assert.match(s, /calls\[0\]/);
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
    );
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
    );
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

  it("keeps counters across run restarts, resets on a user prompt", () => {
    const { pi, fire } = makeFakePi();
    indexDefault(pi);
    const ctx = fakeCtx();
    fire("tool_call", { toolName: "bash", toolCallId: "1", input: { command: "grep foo" } }, ctx);
    fire("tool_call", { toolName: "bash", toolCallId: "2", input: { command: "grep foo" } }, ctx);

    // Agent-originated run restarts must NOT wipe counters — that is what let
    // cross-run loops escape. The extension deliberately no longer subscribes
    // to `before_agent_start` (hosts emit it per run start); a custom-role
    // input message — how steers/async drains actually arrive — must not reset.
    fire("message_end", { message: { role: "custom", content: [] } }, ctx);
    const r = fire(
      "tool_call",
      { toolName: "bash", toolCallId: "3", input: { command: "grep foo" } },
      ctx,
    );
    assert.ok(r, "3rd identical call still blocks after run restarts");

    // A genuine user prompt resets: the same call passes again.
    fire("message_end", { message: { role: "user", content: [] } }, ctx);
    const after = fire(
      "tool_call",
      { toolName: "bash", toolCallId: "4", input: { command: "grep foo" } },
      ctx,
    );
    assert.equal(after, undefined, "after a user prompt the same call passes again");
  });

  it("registers the /loopcheck command with status, reset, suspend, resume", async () => {
    const { pi, commands } = makeFakePi();
    indexDefault(pi);
    const cmd = commands.get("loopcheck");
    assert.ok(cmd, "/loopcheck must be registered");

    const notices: string[] = [];
    const ctx = { ui: { notify: (m: string) => notices.push(m) } };

    await cmd!.handler("", ctx);
    assert.match(notices[0], /anti-doom-loop: repeats>=3/);
    assert.match(notices[0], /steers=0 aborts=0/);

    await cmd!.handler("suspend", ctx);
    assert.match(notices[1], /suspended/);

    await cmd!.handler("resume", ctx);
    assert.match(notices[2], /resumed/);

    await cmd!.handler("reset", ctx);
    assert.match(notices[3], /counters reset/);
  });
});

describe("nested codemode calls (parentToolCallId, pi ≥ 0.99)", () => {
  it("routes nested calls through the stricter path and does not touch the top-level window", () => {
    const c = createController();
    // Script p1: 1st read passes, 2nd blocks at the nested 2× rule.
    assert.equal(c.onToolCall("read", { path: "a.ts" }, "p1/1", "p1"), null);
    const block = c.onToolCall("read", { path: "a.ts" }, "p1/2", "p1");
    assert.ok(block !== null && block.block === true && block.nested === true);
    assert.match(block.reason, /inside one codemode script/);
    // The top-level window must stay clean.
    assert.equal(
      c.onToolCall("read", { path: "a.ts" }, "top1"),
      null,
      "nested traffic must not leak into the top-level window",
    );
  });

  it("nested escalations abort the turn", () => {
    const c = createController();
    // p1: 2nd identical call blocks (no escalation). A NEW script starts
    // clean, but once IT repeats the same signature, the cross-script block
    // counter escalates.
    c.onToolCall("read", { path: "a.ts" }, "p1/1", "p1");
    const first = c.onToolCall("read", { path: "a.ts" }, "p1/2", "p1");
    assert.ok(first !== null && !first.escalate);
    assert.equal(
      c.onToolCall("read", { path: "a.ts" }, "p2/1", "p2"),
      null,
      "new script starts clean",
    );
    const escalate = c.onToolCall("read", { path: "a.ts" }, "p2/2", "p2");
    assert.ok(escalate !== null && escalate.escalate, "repeat in a new script escalates");
  });

  it("blocked nested ids are excluded from error streaks; allowed nested errors arm error-retry", () => {
    const c = createController();
    // Blocked call (p1/2) never ran: its error result must be swallowed…
    c.onToolCall("read", { path: "a.ts" }, "p1/1", "p1");
    c.onToolCall("read", { path: "a.ts" }, "p1/2", "p1"); // block
    c.onToolResult("read", "p1/2", true, "p1");
    // …and the FIRST blocked-id hit is consumed, so an identical id replay
    // must not double-consume (defensive: pi never reuses ids).
    c.onToolResult("read", "p1/2", true, "p1");
    // Allowed error result arms the error-retry rule for the next script.
    c.onToolCall("bash", { command: "npm test" }, "p3/1", "p3");
    c.onToolResult("bash", "p3/1", true, "p3");
    const hit = c.onToolCall("bash", { command: "npm test" }, "p3/2", "p3");
    assert.ok(hit !== null, "identical retry after a nested error must block");
    if (hit) assert.match(hit.reason, /already failed inside this script/);
  });

  it("message_end steers once with NESTED_STEER_TEXT after a script swallowed a nested block", () => {
    const c = createController();
    // A codemode block arms the one-shot steer.
    c.onToolCall("read", { path: "a.ts" }, "p1/1", "p1");
    assert.ok(c.onToolCall("read", { path: "a.ts" }, "p1/2", "p1") !== null);

    // The script returns a plain summary; the assistant message looks healthy.
    const outcome = c.onMessageEnd("assistant", [{ type: "text", text: "All done, files read." }]);
    assert.ok(outcome !== null, "the swallowed nested block must still steer");
    assert.equal(outcome?.action, "steer");
    assert.equal(outcome?.nested, true);
    assert.match(outcome?.reason ?? "", /codemode script was blocked/);
    // One-shot: the next healthy message is not flagged again.
    assert.equal(c.onMessageEnd("assistant", [{ type: "text", text: "Continuing work." }]), null);
  });

  it("steer-again waits for an assistant message and does not fire on user/toolResult ends", () => {
    const c = createController();
    c.onToolCall("read", { path: "a.ts" }, "p1/1", "p1");
    c.onToolCall("read", { path: "a.ts" }, "p1/2", "p1"); // arms steerAgain
    assert.equal(c.onMessageEnd("toolResult", [{ type: "text", text: "x" }]), null);
    const outcome = c.onMessageEnd("assistant", [{ type: "text", text: "ok" }]);
    assert.ok(outcome !== null && outcome.action === "steer" && outcome.nested === true);
  });

  it("reset clears the armed nested steer", () => {
    const c = createController();
    c.onToolCall("read", { path: "a.ts" }, "p1/1", "p1");
    c.onToolCall("read", { path: "a.ts" }, "p1/2", "p1"); // arms steerAgain
    c.reset(); // new user prompt
    assert.equal(
      c.onMessageEnd("assistant", [{ type: "text", text: "fresh start" }]),
      null,
      "armed steer must not survive a reset",
    );
  });

  it("status reports nested codemode counters", () => {
    const c = createController();
    c.onToolCall("read", { path: "a.ts" }, "p1/1", "p1");
    c.onToolCall("read", { path: "a.ts" }, "p1/2", "p1");
    assert.match(c.status(), /nested: calls=1 blocks=1/);
  });

  it("adapter forwards parentToolCallId and sends NESTED_STEER_TEXT via sendMessage", () => {
    const { pi, fire, sent } = makeFakePi();
    indexDefault(pi);
    const aborts: string[] = [];
    const ctx = { ...fakeCtx(), abort: () => aborts.push("abort") };

    // Two identical nested reads from one script → 2nd blocks (no abort).
    fire(
      "tool_call",
      { toolName: "read", toolCallId: "p1/1", input: { path: "a.ts" }, parentToolCallId: "p1" },
      ctx,
    );
    const blocked = fire(
      "tool_call",
      { toolName: "read", toolCallId: "p1/2", input: { path: "a.ts" }, parentToolCallId: "p1" },
      ctx,
    );
    assert.ok(blocked && blocked.block === true, "2nd identical nested call must block");
    assert.equal(aborts.length, 0, "first nested block does not abort");

    // Script ends; assistant message_end → the armed nested steer fires.
    fire(
      "message_end",
      { message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      ctx,
    );
    assert.equal(sent.length, 1, "a steer message was sent");
    assert.match(sent[0].content?.content ?? "", /codemode script repeated identical tool calls/);
    assert.equal(sent[0].options?.deliverAs, "steer");

    // A new script re-issuing the same signature escalates → abort.
    fire(
      "tool_call",
      { toolName: "read", toolCallId: "p2/1", input: { path: "a.ts" }, parentToolCallId: "p2" },
      ctx,
    );
    const esc = fire(
      "tool_call",
      { toolName: "read", toolCallId: "p2/2", input: { path: "a.ts" }, parentToolCallId: "p2" },
      ctx,
    );
    assert.ok(esc && esc.block === true);
    assert.equal(aborts.length, 1, "cross-script repeat escalates to abort");
  });
});
