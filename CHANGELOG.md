# Changelog

All notable changes to **pi-anti-doom-loop**.

## [Unreleased]

### Fixed

- **`tinypool` critical advisories** — `oxfmt` 0.62.0 pinned `tinypool` 2.1.0, which carries two critical prototype-pollution-to-RCE advisories (`GHSA-85c8-ppgw-ccpr`, `GHSA-5gmw-xhrv-c9v3`); dev-only, but critical. `oxfmt` is now 0.74.0 (`tinypool` 2.2.0) and `pnpm audit` is clean.
- **Deprecated Actions runtime** — `actions/checkout` and `actions/setup-node` were pinned to v4 commits, which GitHub now forces from Node 20 to Node 24 with a warning on every run. Both are on v7, which targets Node 24 natively.

### Added

- **CI on every push and pull request** — `.github/workflows/ci.yml` runs the same gate as `prepublishOnly`, so master can no longer drift from the release check.
- **Dependabot** — weekly npm and GitHub Actions updates (minor/patch grouped), with vulnerability alerts and automated security fixes enabled on the repository.

## [0.0.12] — 2026-10-01

### Added

- **E2E tests against a real pi ≥ 0.99** (`tests/e2e/pi.test.ts` + `tests/e2e/pi-rig.ts`) — the rig downloads the real `@earendil-works/pi-coding-agent@0.99.2` (cached), runs pi's RPC entry headlessly with the repo extension loaded, and drives sessions with an in-process OpenAI-compatible fake LLM, fully offline. Verified: the extension blocks a scripted identical-`bash` doom loop in a real session; a **real codemode worker** executing a script that polls a file 5× inside ONE `codemode` call is blocked by the nested 2× rule and the script fails with the `BLOCKED by anti-doom-loop` reason; the recommended distinct `Promise.allSettled` batch completes untouched. Skips cleanly when the npm registry is unreachable. Run with `pnpm run e2e:pi`.
- **Codemode nested-loop fixtures** — `codemodeNestedLoop` (in-script poll loop), `codemodeErrorRetryLoop` (identical retry after an in-script error), `codemodeCrossScriptRepeat` (second script re-issuing a blocked signature → escalation), and `codemodeHealthyBatch` (the documented `Promise.allSettled` pattern stays unblocked), each driven through the controller exactly as pi delivers nested events, plus a contrast test proving a 2× loop blocks nested while staying under the top-level 3× threshold.

### Changed

- **Tooling migrated to pnpm (latest, 12.8.1)** — `packageManager` pin, `pnpm-lock.yaml` with the default virtual store (`node_modules/.pnpm`), all scripts and docs use `pnpm`, the release workflow installs via `pnpm/action-setup` + `--frozen-lockfile` and publishes with `pnpm publish --no-git-checks`; the tarball e2e asserts via `pnpm pack` and pins the tooling.

### Fixed

- **Fresh installs failed under pnpm 12** — unapproved dependency build scripts made `pnpm install --frozen-lockfile` exit `ERR_PNPM_IGNORED_BUILDS`, which would have aborted the release workflow before the quality gate. The dev-only transitives pi pulls (`esbuild`, `protobufjs`, `@google/genai`) are now explicitly denied in `pnpm-workspace.yaml`; their binaries come from optional platform packages.
- **`oxlint-tsgolint` pin had no matching artifact** — `package.json` asked for `7.0.2003` while `@effect/tsgo` ships its patched tsgolint for `7.0.2001` only. The devDependency now matches the artifact (the workspace override already pinned it), so `prepare` no longer looks for a missing binary.
- **Bounded codemode memory** — a script's window now keeps only its most recent 100 calls (args are capped at 100 KB each), so a long-running script cannot pin unbounded memory; in-script loops repeat adjacent calls and still block at 2×.
- **Real-pi e2e reported green when it never ran** — offline runs returned early from each test, which `node:test` records as passing. They now report `skipped`, so `pnpm test` can no longer claim coverage it did not execute.

### Tests

- 122 → 133: 4 real-pi e2e sessions, 6 codemode fixture tests, pnpm-pack artifact assertions, and the bounded nested-window case.

