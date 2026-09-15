# 更新日志

本项目所有重要变更都记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

[English](CHANGELOG.md) | [中文](CHANGELOG.zh.md)

## [未发布]

### 新增

- 为所有面向用户的客户端界面加入英文本地化。插件跟随浏览器语言：`zh`
  区域继续显示中文，其他区域默认显示英文。已知的服务端兜底标签与错误码在客户端
  完成本地化，不改变宿主端行为。

## [0.4.0] - 2026-09-12

### 修复

- **DSH 0.1.5 上设置里的「会话回收站」整项不出现 —— 注册其实一直是好的，那条导航行被渲染到可视区之外并被裁掉了。** 设置面板把导航列的高度固定为约 808px（17 行 × 44px）：面板自身 `overflow: hidden`，导航列 `overflow: visible`，且没有滚动条。只要窗口高度放不下整个面板，**这一列的尾部就会被直接裁掉，并且滚不到**。我们这条注册用的是 `order: 200`，也就是倒数第二行，于是任何矮于约 800px 的窗口上它都会彻底消失；而会话头部的删除按钮（session 作用域）与侧边栏行按钮始终正常。正是这种“半边好半边坏”的反差，使它看起来像注册问题。

  在线上宿主实测（`dsh web`，DSH 0.1.5-rc.2，1440×800 视口）：该项 `top: 748px / bottom: 788px`，距离底边只剩 12px；到 700px 视口时已是 `bottom: 788 > 700` —— 既看不见也够不到。而槽账本里这条注册一直都在，用别的方式打开该分节时面板也能正常渲染。

  现在 `order` 取 **25**，落在 `20`（dsh-mnemon「Memory System」）与 `30`（dsh-cost-meter「Cost」）之间，属于最上面几行，正常窗口不可能裁到。`order` 在两代际都只是普通数字，0.1.1-rc.2 / 0.1.2-rc.1 不受影响。`tests/client-header-action.test.js` 已固化这个位置——夹具会记录注册项参数，用例断言显式数字 `order < 100` 以及 `id`/`label` 契约——该条目不会再悄悄漂回被裁切的区间。

- **`settings.section` 注册传了契约外的字段。** 它带了 `icon` / `iconName` / `Icon` / `renderIcon`，而 0.1.5 的设置导航行契约只有 `{ id, order, label }`：`dsh-cordis-client-runner` 内置的 slot 目录在 `registerOptions` 下恰好只列 `id`（必填）、`order`、`label`（`string | (() => string)`），那些图标字段属于 0.1.5 之前「每行渲染一个字形」的旧导航。现只保留契约内字段。`label` 仍是 thunk——两个代际都接受（“thunk 在每次投影时被重新读取”）。

- **`dsh.client.inject` 为空，客户端 fiber 因此构建在设置模块的上下文之外。** 该字段是客户端模块图的依赖声明，**所有**向设置/槽系统贡献内容的第三方插件都在此声明宿主模块——`dsh-mnemon`、`dshmarket`、`dsh-context`、`dsh-vision-router`、`@anweat/dsh-browser` 均列有 `@deepseek-ai/dsh-client-ui-settings`，`dsh-better-sidebar`、`dsh-at-file` 列有 `@deepseek-ai/dsh-client-ui-slots`。我们声明的是 `[]`，于是 session 作用域的槽（会话头部删除按钮）照常工作，而 root 作用域的 `settings.section` 注册**被静默地不接纳**——控制台无任何报错，导航项就是不存在。现声明 `@deepseek-ai/dsh-client-ui-settings` 与 `@deepseek-ai/dsh-client-ui-conversation`，并已对照线上 `__DSH_BOOT__` 模块图核实：我们的那一行曾是**唯一** inject 为空的设置/槽贡献者。

- **`exports.inject` 声明了 `typert`，而 DSH 0.1.5 的 Web 客户端已不再提供该服务**（该包甚至未被打包进 Web bundle）。Cordis 规则要求 `inject` 数组里的所有服务必须被提供，否则该插件的 Fiber 会被永久标记为 `INACTIVE`（`epoch = INACTIVE`）。其后果是客户端 `apply(ctx)` 根本未被调用——槽注册（`settings.section` 与会话删除按钮）、样式注入及侧边栏删除按钮初始化完全被挂起。现将 `exports.inject` 移除不存在的 `typert`，并把内部事件监听安全降级为 `ctx?.get?.('typert')?.on?.(...)`。

