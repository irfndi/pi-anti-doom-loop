# Changelog

All notable changes to **pi-anti-doom-loop**.

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

[0.0.5]: https://github.com/irfndi/pi-anti-doom-loop/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/irfndi/pi-anti-doom-loop/compare/v0.0.3...v0.0.4
[0.0.2]: https://github.com/irfndi/pi-anti-doom-loop/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/irfndi/pi-anti-doom-loop/releases/tag/v0.0.1
