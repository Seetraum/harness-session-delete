# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[English](CHANGELOG.md) | [中文](CHANGELOG.zh.md)

## [0.3.3] - 2026-09-02

### Fixed

- **Overwrite-installing a new version over a running dsh web kept executing the OLD code, so the recycle-bin list stayed at "0 轮对话" no matter what was fixed.** Three stacked reasons, now worked around plugin-side: dshmarket only hot-mounts NEWLY-ADDED packages (an install over an existing name never live-activates); every live-activation path (market hot mount, loader entry update) imports this package by the same module URL, so Node's ESM cache keeps returning the first module object the process ever loaded; and a same-name loader entry update reuses the previous runtime callback outright. `index.js` is now a BYTE-STABLE loader shim whose `apply()` imports the implementation through `?<sha256-of-file>`: identical content reuses the cached module, changed content (a new version on disk) gets a fresh URL and therefore fresh code — so after one restart onto this shim, an uninstall → install (or market disable → enable) swaps plugin versions in-process without a restart. A plain overwrite-install still requires a restart — that is dshmarket's activation design, outside plugin control. The shim file itself must never change again; all version-to-version changes live in the implementation file.
- **A registry patch leaked by an older fiber now keeps working instead of degrading to 0 turns.** `patchWorkspaceRegistry` snapshots `sessionPersistence` at patch time, so `listArchivedSessions()` / `permanentlyDeleteSession()` no longer resolve services through the (possibly dead) context accessor at call time — the exact throw that was silently zeroing turn counts. Safe `ctx.get(...)` lookups stay dynamic.

### Added

- Lifecycle regression tests: a leaked `listArchivedSessions` reference must keep counting turns after its fiber unloads, and the entry shim — imported from the ESM cache — must mount the impl CURRENTLY on disk after the impl file is replaced (both fail on v0.3.2).

## [0.3.2] - 2026-09-02

### Fixed

- **Recycle-bin list showed "0 轮对话" for every session after uninstalling and reinstalling the plugin without a restart, while the preview modal still worked.** This was the sibling of the v0.3.1 route leak: the methods patched onto the SHARED `workspaceRegistry` service (`listArchivedSessions` and friends) stayed behind after the owning fiber unloaded, and the new instance's `typeof x !== 'function'` guards then refused to re-patch — so the list kept calling a method whose closure held the dead context: `ctx.sessionPersistence` threw inside the per-session try/catch, turn counts silently read 0, and the preview (whose routes snapshot services at mount) stayed healthy. All service patches are now REVERSIBLE and token-tagged: each install tags the methods it adds (or, for `persistence.delete`, the wrapper it installs) with its own token, a fresh install overwrites whatever stale patch it finds — healing a broken live process in place — and the fiber's unload disposer removes only methods still carrying that install's token. Context-free leftovers from <= v0.3.1 (the old `persistence.delete` wrapper, `cache.remove`) are detected and kept instead of being nested.

### Added

- Lifecycle regression tests for the new failure mode: uninstall + reinstall must keep `listArchivedSessions()` on the live context (turn counts and derived titles survive), and mounting over stale untagged (<= v0.3.1) registry methods must heal them in place.

## [0.3.1] - 2026-09-02

### Fixed

- **Recycle-bin turn counts showed "0 轮对话" and the preview modal failed with `cannot get required service "sessionPersistence" in inactive context`** after reinstalling the plugin without restarting `dsh web` (the same holds for any other in-process fiber reload: loader config updates, dependency service restarts). The `/api/session-trash/*` route disposers were kept on a class-instance field that `@deepseek-ai/cordis@4` never invokes, so the unloaded fiber leaked its routes — still served by handlers bound to a dead context — and the reloaded instance then died on `webServer.register`'s duplicate-path throw, leaving the plugin broken until a process restart. Route unregistration is now wired into the owning fiber via `ctx.effect(...)` (the framework's register() disposer contract): unload clears the route table and reload re-registers cleanly, so reinstalling v0.3.1 or later no longer requires a restart (upgrading from a version that already leaked routes still does — the stale table only clears on a restart). Route handlers also snapshot `sessionPersistence` at mount time instead of re-resolving it through the context on every request.
- `SessionPersistence.delete` is no longer wrapped a second time when the plugin fiber reloads (the patch is idempotent now).
- A duplicate-path registration failure now reports that a previously leaked route occupies the path and that restarting `dsh web` clears it, instead of the bare `webserver: duplicate exact route ...` error.

### Added

- Fiber-lifecycle regression test (`tests/reload-lifecycle.test.js`) that runs the real plugin against a real `@deepseek-ai/cordis` copy discovered in `node_modules/.pnpm` (auto-skipped when none is installed): a plugin restart must neither leak nor lose routes, and a full unload must unregister every route.

## [0.3.0] - 2026-09-02

### Added

