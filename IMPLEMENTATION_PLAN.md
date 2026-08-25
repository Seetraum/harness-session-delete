# DSH 会话删除与回收站 — 实现计划

> 基于源码分析评审，2026 年。目标：在现有 `archivedSessionIds` 基础设施上，
> 补全还原（unarchive）、永久删除（permanent delete）、回收站列表能力，
> 并通过 RPC 暴露给浏览器端。

## 涉及包列表

| 包名 | 角色 | 变更类型 |
|---|---|---|
| `@deepseek-ai/dsh-session-persistence` | 抽象持久化层 | 新增 `delete(id)` 抽象方法 |
| `@deepseek-ai/dsh-session-persistence-jsonl` | JSONL 后端 | 实现 `delete(id)` → `rm -rf` 会话目录 |
| `@deepseek-ai/dsh-session-projection-cache` | 投影缓存 | 新增 `remove(id)` 公开方法 |
| `@deepseek-ai/dsh-workspace` | 工作区注册表 | 新增 `unarchiveSession` / `permanentlyDeleteSession` / `listArchivedSessions` |
| `@deepseek-ai/dsh-host-apiproxy` | RPC API 代理 | 扩展 `WorkspaceApi` 接口 + schemas + RpcMethodMap |
| `@deepseek-ai/dsh-api-remotes` | Client Remote 装配 | 重新导出新类型（type-only） |
| `@deepseek-ai/dsh-client-connection` | 浏览器连接 | 重新导出新类型（type-only） |
| `@deepseek-ai/dsh-client-ui-workspace` | 侧边栏工作区 UI | 无需变更（archive 动作已存在） |
| **新插件** `ui-settings-trash` | 回收站设置页 | 新建包，注册到 `settings.plugins.tab` slot |
| `cordis.patch.yml` | 组合链注册 | 添加新插件行 |

---

## 阶段 1：持久化层 — `delete(id)`

### 1.1 抽象层：`dsh-session-persistence`

**文件**：`lib/index.js`（SessionPersistence 类）

在 `listSnapshots` 方法之后，添加：

```js
/**
 * Permanently delete one session's entire durable log.
 * The id will resolve even when no log was ever materialized
 * (idempotent — a create-never-appended session leaves nothing).
 * @param {SessionId} id - The session whose durable log to delete.
 * @returns {Promise<void>} resolution after the durable log is gone.
 */
async delete(id) {
  throw new Error('not implemented');
}
```

**类型文件**：`lib/types/index.d.ts`

在 `listSnapshots` 之后，`readRaw` 之前，添加：

```typescript
/**
 * Permanently delete one session's entire durable log.
 * Idempotent: resolves without error even when no log was ever
 * materialized (create-never-appended).
 * @param id - The session whose durable log to delete.
 */
abstract delete(id: SessionId): Promise<void>;
```

### 1.2 JSONL 后端实现：`dsh-session-persistence-jsonl`

**文件**：`lib/index.js`（JsonlSessionPersistence 类）

```js
/**
 * Permanently delete one session's stored log directory.
 * Idempotent: a never-materialized session resolves without error.
 * @param {SessionId} id - The session to delete.
 * @returns {Promise<void>} resolution after the durable directory is removed.
 */
async delete(id) {
  // Resolve the absolute directory for this session
  const logPath = await this.findLog(id);
  if (logPath === undefined) return; // never materialized — idempotent
  const dir = path.dirname(logPath);
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // already gone — idempotent
  }
  // Optionally clean up empty parent project directory
  const parentDir = path.dirname(dir);
  try {
    const entries = await fs.promises.readdir(parentDir);
    if (entries.length === 0) {
      await fs.promises.rmdir(parentDir);
    }
  } catch {
    // Best-effort: parent may already be gone or have new entries
  }
}
```

> `findLog(id)` 是现有私有方法，遍历项目目录查找匹配的会话日志文件并返回其路径。

**类型文件**：`lib/types/index.d.ts`

在 `readRaw` 之后添加声明：

```typescript
delete(id: SessionId): Promise<void>;
```

---

## 阶段 2：投影缓存 — `remove(id)`

### 2.1 `dsh-session-projection-cache`

**文件**：`lib/index.js`（SessionProjectionCache 类）

```js
/**
 * Remove one session's cached checkpoint record durably.
 * Fail-soft: a missing row resolves without error (the cache
 * is never an authority).
 * @param {SessionId} id - The session to remove from the cache.
 * @returns {Promise<void>} resolution after the durable row is gone.
 */
async remove(id) {
  const table = this.requireTable();
  try {
    await table.delete(id);
  } catch (error) {
    // Fail-soft: cache writes/delete must never fail their caller
    this.ctx.logger?.warn?.('session-projection-cache: remove(%s) failed: %s', id, error.message);
  }
  this.markClean(id);
}
```

