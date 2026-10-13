# dsh-session-recycle-bin

**Session recycle bin & permanent delete for DeepSeek Harness.**

Move the current session into a recycle bin from the conversation header, restore or permanently delete archived sessions (single or batch), with live-session protection.

The interface automatically follows the browser language: Chinese locales use
Chinese and all other locales use English.

[English](README.md) | [中文](README.zh.md)

---

## ✨ Features

- **Conversation-header archive button** — move the current session into the recycle bin from the header (no confirmation; always recoverable).
- **No duplicate of DSH's own affordance** — archiving from the sidebar uses DSH's built-in hover button; this plugin no longer injects a second, differently worded icon (0.4.4 removed the old row trash icon and the document-wide MutationObserver that drove it).
- **Recycle-bin manager** (Settings → 🗑 会话回收站) — archived sessions with multi-select: batch restore, batch permanent delete; each item shows its ID and path.
- **True permanent delete** — physically removes the session log from disk and the projection-cache record; ghost sessions (records without a log) are cleaned up so they vanish instead of lingering.
- **Live-session protection** — sessions with an active agent are refused deletion.
- **Sub-session aware** — each row can show how many sub-agent sessions it left behind (whole tree, any depth) and open them inline: title, size, time and running state, with a checkbox per sub-session. Permanent delete removes the whole tree; the ones you uncheck are kept and stay reachable as a "deleted main session · N sub-sessions kept" row instead of becoming invisible leftovers.
- **Running sub-agents block the row** — a session is refused while any sub-session in its tree is still running, and the refusal names it.
- **Batch fault tolerance** — batch operations delete per-session with error collection and reporting.
- **Light/dark adaptive UI** — all colors are CSS custom properties in `client.css`; components follow the resolved DSH appearance (`data-ds-dark-theme`) with `prefers-color-scheme` as the OS-level fallback (no hardcoded palette). UI and code text follow the app font too (`--dsw-font-family` / `--ds-font-family-code`), so the Settings → 字体 choice applies here as well.

---

## 📋 Requirements

- **DSH 0.2.0-rc.2 or newer** (this release is tested on that version only; older hosts are untested).

  The recycle-bin list no longer reads session logs: its titles and turn counts come from the Session projection cache (`SessionProjectionCache.cachedSnapshot`, plus `cachedPredecessorTitle` for checkpoints written by an older format generation) — the same zero-I/O face DSH's own session list uses. On a host without those two methods the plugin still mounts, archives and restores, but the list degrades to 「未命名会话」 with no turn counts.

  The floor is declared as `dsh.engines.dsh`. Note that DSH 0.2.0-rc.2 does **not** read that field: it is documentation for users and marketplaces, not a runtime gate.

---

## 📦 Install

### One-click from the plugin market (dsh-market)

Once listed in the [awesome-dsh-plugin](https://awesome-dsh-plugin.com) registry: open **Settings → Plugin Market** → search **dsh-session-recycle-bin** → install.

### Manual

```bash
dsh plugin --profile web add dsh-session-recycle-bin
```

Then restart the web app (stop the `dsh web` process and run `dsh web` again).

### Local development install

```bash
dsh plugin --profile web add link:/absolute/path/to/harness-session-delete
```

### Uninstall

```bash
dsh plugin --profile web remove dsh-session-recycle-bin
```

---

## 🚀 Usage

1. **Move to the recycle bin** — click the 「移入回收站」 icon in the conversation header: the session is archived and an undo toast appears. Whether an archived session keeps showing in the left sidebar is decided by DSH's own **View options → Filter sessions** setting (Hide archived / All conversations / Archived only); this plugin does not touch it, exactly like DSH's built-in archive button.
2. **Settings recycle bin** — open **Settings ⚙️ → 🗑 会话回收站**:
   - Checkbox multi-select → **Restore** (batch unarchive) or **Permanent delete** (batch purge).
   - Each entry shows the session name, ID and working path (hover for full details).
3. **Permanent delete** physically removes the log and projection cache; live sessions are protected.
4. **Undo** — restoring shows an undo toast that re-archives the session.

---

## 🛠 Development

```bash
pnpm test          # run the test suite (host logic + HTTP routes)
```

Repo layout:

```
harness-session-delete/
├── package.json            # single bundle manifest (dsh.bundle.patch + dsh.client)
├── cordis.patch.yml        # bundle patch: one insert mounting the host row
├── index.js                # node half: host entry (inject + apply)
├── client.js               # browser half: conversation-header action + settings recycle bin
├── client.css              # plugin stylesheet: design tokens + light/dark adaptive components
└── packages/
    └── session-trash-host/ # host implementation (persistence/workspace/cache patches, HTTP routes)
```

### Changelog convention

`CHANGELOG.md` and `CHANGELOG.zh.md` mirror each other. Every entry follows:

- Version section `## [version] - YYYY-MM-DD`, with only the `### Added` / `### Changed` / `### Fixed` / `### Performance` / `### Removed` headings it actually uses.
- One topic per bullet: **a short bold lead stating the outcome**, then 1-2 sentences on what changed and why it matters.
- No implementation detail, no code, no test or verification results — those belong in the commit or the PR.
- Write only user-visible or breaking changes; skip internal refactors with no visible effect.

---

## 🔌 How it works

- A **single npm bundle** covers both halves, same as other published plugins: the host row mounts via `cordis.patch.yml`; the browser half joins automatically through `dsh.client` + `exports["./client"]`.
- The browser talks to the host over the plugin's own `/api/session-trash/*` HTTP routes (registered on the webserver; non-GET requests carry an `x-dsh-plugin` CSRF header).

---

## 📄 License

[MIT](LICENSE)
