# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[English](CHANGELOG.md) | [中文](CHANGELOG.zh.md)

## [0.4.1] - 2026-09-16

### Fixed

- **A trashed conversation whose write handle the host still held showed "0 轮对话" and an empty 查看 preview.** `readSessionEvents` called `persistence.open(id)` without an access mode: the 0.1.5 jsonl backend branches on `access === "read"`, so a missing argument takes the single-writer path (`claimWrite` plus an exclusive lease) and reading a session the host still owns — the conversation the user just deleted and is still loaded — throws `SessionAlreadyOwnedError`, which was swallowed. The list reported `turnCount: 0` and the preview returned empty, for that session only. Reads now use `open(id, 'read')`; the older cohort has no `open()` (it is `inspect`-only), so the extra argument is inert. A failed read now warns once per session instead of staying silent.
- Verification: the real-host fixture gained a "host still owns the session" stage (it fails before this fix) and passes 18/18 against a real 0.1.5-rc.2 package tree; unit tests pass 32/32 (the mock now asserts `access === 'read'`).

## [0.4.0] - 2026-09-12

### Fixed

- **The settings nav entry "会话回收站" never appeared on DSH 0.1.5 — the registration had been healthy all along; the row was rendered below the visible fold and clipped.** The settings panel pins its nav column to ~808 px (17 rows × 44 px): the panel itself is `overflow: hidden`, the nav column is `overflow: visible`, and there is no scrollbar. Whenever the window is not tall enough to fit the whole panel, the **tail of the column is cut off with no way to scroll to it**. Our section was registered with `order: 200` — the second-to-last row — so on any window shorter than roughly 800 px the entry vanished completely, while the session-header delete action (session-scoped) and the sidebar row buttons kept working. That asymmetry is why this looked like a registration bug.

  Measured against the live host (`dsh web`, DSH 0.1.5-rc.2, 1440×800 viewport), the entry sat at `top: 748px / bottom: 788px` of an 800 px viewport — a 12 px margin. At 700 px it is already `bottom: 788 > 700`: invisible *and* unreachable. In the slot ledger the registration was present the whole time; opening the section by other means rendered the panel correctly.

  `order` is now **25**, between `20` (dsh-mnemon "Memory System") and `30` (dsh-cost-meter "Cost"), i.e. in the top rows that no realistic window can clip. `order` is a plain number in both cohorts, so 0.1.1-rc.2 / 0.1.2-rc.1 are unaffected. `tests/client-header-action.test.js` now pins that placement — the harness records the registration options and the test asserts an explicit numeric `order < 100` together with the `id`/`label` contract — so the entry cannot silently drift back into the clipped band.

- **The `settings.section` registration passed contract-foreign fields.** It carried `icon` / `iconName` / `Icon` / `renderIcon`, while 0.1.5's settings nav row contract is only `{ id, order, label }` — the slot catalog shipped inside `dsh-cordis-client-runner` lists exactly `id` (required), `order` and `label` (`string | (() => string)`) under `registerOptions`, and the icon fields belonged to the pre-0.1.5 nav that rendered a glyph per row. The registration now carries contract fields only. `label` stays a thunk — both cohorts accept it ("a thunk is re-read on every projection").

- **`dsh.client.inject` was empty, so the client fiber was constructed outside the settings module's context.** That field is the client module graph's dependency declaration, and every third-party plugin that contributes to the settings or slot system names the owning module there — `dsh-mnemon`, `dshmarket`, `dsh-context`, `dsh-vision-router` and `@anweat/dsh-browser` all list `@deepseek-ai/dsh-client-ui-settings`, while `dsh-better-sidebar` and `dsh-at-file` list `@deepseek-ai/dsh-client-ui-slots`. Ours declared `[]`, so session-scoped slots (the session-header delete action) kept working, while the root-scoped `settings.section` registration was silently never adopted — no console error, the nav entry simply did not exist. The declaration now lists `@deepseek-ai/dsh-client-ui-settings` and `@deepseek-ai/dsh-client-ui-conversation`, verified against the live `__DSH_BOOT__` graph, where our row was the only settings/slot contributor with an empty `inject`.

- **`exports.inject` declared `typert`, which DSH 0.1.5 no longer provides on the Web client** (the package is not even included in the Web app bundle). Cordis requires all services declared in `inject` to be present; if any service is unprovided, the plugin's Fiber is permanently parked in the `INACTIVE` state (`epoch = INACTIVE`). Consequently, `apply(ctx)` was never executed — slot registrations (`settings.section` and the session header delete action), stylesheet injection, and sidebar delete button setup were all stalled. `typert` is removed from `exports.inject` and the optional listener now degrades safely through `ctx?.get?.('typert')?.on?.(...)`.

- **On DSH 0.1.5-rc.1 the session-header "移入回收站" button rendered but clicking it did nothing.** Two stacked causes, both in the browser half. (1) `currentTitle()` was declared INSIDE the `TrashTab` component while the module-level `DeleteSessionAction` — and the sidebar row injector — called it, so every click threw a synchronous `ReferenceError` before any request or toast could happen; the branch is reachable only once the slot stops passing `session`, which is exactly what 0.1.5 does. (2) The 0.1.5 slot runtime no longer puts the active session on the action's props, and the plugin's fallbacks (`ctx.sessions.active` / `ctx.sessions.currentId`) never existed on either cohort — the id now also resolves from the `sessions.list` snapshot's `current` field, which 0.1.1-rc.2 and 0.1.5-rc.1 both provide. The title resolver is hoisted to module scope, which removes the same latent crash from the sidebar row injector.

