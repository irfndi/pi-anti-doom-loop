# State machines

Every machine this package runs, with its states, the invariants the code
depends on, and the transitions it allows. Each machine also lists the invalid
states the code could reach before the fix, and the issue that fixed it.

Code is the source of truth: `extensions/detector.ts` (pure detection),
`extensions/controller.ts` (event logic), `extensions/index.ts` (pi adapter),
`scripts/guard-publish.ts` (release gate).

| #   | Machine                        | Lives in                   |
| --- | ------------------------------ | -------------------------- |
| M1  | Prompt window                  | detector + controller      |
| M2  | Signature block / escalation   | detector                   |
| M3  | Acknowledgement (`loop_ack`)   | detector + controller      |
| M4  | Failure streak                 | detector                   |
| M5  | Assistant-text ladder          | detector + controller      |
| M6  | Nested codemode script windows | detector + controller      |
| M7  | Guard enablement               | index + detector           |
| M8  | Release gate                   | `scripts/guard-publish.ts` |

---

## M1 — Prompt window

One user prompt is the unit of memory. Everything the detector holds is scoped
to it, except the controller's session counters.

**States:** `EMPTY` → `ACCUMULATING` → `FULL` (oldest entries evicted) → `EMPTY`
on a reset.

| Held by `LoopDetector`                       | Meaning                              |
| -------------------------------------------- | ------------------------------------ |
| `recentSigs`, `recentResults`                | window of allowed calls and results  |
| `recentTexts`, `lastText`, `textStreak`      | window of assistant texts            |
| `lastBlockedSig`, `acksByTool`               | per-prompt block bookkeeping (M2–M4) |
| `nestedSigs`, `nestedIds`, `nestedErrorSigs` | per-script windows (M6)              |
| `lastBlock`                                  | the block `loop_ack` acts on (M3)    |

Session state, kept across resets: `steered`, `steerAgain`, `resumes`, `steers`,
`aborts`, `suspended`.

| From / any     | Event                              | To             | Side effects                              |
| -------------- | ---------------------------------- | -------------- | ----------------------------------------- |
| any            | user `message_end` (`role:"user"`) | `EMPTY`        | window cleared; session counters kept     |
| any            | `session_start`                    | `EMPTY`        | new controller: counters and budget reset |
| any            | `/loopcheck reset`                 | `EMPTY`        | window cleared; session counters kept     |
| `EMPTY`        | allowed tool call (`record`)       | `ACCUMULATING` | entry appended, oldest evicted            |
| `ACCUMULATING` | result (`recordResult`)            | `ACCUMULATING` | result appended                           |

**Invariants**

- I1.1 Every window length stays `<= windowSize` (`evictSigs`, `evictResults`,
  `evictTexts`).
- I1.2 Only _allowed_ calls enter `recentSigs`; a blocked call never does, so a
  blocked retry cannot inflate the count it already tripped.
- I1.3 A blocked call's synthesized error result never enters `recentResults`.
- I1.4 Nested traffic never enters the top-level window and vice versa (M6).
- I1.5 `windowSize >= max(repeatThreshold-1, failThreshold, failRateMinCalls,
  textRepeatThreshold-1)`, so no configured signal is unreachable.

**Reached invalid states:** ISS-2 (a prompt reset replaced the whole controller,
discarding the session resume budget), ISS-3 (results of a suspended window were
still recorded), ISS-8 (a short window silently disabled a signal).

---

## M2 — Signature block and escalation

One block is a warning; re-issuing a blocked signature aborts the turn.

**States:** `CLEAN` → `BLOCKED(sig)` → `ESCALATED(sig)`.

| From           | Event                                               | To          | `escalate` | Adapter       |
| -------------- | --------------------------------------------------- | ----------- | ---------- | ------------- |
| `CLEAN`        | `repeatThreshold` identical or near-identical calls | `BLOCKED`   | `false`    | block         |
| `BLOCKED(sig)` | same `sig` re-issued                                | `ESCALATED` | `true`     | block + abort |
| `BLOCKED(sig)` | `loop_ack` on that block                            | `CLEAN`     | —          | —             |
| `BLOCKED(sig)` | `sig` evicted from the window                       | `CLEAN`     | —          | —             |

