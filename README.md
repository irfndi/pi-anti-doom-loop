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

| Signal                          | Default                 | Blocked when                                                    |
| ------------------------------- | ----------------------- | --------------------------------------------------------------- |
| Same `(tool, args)` repeated    | 3× in the last 10 calls | The pattern has repeated `3` times with no change               |
| Same tool failing consecutively | 3×                      | A tool errored `3` times in a row — stop retrying it blindly    |
| Same assistant text verbatim    | 3× in a row             | The model re-emitted identical text `3` times (text-only loops) |

Blocks hand the model an instructive reason ("change your approach, use a
different tool, or ask the user"). If the model ignores the block and re-issues
the exact same call, the turn is **aborted** and you are notified. A verbatim
text loop (no tool calls involved) aborts the run immediately with a
notification.

Counters reset on every user prompt, so a task legitimately repeated later in
the same session is never a false positive.

## Configuration

Environment variables, read at session/prompt start:

| Variable                    | Default | Meaning                                            |
| --------------------------- | ------- | -------------------------------------------------- |
| `PI_ANTI_LOOP_REPEATS`      | `3`     | Identical-call block threshold                     |
| `PI_ANTI_LOOP_FAILS`        | `3`     | Consecutive-failure block threshold                |
| `PI_ANTI_LOOP_TEXT_REPEATS` | `3`     | Consecutive identical assistant texts before abort |
| `PI_ANTI_LOOP_WINDOW`       | `10`    | How many recent calls/results are inspected        |
| `PI_ANTI_LOOP_DISABLE`      | —       | Set to `1` to disable the extension entirely       |

## Command

- `/loopcheck` — show current thresholds and counters
- `/loopcheck reset` — clear counters

## How it works

Everything hooks into the `tool_call` / `tool_result` events; detection is a
small sliding-window counter (see `extensions/detector.ts`) with no state kept
between user prompts. Works with any model — cheap models just trigger it more
often.

## Development

Requires Node 22.6+ (plain `node` runs the TS self-check).

```bash
npm install
npm run check   # detector self-check + tsc + oxlint + oxfmt
```

## Releasing

Publishing is handled by the GitHub Actions workflow [`.github/workflows/release.yml`](.github/workflows/release.yml), guarded against version drift:

1. Add an npm **Automation** token as the `NPM_TOKEN` repo secret (Settings → Secrets and variables → Actions, or `gh secret set NPM_TOKEN`).
2. Bump `version` in `package.json`, commit, then tag and push:

```bash
git tag v0.0.1
git push origin v0.0.1
```

CI runs the quality gate, then the **version bump guard** (`npm run guard`): it blocks publishing if the version is already on npm or the tag doesn't match `package.json`. After the first publish, the [pi.dev gallery](https://pi.dev/packages) picks the package up automatically via the `pi-package` keyword.

## License

MIT
