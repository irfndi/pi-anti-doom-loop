import type { ToolInput } from "../extensions/detector.ts";

/** One tool call in a fixture transcript, with JSON tool args. */
export interface FixtureCall {
  tool: string;
  args: ToolInput;
}

/** A named fixture transcript of repeated tool calls. */
export interface CallFixture {
  name: string;
  calls: FixtureCall[];
}

/**
 * Real-world doom-loop captures (fixtures).
 *
 * These are verbatim snippets from actual agent sessions that looped:
 *  - the NeuraTrade CI mystery: the agent repeated "Let me fetch the merge
 *    ref:" verbatim dozens of times and re-ran the same `gh run view` /
 *    `grep` commands, never making progress
 *  - the wallet-equity refactor: the agent re-emitted "Now update buildProgram
 *    and add a shared wallet-equity reader. Let me make the edits:" forever
 *  - the original "grep the same file 10 times" no-progress pattern
 */

export const textLoop = {
  name: "NeuraTrade CI mystery — verbatim 'Let me fetch the merge ref'",
  messages: [
    "Let me fetch the merge ref:",
    "Let me fetch the merge ref:",
    "Let me fetch the merge ref:",
    "Let me fetch the merge ref:",
    "Let me fetch the merge ref:",
  ],
};

export const textLoopBuildProgram = {
  name: "wallet-equity refactor — verbatim 'Now update buildProgram'",
  messages: [
    "Now update buildProgram and add a shared wallet-equity reader. Let me make the edits:",
    "Now update buildProgram and add a shared wallet-equity reader. Let me make the edits:",
    "Now update buildProgram and add a shared wallet-equity reader. Let me make the edits:",
    "Now update buildProgram and add a shared wallet-equity reader. Let me make the edits:",
  ],
};

/**
 * same sentence, so consecutive messages differ (verbatim streak never
 * forms) and the repeated tool args vary (identical-call check misses).
 * The signal is the sentence repeating WITHIN one message.
 */
export const growingTextLoop = {
  name: "production restart — growing self-concatenation 'Let me view the failing test context'",
  messages: [
    "Let me view the failing test context in the CI log:",
    "Let me view the failing test context in the CI log:Let me view the failing test context in the CI log:",
    "Let me view the failing test context in the CI log:Let me view the failing test context in the CI log:Let me view the failing test context in the CI log:",
    "Let me view the failing test context in the CI log:Let me view the failing test context in the CI log:Let me view the failing test context in the CI log:Let me view the failing test context in the CI log:",
  ],
};

/** Same loop but with whitespace/punctuation drift between repeats. */
export const growingTextLoopSpaced = {
  name: "growing loop with spacing drift",
  messages: [
    "Let me view the failing test context in the CI log:",
    "Let me view the failing test context in the CI log: Let me view the failing test context in the CI log:",
    "Let me view the failing test context in the CI log: Let me view the failing test context in the CI log: Let me view the failing test context in the CI log:",
  ],
};

/**
 * Live capture from a pi session: the model repeated a regex pattern 3+ times
 * inside one message while searching; the within-message signal fired and the
 * steer message broke the loop.
 */
export const regexRepeatLoop = {
  name: "regex pattern repeated inside one message (live capture)",
  messages: [
    'Let me search for parameter\\s+(\\S+)\\s+(" in the test file.',
    "Searching for the pattern now.",
    'parameter\\s+(\\S+)\\s+(": parameter\\s+(\\S+)\\s+(": parameter\\s+(\\S+)\\s+("',
  ],
};

/** Repeated identical tool calls from the CI-log investigation. */
export const toolLoopGhRunView: CallFixture = {
  name: "repeated identical `gh run view --log` calls",
  calls: [
    { tool: "bash", args: { command: "gh run view 30995002816 --log > /tmp/run30995002816.log" } },
    { tool: "bash", args: { command: "gh run view 30995002816 --log > /tmp/run30995002816.log" } },
    { tool: "bash", args: { command: "gh run view 30995002816 --log > /tmp/run30995002816.log" } },
    { tool: "bash", args: { command: "gh run view 30995002816 --log > /tmp/run30995002816.log" } },
    { tool: "bash", args: { command: "gh run view 30995002816 --log > /tmp/run30995002816.log" } },
  ],
};