**类型文件**：`lib/types/index.d.ts`

在 `coldSnapshot` 之后添加：

```typescript
/**
 * Remove one session's cached checkpoint record durably (fail-soft).
 * @param id - The session to remove from the cache.
 */
remove(id: SessionId): Promise<void>;
```

---

## 阶段 3：工作区注册表 — 还原 / 永久删除 / 列表

### 3.1 `dsh-workspace` — WorkspaceRegistry

**文件**：`lib/index.js`（WorkspaceRegistry 类）

在 `archiveSession` 方法之后添加三个新方法：

#### `unarchiveSession(sessionId)` — 还原

```js
/**
 * Remove one session from the registry-global archive set, restoring
 * its visibility on every grouping surface. The session's workspace
 * accounting slot is untouched (it was preserved at archive time).
 * An id not currently archived resolves without writing.
 * @param {SessionId} sessionId - The session to unarchive.
 * @returns {Promise<void>} resolution after durability.
 */
unarchiveSession(sessionId) {
  return this.enqueueOperation(async () => {
    const state = this.requireState();
    if (!state.archivedSessionIds.includes(sessionId)) return;
    await this.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId)
    });
  });
}
```

#### `permanentlyDeleteSession(sessionId)` — 永久删除

```js
/**
 * Permanently delete one session: its durable log, cached
 * projections, every workspace accounting slot, and its archive-set
 * membership (if present). An unknown id is idempotent for the
 * workspace/archive cleanup but still attempts physical deletion
 * (the log may exist without any workspace accounting).
 *
 * Rejects when the session is currently live (loaded in ctx.sessions),
 * because a running session's log is the durable source of truth.
 * @param {SessionId} sessionId - The session to permanently delete.
 * @returns {Promise<void>} resolution after all durable state is removed.
 */
async permanentlyDeleteSession(sessionId) {
  // --- guard: never delete a live session ---
  const sessions = this.ctx.get('sessions');
  if (sessions?.get(sessionId) !== undefined) {
    throw new Error(`cannot permanently delete session '${sessionId}': session is currently running`);
  }

  // --- 1. physical log deletion ---
  try {
    await this.ctx.sessionPersistence.delete(sessionId);
  } catch (error) {
    // Propagate storage faults; do not silently continue
    throw new Error(`failed to delete session log for '${sessionId}'`, { cause: error });
  }

  // --- 2. projection cache cleanup ---
  const cache = this.ctx.get('sessionProjectionCache');
  if (cache?.remove !== undefined) {
    await cache.remove(sessionId);
  }

  // --- 3. detach from every workspace that accounts it ---
  for (const entity of this.entities.values()) {
    if (entity.record.sessionIds.includes(sessionId)) {
      await entity.detachSession(sessionId);
    }
  }

  // --- 4. remove from archive set ---
  return this.enqueueOperation(async () => {
    const state = this.requireState();
    if (!state.archivedSessionIds.includes(sessionId)) return;
    await this.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId)
    });
  });
}
```

#### `listArchivedSessions()` — 回收站列表

```js
/**
 * List every archived session with display fields for the recycle-bin
 * surface. Cross-references session persistence for title and cwd,
 * and workspace accounting for directory hints.
 * @returns {Promise<Array<{sessionId: SessionId, title: string, cwd?: string, workspacePath?: string, workspaceTitle?: string}>>} archived session details.
 */
async listArchivedSessions() {
  const state = this.requireState();
  const archivedIds = state.archivedSessionIds;
  if (archivedIds.length === 0) return [];

  // Read all stored headers for title / cwd
  const headers = await this.ctx.sessionPersistence.list();
  const byId = new Map(headers.map((h) => [h.id, h]));

  // Map workspace paths for each session
  const workspaceBySession = new Map();
  for (const entity of this.entities.values()) {
    for (const sid of entity.record.sessionIds) {
      if (archivedIds.includes(sid) && !workspaceBySession.has(sid)) {
        workspaceBySession.set(sid, {
          workspacePath: entity.record.path,
          workspaceTitle: entity.record.title,
        });
      }
    }
  }

  return archivedIds.map((sessionId) => {
    const header = byId.get(sessionId);
    const ws = workspaceBySession.get(sessionId);
    return {
      sessionId,
      title: header?.title ?? String(sessionId),
      cwd: header?.cwd,
      workspacePath: ws?.workspacePath,
      workspaceTitle: ws?.workspaceTitle,
    };
  });
}
```

**类型文件**：`lib/types/index.d.ts`

在 `archiveSession` 声明之后添加：

