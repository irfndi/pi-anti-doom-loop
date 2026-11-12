# pi-anti-doom-loop

Stop agent doom loops in [pi](https://pi.dev/) before they burn tokens.

Cheap models sometimes get stuck repeating the same cheap tool call — `grep`
the same file, re-run the same failing command — with no progress. Each
iteration is so cheap nobody notices until the bill mounts. This extension
watches every tool call and blocks the loop at the source.

## Install

```bash
pi install npm:pi-anti-doom-loop
```

## What it detects

| Signal                                                  | Default                       | Blocked when                                                                                                                                         |
| ------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same `(tool, args)` repeated                            | 3× in the last 10 calls       | The pattern has repeated `3` times with no change                                                                                                    |
| Same tool failing consecutively                         | 3×                            | A tool errored `3` times in a row — stop retrying it blindly. The next call is allowed through                                                       |
| Same assistant text verbatim                            | 3× within the last N messages | The model re-emitted identical text `3` times inside the sliding window                                                                              |
| Same sentence inside ONE message                        | 3×                            | A sentence repeats `3`+ times within a single message (growing self-concatenation loops)                                                             |
| Near-identical text (rephrasing)                        | 3× in a row                   | Consecutive messages share ≥55% tokens — the model is rephrasing the same step                                                                       |
| Near-identical text cycle (rotating rephrased commands) | 3× within the last N messages | Near-identical assistant texts (≥55% token similarity) accumulate to the repeat threshold in the window, even when not identical and not consecutive |

Blocks hand the model an instructive reason ("change your approach, use a
different tool, or ask the user"). If the model ignores the block and re-issues
the exact same call, the turn is **aborted**.

### Escalation (text loops): steer → abort → bounded resume

The first text-loop detection **steers** the agent mid-run (injects guidance,
lets it continue). If it persists, the run is **aborted** and **one** fresh-
resume directive is queued so work continues with a new approach. If it still
loops after that, the run aborts for real and control returns to you — the
auto-resume budget is capped per **session** (a new prompt does not restore it)
so a truly stuck model can't cycle forever. Detection counters reset on every
user prompt, so a task legitimately repeated later in the same session is never
a false positive.

Every state machine behind this behaviour — states, invariants, and the
transitions the code allows — is documented in
[`docs/state-machines.md`](docs/state-machines.md).

## Configuration

Environment variables, read at session/prompt start:

| Variable                     | Default | Meaning                                                                                                                                            |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_ANTI_LOOP_REPEATS`       | `3`     | Identical-call block threshold                                                                                                                     |
| `PI_ANTI_LOOP_FAILS`         | `3`     | Consecutive-failure block threshold                                                                                                                |
| `PI_ANTI_LOOP_TEXT_REPEATS`  | `3`     | Window/cycle repeat threshold for identical and near-identical assistant texts                                                                     |
| `PI_ANTI_LOOP_WINDOW`        | `10`    | How many recent calls/results are inspected (raised if a threshold needs more)                                                                     |
| `PI_ANTI_LOOP_TIME_WINDOW`   | `0`     | Elapsed-time window in ms (`0` = disabled, count-only): evicts window entries older than this so slow chronic loops over a long session are caught |
| `PI_ANTI_LOOP_FAIL_RATE`     | `0`     | Fail-rate block threshold `0..1` (`0` = disabled): block when a tool's error share of its in-window calls reaches this                             |
| `PI_ANTI_LOOP_FAIL_RATE_MIN` | `3`     | Minimum calls before the fail-rate window can block                                                                                                |
| `PI_ANTI_LOOP_TOOLS_EXCLUDE` | —       | Comma-separated tool names to disable detection for entirely (never block, never enter the window — applies to nested codemode calls too)          |
| `PI_ANTI_LOOP_DISABLE`       | —       | Set to `1` to disable the extension entirely; read per prompt, not only at load                                                                    |

## When the agent needs to repeat anyway

Some repeats are correct. Polling a job, waiting on a deploy to go green, or
re-running one flaky step all mean calling the same thing again — and the reason
lives in the agent's head, not in the arguments. Blocking those just forces a
workaround.

So a repeat block is **overridable by the agent itself**, through a `loop_ack`
tool registered by this extension:

1. A repeat block names it, in the block reason: _"If this repeat is
   intentional … call loop_ack and say why."_
2. The agent calls `loop_ack` with the reason.
3. The call it just got blocked on is cleared from the window — and so is the
   whole near-identical cluster behind the block, so a retry whose args drifted
   (the `head`, a `sleep` wrapper) is not instantly re-blocked — and the retry
   runs.

It acts on the **last block**, so the agent never re-sends the arguments — the
detector already has them.

It is deliberately narrow:

- **Only repeat blocks.** A block caused by repeated **failures** cannot be
  acknowledged. There the evidence is already in the transcript, and waving it
  through would remove the guard that stops blind retries.
- **Not a repeat that is also failing.** If the tool has failed since its last
  success, the block is a blind retry, and the hint is not offered at all.
  An acknowledgement never erases failure evidence, so a command that starts
  failing re-blocks.
- **Bounded per tool.** One tool can be acknowledged twice per prompt, not
  more — otherwise "ack, retry, blocked, ack" becomes the loop it was meant to
  allow. Scoped to the tool rather than the exact call, because a drifting loop
  changes its arguments on every retry and would otherwise get a fresh
  allowance each time.
- **Reset with everything else** on the next user prompt.

Prefer this over the disable switches when only one call is in question.

## Turning it off

Loosest to strictest — pick the scope you need:

| Scope                        | How                                                                   | Effect                                          |
| ---------------------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| One blocked repeat           | the agent calls `loop_ack` with a reason (see above)                  | that signature is cleared and the retry allowed |
| This session                 | `/loopcheck suspend`                                                  | off until the next prompt                       |
| Global                       | `"antiDoomLoop": { "enabled": false }` in `~/.pi/agent/settings.json` | off in every project                            |
| This project                 | `"antiDoomLoop": { "enabled": false }` in `<repo>/.pi/settings.json`  | off in this project only; needs project trust   |
| Everywhere, incl. automation | `PI_ANTI_LOOP_DISABLE=1`                                              | off, for CI and scripts                         |

Pi deep-merges the two `settings.json` files with the project winning per key,
so a project can disable what global enables (and vice versa) without either
file repeating the other. Only an explicit `false` disables: a missing key, a
malformed value, or a non-boolean leaves detection on, because a typo must
never silently turn off loop detection. The project scope only applies to a
trusted project — pi does not read `.pi/settings.json` otherwise.

Edit either file during a session and the change lands on the next prompt; no
restart needed.

## Command

- `/loopcheck` — show thresholds, counters (steers/aborts this session), suspend state, the current window contents (most-repeated recent calls and texts), repeated-argument token count, and the fail-rate/time-window/exclude config when enabled
- `/loopcheck reset` — clear counters
- `/loopcheck suspend` — pause detection until the next prompt (escape hatch for intentional repetition)
- `/loopcheck resume` — re-enable detection early

### Codemode (pi ≥ 0.99): nested script calls

pi's `codemode` tool lets the model run a JavaScript script that calls other
tools via `tools.<name>(args)` — a script can loop hundreds of calls inside
ONE top-level tool call, which per-call detection never sees as a streak.
Since pi 0.99, those nested calls still flow through the `tool_call`/
`tool_result` events tagged with `parentToolCallId` — and this extension
tracks them:

- **Stricter in-script threshold** — inside one script, the 2nd identical
  call blocks (top-level detection needs 3). A repeated call inside a script
  is never progress: the script can store its first result in a variable and
  reuse it. Wrapper drift (a `sleep`/`timeout` prefix, an extra `| tail`) on
  a repeated command counts too; a loop over different targets does not.
- **Error-retry rule** — an identical retry of a call that already errored
  inside the same script blocks immediately with a "the identical call
  already failed inside this script" reason.
- **Script-level isolation** — nested traffic never enters the top-level
  window and vice versa, so script loops cannot hide from their own 2× rule
  and legitimate top-level repetition is never inflated by scripts.
- **The information wall** — a nested block reason reaches the _script_ as a
  tool error, not the model (only the script's return value does). When a
  script swallows it anyway, the next assistant message gets a one-shot steer
  telling the model to call each tool once and reuse results — so the loop
  signal can never be silently eaten by a script that ignores tool errors.
- **Cross-script escalation** — counters are per-script (a new script starts
  clean), but re-issuing a signature blocked in an earlier script this prompt
  escalates and aborts the turn, mirroring top-level block-escalation.

Huge nested payloads (whole-file reads) are identity-capped (100 KB per call)
and each script keeps only its most recent 100 calls, so memory stays bounded. `/loopcheck` reports `nested: calls=N blocks=M`.

**Wrapper drift, not token overlap.** A near-identical call is the same
`command` with at most three tokens added or removed: `gh run list …` re-issued
as `sleep 150; gh run list …`, or with `| tail -3` appended. Entries are
compared as a connected group, so `poll`, `timeout 30; poll` and
`sleep 150; poll` are three occurrences of one call even though the wrappers
differ from each other.

A shared-token score cannot make this call: on a 13-token curl probe, changing
one URL operand still scores 0.85, sitting right next to a genuinely wrapped
poll at 0.72. Scoring flagged the second probe of a nine-URL status sweep — a
loop over _targets_, which is what a codemode script is for. Containment asks
the question that matters: is this the same call with cosmetic padding?

**Scripts are exempt from the near-identical rule entirely.** Two _different_
scripts share JS boilerplate (`const`, `await`, `tools`, `return`); sequential
one-off scripts checking different hypotheses are normal exploration, not a
loop. They are compared by exact identity only (the same script re-issued still
blocks), while their real loop shape — repeated calls _inside_ one script — is
covered by the nested 2× rule above. If a specific call is a deliberate repeat,
the agent can clear it with `loop_ack`.

## Token-cost awareness

The detector estimates the size of repeated argument text (~4 chars/token) and
reports it as `"~N tokens of repeated arguments."` in tool-call block reasons.
The cumulative count also appears in `/loopcheck` status.

It is deliberately _not_ labelled "wasted": for an exploratory session, a
repeat can be the productive move, and only the caller knows which. The figure
sizes the repetition; it does not judge it.

## How it works

Everything hooks into the `tool_call` / `tool_result` / `message_end` events;
detection is a small sliding-window counter (see `extensions/detector.ts`) with
per-session counters (steers/aborts) tracked in `extensions/controller.ts`.
Works with any model — cheap models just trigger it more often.

## Development

Requires Node 22.18+ and [pnpm](https://pnpm.io) 12 (pinned via `packageManager`; the install uses pnpm's virtual store at `node_modules/.pnpm`).

```bash
pnpm install
pnpm test        # node --test: unit + fixture + fuzz + integration + e2e (incl. real-pi e2e)
pnpm run check   # pnpm test + tsc + oxlint --deny-warnings + oxfmt
```

### E2E against real pi ≥ 0.99

`tests/e2e/pi.test.ts` downloads the real `@earendil-works/pi-coding-agent@0.99.2`
once (cached in the OS temp dir), then drives it headlessly: an in-process
OpenAI-compatible fake LLM scripts the assistant turns, pi's RPC entry runs
with THIS repo's extension loaded, and the assertions read the real RPC event
stream. Verified scenarios:

- the extension loads into pi 0.99 and blocks a scripted identical-`bash` doom
  loop with the instructive block reason
- a **real codemode worker** executing a script that polls a file 5× inside
  ONE `codemode` call gets blocked by the nested 2× rule — the script fails
  with `BLOCKED by anti-doom-loop — inside one codemode script…`
- the recommended distinct `Promise.allSettled` batch completes untouched

Everything is offline (no API keys); if the npm registry is unreachable the
real-pi tests skip cleanly instead of failing. Run just them with:

```bash
pnpm run e2e:pi
```

### Test suite (Node built-in runner, no framework)

| Suite       | File                                          | What it proves                                                                                                                                                                      |
| ----------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | `tests/unit.test.ts`                          | detector semantics: repeat/failure/text/nested signals, window eviction, options clamping, helpers                                                                                  |
| fixture     | `tests/fixtures.ts` + `tests/fixture.test.ts` | real doom-loop transcripts (CI-log loops, verbatim repeats, codemode script loops) are caught; healthy sessions are not                                                             |
| fuzz        | `tests/fuzz.test.ts`                          | seeded random streams: never throws, no false positives, injected loops always block, canonical stability                                                                           |
| integration | `tests/integration.test.ts`                   | controller + `index.ts` adapter driven through a fake `PiLike`: blocks, escalations, aborts, resets, `/loopcheck`                                                                   |
| e2e         | `tests/e2e.test.ts` + `tests/e2e/pi.test.ts`  | real subprocesses: detector self-check, version guard, tarball contents (extensions/scripts ship, tests don't), and full sessions against a real pi ≥ 0.99 with a scripted fake LLM |

> `peerDependencies` pins `@earendil-works/pi-coding-agent` at `"*"` on purpose — the
> [pi packages docs](https://pi.dev/docs/latest/packages) require an unbounded range for
> pi-core packages (pi provides them at runtime). The extension loads `.ts` directly via
> jiti, so no build step ships; `prepublishOnly` runs the full quality gate before publish.
> When a call is blocked, escalation still works without recording it in the window:
> re-issuing the identical call increments a per-signature block counter and aborts the
> turn on the second block. Thresholds are clamped to a minimum of 2 so a bad config
> can never brick the agent.

## Releasing

Publishing is handled by the GitHub Actions workflow [`.github/workflows/release.yml`](.github/workflows/release.yml), guarded against version drift:

1. Add an npm **Automation** token as the `NPM_TOKEN` repo secret (Settings → Secrets and variables → Actions, or `gh secret set NPM_TOKEN`).
2. Bump `version` in `package.json`, commit, then tag and push:

```bash
git tag v0.0.1
git push origin v0.0.1
```

CI runs the quality gate with pnpm, then the **version bump guard** (`pnpm run guard`): it blocks publishing if the version is already on npm or the tag doesn't match `package.json`. After publishing, the workflow polls the registry until the new version is actually installable — npm scans new publishes before serving them, so `publish` succeeding is not the same as `install` working. After the first publish, the [pi.dev gallery](https://pi.dev/packages) picks the package up automatically via the `pi-package` keyword.

## License

MIT