- **DSH 0.1.5-rc.1 上，会话顶部的「移入回收站」按钮渲染出来了，但点击毫无反应。** 两个叠加原因都在浏览器半边。（1）`currentTitle()` 声明在 `TrashTab` 组件**内部**，却被模块级的 `DeleteSessionAction`（以及侧边栏行注入器）调用，因此每次点击都在发请求、弹提示之前就同步抛出 `ReferenceError`；而这条分支只有在插槽不再传 `session` 时才会走到——0.1.5 正是如此。（2）0.1.5 的插槽运行时不再把当前会话放进 action 的 props，而插件原先的回退（`ctx.sessions.active` / `ctx.sessions.currentId`）在**两代宿主上都不存在**——现在改为同时从 `sessions.list` 快照的 `current` 字段取（0.1.1-rc.2 与 0.1.5-rc.1 都提供）。标题解析已提升到模块级，侧边栏行注入器同一处潜在崩溃也随之消除。

- **`findLog()` 在不同代际宿主返回两种形状，0.1.5 上永久删除与列表元数据因此失效。** 0.1.1/0.1.2 返回路径字符串；0.1.5 的 jsonl 后端返回“代描述符”对象（`{ sourcePath, sourceVersion, currentPath }`），对其调用 `dirname()` 直接抛错——清空失败、文件大小与轮数读成 0。适配层现同时归一化两种形状。单测 mock 此前只覆盖了字符串形状，该回归由新增的真机夹具捕获。

### 新增

- **双代际宿主支持（DSH 0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.1）。** 宿主半边现已适配 0.1.5-rc.1 的持久化重写，同时完整保留旧宿主的每一条路径；改动由 `dsh-upgrade-audit`（npm 模式，0.1.2-rc.1 → 0.1.5-rc.1）驱动：
  - `persistence.list()` 头归一化——0.1.5 返回 `SessionPersistenceSnapshot[]`（`{ header, … }`）而非裸 `SessionHeader[]`；两种形状现均接受（`normalizeStoredHeader`）。
  - 会话事件读取不再依赖 `persistence.inspect()`（0.1.5 已移除）——回退到 `persistence.open(id)` → `handle.read()`（`readSessionEvents`）。
  - 物理日志路径解析不再只依赖 `findLog`/`locate`：`resolveSessionLogPath` 依次尝试 `findLog`（权威、原样返回）→ `locate`（stat 校验候选）→ 与宿主 API 无关的 `~/.dsh/sessions/<project>/<sessionId>/session*.jsonl*` 目录扫描，并识别 0.1.5 的按代命名 `session.v{1..3}.jsonl`。
  - 六个 `dsh` peer 范围放宽为 `^0.1.1-rc.2 || ^0.1.2-rc.1 || ^0.1.5-rc.1`——npm 的预发布规则要求显式并集。`cordis` 保持 `^4.0.1`（本就接受 4.0.2）。
  - 客户端 DOM 锚定与 `archivedSessionIds` 快照读取经核验在 0.1.2 与 0.1.5 之间不变（会话树在 `dsh-client-ui-workspace`，行标记完全相同）。
- **真机沙箱夹具** —— `scripts/verify-real-host.mjs`（`npm run verify:host -- --packages <dir>`）把宿主半边挂载到**真实发布的 DSH 包树**上，按 bundle patch 的原始装配（storage → storage-json → storage-domain → session-persistence-jsonl → workspace），并通过插件自己的 HTTP 路由跑通完整回收站流程：写入真实会话 → `POST /archive` → `GET /list` → `GET /messages` → `POST /purge`，最后断言物理会话目录已被删除。仅 webServer 与投影缓存为桩。脚本具备代际感知（0.1.5 用 handle API，≤0.1.2 用 create+append），并以宿主自身的 `SESSION_FORMAT_VERSION` 写入头。结果：**0.1.2-rc.1 14/14**、**0.1.5-rc.1 14/14**，另有在真实 0.1.5-rc.1 宿主上的完整端到端流程（创建 → 归档 → 列表标题/轮数/文件大小正确 → 消息 → 清空并物理删除 `.jsonl.zstd`）。经 `.npmignore` 排除，不进入 npm 包。
- **针对新失效模式的回归测试** —— 宿主测试 8 固定 0.1.5 持久化形状（快照 `list`、`open`/`read` handle、无 `inspect`、`locate` 候选），测试 9 固定 `findLog` 的“代描述符”形态；`tests/client-header-action.test.js` 以桩 DOM 加载 `client.js`，断言 0.1.5 的 props 形状（`{}`）与旧版形状（显式 `sessionId`）都能归档当前会话、断言不存在模块级代码调用组件内 helper，并断言 `settings.section` 注册保留显式数字 `order < 100`。