```typescript
/**
 * Remove one session from the archive set, restoring visibility.
 * @param sessionId - The session to unarchive.
 */
unarchiveSession(sessionId: SessionId): Promise<void>;

/**
 * Permanently delete one session: durable log, cached projections,
 * workspace accounting, and archive membership. Rejects for live sessions.
 * @param sessionId - The session to permanently delete.
 */
permanentlyDeleteSession(sessionId: SessionId): Promise<void>;

/** One row projected from the archive set for a recycle-bin surface. */
export interface ArchivedSessionView {
  sessionId: SessionId;
  title: string;
  cwd?: string;
  workspacePath?: string;
  workspaceTitle?: string;
}

/**
 * List every archived session with display fields.
 * @returns archived session details in archive order.
 */
listArchivedSessions(): Promise<ArchivedSessionView[]>;
```

---

## 阶段 4：RPC 层暴露

### 4.1 `dsh-host-apiproxy` — WorkspaceApi 接口扩展

**文件**：`lib/types/api/workspace.d.ts`

在 `archiveSession` 声明之后添加三个新方法：

```typescript
/**
 * Removes one session from the registry-global archive set, restoring
 * its visibility everywhere. An id not currently archived resolves
 * without error. Returns the full updated archive set.
 */
unarchiveSession(request: RpcRequest<{
    sessionId: SessionId;
}>): Promise<RpcResponse<{
    archivedSessionIds: SessionId[];
}>>;

/**
 * Permanently deletes one session: durable log, cached projections,
 * every workspace accounting slot, and archive-set membership.
 * Rejects for a currently running session. Unknown sessions are
 * idempotent for workspace/archive cleanup.
 */
permanentlyDeleteSession(request: RpcRequest<{
    sessionId: SessionId;
}>): Promise<RpcResponse<{
    deleted: true;
}>>;

/** One row in the recycle-bin surface. */
export interface ArchivedSessionView {
    sessionId: SessionId;
    title: string;
    cwd?: string;
    workspacePath?: string;
    workspaceTitle?: string;
}

/**
 * Lists every archived session with display fields for the
 * recycle-bin surface. Cross-references session persistence and
 * workspace accounting.
 */
listArchivedSessions(request: RpcRequest<{}>): Promise<RpcResponse<{
    items: ArchivedSessionView[];
}>>;
```

### 4.2 Schemas

**文件**：`lib/types/api/workspace.schema.d.ts`

在现有 `workspaceArchiveSessionValueSchema` 之后添加：

```typescript
/** workspace.unarchiveSession request payload. */
export declare const workspaceUnarchiveSessionRequestSchema: z.ZodObject<{
    sessionId: z.ZodType<SessionId, unknown, ...>;
}, ...>;

/** workspace.unarchiveSession response value. */
export declare const workspaceUnarchiveSessionValueSchema: z.ZodObject<{
    archivedSessionIds: z.ZodArray<z.ZodType<SessionId, unknown, ...>>;
}, ...>;

/** workspace.permanentlyDeleteSession request payload. */
export declare const workspacePermanentlyDeleteSessionRequestSchema: z.ZodObject<{
    sessionId: z.ZodType<SessionId, unknown, ...>;
}, ...>;

/** workspace.permanentlyDeleteSession response value. */
export declare const workspacePermanentlyDeleteSessionValueSchema: z.ZodObject<{
    deleted: z.ZodLiteral<true>;
}, ...>;

/** workspace.listArchivedSessions request payload (empty). */
export declare const workspaceListArchivedSessionsRequestSchema: z.ZodObject<{}, ...>;

/** workspace.listArchivedSessions response value. */
export declare const workspaceListArchivedSessionsValueSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        sessionId: z.ZodType<SessionId, unknown, ...>;
        title: z.ZodString;
        cwd: z.ZodOptional<z.ZodString>;
        workspacePath: z.ZodOptional<z.ZodString>;
        workspaceTitle: z.ZodOptional<z.ZodString>;
    }, ...>>;
}, ...>;
```

### 4.3 RpcMethodMap 注册

**文件**：`lib/types/api/rpc-map.d.ts`

在 `'workspace.archiveSession'` 之后添加：

```typescript
'workspace.unarchiveSession': WorkspaceApi['unarchiveSession'];
'workspace.permanentlyDeleteSession': WorkspaceApi['permanentlyDeleteSession'];
'workspace.listArchivedSessions': WorkspaceApi['listArchivedSessions'];
```

### 4.4 ApiProxy 实现（JS）

**文件**：`lib/` 中对应的 workspace API handler JS 文件

需要将三个新 RPC 方法路由到 `ctx.workspaceRegistry`：

```js
// workspace.unarchiveSession
async unarchiveSession({ payload }) {
  await ctx.workspaceRegistry.unarchiveSession(payload.sessionId);
  return { archivedSessionIds: [...ctx.workspaceRegistry.archivedSessionIds] };
}

// workspace.permanentlyDeleteSession
async permanentlyDeleteSession({ payload }) {
  await ctx.workspaceRegistry.permanentlyDeleteSession(payload.sessionId);
  return { deleted: true };
}

// workspace.listArchivedSessions
async listArchivedSessions() {
  const items = await ctx.workspaceRegistry.listArchivedSessions();
  return { items };
}
```

