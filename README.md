# dsh-session-trash

**Session trash & permanent delete for DeepSeek Harness.** · **DSH 会话回收站与彻底删除插件。**

Move sessions into a recycle bin from the sidebar, restore or permanently delete them (single or batch), with live-session protection. · 侧边栏一键移入回收站，设置页多选还原/彻底删除，活跃会话安全拦截。

---

## ✨ Features / 功能特性

- **Sidebar per-session delete icon** — hover a session row, a small trash icon appears; click to move it into the recycle bin instantly (no confirmation; always recoverable). · 侧边栏会话行悬停出现垃圾桶图标，点击即移入回收站（免确认，随时可找回）。
- **Session-header delete button** — delete the current session from the conversation header. · 会话头部删除按钮，删除当前会话。
- **Recycle-bin manager** (Settings → 🗑 会话回收站) — archived sessions with multi-select: batch restore, batch permanent delete; each item shows its ID and path. · 设置页回收站：多选批量还原/彻底删除，条目显示 ID 与路径。
- **True permanent delete** — physically removes the session log from disk and the projection-cache record; ghost sessions (records without a log) are cleaned up so they vanish instead of lingering. · 彻底删除：物理清除磁盘日志与投影缓存；无日志的幽灵会话被彻底清理，不会残留。
- **Live-session protection** — sessions with an active agent are refused deletion. · 活跃会话（正在运行）拒绝删除，防止误删。
- **Batch fault tolerance** — batch operations delete per-session with error collection and reporting. · 批量操作逐条容错并汇报失败项。

---

## 📦 Install / 安装

### One-click from the plugin market (dsh-market)

Once listed in the [awesome-dsh-plugin](https://awesome-dsh-plugin.com) registry: open **Settings → Plugin Market** → search **dsh-session-trash** → install.

### Manual / 手动安装

```bash
dsh plugin --profile web add dsh-session-trash
```

Then restart the web app (stop the `dsh web` process and run `dsh web` again). · 重启 `dsh web` 进程生效。

### Local development install / 本地开发安装

```bash
dsh plugin --profile web add link:/absolute/path/to/harness-session-delete
```

### Uninstall / 卸载

```bash
dsh plugin --profile web remove dsh-session-trash
```

---

## 🚀 Usage / 使用说明

1. **Sidebar delete** — hover a session in the left sidebar, click the trash icon: the session moves into the recycle bin and the row disappears immediately. · 侧边栏会话行悬停 → 点垃圾桶图标 → 移入回收站，行即时消失。
2. **Settings recycle bin** — open **Settings ⚙️ → 🗑 会话回收站**:
   - Checkbox multi-select → **Restore** (batch unarchive) or **Permanent delete** (batch purge). · 多选 → 批量还原 / 批量彻底删除。
   - Each entry shows the session name, ID and working path (hover for full details). · 条目显示会话名、ID 与路径（悬浮看详情）。
3. **Permanent delete** physically removes the log and projection cache; live sessions are protected. · 彻底删除物理清除日志与缓存；活跃会话受保护。
4. **Undo** — restoring shows an undo toast that re-archives the session. · 还原操作带撤销提示，可重新归档。

---

## 🛠 Development / 开发

```bash
pnpm test          # run the test suite (host logic + HTTP routes)
```

Repo layout / 仓库结构：

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

## 🔌 How it works / 工作原理

- A **single npm bundle** covers both halves, same as other published plugins: the host row mounts via `cordis.patch.yml`; the browser half joins automatically through `dsh.client` + `exports["./client"]`. · 单包 bundle：host 半边由 patch 挂载，浏览器半边经 `dsh.client` 自动进入模块图。
- The browser talks to the host over the plugin's own `/api/session-trash/*` HTTP routes (registered on the webserver; non-GET requests carry an `x-dsh-plugin` CSRF header). · 浏览器通过插件自身的 `/api/session-trash/*` 路由与宿主通信（非 GET 带 CSRF 头）。

---

## 📄 License / 许可证

[MIT](LICENSE)
