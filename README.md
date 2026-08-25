# dsh-session-recycle-bin

**Session recycle bin & permanent delete for DeepSeek Harness.**

Move sessions into a recycle bin from the sidebar, restore or permanently delete them (single or batch), with live-session protection.

[English](README.md) | [中文](README.zh.md)

---

## ✨ Features

- **Sidebar per-session delete icon** — hover a session row, a small trash icon appears; click to move it into the recycle bin instantly (no confirmation; always recoverable).
- **Session-header delete button** — delete the current session from the conversation header.
- **Recycle-bin manager** (Settings → 🗑 会话回收站) — archived sessions with multi-select: batch restore, batch permanent delete; each item shows its ID and path.
- **True permanent delete** — physically removes the session log from disk and the projection-cache record; ghost sessions (records without a log) are cleaned up so they vanish instead of lingering.
- **Live-session protection** — sessions with an active agent are refused deletion.
- **Batch fault tolerance** — batch operations delete per-session with error collection and reporting.

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

1. **Sidebar delete** — hover a session in the left sidebar, click the trash icon: the session moves into the recycle bin and the row disappears immediately.
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
├── client.js               # browser half: sidebar icons + settings recycle bin
└── packages/
    └── session-trash-host/ # host implementation (persistence/workspace/cache patches, HTTP routes)
```

---

## 🔌 How it works

- A **single npm bundle** covers both halves, same as other published plugins: the host row mounts via `cordis.patch.yml`; the browser half joins automatically through `dsh.client` + `exports["./client"]`.
- The browser talks to the host over the plugin's own `/api/session-trash/*` HTTP routes (registered on the webserver; non-GET requests carry an `x-dsh-plugin` CSRF header).

---

## 📄 License

[MIT](LICENSE)
