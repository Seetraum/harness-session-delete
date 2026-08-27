# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