**Invariants**

- I2.1 Escalation is per signature, never per tool.
- I2.2 A block is overridable only when no failure reason fired and the tool's
  failure streak is empty; a failing repeat is a blind retry.
- I2.3 Escalation state never outlives the window entry that justified it: the
  check is `lastBlockedSig === sig` **and** `sig` still in the window.

**Reached invalid state:** ISS-7 — a per-signature counter was never pruned, so
a second, unrelated loop of the same command later in the prompt escalated on its
**first** block and aborted a healthy turn.

---

## M3 — Acknowledgement (`loop_ack`)

**States:** `NOTHING` → `PENDING(block)` → `NOTHING`.

| Field                    | Meaning                                                |
| ------------------------ | ------------------------------------------------------ |
| `lastBlock.sig/toolName` | the blocked call, and the tool named back to the agent |
| `lastBlock.overridable`  | `false` when any failure reason fired                  |
| `acksByTool[tool]`       | acks spent on that tool this prompt (`ACK_LIMIT = 2`)  |

| From      | Event                                 | To        | Result                                    |
| --------- | ------------------------------------- | --------- | ----------------------------------------- |
| `NOTHING` | tool block (top level)                | `PENDING` | reason names `loop_ack` if overridable    |
| any       | tool block (nested, M6)               | `NOTHING` | a nested block supersedes the pending one |
| `PENDING` | `loop_ack`, overridable, credit left  | `NOTHING` | tool's window entries dropped, credit +1  |
| `PENDING` | `loop_ack`, not overridable           | `PENDING` | refused: fix the failure                  |
| `PENDING` | `loop_ack`, `acksByTool >= ACK_LIMIT` | `PENDING` | refused: change the approach              |

**Invariants**

- I3.1 An ack clears the whole **tool's** window entries, not just the blocked
  signature: a near-identical block leaves its cluster behind and would re-block
  the acknowledged retry.
- I3.2 Credits are per tool, not per signature, or a loop that changes one flag
  gets a fresh allowance on every retry.
- I3.3 A failure block is never acknowledgeable.
- I3.4 A block is consumed by the ack that acts on it, so one block can never
  spend two credits (ISS-4).

**Reached invalid state:** ISS-4 — `lastBlock` was never consumed, so the same
block accepted two acks, and a nested block left the previous top-level block
ackable.

---

## M4 — Failure streak

**States per tool:** `HEALTHY` (trailing error run 0) → `STREAK(n)` → `BLOCKED`
(the block consumes the run) → `HEALTHY` or `STREAK` again. The whole state is
the trailing error run in `recentResults`.

| From     | Event                      | To        | Notes                              |
| -------- | -------------------------- | --------- | ---------------------------------- |
| `STREAK` | error result, same tool    | `STREAK`  | count + 1                          |
| `STREAK` | call at `>= failThreshold` | `HEALTHY` | block; that tool's run is consumed |
| any      | success result, same tool  | `HEALTHY` | clears the trailing errors         |
| any      | different tool's result    | unchanged | streaks are per tool               |
| any      | prompt reset               | `HEALTHY` | cleared with the window            |

**Invariants**

- I4.1 A blocked call never runs, so its result must not extend the streak.
- I4.2 The failure state must have a release path: a blocked call cannot produce
  the success that would clear the streak, so the block itself consumes the
  evidence (ISS-1). The cost: the guard cannot tell the fix from a retry, so a
  model that keeps failing re-earns the streak every `failThreshold` calls.
- I4.3 `failRateThreshold` is a separate opt-in signal over the same window and
  is consumed by the same failure block.

**Reached invalid state:** ISS-1 — the streak was a latch. After three failures
**every** later call to that tool was blocked for the rest of the prompt,
including a genuinely different, healthy command, and no result could ever clear
it. Reproduced against real pi 0.99.2: three `exit N` failures, then
`echo recovered` and `ls /tmp` both blocked.

---

## M5 — Assistant-text ladder