export const toolLoopGrepSameFile: CallFixture = {
  name: "repeated identical `grep` on the same file",
  calls: [
    { tool: "grep", args: { pattern: "legacy schema", path: "real-money-readiness.test.ts" } },
    { tool: "grep", args: { pattern: "legacy schema", path: "real-money-readiness.test.ts" } },
    { tool: "grep", args: { pattern: "legacy schema", path: "real-money-readiness.test.ts" } },
    { tool: "grep", args: { pattern: "legacy schema", path: "real-money-readiness.test.ts" } },
  ],
};

/** A healthy session: varied reads + edits with progress — must NOT flag. */
export const healthySession: CallFixture = {
  name: "healthy multi-step session (no loop)",
  calls: [
    { tool: "read", args: { path: "src/a.ts" } },
    { tool: "grep", args: { pattern: "buildProgram", path: "src/" } },
    { tool: "read", args: { path: "src/b.ts" } },
    { tool: "edit", args: { path: "src/a.ts" } },
    { tool: "read", args: { path: "src/b.ts" } },
    { tool: "bash", args: { command: "npm test" } },
    { tool: "read", args: { path: "src/a.ts" } },
    { tool: "write", args: { path: "src/c.ts" } },
  ],
};

// --- codemode (pi ≥ 0.99): nested calls inside ONE script -------------------

/** One nested tool call made by a codemode script (`parentToolCallId` set). */
export interface NestedFixtureEvent {
  /** Tool call id of the parent codemode call (pi formats children as `<parent>/<n>`). */
  parent: string;
  id: string;
  tool: string;
  args: ToolInput;
  isError?: boolean;
}

/** A named transcript of nested codemode traffic. */
export interface NestedFixture {
  name: string;
  /** The script source (documentation of what the nested events came from). */
  script: string;
  events: NestedFixtureEvent[];
}

/**
 * The codemode doom loop this extension exists to catch: a script polling the
 * same file in a loop. Per-call detection never sees it as a streak — every
 * nested call is part of ONE top-level tool call.
 */
export const codemodeNestedLoop: NestedFixture = {
  name: "codemode script polls the same file 5× inside one script",
  script:
    'for (let i = 0; i < 5; i++) { await tools.read({ path: "src/config.json" }); } return "done";',
  events: Array.from({ length: 5 }, (_, i) => ({
    parent: "cm1",
    id: `cm1/${i + 1}`,
    tool: "read",
    args: { path: "src/config.json" },
  })),
};

/**
 * A script that retries an identical call after it errored — the in-script
 * error-retry rule must block the retry immediately.
 */
export const codemodeErrorRetryLoop: NestedFixture = {
  name: "codemode script retries an identical call after it errored",
  script:
    'try { await tools.bash({ command: "npm test" }); } catch {} await tools.bash({ command: "npm test" }); return "retried";',
  events: [
    { parent: "cm1", id: "cm1/1", tool: "bash", args: { command: "npm test" }, isError: true },
    { parent: "cm1", id: "cm1/2", tool: "bash", args: { command: "npm test" } },
  ],
};

/**
 * Two scripts re-issuing the same signature in one prompt: the second block
 * must escalate (the model ignored the first script's error).
 */
export const codemodeCrossScriptRepeat: NestedFixture = {
  name: "two codemode scripts repeat the same signature across scripts",
  script:
    'await tools.read({ path: "src/config.json" }); await tools.read({ path: "src/config.json" });',
  events: [
    { parent: "cm1", id: "cm1/1", tool: "read", args: { path: "src/config.json" } },
    { parent: "cm1", id: "cm1/2", tool: "read", args: { path: "src/config.json" } },
    { parent: "cm2", id: "cm2/1", tool: "read", args: { path: "src/config.json" } },
    { parent: "cm2", id: "cm2/2", tool: "read", args: { path: "src/config.json" } },
  ],
};

