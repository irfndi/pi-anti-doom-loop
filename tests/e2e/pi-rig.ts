/**
 * E2E rig — real pi (≥ 0.99) subprocess driven by an in-process fake LLM.
 *
 * Everything is offline and hermetic:
 *  - `ensurePi()` downloads the real `@earendil-works/pi-coding-agent@0.99.2`
 *    tarball once into a temp cache (reused across runs).
 *  - `FakeOpenAI` is an in-process OpenAI-compatible streaming server; each
 *    assistant turn is scripted, so no network or API key is ever touched.
 *  - `runPi()` launches pi's RPC entry with the repo extension loaded and a
 *    per-test workspace (models.json provider pointing at the fake server),
 *    collects the JSONL event stream, and returns the parsed events.
 *
 * This exercises the real shipped pipeline: pi loads `extensions/index.ts`,
 * the fake model doom-loops, and pi's real agent loop / codemode worker run
 * against our event handlers — no mocks of the code under test.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const run = promisify(execFile);

/** Exact pi version the rig pins (first release line with codemode + parentToolCallId). */
export const PI_VERSION = "0.99.2";

/** Root of a cached pi install: contains node_modules/@earendil-works/pi-coding-agent. */
export async function ensurePi(): Promise<string> {
  const cache = join(tmpdir(), "pi-anti-doom-loop-e2e", `pi-${PI_VERSION}`);
  const pkg = join(cache, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  try {
    await readFile(pkg, "utf8");
    return cache; // cached from a previous run
  } catch {
    // not cached — install below
  }
  await rm(cache, { recursive: true, force: true });
  await mkdir(cache, { recursive: true });
  await writeFile(
    join(cache, "package.json"),
    JSON.stringify({ name: "pi-e2e-rig", private: true }),
  );
  const tarball = join(cache, `pi-coding-agent-${PI_VERSION}.tgz`);
  await run(
    "node",
    [
      "-e",
      `fetch("https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-${PI_VERSION}.tgz").then(async r => { if (!r.ok) throw new Error("registry " + r.status); const { writeFileSync } = await import("node:fs"); writeFileSync(process.argv[1], Buffer.from(await r.arrayBuffer())); })`,
      tarball,
    ],
    { timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  await run("npm", ["install", tarball, "--no-save", "--ignore-scripts", "--loglevel", "error"], {
    cwd: cache,
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  await readFile(pkg, "utf8"); // sanity: install really landed
  return cache;
}

/** True when `server.address()` returned the TCP variant (not a pipe path). */
function isAddressInfo(value: unknown): value is { port: number } {
  return (
    typeof value === "object" && value !== null && "port" in value && typeof value.port === "number"
  );
}

/** The installed pi's version string (read from its package.json). */
export async function installedPiVersion(piRoot: string): Promise<string> {
  // SAFETY: the rig installs this exact package, whose manifest carries
  // `version`; a broken tarball fails the install step before we get here.
  const pkg = JSON.parse(
    await readFile(
      join(piRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
      "utf8",
    ),
  ) as PiManifest;
  return pkg.version;
}

/** The manifest fields the rig reads from the installed pi package. */
interface PiManifest {
  version: string;
}

/** Tool arguments the fake LLM sends (JSON-serializable tool input). */
type ToolCallArgs = Record<string, string | number | boolean | null>;

/** One scripted assistant turn: either tool calls or a plain text reply. */
export interface FakeTurn {
  toolCalls?: { name: string; args: ToolCallArgs }[];
  text?: string;
}

/** The `delta` object of one OpenAI chat chunk (only the fields the rig sends). */
interface ChunkDelta {
  role?: string;
  content?: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    index: number;
    function: { name: string; arguments: string };
  }[];
}

/**
 * Minimal OpenAI-compatible streaming server. Serves `turns` in order
 * (a plain "done" text reply after they are exhausted) and records how many
 * completions were requested.
 */
export class FakeOpenAI {
  private shutdown: (() => Promise<void>) | undefined;
  private served = 0;
  private readonly turns: FakeTurn[];
  baseUrl = "";

  constructor(turns: FakeTurn[]) {
    this.turns = turns;
  }

  start(): Promise<string> {
    const server = createServer((req, res) => {
      if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const n = this.served++;
        const turn = this.turns[n] ?? { text: "done" };
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (s: string) => res.write(`data: ${s}\n\n`);
        const chunk = (delta: ChunkDelta, finish?: string) =>
          JSON.stringify({
            id: "e2e",
            object: "chat.completion.chunk",
            created: 1,
            model: "loop-bot",
            choices: [{ index: 0, delta, finish_reason: finish ?? null }],
          });
        send(chunk({ role: "assistant" }));
        if (turn.toolCalls) {
          turn.toolCalls.forEach((call, i) =>
            send(
              chunk({
                tool_calls: [
                  {
                    id: `call_${n}_${i}`,
                    type: "function",
                    index: i,
                    function: { name: call.name, arguments: JSON.stringify(call.args) },
                  },
                ],
              }),
            ),
          );
        } else {
          send(chunk({ content: turn.text ?? "done" }));
        }
        send(chunk({ content: null }, turn.toolCalls ? "tool_calls" : "stop"));
        send("[DONE]");
        res.end();
      });
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        assert.ok(isAddressInfo(addr), "listening on a TCP port yields an AddressInfo");
        this.shutdown = () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          });
        this.baseUrl = `http://127.0.0.1:${addr.port}/v1`;
        resolve(this.baseUrl);
      });
    });
  }

  async stop(): Promise<void> {
    const shutdown = this.shutdown;
    if (!shutdown) return;
    this.shutdown = undefined;
    await shutdown();
  }
}