Text-only loops never reach `tool_call`; they are handled at `message_end`.

**States:** `IDLE` → `STEERED` → `ABORTED`.

| From      | Event                                       | To        | Adapter                              |
| --------- | ------------------------------------------- | --------- | ------------------------------------ |
| `IDLE`    | text signal (verbatim, near, in-message)    | `STEERED` | steer injected                       |
| `STEERED` | another detection, resume budget left       | `ABORTED` | abort + one `followUp` resume        |
| `ABORTED` | another detection, budget spent             | `ABORTED` | abort, no resume                     |
| any       | duplicate tool calls batched in one message | unchanged | abort (steering cannot retract them) |
| any       | prompt reset                                | `IDLE`    | `steered` cleared; budget kept       |

**Invariants**

- I5.1 The resume budget is session-scoped: a prompt reset must not restore it
  (ISS-2); only a new session does.
- I5.2 The duplicate-batch abort is an abort and must be counted as one (ISS-9).
- I5.3 A nested-codemode steer is its own one-shot and must not be starved by an
  earlier text steer (ISS-5).

**Reached invalid states:** ISS-2 (prompt reset restored the budget), ISS-5
(`steerAgain && !steered` hid a swallowed codemode block once the text ladder had
steered), ISS-9 (the batch abort returned before touching `aborts`).

---

## M6 — Nested codemode script windows

A codemode script's tool calls carry `parentToolCallId`. Inside one script a
repeat is never progress, so the threshold is 2×, not 3×.

**States per parent:** `LIVE(window)` → `DONE` (parent result arrived, window
dropped) → `GONE` (parent cap evicted it first).

| Field                     | Scope      | Meaning                                           |
| ------------------------- | ---------- | ------------------------------------------------- |
| `nestedSigs[parent]`      | per script | last `NESTED_POOL_LIMIT` allowed calls            |
| `nestedIds[id]`           | per call   | in-flight call → signature, to wire results back  |
| `nestedErrorSigs[parent]` | per script | signatures that already errored in this script    |
| `nestedBlockedBySig[sig]` | per prompt | blocks per signature, across scripts (escalation) |
| `steerAgain`              | per prompt | a nested block still owes the model a steer       |

| From   | Event                                   | To     | Notes                              |
| ------ | --------------------------------------- | ------ | ---------------------------------- |
| —      | first nested call of a script           | `LIVE` | window created                     |
| `LIVE` | identical/near-identical call (2×)      | `LIVE` | block; reason goes to the script   |
| `LIVE` | identical call after an error in-script | `LIVE` | block immediately                  |
| `LIVE` | parent `tool_result`                    | `DONE` | window + error set dropped (ISS-6) |
| `LIVE` | more than `NESTED_PARENT_LIMIT` live    | `GONE` | oldest live parent evicted (ISS-6) |
| any    | prompt reset                            | `GONE` | all windows cleared                |

**Invariants**

- I6.1 A script's window dies with the script; forgetting it must never lose a
  signature that later escalates — escalation is keyed by signature, not parent.
- I6.2 Memory is bounded in three dimensions: `NESTED_ARG_STORAGE_LIMIT` (4 KB)
  per call, `NESTED_POOL_LIMIT` (100) calls per window, `NESTED_PARENT_LIMIT` (8)
  live windows.
- I6.3 A nested block never leaves the top-level `lastBlock` ackable.

**Reached invalid state:** ISS-6 — windows were never dropped when a script
finished and the parent count was unbounded: 200 scripts × 20 calls × 90 KB args
held **833 MB** of RSS in one prompt. Capping the stored args at 4 KB is what
makes the per-window and per-parent caps enough; identity only has to match a
neighbouring call.

---

## M7 — Guard enablement

**States:** `ON`, `OFF_SETTINGS`, `OFF_ENV`, `SUSPENDED`.