## [0.0.11] — 2026-10-01

### Added

- **Codemode awareness (pi ≥ 0.99)** — pi's `codemode` tool runs model-written scripts that call other tools via `tools.<name>(args)`; those nested calls carry `parentToolCallId` in the `tool_call`/`tool_result` events and previously bypassed detection entirely (a script can issue hundreds of calls inside ONE top-level tool call). The extension now tracks them: identical calls inside one script block at **2×** (stricter than the top-level 3× — a repeated in-script call is never progress; store the result and reuse it), near-identical args count toward the same rule, and an identical retry of a call that already **errored** in the same script blocks immediately. Nested traffic is windowed **per script** and fully isolated from the top-level window in both directions. A NEW script re-issuing a signature blocked in an earlier script this prompt **escalates** (aborts the turn), mirroring top-level block escalation. `PI_ANTI_LOOP_TOOLS_EXCLUDE` applies to nested calls; nested identity is storage-capped (100 KB per call, most recent 100 calls per script) so huge payloads (whole-file reads) stay cheap; `/loopcheck` reports `nested: calls=N blocks=M`.
- **The information wall** — a nested block reason reaches the _script_ as a tool error, not the model (pi delivers only the script's return value). If a script swallows block errors, the loop signal was lost. The extension now arms a one-shot **steer** on the next assistant `message_end` after any nested block, telling the model to call each tool once per script and reuse results — so a script that ignores tool errors can no longer silently eat the loop signal.

### Tests

- 99 → 122: nested unit semantics (2× rule, per-script isolation, error-retry, cross-script escalation, payload cap, exclude-list), adapter wiring (`parentToolCallId` forwarding, `NESTED_STEER_TEXT` via `sendMessage`, escalation aborts), and nested fuzz streams (never throw, injected in-script loops always block, random unique-args streams never false-positive).

## [0.0.10] — 2026-09-23

### Fixed

- **Counters reset per user prompt, not per run** — the extension reset on `before_agent_start`, which omp emits on _every_ run start: auto-continue turns (`role:"developer"`), steers/resumes, advisor cards, and queued async-result drains all restart the run, wiping counters (including block-escalation state) between the iterations of exactly the cross-run loops this extension exists to catch. Reported identical `ssh`-polling loops ran 7+ times unblocked while intra-run repeats fired correctly — replaying the incident session on detector-visible input reproduces its 9 exact blocks, with the only discrepancies landing right after post-abort run restarts, where the per-run reset had cleared the window. Reset now keys off `message_end` with `role:"user"` (emitted with the run's input messages on omp and pi alike), matching the documented per-user-prompt contract; steers and auto-continues keep counting, so the steer→abort escalation ladder survives run restarts too.

### Added

- **Near-identical tool-call detection** — when no exact signature repeats, `check()` counts same-tool window entries whose canonical args share ≥ 55% whitespace tokens (token union ≥ 5): sleep-wrapped polls (`gh run list…` → `sleep 150; gh run list…`), flag/grep-pattern/tail drift. Block reason prefix: _"…" was called with near-identical arguments N times…_. Short inputs stay exact-only via the union guard; exact repeats still block first with the exact reason.

### Notes

- omp strips the harness intent label (`i`) at parse (`extractIntent`), before extension events — this detector never sees it; no handling was added. pi has no intent field at all.

## [0.0.9] — 2026-09-07

### Added

- **Full anti-slop rule set** — synced the vendored Oxlint plugin with upstream: 5 missing generic rules (`no-module-mocking`, `no-reflect-apply`, `no-reflect-get`, `no-unknown-returns`, `require-safety-comment-for-type-assertion`), the opt-in Effect plugin (`no-service-constructor-imports`, enabled — this repo declares `effect`), and the supporting shared helpers. All 15 generic rules plus the Effect rule run at `error`.
- **Complexity gate** — `eslint/complexity` with `{ max: 10 }`; anything in the 11+ "refactor now" band fails the build.

### Fixed

- **Within-message false positive on status lists** — `repeatedSegment` no longer splits on `:` (status updates like "worker dispatched: a. worker dispatched: b. worker dispatched: c." stay whole and distinct). Separator-less concatenation (`S:S:S:`) and truncated repeats are still caught by the new `tandemPrefix` check.
- **Complexity + slop findings in owned code** — extracted `collectBlockReasons` (`check` CC 11 → 6); replaced `as` casts at I/O boundaries with `SAFETY:` invariants, real `isManifest` / `hasStringVersion` guards, a named `PiHandlerResult` contract, and assertion-free tests.

## [0.0.8] — 2026-08-24

### Added

- **Within-message tool-call spam detection** — `onMessageEnd` now inspects the assistant message's `toolCall` blocks and aborts immediately when `textRepeatThreshold` identical `(tool, args)` calls are batched in ONE message (`LoopDetector.checkDuplicateCalls`). Catches degenerate parallel batches — e.g. a single response emitting 1405 identical `bash "true"` calls (observed in production) — which per-call detection never sees as a streak because every call arrives at once, and which can be aborted before any call executes. Respects `PI_ANTI_LOOP_TOOLS_EXCLUDE`; aborts rather than steers since steering cannot retract emitted calls.

## [0.0.7] — 2026-08-13

### Changed

- **Effect 4.0 RC** — upgraded `effect` from `^4.0.0-beta.103` to `^4.0.0-rc.108`.
- **Anti-slop lint hardening** — vendored an opinionated Oxlint rule set (`tools/oxlint/anti-slop/`) and enabled it in `oxlint.config.ts`; resolved all 23 findings by introducing a JSON-safe `ToolInput` domain type decoded at the pi boundary, replacing `unknown` parameters, `typeof` checks, `Record<string, unknown>`, and value widening.

## [0.0.6] — 2026-08-12

### Added

- **Near-identical text cycle detection** — `checkText` now fires when near-identical assistant texts (token similarity ≥ 55%) accumulate to the text-repeat threshold within the sliding window, even when they are not identical and not consecutive. Catches a rotating set of rephrased commands ("Run the test." / "Run tests now." / "Let me run the test.") that never repeat verbatim. New block reason prefix: _"Assistant sent near-identical text N times within the last M messages"_.
- **Token-cost awareness** — the detector estimates tokens burned on redundant repeats (~4 chars/token) and reports `~N tokens burned on repeats.` in tool-call block reasons; the cumulative wasted-token count appears in `/loopcheck` status.
- **Time-windowed eviction** — optional `PI_ANTI_LOOP_TIME_WINDOW` (elapsed-time window in ms; default `0` = disabled, count-only) so slow chronic loops spread over a long session are caught.
- **Failure-rate window** — optional `PI_ANTI_LOOP_FAIL_RATE` (0..1, default `0` = disabled) blocks a tool when its error share of in-window calls reaches the threshold, with `PI_ANTI_LOOP_FAIL_RATE_MIN` (default `3`) as the minimum-calls gate. Catches flaky retries interleaved with successes that never form a consecutive streak.
- **Per-tool allowlist** — `PI_ANTI_LOOP_TOOLS_EXCLUDE` (comma-separated tool names) disables detection for those tools entirely: they never block and never enter the window.
- **Richer `/loopcheck` diagnostics** — status now shows the current window contents (most-repeated recent calls and texts) and the wasted-token count, plus the fail-rate/time-window/exclude config when enabled.

### Changed

- **Same assistant text verbatim** now uses window semantics: it blocks on `3× within the last N messages` rather than strictly "in a row", consistent with the sliding-window repeat threshold.

### Tests

- Detection and regression coverage for the near-identical text cycle, token-cost reporting, time-windowed eviction, failure-rate window, per-tool exclusion, and the richer `/loopcheck` status.

## [0.0.5] — 2026-08-05

### Added

- **`/loopcheck suspend` / `resume`** — escape hatch: pause detection until the next prompt when repetition is intentional (polling, retrying a deploy). No env restart needed.
- **Session counters** — `steers`/`aborts` appear in `/loopcheck` status; session-scoped (survive per-prompt resets, reset on `/loopcheck reset` or new session).
- Fixture for the live regex-repeat capture (`parameter\s+(\S+)\s+("` 3× in one message) — regression-covered via the within-message signal.
- `CHANGELOG.md` ships in the tarball.

### Tests

- 72 → 75: suspend/resume lifecycle, session counters, regex-repeat fixture, `/loopcheck` subcommands.

## [0.0.4] — 2026-08-05

### Added

- **Near-identical text detection** — token-set Jaccard similarity ≥ 0.55 on consecutive assistant messages counts as a loop streak. Catches rephrasing loops where the model changes one or two words per turn ("inspect the failing test" → "examine the failing assertion") that exact matching missed.
- **Escalation ladder for text loops: steer → abort → bounded resume** — the first detection steers the agent mid-run (injects guidance, work continues); a persistent loop aborts the run and queues **one** fresh-resume directive (`followUp`) so work continues with a new approach; further looping aborts for real and hands control back. The auto-resume budget is session-scoped so a stuck model cannot cycle forever.
- Detector now fires on every message while a loop condition holds; the controller turns the 1st into a steer, later ones into aborts.
- Tests: 65 → 72 (token-similarity unit cases, near-identical streak + reset, steer→abort→resume ladder, budget persistence, adapter wiring, fuzz no-FP + injected-3× properties).

## [0.0.3] — 2026-08-05

### Added

- **Within-message self-repetition detection** — a sentence repeating 3+ times inside ONE message (growing self-concatenation loops like "…X:…X:…X") now aborts/steers immediately. Liquid Antidoom's loop definition ("a section repeats at least N times").
- Segmenter ignores chunks < 16 chars so pasted logs with repeated one-word lines never false-positive.
- Fixtures for the production growing-loop capture (exact + spaced variants).

### Fixed

- Production gap: loops that grow by self-concatenation evaded both verbatim-streak (messages differ) and identical-call (args vary) detection. Now caught at the message itself.

### Tests

- 51 → 65: `repeatedSegment` unit cases, growing-pattern `checkText` cases, fixture controller paths, fuzz no-FP + injected-3× properties.

## [0.0.2] — 2026-08-05

### Added

- **Full test suite** — Node's built-in `node:test`, no framework:
  - unit (detector semantics, options clamping, helpers)
  - fixtures (real doom-loop transcripts: CI-log loops, verbatim repeats; healthy sessions not flagged)
  - fuzz (seeded: never throws, no false positives, injected loops always block)
  - integration (controller + adapter driven through a fake `PiLike`)
  - e2e (real subprocesses: detector self-check, version guard, tarball contents)
- **`controller.ts`** — extracted all event logic into a pure, pi-free, testable module; `index.ts` became a thin structural adapter.
- `npm test`, `engines >= 22.18`, `files` includes `scripts/`.

### Fixed

- Thresholds clamped to a minimum of 2 (a config of 1 would brick the agent — deepsec finding).
- GitHub Actions pinned to commit SHAs (NPM_TOKEN in scope — deepsec finding).
- Release job `concurrency` group (publish race / TOCTOU).
- `npm publish --dry-run` preflight before the real publish.
- Version guard requires the git tag `v$version` on the manual-dispatch path.

### Changed

- Leveraged `better-result` (detector decisions) and `effect` v4 (release guard).

## [0.0.1] — 2026-08-05

### Added

- Initial release. Detects and breaks agent doom loops in pi:
  - **identical (tool, args) repeated** 3× in the last 10 calls → block with an instructive reason
  - **same tool failing** 3× consecutively → block with "stop retrying, fix the root cause"
  - escalation: re-issuing a blocked call aborts the turn
- `/loopcheck` command (status + reset).
- Counters reset per user prompt (legit repeated tasks are never false positives).
- GitHub Actions release workflow: quality gate → version bump guard → dry-run → publish, triggered by `v*` tags.
- `pi-package` keyword + `pi` manifest for the pi.dev gallery.

[0.0.7]: https://github.com/irfndi/pi-anti-doom-loop/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/irfndi/pi-anti-doom-loop/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/irfndi/pi-anti-doom-loop/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/irfndi/pi-anti-doom-loop/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/irfndi/pi-anti-doom-loop/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/irfndi/pi-anti-doom-loop/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/irfndi/pi-anti-doom-loop/releases/tag/v0.0.1