- **`findLog()` returns a different shape per host cohort, so permanent delete and list metadata broke on 0.1.5.** 0.1.1/0.1.2 return a path string; the 0.1.5 jsonl backend returns a generation descriptor (`{ sourcePath, sourceVersion, currentPath }`), and `dirname()` on that object threw — purge failed and fileSize/turnCount read as zero. The adapter now normalizes both shapes. The unit mocks had only ever exercised the string shape; the regression was caught by the new real-host harness.

### Added

- **Dual-cohort host support (DSH 0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.1).** The host half now adapts to the 0.1.5-rc.1 persistence rewrite while keeping every older-host path intact; the changes were driven by `dsh-upgrade-audit` (npm mode, 0.1.2-rc.1 → 0.1.5-rc.1):
  - `persistence.list()` header normalization — 0.1.5 returns `SessionPersistenceSnapshot[]` (`{ header, … }`) instead of raw `SessionHeader[]`; both shapes are now accepted (`normalizeStoredHeader`).
  - Session-event reads no longer depend on `persistence.inspect()` (removed in 0.1.5) — they fall back to `persistence.open(id)` → `handle.read()` (`readSessionEvents`).
  - Physical log-path resolution no longer relies on `findLog`/`locate` alone: `resolveSessionLogPath` tries `findLog` (authoritative, verbatim) → `locate` (stat-verified candidate) → a host-API-independent scan of `~/.dsh/sessions/<project>/<sessionId>/session*.jsonl*` that also recognizes the 0.1.5 versioned `session.v{1..3}.jsonl` names.
  - The six `dsh` peer ranges are widened to `^0.1.1-rc.2 || ^0.1.2-rc.1 || ^0.1.5-rc.1` — npm's prerelease rule requires the explicit union. `cordis` stays `^4.0.1` (already accepts 4.0.2).
  - Client-side DOM anchoring and `archivedSessionIds` snapshot reads were confirmed unchanged between 0.1.2 and 0.1.5 (the session tree lives in `dsh-client-ui-workspace`, whose row markup is identical).
- **Real-host sandbox harness** — `scripts/verify-real-host.mjs` (`npm run verify:host -- --packages <dir>`) mounts the host half against a **real published DSH package tree**, composed exactly as the bundle patches declare (storage → storage-json → storage-domain → session-persistence-jsonl → workspace), and drives the full recycle-bin flow through the plugin's own HTTP routes: create a stored session → `POST /archive` → `GET /list` → `GET /messages` → `POST /purge`, then asserts the physical session directory is gone. Only webServer and the projection cache are stubbed. It is cohort-aware (handle API on 0.1.5, create+append on ≤0.1.2) and stamps the host's own `SESSION_FORMAT_VERSION`. Results: **0.1.2-rc.1 14/14**, **0.1.5-rc.1 14/14**, plus a full end-to-end lifecycle against a real 0.1.5-rc.1 host (create → archive → list with correct title/turnCount/fileSize → messages → purge with physical `.jsonl.zstd` deletion). Excluded from the npm package via `.npmignore`.
- **Regression tests for the new failure modes** — host test 8 pins the 0.1.5 persistence shape (snapshot `list`, `open`/`read` handle, no `inspect`, `locate` candidate) and test 9 pins the generation-descriptor form of `findLog`; `tests/client-header-action.test.js` loads `client.js` against a stub DOM and asserts that both the 0.1.5 props shape (`{}`) and the legacy shape (explicit `sessionId`) archive the active session, that no module-level code calls a component-scoped helper, and that the `settings.section` registration keeps an explicit numeric `order < 100`.

### Notes

- The three contract deviations fixed in this release (`icon`/`iconName`/`Icon`/`renderIcon`, the empty `dsh.client.inject`, the unprovided `typert`) were each a genuine deviation from the 0.1.5 contracts and are kept, but **none of them was the cause of the missing nav entry**: the entry was registered the whole time and only ever clipped. The reported symptom is fixed by this release's placement change.
- **The clipping itself is a host defect** (`dsh-client-ui-settings-general`: `nav { overflow: visible }` inside `panel { overflow: hidden }`, a fixed 808 px row stack, no scrolling). It hides the last row or two for *every* section with a large order. Worth reporting upstream; this plugin deliberately does not patch the host's DOM.
- Cosmetic trade-off on DSH ≤ 0.1.2: that cohort reads the settings-nav glyph from this same registration, so it now renders the entry without the custom trash icon. Functionality is unaffected (0.1.5's nav has no icon seat at all).
- Compatibility is verified for DSH **0.1.1-rc.2**, **0.1.2-rc.1** and **0.1.5-rc.1**. The 0.1.5 pre-release checklist — live `webServer.register` route auth, the `x-dsh-plugin` CSRF seam, and end-to-end archive/purge on a real profile — is fully discharged.

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