| State          | Entered by                                         | Leaves on                     |
| -------------- | -------------------------------------------------- | ----------------------------- |
| `ON`           | default; missing or malformed setting              | any off switch                |
| `OFF_SETTINGS` | `antiDoomLoop.enabled === false` (merged settings) | settings edit + next prompt   |
| `OFF_ENV`      | `PI_ANTI_LOOP_DISABLE=1`                           | env change, checked per event |
| `SUSPENDED`    | `/loopcheck suspend`                               | prompt reset, `/resume`       |

**Invariants**

- I7.1 Only an explicit `false` disables via settings; a typo must not.
- I7.2 While off, neither half of a call/result pair is recorded, so the off
  period cannot seed a streak that fires when detection returns (ISS-3).

**Reached invalid state:** ISS-3 — `onToolCall` returned early while suspended but
`onToolResult` still recorded, so off-period failures blocked the first fresh call
after `/loopcheck resume`.

**Accepted limit:** the env/settings switches bypass the whole handler, so a call
blocked just before the switch keeps its id in `blockedIds` until the next prompt
reset. Ids are unique, so the residue is bounded by one prompt's blocks.

---

## M8 — Release gate

`scripts/guard-publish.ts` guards `npm publish` over three inputs: local version
`L`, expected version `E` (tag or dispatch input, `""` when absent), and the
latest published version `P` (`null` when the registry is unreachable).

**States:** `CHECKING` → `PUBLISHABLE` → `PUBLISHED`, or `REJECTED`.

| `L`         | `E`             | `P`         | Outcome                         |
| ----------- | --------------- | ----------- | ------------------------------- |
| not `X.Y.Z` | any             | any         | `REJECTED` (not semver)         |
| valid       | `E !== L`       | any         | `REJECTED` (tag/manifest drift) |
| valid       | `E === L` or "" | `P === L`   | `REJECTED` (already published)  |
| valid       | `E === L`       | tag missing | `REJECTED` (untagged release)   |
| valid       | `E === L` or "" | `P !== L`   | `PUBLISHABLE`                   |

**Invariants**

- I8.1 Check-then-act is serialised: the `release-<ref>` concurrency group
  (`cancel-in-progress: false`) queues two releases of the same ref.
- I8.2 A registry failure is a warning, never a pass or a fail.
- I8.3 `E === ""` skips the tag check, because a dispatch pushes no tag.

**Known gap (open, policy):** with `E === ""` nothing ties the publish to a git
tag, so "tags and manifests stay in sync" holds only for tag pushes. ISS-10.

---

## Issue index

Impact: **critical** = the guard bricks normal work; **high** = it silently stops
working; **medium** = wrong block, wrong ack, or unbounded growth; **low** =
reporting inaccuracy.

| Issue  | Machine | Impact   | Summary                                                    | Status                |
| ------ | ------- | -------- | ---------------------------------------------------------- | --------------------- |
| ISS-1  | M4      | critical | A failure block latched the tool for the whole prompt      | fixed                 |
| ISS-2  | M1, M5  | high     | Prompt reset restored the auto-resume budget               | fixed                 |
| ISS-3  | M7      | high     | Suspension recorded results, blocking the next fresh call  | fixed                 |
| ISS-4  | M3      | medium   | One block acked twice; a nested block left a stale ackable | fixed                 |
| ISS-5  | M5, M6  | medium   | A text steer starved the nested-codemode steer             | fixed                 |
| ISS-6  | M6      | medium   | Finished script windows were never dropped (833 MB)        | fixed                 |
| ISS-7  | M2      | medium   | Stale escalation aborted a healthy turn on a first block   | fixed                 |
| ISS-8  | M1      | medium   | A short `PI_ANTI_LOOP_WINDOW` silently disabled signals    | fixed                 |
| ISS-9  | M5      | low      | The duplicate-batch abort was not counted                  | fixed                 |
| ISS-10 | M8      | low      | A dispatch with no version can publish an untagged commit  | open (policy, see M8) |

Regression tests: `tests/unit.test.ts`, `tests/integration.test.ts`,
`tests/e2e/pi.test.ts` (real pi 0.99.2 subprocess).

A change to detection code changes one of these machines: update its states, its
transitions, and this index in the same commit. The file ships in the tarball
(`package.json` `files`) and `tests/e2e.test.ts` asserts it does.
