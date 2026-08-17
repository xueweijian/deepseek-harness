# Agent Note: Desktop release hardening: macOS, dependency following, readiness polling

Status: implemented

English | [中文](2026-08-17-desktop-release-hardening.zh.md)

## Problem

The standalone desktop shell shipped Windows and Linux only, its `@deepseek-ai/dsh` runtime pin moved only by hand, and both the sidecar and the smoke test declared readiness by matching the `dsh web: http://127.0.0.1:<port>` line the child prints. That regex — plus the hardcoded `lib/bin.js` entry path — coupled the shell to two upstream details the shell does not need: the child's log format and its package layout. Review also asked for tray, native notifications, `dsh://` deep links, and a Windows signing path.

## Decisions

**Readiness is polled, not parsed.** The shell passes `--port <n>` to the child, so the serving URL is known before spawn. `sidecar.ts` and `smoke-sidecar.mjs` now poll `http://127.0.0.1:<n>/` (per-attempt HTTP timeout 2 s, 250 ms spacing, 60 s budget) and treat any HTTP response as ready. Child stdout/stderr still feed the diagnostic log ring, but no code reads semantics out of them. An upstream log-format or entry-path change can no longer break startup detection.

**The CLI entry comes from the manifest.** Both the sidecar and the smoke test resolve the dsh entry through the installed package's `bin` field (`dsh`-named entry, else the single entry), failing loud when the manifest is unreadable or has no usable entry. Setup failures surface through the existing fatal/error-page path instead of an unhandled rejection. The CI packaged-smoke steps pass `SMOKE_DSH_DIR` (a package directory) rather than an explicit `lib/bin.js` path, so the override cannot reintroduce the coupling.

**macOS ships as two cross-built arches.** `fetch-node.mjs` accepts `--arch arm64|x64` (stamp records and verifies arch; win/linux stay x64-only), downloads the darwin `.tar.gz`, and prunes the same directories as Linux. A `macos-latest` job cross-builds dmg+zip for arm64 and x64 — viable because the app ships no Electron native modules and `extraResources` are plain files — and runs the packaged smoke against `dist/mac-arm64` / `dist/mac` (the x64 sidecar Node runs under Rosetta). mac builds are ad-hoc signed (`identity: null`), and the updater skips darwin with a log line because Squirrel.Mac cannot self-update unsigned apps.

**Dependabot follows the two desktop manifests.** The existing `.github/dependabot.yml` now excludes `desktop/**` from the root npm entry and adds `/desktop` (Electron toolchain) and `/desktop/runtime` (the dsh closure) with a 7-day cooldown instead of the root's 30. Each bump PR triggers the desktop CI validation build and smoke test, so upstream breaking changes surface before merge.

**The shell gained tray, notifications, and `dsh://`.** Closing the window hides to a tray (one-time notification explains where it went; tray menu「退出」 quits through the existing sidecar-teardown path). A downloaded update raises a native notification whose click calls `quitAndInstall`. `dsh://` is registered via `protocols` in electron-builder.yml plus `setAsDefaultProtocolClient`; links focus the window and are logged, with no route mapping until the web UI defines one.

**Windows signing is plumbing, not a purchase.** The release workflow forwards optional `CSC_LINK`/`CSC_KEY_PASSWORD` secrets; electron-builder signs when they exist and behaves exactly as before when they do not.

**Smoke overrides resolve to absolute paths.** Running the packaged smoke exposed a latent failure: `spawn` resolves a relative executable against `options.cwd`, and the child runs with `cwd: homedir()`, so the CI-style relative `SMOKE_NODE` path raised ENOENT even though the file existed next to the script. Both the Node executable and the dsh entry are now `path.resolve`d before spawn. A `typecheck` script (`tsc --noEmit`) also joined package.json after the same session found committed type errors that esbuild's transpile-only build never surfaced.

## Alternatives considered

**Make the readiness regex env-overridable.** Rejected: it keeps the coupling and adds a knob to maintain. Polling the port we chose removes the dependency outright.

**macOS on x64 runners.** Rejected: GitHub's Intel macOS images are being phased out. Cross-building on the arm64 runner keeps one runner type and works because nothing in the package chain is arch-sensitive at build time.

**Renovate for the desktop manifests.** Rejected: the repository already runs Dependabot; covering `/desktop` and `/desktop/runtime` reuses its labels, schedule, and PR plumbing without a second bot.

**Map `dsh://` paths into web routes now.** Rejected: the web UI defines no such routes; inventing a mapping would break on first upstream change. The protocol registration and focus behavior are the stable parts.

## Consequences

Startup no longer depends on upstream's log wording or entry filename; the remaining upstream couplings are the `web --port --host` CLI flags and the `node-pty@1.1.0` patch, both exercised by every CI validation build. Releases now cover three platforms with arch-specific macOS artifacts and no change to the release-tag flow. Unsigned mac builds cannot auto-update — the README says so and points to manual dmg installs — and Windows SmartScreen persists until a certificate lands in the repo secrets. Users get close-to-tray behavior by default, which changes what the window close button means; the tray notification and menu carry that contract.