---

## 阶段 5：浏览器端类型链

### 5.1 `dsh-api-remotes` 重新导出

在 `lib/types/client/index.d.ts` 中补充导出：

```typescript
export type { ArchivedSessionView } from '@deepseek-ai/dsh-host-apiproxy/api';
```

### 5.2 `dsh-client-connection` 重新导出

在 `lib/types/client/index.d.ts` 或 `lib/types/client/api.d.ts` 中补充导出：

```typescript
export type { ArchivedSessionView } from '@deepseek-ai/dsh-host-apiproxy/api';
```

---

## 阶段 6：回收站设置页（新插件 `ui-settings-trash`）

### 6.1 包结构

```
ui-settings-trash/
├── package.json
├── lib/
│   ├── index.js          # apply(ctx) — 注册到 settings.plugins.tab
│   ├── invariant.js
│   └── types/
│       ├── index.d.ts
│       └── client/
│           ├── index.d.ts       # apply(ctx: ClientContext)
│           ├── TrashTab.d.ts    # React 组件
│           └── contract/
│               └── slots.d.ts   # slot 注册声明
```

### 6.2 Slot 注册

注册到 `settings.plugins.tab`（`kind: 'list'`）：

```typescript
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.plugins.tab': {
      // ... 现有声明不变，新条目以运行时注册方式添加
    };
  }
}
```

插件在 `apply()` 中通过 `ctx.slots.register('settings.plugins.tab', {...})` 注册：

```js
export function apply(ctx) {
  ctx.slots.register('settings.plugins.tab', {
    id: 'trash',
    order: 200,
    label: ctx.t('trash:tabLabel', '会话回收站'),
    render: TrashTab,
  });
}
```

### 6.3 回收站 Tab UI（React 组件）

```
┌──────────────────────────────────────────┐
│  会话回收站                       [清空回收站] │
│                                          │
│  ┌──────────────────────────────────────┐│
│  │ 📝 会话标题          workspace 路径   ││
│  │ /Users/.../project   2024-01-15      ││
│  │ [还原]  [永久删除]                    ││
│  ├──────────────────────────────────────┤│
│  │ 📝 另一个会话        workspace 路径   ││
│  │ ...                                  ││
│  └──────────────────────────────────────┘│
│                                          │
│  共 N 个会话在回收站中                     │
└──────────────────────────────────────────┘
```

核心数据流：
- 挂载时调用 `ctx.remote.workspace.listArchivedSessions({})`
- 监听 `host/archived-sessions-changed` 帧增量更新
- 还原 → `ctx.remote.workspace.unarchiveSession({ sessionId })`
- 永久删除 → `ctx.remote.workspace.permanentlyDeleteSession({ sessionId })`（弹确认框）
- 清空回收站 → 对每个条目调用 `permanentlyDeleteSession`（弹严厉确认框）

### 6.4 确认对话框

- **还原**：轻量 toast，可撤销（"已还原「会话标题」[撤销]"）
- **永久删除**：Modal — "永久删除「会话标题」后无法恢复，其所有对话记录将被清除。确认？"
- **清空回收站**：Modal — "将永久删除回收站中全部 N 个会话，此操作不可撤销。确认？"

---

## 阶段 7：注册到组合链

### 7.1 `cordis.patch.yml`

在 `ui-settings-plugins` 之后添加新行：

```yaml
    # Recycle bin for archived sessions: restore or permanently delete.
    - id: ui-settings-trash
      name: '@deepseek-ai/dsh-client-ui-settings-trash'
```

---

## 测试验证清单

- [ ] `sessionPersistence.delete(id)` — 会话目录物理删除，不存在时 idempotent
- [ ] `sessionProjectionCache.remove(id)` — 缓存记录删除，不存在时 fail-soft
- [ ] `unarchiveSession` — 从 `archivedSessionIds` 移除，`HostFrame` 推送更新
- [ ] `unarchiveSession` — 原本有 workspace 槽位的会话还原后恢复可见
- [ ] `permanentlyDeleteSession` — 活跃会话拒绝删除
- [ ] `permanentlyDeleteSession` — 日志 + 缓存 + workspace 关联 + archive 全部清理
- [ ] `permanentlyDeleteSession` — 未知会话 idempotent
- [ ] `listArchivedSessions` — 返回标题/cwd/workspace 信息
- [ ] RPC 调用三个新方法成功
- [ ] 回收站 Tab 正确渲染
- [ ] 还原/永久删除/清空操作正确
- [ ] 撤销还原（toast action）正常工作
- [ ] `HostFrame['host/archived-sessions-changed']` 正确推送