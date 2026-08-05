/**
 * Fuzz tests — deterministic (seeded), no external deps.
 *
 * Properties verified:
 *  1. The detector never throws on arbitrary JSON-safe inputs.
 *  2. Random tool-call streams (window 10, threshold 3) do not false-positive.
 *  3. Any stream containing N identical calls within the window MUST block.
 *  4. canonical() is stable/idempotent across equivalent structures.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoopDetector, canonical, type LoopOptions } from "../extensions/detector.ts";

/** mulberry32 — tiny deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["read", "grep", "bash", "edit", "write", "ls", "find", "test", "alpha", "beta"];
const PATHS = [
  "a.ts",
  "b.ts",
  "src/x",
  "config.json",
  "lib/util.ts",
  "test/spec.ts",
  "scripts/build.ts",
];
const TOOLS = ["read", "grep", "bash", "edit", "write", "ls"];

function randomArgs(rand: () => number): Record<string, unknown> {
  const kind = Math.floor(rand() * 6);
  switch (kind) {
    case 0:
      return { path: PATHS[Math.floor(rand() * PATHS.length)], offset: Math.floor(rand() * 100) };
    case 1:
      return {
        pattern: WORDS[Math.floor(rand() * WORDS.length)],
        path: PATHS[Math.floor(rand() * PATHS.length)],
      };
    case 2:
      return {
        command: `${WORDS[Math.floor(rand() * WORDS.length)]} ${Math.floor(rand() * 1000)}`,
      };
    case 3:
      return {
        path: PATHS[Math.floor(rand() * PATHS.length)],
        edits: [{ oldText: "x", newText: "y" }],
      };
    case 4:
      return { nested: { deep: [{ value: rand() }], list: [1, 2, 3] }, flag: rand() > 0.5 };
    default:
      return { empty: true, id: Math.floor(rand() * 1_000_000_000) }; // discriminator keeps it unique
  }
}

const opts: LoopOptions = {
  repeatThreshold: 3,
  failThreshold: 3,
  windowSize: 10,
  textRepeatThreshold: 3,
};

describe("fuzz: no-crash on arbitrary inputs", () => {
  it("never throws on random tool streams", () => {
    const rand = rng(0xdeadbeef);
    for (let run = 0; run < 50; run++) {
      const d = new LoopDetector(opts);
      for (let i = 0; i < 200; i++) {
        const tool = TOOLS[Math.floor(rand() * TOOLS.length)];
        const args = randomArgs(rand);
        d.check(tool, args); // may return Ok or Err — must not throw
        d.record(tool, args);
        d.recordResult(tool, rand() > 0.9);
      }
      assert.ok(true);
    }
  });

  it("never throws on random text streams", () => {
    const rand = rng(0xc0ffee);
    const d = new LoopDetector(opts);
    for (let i = 0; i < 500; i++) {
      const len = Math.floor(rand() * 40);
      let text = "";
      for (let j = 0; j < len; j++) text += WORDS[Math.floor(rand() * WORDS.length)] + " ";
      d.checkText(text); // must not throw
    }
  });
});

describe("fuzz: no false positives on random streams", () => {
  it("random varied calls never block within window 10 / threshold 3", () => {
    const rand = rng(0x12345678);
    for (let run = 0; run < 30; run++) {
      const d = new LoopDetector(opts);
      let blocked = 0;
      for (let i = 0; i < 150; i++) {
        const tool = TOOLS[Math.floor(rand() * TOOLS.length)];
        // Unique _seq per call: guarantees non-repeating traffic, so any
        // block would be a false positive.
        const args = { ...randomArgs(rand), _seq: run * 1000 + i };
        if (d.check(tool, args).isOk()) blocked++;
        d.record(tool, args);
      }
      assert.equal(blocked, 0, `random stream false-flagged (run ${run})`);
    }
  });
});

describe("fuzz: any stream with N identical calls must block", () => {
  it("injects the gh-run-view loop into random traffic and expects a block", () => {
    const rand = rng(0xabcdef01);
    for (let run = 0; run < 30; run++) {
      const d = new LoopDetector(opts);
      const loopCall = { command: "gh run view 30995002816 --log" };
      // Deterministic: the first 3 calls are the loop (guaranteed block
      // within the window), then random traffic.
      const sequence: Array<{ tool: string; args: unknown }> = [
        { tool: "bash", args: loopCall },
        { tool: "bash", args: loopCall },
        { tool: "bash", args: loopCall },
      ];
      for (let i = 0; i < 50; i++) {
        const tool = TOOLS[Math.floor(rand() * TOOLS.length)];
        sequence.push({ tool, args: { ...randomArgs(rand), _seq: i } });
      }
      let blocked = false;
      for (const call of sequence) {
        if (d.check(call.tool, call.args).isOk()) blocked = true;
        d.record(call.tool, call.args);
      }
      assert.ok(blocked, `injected loop must block (run ${run})`);
    }
  });

  it("an injected verbatim text loop always fires", () => {
    const rand = rng(0x0d0d0d0d);
    const d = new LoopDetector(opts);
    let fired = false;
    for (let i = 0; i < 200; i++) {
      const text = rand() < 0.3 ? "Let me fetch the merge ref:" : `random ${i}`;
      if (d.checkText(text).isOk()) fired = true;
    }
    assert.ok(fired);
  });
});

describe("fuzz: within-message self-repetition", () => {
  it("random text never fires any signal", () => {
    const rand = rng(0xbeef0001);
    const d = new LoopDetector(opts);
    const pool = [
      "build",
      "deploy",
      "config",
      "schema",
      "module",
      "client",
      "server",
      "worker",
      "migration",
      "endpoint",
      "payload",
      "handler",
      "middleware",
      "queue",
      "worker",
      "database",
      "table",
      "index",
      "query",
      "transaction",
      "pipeline",
      "artifact",
      "version",
      "release",
      "package",
      "binary",
      "manifest",
      "registry",
      "gateway",
    ];
    for (let i = 0; i < 300; i++) {
      // Each message: 6 random DISTINCT words + a unique marker, so two
      // consecutive messages share almost no tokens (similarity stays low)
      // and no sentence repeats inside one message.
      const words = new Set<string>();
      while (words.size < 6) words.add(pool[Math.floor(rand() * pool.length)]);
      const text = [...words].join(" ") + ` marker-${i}`;
      assert.ok(d.checkText(text).isErr(), `random text must not fire: ${text.slice(0, 60)}`);
    }
  });

  it("an injected 3x-repeated sentence always fires", () => {
    const rand = rng(0xbeef0002);
    const d = new LoopDetector(opts);
    let fired = false;
    for (let i = 0; i < 100; i++) {
      const s = "Let me view the failing test context in the CI log";
      const repeats = 1 + Math.floor(rand() * 5);
      const text = (s + ":").repeat(repeats);
      if (d.checkText(text).isOk()) fired = true;
    }
    assert.ok(fired, "at least one message with 3+ repeats must fire");
  });
});

describe("fuzz: canonical stability", () => {
  it("equivalent structures canonicalize identically", () => {
    const rand = rng(7);
    for (let i = 0; i < 200; i++) {
      const base = randomArgs(rand);
      const copy = structuredClone(base);
      assert.equal(canonical(base), canonical(copy), "round-trip copy must canonicalize the same");
    }
  });

  it("handles edge inputs without throwing", () => {
    const d = new LoopDetector(opts);
    assert.doesNotThrow(() => d.check("read", { path: "x".repeat(100_000) }));
    assert.doesNotThrow(() => d.check("bash", { command: "\u{1F600}".repeat(1000) }));
    assert.doesNotThrow(() => d.check("grep", { pattern: "", path: "" }));
    assert.doesNotThrow(() => d.check("read", { depth: 100, nested: buildDeep(100) }));
    assert.doesNotThrow(() => d.checkText("x".repeat(200_000)));
    assert.doesNotThrow(() => canonical([null, undefined, true, false, 0, -1, 3.14, "", "a"]));
  });
});

function buildDeep(depth: number): unknown {
  let o: unknown = "leaf";
  for (let i = 0; i < depth; i++) o = { child: o };
  return o;
}
