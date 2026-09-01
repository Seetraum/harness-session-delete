# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[English](CHANGELOG.md) | [中文](CHANGELOG.zh.md)

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
