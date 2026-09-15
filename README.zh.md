# dsh-session-recycle-bin

**DSH 会话回收站与彻底删除插件（DeepSeek Harness）。**

侧边栏一键移入回收站，设置页多选还原/彻底删除，活跃会话安全拦截。

界面会自动跟随浏览器语言：中文区域显示中文，其他区域显示英文。

[English](README.md) | [中文](README.zh.md)

---

## ✨ 功能特性

- **侧边栏会话行删除图标** — 悬停会话行出现小垃圾桶图标，点击即移入回收站（免确认，随时可找回）。
- **会话头部删除按钮** — 从会话页顶部删除当前会话。
- **回收站管理器**（设置 → 🗑 会话回收站）— 已归档会话多选：批量还原、批量彻底删除；条目显示 ID 与路径。
- **真正的彻底删除** — 物理清除磁盘日志与投影缓存；无日志的幽灵会话被彻底清理，不会残留。
- **活跃会话保护** — 正在运行（有活跃 agent）的会话拒绝删除。
- **批量容错** — 批量操作逐条执行，收集并汇报失败项。
- **浅色/深色自适应界面** — 所有颜色以 CSS 变量（设计令牌）收敛在 `client.css`，组件优先跟随 DSH 应用外观（`data-ds-dark-theme`），并以 `prefers-color-scheme` 作为系统级兜底，无硬编码色板。

---

## 📦 安装

### 从插件市场一键安装（dsh-market）

收录进 [awesome-dsh-plugin](https://awesome-dsh-plugin.com) 注册表后：打开 **设置 → 插件市场** → 搜索 **dsh-session-recycle-bin** → 安装。

### 手动安装

```bash
dsh plugin --profile web add dsh-session-recycle-bin
```

安装完成后重启 Web 服务（停止 `dsh web` 进程后重新启动）。

### 本地开发安装

```bash
dsh plugin --profile web add link:/绝对路径/harness-session-delete
```

### 卸载

```bash
dsh plugin --profile web remove dsh-session-recycle-bin
```

---

## 🚀 使用说明

1. **侧边栏删除** — 悬停左侧会话列表中的会话，点击垃圾桶图标：会话移入回收站，行即时消失。
2. **设置页回收站** — 打开「设置 ⚙️ → 🗑 会话回收站」：
   - 复选框多选 → **还原**（批量解除归档）或 **彻底删除**（批量清除）。
   - 每个条目显示会话名、ID 与工作路径（悬浮查看完整信息）。
3. **彻底删除** 物理清除日志与投影缓存；活跃会话受保护。
4. **撤销** — 还原操作带撤销提示，可重新归档。

---

## 🛠 开发

```bash
pnpm test          # 运行测试套件（host 逻辑 + HTTP 路由层）
```

仓库结构：

```
harness-session-delete/
├── package.json            # 单包 bundle 声明（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml        # bundle patch：一行 insert 挂载 host 行
├── index.js                # node 半边：host 入口（inject + apply）
├── client.js               # browser 半边：侧边栏图标 + 设置页回收站
├── client.css              # 插件样式表：设计令牌 + 浅色/深色自适应组件
└── packages/
    └── session-trash-host/ # host 实现（persistence/workspace/cache 补丁、HTTP 路由）
```

---

## 🔌 工作原理

- **单包 bundle** 同时覆盖两端，与其它已发布插件一致：host 半边由 `cordis.patch.yml` 挂载；浏览器半边经 `dsh.client` + `exports["./client"]` 自动进入模块图。
- 浏览器通过插件自身的 `/api/session-trash/*` HTTP 路由与宿主通信（webserver 注册；非 GET 请求携带 `x-dsh-plugin` CSRF 头）。

---

## 📄 许可证

[MIT](LICENSE)
