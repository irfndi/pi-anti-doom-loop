/**
 * E2E tests — real pi (≥ 0.99) subprocess, offline fake LLM.
 *
 * These launch the actual `pi` RPC entry with THIS repo's extension loaded
 * (`-e extensions/index.ts`), an in-process OpenAI-compatible fake server,
 * and a per-test workspace. Verified scenarios:
 *
 *  1. the extension loads into pi ≥ 0.99 and registers its command
 *  2. a scripted identical-bash doom loop is blocked with our block reason
 *  3. a real codemode script polling a file 5× inside ONE script call is
 *     blocked by the nested 2× rule, and the script fails with our reason
 *  4. a healthy codemode batch (distinct Promise.allSettled reads) completes
 *     without any block
 *
 * The rig skips cleanly (not fails) when the npm registry is unreachable, so
 * fully offline machines still pass `npm test`.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  ensurePi,
  installedPiVersion,
  runPi,
  assistantEnds,
  toolResultEnds,
  resultText,
  type FakeTurn,
} from "./pi-rig.ts";

let piRoot: string | undefined;

before(async () => {
  try {
    piRoot = await ensurePi();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`e2e: pi install unavailable, skipping pi e2e tests (${message})`);
  }
});

describe("e2e: pi ≥ 0.99 loads the extension", () => {
  it("installs a real pi with the expected version line", async (t) => {
    if (!piRoot) return t.skip("pi install unavailable (offline)");
    const version = await installedPiVersion(piRoot);
    assert.match(version, /^0\.9[9]\./, "pi must be the 0.99+ codemode line");
  });
});

describe("e2e: top-level doom loop is blocked in a real session", () => {
  it("blocks the 3rd identical bash call with the instructive reason", async (t) => {
    if (!piRoot) return t.skip("pi install unavailable (offline)");
    const { events } = await runPi(piRoot, {
      turns: [
        { toolCalls: [{ name: "bash", args: { command: "echo loop-probe" } }] },
        { toolCalls: [{ name: "bash", args: { command: "echo loop-probe" } }] },
        { toolCalls: [{ name: "bash", args: { command: "echo loop-probe" } }] },
        { text: "done" },
      ],
      env: { PI_ANTI_LOOP_REPEATS: "3" },
    });
    const results = toolResultEnds(events).map(resultText);
    const blocked = results.filter((t) => t.includes("BLOCKED by anti-doom-loop"));
    assert.ok(
      blocked.length >= 1,
      `expected a blocked tool result, got: ${JSON.stringify(results)}`,
    );
    assert.ok(
      blocked.some((t) => t.includes("identical arguments 3 times")),
      "block reason must name the repeat count",
    );
  });
});

describe("e2e: codemode nested loop (real codemode worker)", () => {
  it("blocks an in-script poll loop at the nested 2× rule and the script fails with our reason", async (t) => {
    if (!piRoot) return t.skip("pi install unavailable (offline)");
    const { events } = await runPi(piRoot, {
      turns: [
        {
          toolCalls: [
            {
              name: "codemode",
              args: {
                code: 'for (let i = 0; i < 5; i++) { await tools.read({ path: "probe.txt" }); } return "all reads done";',
              },
            },
          ],
        },
        { text: "codemode loop observed" },
      ],
      files: { "probe.txt": "loop probe content\n" },
    });
    const codemodeResults = toolResultEnds(events).filter(
      (e) => e.message?.toolName === "codemode",
    );
    assert.equal(codemodeResults.length, 1, "one codemode call must have run");
    const text = resultText(codemodeResults[0]);
    assert.match(text, /Script failed/, "the looped script must fail");
    assert.match(
      text,
      /"read" was called with identical arguments 2 times inside one codemode script/,
      "the nested block reason must reach the script",
    );
    assert.match(text, /BLOCKED by anti-doom-loop/);
    // The model still saw a sane session (no crash, run completed).
    assert.ok(assistantEnds(events).length >= 2, "the run completes after the failed script");
  });

  it("lets the recommended distinct Promise.allSettled batch through untouched", async (t) => {
    if (!piRoot) return t.skip("pi install unavailable (offline)");
    const { events } = await runPi(piRoot, {
      turns: [
        {
          toolCalls: [
            {
              name: "codemode",
              args: {
                code: 'const [a, b, c] = await Promise.allSettled([tools.read({ path: "a.txt" }), tools.read({ path: "b.txt" }), tools.read({ path: "c.txt" })]); return "batch ok";',
              },
            },
          ],
        },
        { text: "batch done" },
      ],
      files: { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" },
    });
    const codemodeResults = toolResultEnds(events).filter(
      (e) => e.message?.toolName === "codemode",
    );
    assert.equal(codemodeResults.length, 1);
    const text = resultText(codemodeResults[0]);
    assert.match(text, /Script completed/, "the healthy batch must complete");
    assert.doesNotMatch(text, /BLOCKED by anti-doom-loop/, "no block for distinct reads");
  });
});

describe("e2e: issue #8 — exploratory codemode scripts are not a doom loop", () => {
  it("runs three distinct scripts in sequence without a block", async (t) => {
    if (!piRoot) return t.skip("pi install unavailable (offline)");
    // Each script checks a different hypothesis, exactly the bisect shape the
    // issue reports. They share enough JS boilerplate to score ~0.69 under the
    // near-identical rule, so only the codemode exemption keeps them running.
    const script = (stage: string) =>
      `const r = await tools.bash({ command: "node -e 'console.log(\\"stage ${stage}\\")'" });\nreturn r.output;`;
    const { events } = await runPi(piRoot, {
      turns: [
        { toolCalls: [{ name: "codemode", args: { code: script("a") } }] },
        { toolCalls: [{ name: "codemode", args: { code: script("b") } }] },
        { toolCalls: [{ name: "codemode", args: { code: script("c") } }] },
        { text: "bisect done" },
      ],
    });
    const results = toolResultEnds(events).filter((e) => e.message?.toolName === "codemode");
    assert.equal(results.length, 3, "all three scripts ran");
    for (const [i, r] of results.entries()) {
      const text = resultText(r);
      assert.doesNotMatch(text, /BLOCKED by anti-doom-loop/, `script ${i + 1} was not blocked`);
      assert.match(text, /Script completed/, `script ${i + 1} completed`);
    }
  });
});

describe("e2e: a tool blocked for repeated failures can be recovered (ISS-1)", () => {
  it("blocks the first attempt once, then lets the fix run", async (t) => {
    if (!piRoot) return t.skip("pi install unavailable (offline)");
    const fail = (n: number) => ({ toolCalls: [{ name: "bash", args: { command: `exit ${n}` } }] });
    const { events } = await runPi(piRoot, {
      turns: [
        fail(1),
        fail(2),
        fail(3),
        // The attempt after the streak is blocked, then the fix must run. Before
        // the fix this call and every later one stayed blocked for the prompt.
        { toolCalls: [{ name: "bash", args: { command: "echo first-attempt" } }] },
        { toolCalls: [{ name: "bash", args: { command: "echo recovered" } }] },
        { text: "done" },
      ],
      env: { PI_ANTI_LOOP_FAILS: "3" },
    });
    const results = toolResultEnds(events).map(resultText);
    const blocked = results.filter((r) => r.includes("BLOCKED by anti-doom-loop"));
    assert.equal(blocked.length, 1, `exactly one warning block, got: ${JSON.stringify(results)}`);
    assert.ok(
      blocked[0].includes("failed 3 consecutive times"),
      `the block must name the failure streak, got: ${blocked[0]}`,
    );
    assert.ok(
      results.some((r) => r.includes("recovered")),
      `the fix must run, got: ${JSON.stringify(results)}`,
    );
  });
});

describe("e2e: global and project disable", () => {
  // Three identical bash calls: the classic top-level repeat the guard exists for.
  const loop: FakeTurn = { toolCalls: [{ name: "bash", args: { command: "echo loop-probe" } }] };

  it("global settings.json turns the guard off", async (t) => {
    if (!piRoot) return t.skip("pi install unavailable (offline)");
    const { events } = await runPi(piRoot, {
      turns: [loop, loop, loop, { text: "done" }],
      agentDirFiles: {
        "settings.json": JSON.stringify({
          defaultTools: ["+codemode"],
          antiDoomLoop: { enabled: false },
        }),
      },
    });
    const results = toolResultEnds(events).map(resultText);
    assert.ok(results.length >= 3, "all three calls ran");
    assert.ok(
      !results.some((r) => r.includes("BLOCKED by anti-doom-loop")),
      `global disable must prevent the block, got: ${JSON.stringify(results)}`,
    );
  });

  it("project .pi/settings.json turns the guard off", async (t) => {
    if (!piRoot) return t.skip("pi install unavailable (offline)");
    const { events } = await runPi(piRoot, {
      // A project file needs project trust, so the run is launched with --approve.
      args: ["--approve"],
      turns: [loop, loop, loop, { text: "done" }],
      files: {
        ".pi/settings.json": JSON.stringify({ antiDoomLoop: { enabled: false } }),
      },
    });
    const results = toolResultEnds(events).map(resultText);
    assert.ok(results.length >= 3, "all three calls ran");
    assert.ok(
      !results.some((r) => r.includes("BLOCKED by anti-doom-loop")),
      `project disable must prevent the block, got: ${JSON.stringify(results)}`,
    );
  });

  it("the project setting wins over an enabling global setting", async (t) => {
    if (!piRoot) return t.skip("pi install unavailable (offline)");
    const { events } = await runPi(piRoot, {
      args: ["--approve"],
      turns: [loop, loop, loop, { text: "done" }],
      agentDirFiles: {
        "settings.json": JSON.stringify({
          defaultTools: ["+codemode"],
          antiDoomLoop: { enabled: true },
        }),
      },
      files: { ".pi/settings.json": JSON.stringify({ antiDoomLoop: { enabled: false } }) },
    });
    const results = toolResultEnds(events).map(resultText);
    assert.ok(
      !results.some((r) => r.includes("BLOCKED by anti-doom-loop")),
      "the project scope decides",
    );
  });

  it("the guard still blocks by default (the switch is not on by accident)", async (t) => {
    if (!piRoot) return t.skip("pi install unavailable (offline)");
    const { events } = await runPi(piRoot, {
      turns: [loop, loop, loop, { text: "done" }],
      env: { PI_ANTI_LOOP_REPEATS: "3" },
    });
    const results = toolResultEnds(events).map(resultText);
    assert.ok(
      results.some((r) => r.includes("BLOCKED by anti-doom-loop")),
      `default must block, got: ${JSON.stringify(results)}`,
    );
  });
});

describe("e2e: loop_ack lets the agent override an intentional repeat", () => {
  // The scenario the feature exists for: a call the agent means to repeat
  // (polling a job) gets blocked, so it says why instead of arguing.
  const CMD = { command: "echo poll-the-job" };

  it("a blocked repeat is allowed after the agent calls loop_ack", async (t) => {
    if (!piRoot) return t.skip("pi install unavailable (offline)");
    const { events } = await runPi(piRoot, {
      turns: [
        { toolCalls: [{ name: "bash", args: CMD }] },
        { toolCalls: [{ name: "bash", args: CMD }] },
        // 3rd identical call is blocked; the block reason offers loop_ack.
        { toolCalls: [{ name: "bash", args: CMD }] },
        {
          toolCalls: [
            {
              name: "loop_ack",
              args: { why: "polling the job until it finishes" },
            },
          ],
        },
        // The acknowledged repeat now runs.
        { toolCalls: [{ name: "bash", args: CMD }] },
        { text: "done" },
      ],
      env: { PI_ANTI_LOOP_REPEATS: "3" },
    });
    const results = toolResultEnds(events).map(resultText);
    const blocked = results.filter((r) => r.includes("BLOCKED by anti-doom-loop"));
    assert.ok(blocked.length >= 1, `expected a block, got: ${JSON.stringify(results)}`);
    assert.ok(
      blocked.some((r) => r.includes("call loop_ack")),
      "the block reason must advertise loop_ack",
    );

    const acked = results.find((r) => r.includes("Acknowledged ("));
    assert.ok(acked, `loop_ack must acknowledge, got: ${JSON.stringify(results)}`);
    assert.match(acked, /cleared from the loop window/);
    // The retry really ran: one block, none after the ack.
    assert.equal(
      blocked.length,
      1,
      `the acknowledged retry must run, got blocks: ${JSON.stringify(blocked)}`,
    );
  });

  it("refuses a failure block, which is not an intentional repeat", async (t) => {
    if (!piRoot) return t.skip("pi install unavailable (offline)");
    const failing = { command: "exit 1" };
    const { events } = await runPi(piRoot, {
      turns: [
        { toolCalls: [{ name: "bash", args: failing }] },
        { toolCalls: [{ name: "bash", args: failing }] },
        { toolCalls: [{ name: "bash", args: failing }] },
        {
          toolCalls: [
            {
              name: "loop_ack",
              args: { why: "it will work this time" },
            },
          ],
        },
        { text: "done" },
      ],
    });
    const results = toolResultEnds(events).map(resultText);
    const refusal = results.find((r) => r.includes("Not acknowledged"));
    assert.ok(refusal, `loop_ack must refuse, got: ${JSON.stringify(results)}`);
    assert.match(
      refusal,
      /cannot be acknowledged|nothing is blocked|failures/,
      "a failing repeat must be refused, and the reason must name the failure",
    );
  });
});
