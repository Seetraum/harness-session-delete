# dsh-session-recycle-bin

**DSH 会话回收站与彻底删除插件（DeepSeek Harness）。**

会话详情头部一键移入回收站，设置页多选还原/彻底删除，活跃会话安全拦截。

界面会自动跟随浏览器语言：中文区域显示中文，其他区域显示英文。

[English](README.md) | [中文](README.zh.md)

---

## ✨ 功能特性

- **会话详情头部归档按钮** — 会话页顶部一键把当前会话移入回收站（免确认，随时可找回）。
- **不与 DSH 自带入口重复** — 侧边栏会话行的归档入口统一使用 DSH 自带的悬浮归档按钮；本插件不再注入第二个、措辞不同的图标（0.4.4 起移除了旧的行内垃圾桶，并去掉了驱动它的全文档 MutationObserver）。
- **回收站管理器**（设置 → 🗑 会话回收站）— 已归档会话多选：批量还原、批量彻底删除；条目显示 ID 与路径。
- **真正的彻底删除** — 物理清除磁盘日志与投影缓存；无日志的幽灵会话被彻底清理，不会残留。
- **活跃会话保护** — 正在运行（有活跃 agent）的会话拒绝删除。
- **子会话可见可控** — 每行可显示该会话留下的子代理会话数量（任意层级全树），并可就地展开：标题、大小、时间、运行状态，逐个勾选。彻底删除会一并清除整棵子树；未勾选的会保留，并以「已删除的主会话 · 保留 N 个子会话」的形式继续可见，而不是变成看不见、够不着的残留。
- **运行中的子代理会拦住删除** — 只要该会话的子树里还有子会话在运行就拒绝删除，并点名是哪一个。
- **批量容错** — 批量操作逐条执行，收集并汇报失败项。
- **浅色/深色自适应界面** — 所有颜色以 CSS 变量（设计令牌）收敛在 `client.css`，组件优先跟随 DSH 应用外观（`data-ds-dark-theme`），并以 `prefers-color-scheme` 作为系统级兜底，无硬编码色板。界面与代码文字同样跟随 DSH 全局字体（`--dsw-font-family` / `--ds-font-family-code`），「设置 → 字体」对本插件同样生效。

---

## 📋 环境要求

- **DSH 0.2.0-rc.2 及以上**（本版仅在该版本上测试通过；更低版本未测试）。

  回收站列表的标题与轮数不再读取会话日志，而是取自会话投影缓存（`SessionProjectionCache.cachedSnapshot`，以及为跨格式代际准备的 `cachedPredecessorTitle`）——这正是 DSH 自身会话列表使用的零 I/O 门面。缺少这两个方法的旧宿主上，插件仍能挂载、归档与还原，但列表会退化为「未命名会话」且不显示轮数。

  该下限以 `dsh.engines.dsh` 声明。注意：DSH 0.2.0-rc.2 **并不读取**该字段，因此它是给用户与插件市场看的文档性声明，不是运行时强校验。

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

1. **移入回收站** — 在会话页顶部点「移入回收站」图标：会话进入回收站，并弹出可撤销提示。归档后的会话是否仍显示在左侧列表，由 DSH 侧边栏「视图选项 → 筛选会话」的档位决定（隐藏已归档 / 全部对话 / 仅显示已归档），本插件不做干预，与 DSH 自带按钮行为一致。
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
├── client.js               # browser 半边：会话头部动作 + 设置页回收站
├── client.css              # 插件样式表：设计令牌 + 浅色/深色自适应组件
└── packages/
    └── session-trash-host/ # host 实现（persistence/workspace/cache 补丁、HTTP 路由）
```

### 更新日志规范

`CHANGELOG.md` 与 `CHANGELOG.zh.md` 一一对应。每条按下面写：

- 版本段用 `## [版本] - YYYY-MM-DD`，其下只列实际涉及的 `### Added` / `### Changed` / `### Fixed` / `### Performance` / `### Removed`。
- 每条一个主题：**加粗短句点明结论**，随后 1–2 句说明「改了什么 + 为什么、对用户有什么影响」。
- 不写实现细节、不贴代码、不写测试或验证过程 —— 那些属于 commit / PR。
- 只写用户可感知或破坏性的变化；纯内部重构若无可见影响则不写。

---

## 🔌 工作原理

- **单包 bundle** 同时覆盖两端，与其它已发布插件一致：host 半边由 `cordis.patch.yml` 挂载；浏览器半边经 `dsh.client` + `exports["./client"]` 自动进入模块图。
- 浏览器通过插件自身的 `/api/session-trash/*` HTTP 路由与宿主通信（webserver 注册；非 GET 请求携带 `x-dsh-plugin` CSRF 头）。

---

## 📄 许可证

[MIT](LICENSE)
