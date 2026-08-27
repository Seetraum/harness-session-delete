# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
