# Agent Note: Desktop test suite modeled on the harness testing policy

Status: implemented

English | [中文](2026-08-17-desktop-test-suite.zh.md)

## Problem

The standalone desktop shell had zero automated tests: its supervision loop, readiness polling, manifest bin resolution, updater wiring, and error-page rendering shipped on the strength of two smoke runs (dev and packaged) plus manual GUI checks. Upstream packages hold near 1:1 test-to-code (subprocess-local 1391 src / 1384 test lines; session-persistence 2159 / 2573) under a policy that prefers real implementations over mocks and verifies the world rather than self-reports. The shell needed the same discipline without importing the workspace's build chain — desktop is deliberately a standalone npm consumer.

## Decisions

**vitest, same idioms, standalone install.** The desktop project gains `vitest` + `@vitest/coverage-v8` as local devDeps (never shipped), `test` / `test:watch` / `test:coverage` scripts, tests colocated in `electron/tests/` and `scripts/tests/` next to the code they exercise, and a tsconfig that typechecks the specs (`allowImportingTsExtensions`, mirroring upstream's source-plane imports).

**Real subprocesses for the supervision loop.** A `fake-dsh-web.mjs` fixture runs under the test runner's own node and impersonates `dsh web` through inherited env (`FAKE_DELAY_MS`, `FAKE_EXIT_CODE`, `FAKE_NEVER_READY`, `FAKE_SPAM_LINES`, `FAKE_EXIT_AFTER_MS`), so production's fixed argv is exercised verbatim. Suites cover ready-then-teardown (asserting the port stops serving — the world, not the child's word), delayed readiness, crash-loop exhaustion with the last exit code, readiness timeout on a never-serving child, log-ring truncation, spawn failure through the restart budget, double-start rejection, and fatal-then-restart session lifecycle.

**Readiness polling proven against hostile servers.** pollReady suites use real HTTP and raw TCP: a 204 body-less response still counts as ready, connection-refused retries until a server appears, and a black-hole socket that accepts TCP but never answers does not settle the poll — the exact confusion the stdout-regex design could not express.

**Mock only the expensive boundaries.** updater specs mock `electron` and `electron-updater` (the app shell and the network); everything else in the suite is real. Electron `app` is a hoisted mutable stub; `process.platform`/`process.resourcesPath` are save-restored via captured originals after a restore bug (restoring from the live, already-stubbed value) poisoned subsequent tests.

**Testability refactors stayed production-shaped.** Supervision constants (`READY_TIMEOUT_MS`, `MAX_RESTARTS`, `BACKOFF_BASE_MS`) read positive-int env overrides that fail loud when unparsable — genuine slow-first-boot configurability that also makes the timeout paths testable in seconds. `Supervisor` accepts optional injected paths. `findDeepLink`/`errorPageUrl`/`escapeHtml` moved from main.ts into helpers.ts (no Electron import), and fetch-node.mjs guards its main flow behind an is-main-module check while exporting `archFromArgv`/`validateTarget`/`archiveName`/`stampOk`.

**Coverage gate with narrow, justified exemptions.** `test:coverage` enforces statements/functions/lines 100% and branches ≥90 on sidecar.ts, and 100% across the board on updater.ts and helpers.ts. main.ts is exempted (window/tray glue needs a real Electron runtime; manual matrix in README plus CI typecheck own it) following the pwsh-exemption precedent. Five `v8 ignore` spans carry reasons: posix-only killTree (exercised by posix CI legs), the packaged log-path arm (covered for real by the packaged CI smoke), and three non-reproducible defensive paths.

**The suite caught a real bug before release.** `Supervisor.stop()` on an already-exited child registered a fresh `exit` listener that could never fire, then waited the full 5 s grace — every post-fatal recovery and post-fatal quit ate five seconds for nothing. The fix (early-return on an exited child, mirroring killTree's own guard) was driven by a failing test, not by review.

## Alternatives considered

**node:test instead of vitest.** Rejected: upstream standardizes on vitest; matching its idioms (`vi.hoisted`, `vi.mock` with importOriginal passthrough, fake timers) keeps the fork's tests readable to upstream contributors at zero runtime cost.

**Testing through startSidecar only.** Rejected: the module-level session API cannot inject paths, so fixture-driven loop tests would have needed the real runtime closure. Exporting `Supervisor` with optional injection keeps the production call sites unchanged.

**A Playwright electron lane for main.ts.** Deferred: real value, but a new dependency lane and GUI-runner infrastructure; the manual matrix plus pure-helper extraction cover this change's risk. Recorded as follow-up in the desktop README.

## Consequences

Every desktop CI job (Windows, Linux, macOS arm64, macOS x64) now runs typecheck and the unit suite between dependency install and packaging, so a regression lands red on all four platforms before any artifact exists. The suite runs in ~15 s locally. Timing knobs gained env overrides with loud failure, which operators can also use on slow machines. The stop()-grace fix removes a five-second stall from every post-fatal retry and quit. Future GUI automation has a reserved lane (Playwright) and a documented manual matrix until then.