### 备注

- 本版修掉的三处契约偏差（`icon`/`iconName`/`Icon`/`renderIcon`、空的 `dsh.client.inject`、未被提供的 `typert`）各自都是与 0.1.5 契约的真实偏差，故予以保留；但**它们都不是导航项消失的原因**——那条注册始终都在，只是一直被裁掉。用户所报症状由本次的位置调整修复。
- **裁切本身是宿主缺陷**（`dsh-client-ui-settings-general`：`nav { overflow: visible }` 套在 `panel { overflow: hidden }` 里，行栈固定 808px，且不可滚动）。它会让所有 order 偏大的分节都丢掉末尾一到两行。建议向上游反馈；本插件刻意不去改宿主的 DOM。
- DSH ≤ 0.1.2 的外观取舍：该代际的设置导航字形读自同一条注册，因此那里现在会渲染成不带自定义垃圾桶图标的条目。功能不受影响（0.1.5 的导航根本没有图标位）。
- 兼容性已在 DSH **0.1.1-rc.2**、**0.1.2-rc.1**、**0.1.5-rc.1** 上验证。0.1.5 的发布前清单——真实 `webServer.register` 路由鉴权、`x-dsh-plugin` CSRF 接缝、真实 profile 上的归档/清空端到端——已全部完成。

## [0.3.3] - 2026-09-02

### 修复

- **对运行中的 dsh web 覆盖安装新版本后，进程里跑的仍是旧代码——回收站列表因此一直显示“0 轮对话”，修什么都无效。** 三层原因叠加，现已在插件侧绕过：dshmarket 只对“新增包”做热挂载（对已安装同名包的安装从不热激活）；所有热激活路径（market 热挂载、loader entry 更新）都以同一模块 URL 导入本包，Node 的 ESM 缓存永远返回进程最早加载的那个模块对象；loader 的同名 entry 更新更是直接复用旧的 runtime callback。`index.js` 现在是一个**字节级稳定的加载 shim**，其 `apply()` 通过 `?<文件sha256>` 导入实现文件：内容相同则复用缓存模块，内容变化（磁盘上装了新版本）则获得全新 URL、加载全新代码——因此**重启一次进入本 shim 后**，卸载→安装（或市场里停用→启用）即可在进程内换版本、无需重启。纯覆盖安装仍需重启——那是 dshmarket 的激活设计，非插件可控。shim 文件本身今后永不再改；所有版本间变更都放在实现文件里。
- **旧 fiber 泄漏的 registry 补丁现在能继续正常工作，而不再退化为 0 轮。** `patchWorkspaceRegistry` 改为打补丁时快照 `sessionPersistence`，`listArchivedSessions()` / `permanentlyDeleteSession()` 不再在调用时经（可能已死的）ctx 访问器解析服务——正是那个被静默吞掉、把轮数归零的抛错。安全的 `ctx.get(...)` 查找保持动态。

### 新增

- 生命周期回归测试：泄漏的 `listArchivedSessions` 引用在其 fiber 卸载后必须仍能数出轮数；入口 shim（从 ESM 缓存取得）在实现文件被替换后必须挂载**磁盘上当前**的实现（两项在 v0.3.2 上均失败）。

## [0.3.2] - 2026-09-02

### 修复

