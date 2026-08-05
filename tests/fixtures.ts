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
export const toolLoopGhRunView = {
  name: "repeated identical `gh run view --log` calls",
  calls: [
    { tool: "bash", args: { command: "gh run view 30995002816 --log > /tmp/run30995002816.log" } },
    { tool: "bash", args: { command: "gh run view 30995002816 --log > /tmp/run30995002816.log" } },
    { tool: "bash", args: { command: "gh run view 30995002816 --log > /tmp/run30995002816.log" } },
    { tool: "bash", args: { command: "gh run view 30995002816 --log > /tmp/run30995002816.log" } },
    { tool: "bash", args: { command: "gh run view 30995002816 --log > /tmp/run30995002816.log" } },
  ],
};

export const toolLoopGrepSameFile = {
  name: "repeated identical `grep` on the same file",
  calls: [
    { tool: "grep", args: { pattern: "legacy schema", path: "real-money-readiness.test.ts" } },
    { tool: "grep", args: { pattern: "legacy schema", path: "real-money-readiness.test.ts" } },
    { tool: "grep", args: { pattern: "legacy schema", path: "real-money-readiness.test.ts" } },
    { tool: "grep", args: { pattern: "legacy schema", path: "real-money-readiness.test.ts" } },
  ],
};

/** A healthy session: varied reads + edits with progress — must NOT flag. */
export const healthySession = {
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
