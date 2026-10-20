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