/**
 * The pattern codemode's own docs recommend — batch DISTINCT calls with
 * Promise.allSettled in ONE script. Must never block.
 */
export const codemodeHealthyBatch: NestedFixture = {
  name: "codemode batches distinct reads with Promise.allSettled (recommended pattern)",
  script:
    'await Promise.allSettled([tools.read({ path: "src/a.ts" }), tools.read({ path: "src/b.ts" }), tools.grep({ pattern: "TODO", path: "src/" })]); return "ok";',
  events: [
    { parent: "cm1", id: "cm1/1", tool: "read", args: { path: "src/a.ts" } },
    { parent: "cm1", id: "cm1/2", tool: "read", args: { path: "src/b.ts" } },
    { parent: "cm1", id: "cm1/3", tool: "grep", args: { pattern: "TODO", path: "src/" } },
  ],
};

/** One curl probe of a path on the dev box, exactly as the incident ran it. */
const probe = (path: string) =>
  `rtk curl -sk -o /dev/null -m 20 -w '%{http_code}' --resolve dev.aplg-learning.com:443:43.128.218.65 "https://dev.aplg-learning.com${path}"`;

/** The nine paths from the incident: one command, nine different targets. */
export const PROBED_PATHS = [
  "/",
  "/login",
  "/news",
  "/knowledge",
  "/event",
  "/functions/learning",
  "/v1/course-list",
  "/v1/topic-list",
  "/api/health",
];

/**
 * A loop over TARGETS, not over a call: one curl probed against nine paths
 * inside one script. Nothing is repeated — the incident that showed a
 * shared-token score cannot tell this from a wrapped re-issue of one command.
 */
export const codemodeMultiTargetProbe: NestedFixture = {
  name: "codemode script probes 9 distinct paths with one curl",
  script:
    'const paths = ["/", "/login", "/news", "/knowledge", "/event", "/functions/learning", "/v1/course-list", "/v1/topic-list", "/api/health"];\nfor (const p of paths) { await tools.bash({ command: probe(p) }); }',
  events: PROBED_PATHS.map((path, i) => ({
    parent: "cm1",
    id: `cm1/${i + 1}`,
    tool: "bash",
    args: { command: probe(path) },
  })),
};

const POLL = "gh run list --branch main --limit 3 2>&1 | head -6";

/**
 * Wrapper drift INSIDE one script: the same poll re-issued with a different
 * wrapper. The two commands differ from each other, yet both are the one poll —
 * an in-script repeat, which the nested 2× rule must catch.
 */
export const codemodeWrapperPollLoop: NestedFixture = {
  name: "codemode script re-issues one poll behind a sleep wrapper",
  script: `await tools.bash({ command: ${JSON.stringify(POLL)} });\nawait tools.bash({ command: "sleep 150; " + ${JSON.stringify(POLL)} });`,
  events: [
    { parent: "cm1", id: "cm1/1", tool: "bash", args: { command: POLL } },
    { parent: "cm1", id: "cm1/2", tool: "bash", args: { command: `sleep 150; ${POLL}` } },
  ],
};

/** Top-level version of the same sweep: nine distinct probes, no repeat. */
export const topLevelMultiTargetProbe: CallFixture = {
  name: "nine distinct curl probes at top level (one command, nine targets)",
  calls: PROBED_PATHS.map((path) => ({ tool: "bash", args: { command: probe(path) } })),
};

/** Top-level wrapper drift: one poll, re-issued behind sleep/timeout wrappers. */
export const topLevelWrapperPollLoop: CallFixture = {
  name: "one poll re-issued behind sleep and timeout wrappers",
  calls: [
    { tool: "bash", args: { command: POLL } },
    { tool: "bash", args: { command: `sleep 150; ${POLL}` } },
    { tool: "bash", args: { command: `timeout 30; ${POLL}` } },
  ],
};