- **不重启进程卸载再重装插件后，回收站列表每条会话显示“0 轮对话”，而点击查看预览正常。** 这是 v0.3.1 路由泄漏的姊妹问题：打在**共享 `workspaceRegistry` 服务**上的方法补丁（`listArchivedSessions` 等）在所属 fiber 卸载后仍残留在服务对象上，新实例的 `typeof x !== 'function'` 守卫看到方法已存在就拒绝重新打补丁——于是列表一直在调用闭包捕获**已销毁 ctx** 的旧方法：`ctx.sessionPersistence` 在逐会话 try/catch 里抛出被吞，轮数静默归零；而预览（路由每次挂载重建、挂载时快照服务）不受影响。现在所有服务补丁**可逆且带令牌标记**：每次安装给自己新增的方法（`persistence.delete` 则是包装器）打上专属 token，新安装会覆盖发现的任何陈旧补丁——**直接原地治愈线上已损坏的进程**——fiber 卸载时只移除仍携带自己 token 的方法。<= v0.3.1 遗留的无 ctx 依赖补丁（旧 `persistence.delete` 包装器、`cache.remove`）会被识别并保留，绝不嵌套包装。

### 新增

- 新失效模式的生命周期回归测试：卸载 + 重装后 `listArchivedSessions()` 必须仍绑定活 ctx（轮数与衍生标题存活）；在陈旧无标记（<= v0.3.1）的 registry 方法上挂载必须原地治愈。

## [0.3.1] - 2026-09-02

### 修复

- **回收站轮数显示为“0 轮对话”、点击查看报 `cannot get required service "sessionPersistence" in inactive context`**：在不重启 `dsh web` 的情况下重装插件（以及一切进程内 fiber 重载场景：loader 配置更新、依赖服务重启）会触发。根因是 `/api/session-trash/*` 路由的注销函数只存在类实例字段里，而 `@deepseek-ai/cordis@4` 从不调用实例的 dispose()——旧 fiber 卸载后路由泄漏（handler 仍绑定已失活的 ctx），重载的新实例又因 `webServer.register` 路径重复抛错而起不来，插件从此瘫痪直至重启进程。现在通过 `ctx.effect(...)` 把路由注销挂到所属 fiber 的生命周期（框架的 register() disposer 契约）：卸载时清空路由表、重载时干净重注册，v0.3.1 起重装插件不再需要重启（但从已泄漏路由的旧版本升级仍需重启一次，泄漏表只有重启能清）。路由 handler 也改为挂载时快照 `sessionPersistence`，不再每次请求经 ctx 重新解析。
- 插件 fiber 重载时 `SessionPersistence.delete` 不再被二次包装（补丁幂等）。
- 路径重复导致注册失败时，报错会说明是先前实例泄漏的路由占用了路径、重启 `dsh web` 可清理，而不是只有一句裸的 `webserver: duplicate exact route ...`。

### 新增

- fiber 生命周期回归测试（`tests/reload-lifecycle.test.js`）：在 `node_modules/.pnpm` 中自动发现真实 `@deepseek-ai/cordis` 并用真实运行时驱动插件（未安装时自动跳过）——插件 restart 不得泄漏或丢失路由，完整卸载必须注销全部路由。

## [0.3.0] - 2026-09-02

### 新增

- **浅色/深色自适应界面**（PR #1，作者 [@1MLightyears](https://github.com/1MLightyears)）：全部内联样式迁移至独立 `client.css`，由 host 以 `GET /api/session-trash/client.css` 提供服务（懒读取、`no-cache`），`client.js` 以 `<link rel="stylesheet">` 注入；颜色收敛为 `--dstrb-*` 设计令牌并新增暗色配色（卡片、弹窗、预览气泡、Markdown、toast、tooltip 全覆盖）；补充路由测试并更新 README 说明。

### 修复

- **暗色配色解析改为跟随 DSH 应用外观而非仅跟随 OS**：DSH 将外观偏好（浅色/深色/跟随系统）的解析结果落到 `body[data-ds-dark-theme]` 上，`@media (prefers-color-scheme: dark)` 无法感知。暗色令牌现在在 `body[data-ds-dark-theme]` 命中或 OS 媒体查询命中（保留为兜底）时生效，且应用明确为浅色时通过 `body:not([data-ds-dark-theme])` 恢复浅色令牌——修复「应用浅色 + OS 深色」时主标题白字白底不可读的问题，也补上纯媒体查询方案下「应用深色 + OS 浅色」不生效的缺口。
- 回收站页面内的原生表单控件（select、checkbox、滚动条）通过作用域化的 `color-scheme` 规则跟随插件解析后的配色模式，不再被 OS 媒体查询带偏。