export interface PiRunResult {
  /** Parsed JSONL RPC events (one JSON object per line). */
  events: RpcEvent[];
  stderr: string;
}

export interface PiRunOptions {
  /** Assistant turns to script on the fake LLM. */
  turns: FakeTurn[];
  /** Env for the run (thresholds etc.). Extends PI_OFFLINE=1 + the fake provider. */
  env?: Record<string, string>;
  /** Files written into the workspace before the run (relative path → content). */
  files?: Record<string, string>;
  /** Extra files created in the agent dir (e.g. settings.json for defaultTools). */
  agentDirFiles?: Record<string, string>;
  /** Hard deadline for the whole session. */
  timeoutMs?: number;
}

/**
 * Run one headless pi session: fake LLM + workspace + the repo's extension.
 * Returns the RPC event stream (pi's `--mode rpc` protocol over stdout).
 */
export async function runPi(piRoot: string, options: PiRunOptions): Promise<PiRunResult> {
  const extPath = join(new URL("../..", import.meta.url).pathname, "extensions", "index.ts");
  const rpcEntry = join(
    piRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "rpc-entry.js",
  );

  // Agent dir: fake provider in models.json + per-test agent files.
  const agentDir = await mkdtemp(join(tmpdir(), "pi-e2e-home-"));
  const fake = new FakeOpenAI(options.turns);
  const baseUrl = await fake.start();
  const agentDirFiles = {
    "models.json": JSON.stringify({
      providers: {
        fake: { baseUrl, api: "openai-completions", apiKey: "dummy", models: [{ id: "loop-bot" }] },
      },
    }),
    "settings.json": JSON.stringify({ defaultTools: ["+codemode"] }),
    ...options.agentDirFiles,
  } satisfies Record<string, string>;
  for (const [name, content] of Object.entries(agentDirFiles)) {
    await mkdir(join(agentDir, name, ".."), { recursive: true });
    await writeFile(join(agentDir, name), content);
  }

  // Workspace the session runs in.
  const workspace = await mkdtemp(join(tmpdir(), "pi-e2e-ws-"));
  for (const [name, content] of Object.entries(options.files ?? {})) {
    await mkdir(join(workspace, name, ".."), { recursive: true });
    await writeFile(join(workspace, name), content);
  }

  const child = spawn(
    process.execPath,
    [rpcEntry, "--no-session", "--model", "fake/loop-bot", "-e", extPath],
    {
      cwd: workspace,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  // Feed one prompt; end stdin once the run settles (pi exits on EOF) —
  // with a fallback so a hung session still terminates.
  child.stdin.write(JSON.stringify({ type: "prompt", message: "do the task" }) + "\n");
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    out += chunk;
    if (!settled && out.includes('"type":"agent_end"')) {
      settled = true;
      child.stdin.end();
    }
  });

  const timeoutMs = options.timeoutMs ?? 30_000;
  let settled = false;
  let stderr = "";
  let out = "";
  let err = "";
  const timer = setTimeout(() => {
    err += `rig: timeout after ${timeoutMs}ms\n`;
    child.kill("SIGKILL");
  }, timeoutMs);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => (err += c));

  const exit = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? -1));
  }).then((code) => {
    clearTimeout(timer);
    return code;
  });
  await fake.stop();

  // pi can emit trailing non-JSON shutdown noise; keep only parseable lines.
  // SAFETY: only lines that JSON.parse accepts are kept, so every event here
  // is a parsed JSON object from pi's stdout — exactly the RpcEvent domain.
  const events: RpcEvent[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      // SAFETY: pi's RPC stdout is one JSON object per line; the parsed value
      // matching RpcEvent is verified by the helpers' own field checks.
      events.push(parsed as RpcEvent);
    } catch {
      // ignore non-JSON tail
    }
  }
  stderr = err;
  if (exit !== 0 && events.length === 0) {
    throw new Error(`pi exited ${exit} with no events\n${stderr}`);
  }
  return { events, stderr };
}

/**
 * One parsed line of pi's RPC JSONL stream, narrowed to the shapes the tests
 * read. Unknown fields stay on the parsed object; only what the helpers touch
 * is declared here.
 */
export interface RpcEvent {
  type?: string;
  message?: {
    role?: string;
    toolName?: string;
    content?: { type?: string; text?: string }[];
  };
}

/** Assistant `message_end` events, in order. */
export function assistantEnds(events: RpcEvent[]): RpcEvent[] {
  return events.filter((e) => e.type === "message_end" && e.message?.role === "assistant");
}

/** `toolResult` `message_end` events, in order. */
export function toolResultEnds(events: RpcEvent[]): RpcEvent[] {
  return events.filter((e) => e.type === "message_end" && e.message?.role === "toolResult");
}

/** Flatten all text of a toolResult message into one string. */
export function resultText(event: RpcEvent): string {
  const content = event.message?.content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}