- **Light/dark adaptive UI** (PR #1 by [@1MLightyears](https://github.com/1MLightyears)): all inline styles moved into an external `client.css` served by the host at `GET /api/session-trash/client.css` (lazy read, `no-cache`) and injected by `client.js` as a `<link rel="stylesheet">`; colors became `--dstrb-*` design tokens with a dark palette (cards, modals, preview bubbles, markdown, toasts, tooltips); route test coverage and README documentation added.

### Fixed

- **Dark palette resolution now follows the DSH appearance, not only the OS**: DSH resolves its appearance preference (light / dark / system) onto `body[data-ds-dark-theme]`, which `@media (prefers-color-scheme: dark)` cannot observe. Dark tokens now apply under `body[data-ds-dark-theme]` OR the OS media query (kept as fallback), and an explicit light preference restores the light palette via `body:not([data-ds-dark-theme])` — fixing unreadable near-white titles when the app ran light under a dark OS, and the dark-app / light-OS gap left by the media query alone.
- Native form controls (select, checkbox, scrollbars) inside the recycle-bin page now follow the resolved plugin mode via scoped `color-scheme` rules instead of the raw OS media query.

## [0.2.2] - 2026-09-01

### Fixed

- **Sidebar hover delete button missing on newly created sessions**: the injected button on a blank "New Session" row was placed at the row start and removed by React re-renders, leaving a stuck "injected" marker with no button. The button is now inserted between the status slot and the title (same position as normal rows), and a self-heal pass re-injects rows whose marker exists but button was lost.
- **Duplicate-titled sessions could not be deleted** (e.g. several "你好"): the browser session store keeps archived sessions in `byId`, so a single live session titled "你好" was never unique. Archived sessions are now excluded via `workspaces` `archivedSessionIds` before matching; with one live match left, the row binds directly.
- **Multiple live duplicate-titled rows**: the selected row binds to the current session; other rows are disambiguated by list recency position, gated by a relative-time monotonicity check — when the order cannot be confirmed the row stays aligned (invisible spacer) and shows no button, avoiding a wrong delete.
- **Test suite could not run** (`afterEach`/`rm` were used but not imported in `tests/*.test.js`) — imports fixed so `npm test` executes all 18 host tests.

### Changed

- Sidebar rows whose session id cannot be safely resolved keep a same-width invisible spacer, so all rows align (no more "shifted left" rows).

## [0.2.1] - 2026-08-27

### Fixed

- Fixed recursive self-dependency entry in `package.json` to resolve npm installation ENOENT error.

## [0.2.0] - 2026-08-27

### Added

- **Workspace Grouping & Cards**: Categorized archived sessions under dedicated workspace cards (`📁 {workspaceTitle}`).
- **Multi-Select & Bulk Operations**: Capsule checkboxes on each session item with dynamic workspace `•••` action menu ("Purge Selected (N)" / "Purge All Workspace").
- **Session Preview Modal**: View historical User & Assistant conversations in smooth chat bubbles with full markdown rendering.
- **Header Toolbar**: Equal 1:1 CSS grid layout featuring fuzzy search, workspace filter, and sorting options (Newest / Oldest).
- **Rich Card Metadata**: Displays accurate user turn counts, formatted file size badges (`DiskIcon`), and deletion timestamps.
- **Hover Tooltip**: Fast (200ms) tooltip displaying full session title, ID, and absolute path on hover.

### Fixed & Improved

- **Sidebar Hover Icon**: Restored left-aligned hover delete icon (`🗑`) before session titles in the left sidebar tree.
- **Title Freeze & Persistence**: Archived sessions permanently freeze original human titles (`archivedTitles` map) to prevent `sessionId` fallbacks.
- **Accurate Turn Counts**: Refined JSONL prompt detection to count true `USER_INPUT` turns without system false positives.
- **Instant Unarchive Sync**: Triggered 5-way Harness native sessionStore events so restored sessions pop up in the sidebar immediately.

## [0.1.4] - 2026-08-27

### Fixed

- Prevent archiving (moving to recycle bin) running sessions from sidebar or header.
- Provide clear Chinese toast notifications when attempting to delete or permanently delete running sessions.
- Replace browser `alert()` with floating toast notifications (`showToastLayer`).
- Fix batch purge cleanup to only remove successfully deleted sessions from browser state.

## [0.1.0] - 2026-08-25

### Added

- Initial release of `dsh-session-recycle-bin`.
- Sidebar per-session delete icon (hover to reveal, click to archive).
- Session-header delete button for the current session.
- Settings recycle-bin manager: multi-select batch restore / batch permanent delete.
- True permanent delete: physically removes the session log and projection-cache record.
- Ghost-session cleanup: sessions without a physical log are removed entirely instead of lingering.
- Live-session protection: sessions with an active agent are refused deletion.
- Batch fault tolerance: per-session error collection and reporting.
- Plugin transport over `/api/session-trash/*` webserver routes with CSRF header.