## [0.2.2] - 2026-09-01

### 修复

- **新建会话的侧边栏悬浮删除按钮丢失**：空白 "New Session" 行上注入的按钮此前被插到行首，随后被 React 重渲染移除，留下"已注入"标记但无按钮的卡死状态。现在按钮插在状态点与标题之间（与正常行一致），并新增自愈逻辑：标记存在但按钮丢失时自动清除标记并重新注入。
- **同名会话（如多个「你好」）无法删除**：浏览器会话 store 的 `byId` 保留已归档会话，导致唯一一个 live 的「你好」也无法唯一匹配。现在会先通过 `workspaces` 的 `archivedSessionIds` 排除已归档会话；只剩一个 live 同名会话时直接绑定。
- **多个 live 同名会话**：选中的行绑定当前会话；其余行按列表时间顺序位置消歧，并以相对时间标签的单调性校验为门控——顺序无法确认时保持对齐但不显示按钮���避免误删其它同名会话。
- **测试套件无法运行**（`tests/*.test.js` 使用了 `afterEach`/`rm` 但未导入）——已修复导入，`npm test` 可执行全部 18 个 host 测试。

### 变更

- 无法安全解析会话 ID 的侧边栏行保持等宽隐形占位，所有行对齐（不再出现"往左靠"的行）。

## [0.2.1] - 2026-08-27

### 修复

- 修复 `package.json` 中递归的自依赖条目，解决 npm 安装 ENOENT 错误。

## [0.2.0] - 2026-08-27

### 新增

- **工作区分组与卡片**：归档会话按工作区卡片分类展示（`📁 {workspaceTitle}`）。
- **多选与批量操作**：每个会话条目上的胶囊复选框，配合动态工作区 `•••` 操作菜单（"彻底删除选中 (N)" / "彻底删除项目全部"）。
- **会话预览弹窗**：以聊天气泡查看历史用户与助手对话，完整 Markdown 渲染。
- **头部工具栏**：等比例 1:1 CSS 网格布局，支持模糊搜索、工作区筛选、排序（最新 / 最早）。
- **富卡片元数据**：显示准确的用户轮数、格式化文件大小徽标（`DiskIcon`）与删除时间。
- **悬停提示**：悬停 200ms 快速提示，显示完整会话标题、ID 与绝对路径。

### 修复与改进

- **侧边栏悬停图标**：恢复左侧会话树标题前的左对齐悬停删除图标（`🗑`）。
- **标题冻结与持久化**：归档会话永久冻结原始人类标题（`archivedTitles` 映射），避免回退为 `sessionId`。
- **准确轮数统计**：改进 JSONL prompt 检测，只统计真实 `USER_INPUT` 轮次，避免系统误判。
- **即时还原同步**：触发 5 路 Harness 原生 sessionStore 事件，还原后的会话立即出现在侧边栏。

## [0.1.4] - 2026-08-27

### 修复

- 禁止从侧边栏或头部归档（移入回收站）正在运行的会话。
- 尝试删除或彻底删除运行中会话时给出清晰的中文 toast 提示。
- 用浮动 toast 提示（`showToastLayer`）替换浏览器 `alert()`。
- 修复批量彻底删除只从浏览器状态移除成功删除的会话。

## [0.1.0] - 2026-08-25

### 新增

- `dsh-session-recycle-bin` 首个版本。
- 侧边栏逐会话删除图标（悬停显示，点击归档）。
- 当前会话的会话头部删除按钮。
- 设置页回收站管理器：多选批量还原 / 批量彻底删除。
- 真正的彻底删除：物理移除会话日志与投影缓存记录。
- 幽灵会话清理：无物理日志的会话被彻底移除而非残留。
- 活跃会话保护：有活跃 agent 的会话拒绝删除。
- 批量容错：逐条执行并收集汇报失败项。
- 插件通过 `/api/session-trash/*` webserver 路由传输，带 CSRF 头。
