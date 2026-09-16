/**
 * Session Trash Host plugin
 *
 * Extends the running DSH instance with:
 *  - SessionPersistence.delete(id) — physical log deletion
 *  - SessionProjectionCache.remove(id) — cache record cleanup
 *  - WorkspaceRegistry.unarchiveSession(sessionId) — restore from archive
 *  - WorkspaceRegistry.permanentlyDeleteSession(sessionId) — full cleanup
 *  - WorkspaceRegistry.emptyArchivedSessions() — batch permanent delete
 *  - WorkspaceRegistry.listArchivedSessions() — recycle-bin listing
 *  - Typert RPC methods: workspace.unarchiveSession,
 *    workspace.permanentlyDeleteSession, workspace.emptyArchivedSessions,
 *    workspace.listArchivedSessions
 *
 * This plugin patches the existing services at init time. It is designed
 * to be loaded via cordis.patch.yml and works with the compiled DSH packages.
 */
import { rm, readdir, rmdir, stat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Robust Service base class fallback for standalone testing environment
let ServiceClass;
try {
  const cordis = await import('@deepseek-ai/cordis');
  ServiceClass = cordis.Service;
} catch {
  ServiceClass = class Service {
    static init = Symbol.for('cordis.init');
    constructor(ctx, name) {
      this.ctx = ctx;
      this.name = name;
    }
  };
}

/* ------------------------------------------------------------------ */
/*  Helper: Broadcast session state change                             */
/* ------------------------------------------------------------------ */

function notifyArchivedSessionsChanged(ctx, archivedSessionIds) {
  try {
    ctx.emit?.('workspace/archived-sessions-changed', { archivedSessionIds });
    // The browser-side refresh rides the STOCK workspace broadcast: the
    // in-box api-proxy detects the archived-set change and pushes
    // `host/archived-sessions-changed` over the connection itself.
  } catch (error) {
    ctx.logger?.warn?.('session-trash-host: failed to broadcast archived sessions change: %s', error.message);
  }
}

/* ------------------------------------------------------------------ */
/*  Dual-cohort helpers (DSH 0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.1)     */
/* ------------------------------------------------------------------ */

/**
 * Normalize one item from persistence.list() across host cohorts.
 * 0.1.1/0.1.2 list() returns SessionHeader[] (the header itself); 0.1.5
 * returns SessionPersistenceSnapshot[] ({ header, revision, ... }). Both
 * expose the durable SessionHeader, just at different depths.
 * @param {object|undefined} item
 * @returns {object|undefined} the SessionHeader (with .id/.title/.cwd).
 */
function normalizeStoredHeader(item) {
  if (!item) return undefined;
  if (typeof item.id === 'string') return item; // older cohort: raw header
  if (item.header && typeof item.header.id === 'string') return item.header; // 0.1.5 snapshot
  return undefined;
}

/**
 * Resolve one session's physical log path across host cohorts.
 *
 * Priority:
 *  1. persistence.findLog(id)      — older host service method (0.1.1/0.1.2:
 *                                    a path string; 0.1.5: a generation
 *                                    descriptor — both normalized here).
 *  2. persistence.locate({id})     — older service API; still present on the
 *                                    jsonl backend in 0.1.5 ({kind, path}).
 *  3. physical directory scan      — the stable on-disk contract across every
 *                                    0.1.x host: ~/.dsh/sessions/<project>/<sessionId>/session*.jsonl*.
 *                                    This is host-API-independent and also the
 *                                    only mechanism that works when the service
 *                                    stops forwarding locate (0.1.5).
 * @param {object|undefined} persistence ctx.sessionPersistence
 * @param {string} sessionId
 * @returns {Promise<string|undefined>} resolved log path, or undefined.
 */
async function resolveSessionLogPath(persistence, sessionId) {
  // findLog is the AUTHORITATIVE resolver on older hosts: a returned path —
  // even when the file is already gone — means this session has a log
  // location (permanentlyDeleteSession then keeps the workspace slot); a
  // missing answer means the session is a ghost with no log known at all.
  // Its answer is therefore returned verbatim. locate() is a CANDIDATE path
  // computation that never checks existence, so a located candidate counts
  // only when the file is actually there. The physical scan returns only
  // files that exist.
  try {
    if (typeof persistence?.findLog === 'function') {
      const found = await persistence.findLog(sessionId);
      // 0.1.1/0.1.2 return the log path directly; 0.1.5 returns a generation
      // descriptor ({ sourcePath, sourceVersion, currentPath }) — verified
      // against the real 0.1.5 jsonl backend in the sandbox harness.
      const resolved = typeof found === 'string'
        ? found
        : (found?.currentPath ?? found?.sourcePath);
      if (typeof resolved === 'string' && resolved) return resolved;
    }
  } catch { /* fall through */ }

  try {
    if (typeof persistence?.locate === 'function') {
      const loc = persistence.locate({ id: sessionId });
      const candidate = loc?.path ?? (typeof loc === 'string' ? loc : undefined);
      if (candidate && await fileExists(candidate)) return candidate;
    }
  } catch { /* fall through */ }

  return scanSessionLogPath(sessionId);
}

/** True when the path names a regular file on disk. */
async function fileExists(path) {
  if (!path) return false;
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Physical directory scan for a session log file. Layout (all 0.1.x hosts):
 *   ~/.dsh/sessions/<workspace-path-encoded>/<sessionId>/session.jsonl
 *   ~/.dsh/sessions/<workspace-path-encoded>/<sessionId>/session.v{1..3}.jsonl
 * plus the optional .zstd compression suffix. Recognises both the legacy
 * plain name and the 0.1.5 versioned generations.
 * @param {string} sessionId
 * @returns {Promise<string|undefined>}
 */
async function scanSessionLogPath(sessionId) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return undefined;
  const root = join(home, '.dsh', 'sessions');
  try {
    const projects = await readdir(root);
    for (const project of projects) {
      const sessionDir = join(root, project, sessionId);
      const names = await readdir(sessionDir).catch(() => []);
      const logName = names.find((n) => /^session(?:.v\d+)?\.jsonl(?:\.zstd)?$/.test(n));
      if (logName) return join(sessionDir, logName);
    }
  } catch { /* best effort */ }
  return undefined;
}

/**
 * Session ids whose event read failed and was reported once, so a broken
 * artifact doesn't turn every recycle-bin refresh into a log flood.
 */
const readFailureReported = new Set();

/**
 * Read one stored session's events across host cohorts.
 *  1. persistence.inspect(id)                   — older host (0.1.1/0.1.2),
 *                                                 returns { events }.
 *  2. persistence.open(id, 'read') → handle.read() → { events } — 0.1.5
 *     handle API.
 *
 * WHY THE ACCESS ARGUMENT IS MANDATORY (v0.4.1):
 *
 * `SessionPersistence.open(id, access, options)` does NOT default to read.
 * The 0.1.5 jsonl backend branches on `access === "read"`; anything else —
 * including `undefined` — falls through to the single-writer path
 * (`tracker.claimWrite(id)` + a cross-process lease). Reading a session the
 * host itself still has open (the normal case for the conversation the user
 * just deleted, and for any session whose agent is idle but loaded) then
 * throws SessionAlreadyOwnedError, and a session with no durable artifact
 * yet throws NotFound. Both were swallowed below, so `listArchivedSessions`
 * reported `turnCount: 0` and the preview route returned `messages: []`
 * for exactly the sessions that were being viewed — while untouched
 * sessions listed fine. A successful write open would also have claimed
 * write ownership and taken an exclusive lease just to read.
 *
 * The older cohort has no `open()` at all (it is `inspect`-only), so the
 * extra argument is inert there.
 *
 * @param {object|undefined} persistence ctx.sessionPersistence
 * @param {string} sessionId
 * @returns {Promise<Array|undefined>} the event array, or undefined.
 */
async function readSessionEvents(persistence, sessionId) {
  let failure;

  try {
    if (typeof persistence?.inspect === 'function') {
      const stored = await persistence.inspect(sessionId);
      if (stored && Array.isArray(stored.events)) return stored.events;
    }
  } catch (error) {
    failure = error;
  }

  try {
    if (typeof persistence?.open === 'function') {
      const handle = await persistence.open(sessionId, 'read');
      try {
        const result = await handle.read();
        if (result && Array.isArray(result.events)) return result.events;
      } finally {
        if (typeof handle?.close === 'function') await handle.close().catch(() => {});
      }
    }
  } catch (error) {
    failure = error;
  }

  // Best effort: the caller renders a 0-turn row instead of failing the list.
  // Report the underlying reason ONCE per session so a future contract drift
  // is diagnosable instead of showing up as a silently empty recycle bin.
  if (failure && !readFailureReported.has(sessionId) && readFailureReported.size < 200) {
    readFailureReported.add(sessionId);
    console?.warn?.(`session-trash-host: could not read events for "${sessionId}": ${failure.message ?? failure}`);
  }

  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Patch: SessionPersistence.delete(id)                               */
/*  Adds physical deletion and memory index cleanup.                     */
/* ------------------------------------------------------------------ */

/**
 * Marker installed on every service method this bundle patches, carrying the
 * owning install's token. cordis unloads a plugin fiber WITHOUT unwinding
 * methods previously patched onto shared service objects, so a later instance
 * must be able to (a) recognise a patch left behind by an earlier fiber,
 * (b) replace it with one closing over the live context, and (c) on unload
 * remove only its own methods — never a newer instance's.
 */
const TRASH_PATCH = Symbol('dsh-session-trash.patch');
/** Kept on our persistence.delete wrapper: the pristine function to restore. */
const TRASH_PATCH_ORIGINAL = Symbol('dsh-session-trash.patchOriginal');
/** v0.3.1's untagged wrapper marker — still detected so its (context-free,
 *  fully functional) wrapper is kept instead of nested. */
const PERSISTENCE_DELETE_PATCHED = Symbol('dsh-session-trash.persistenceDeletePatched');

/**
 * Patch SessionPersistence to add a durable `delete` method.
 * @param {import('@deepseek-ai/dsh-session-persistence').SessionPersistence} persistence
 * @returns a disposer restoring the pristine delete, or null when an existing
 *   wrapper (ours or ≤v0.3.1's, both context-free) was kept as-is.
 */
function patchSessionPersistenceDelete(persistence) {
  // A wrapper is already installed — by this version, a newer one, or a ≤v0.3.1
  // fiber that leaked it (PERSISTENCE_DELETE_PATCHED, kept for that detection).
  // The wrapper touches no context, so the stale one keeps working; wrapping it
  // again would only nest duplicate physical deletions.
  if (persistence.delete?.[TRASH_PATCH] || persistence.delete?.[PERSISTENCE_DELETE_PATCHED]) return null;
  const originalDelete = persistence.delete;
  const token = Symbol('dsh-session-trash.deletePatch');
  persistence.delete = async function deleteSession(id) {
    if (typeof originalDelete === 'function') {
      try {
        await originalDelete.call(this, id);
      } catch { /* best effort */ }
    }

    try {
      const logPath = await resolveSessionLogPath(this, id);
      if (logPath) {
        const sessionDir = dirname(logPath);
        await rm(sessionDir, { recursive: true, force: true });
        const projectDir = dirname(sessionDir);
        try {
          const entries = await readdir(projectDir);
          if (entries.length === 0) await rmdir(projectDir);
        } catch { /* best effort */ }
      }
    } catch (error) {
      console?.warn?.('session-trash-host: physical log delete failed: %s', error.message);
    }

    // Clear internal memory maps or caches if present
    if (this.cache && typeof this.cache.delete === 'function') this.cache.delete(id);
    if (this.byId && typeof this.byId.delete === 'function') this.byId.delete(id);
    if (this._headers && typeof this._headers.delete === 'function') this._headers.delete(id);
  };
  Object.defineProperty(persistence.delete, TRASH_PATCH, { value: token });
  Object.defineProperty(persistence.delete, TRASH_PATCH_ORIGINAL, { value: originalDelete });
  // Restore the pristine delete on fiber unload — unless a newer install has
  // since replaced the wrapper (token mismatch).
  return () => {
    if (persistence.delete?.[TRASH_PATCH] !== token) return;
    if (originalDelete === undefined) delete persistence.delete;
    else persistence.delete = originalDelete;
  };
}

/* ------------------------------------------------------------------ */
/*  Patch: SessionProjectionCache.remove(id)                           */
/*  Adds fail-soft cache record removal.                                */
/* ------------------------------------------------------------------ */

/**
 * Patch the SessionProjectionCache to add a `remove` method.
 * @param {import('@deepseek-ai/dsh-session-projection-cache').SessionProjectionCache} cache
 * @returns a disposer removing our method, or null when an existing remove
 *   (foreign, or a context-free ≤v0.3.1 leftover doing the same job) was kept.
 */
function patchProjectionCacheRemove(cache) {
  const existing = cache.remove;
  if (typeof existing === 'function' && !existing[TRASH_PATCH]) return null;
  const token = Symbol('dsh-session-trash.cachePatch');
  /**
   * Remove one session's cached checkpoint record durably (fail-soft).
   * @param {import('@deepseek-ai/dsh-session').SessionId} id
   * @returns {Promise<void>}
   */
  cache.remove = async function remove(id) {
    const table = this.requireTable?.();
    if (table) {
      try {
        await table.delete(id);
      } catch (error) {
        console?.warn?.('session-trash-host: remove(%s) projection cache failed: %s', id, error.message);
      }
    }

    if (typeof this.markClean === 'function') {
      this.markClean(id);
    }
  };
  Object.defineProperty(cache.remove, TRASH_PATCH, { value: token });
  // Remove our method on fiber unload — unless a newer install replaced it.
  return () => {
    if (cache.remove?.[TRASH_PATCH] === token) delete cache.remove;
  };
}

/* ------------------------------------------------------------------ */
/*  Patch: WorkspaceRegistry — unarchive / permanentlyDelete / empty   */
/* ------------------------------------------------------------------ */

/**
 * Patch the WorkspaceRegistry with new methods.
 *
 * v0.3.2: methods left on the shared registry by an EARLIER fiber (uninstall
 * + reinstall without a restart) must be replaced, not reused — their
 * closures capture the dead context, so listArchivedSessions() silently
 * lost turn counts while the routes (rebuilt per mount) kept working. Every
 * installed method is tagged with this install's TRASH_PATCH token; a fresh
 * instance overwrites whatever stale methods it finds, and the returned
 * disposer removes only methods still carrying this install's token.
 *
 * @param {import('@deepseek-ai/dsh-workspace').WorkspaceRegistry} registry
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns a disposer removing every method installed here, or null when the
 *   registry is missing.
 */
function patchWorkspaceRegistry(registry, ctx) {
  if (!registry) return null;
  const token = Symbol('dsh-session-trash.registryPatch');
  // Snapshot the services the patched methods need while THIS fiber is live.
  // The methods are installed on the SHARED registry object and may outlive
  // this fiber (a pre-v0.3.2 install could leak them); resolving services
  // through ctx at call time would then hit the dead-fiber guard
  // ("cannot get required service ... in inactive context") and silently
  // zero the turn counts. ctx.get(...) is a safe non-throwing accessor, so
  // the remaining per-call lookups below stay dynamic on purpose.
  const persistence = ctx.sessionPersistence;
  const runInQueue = (fn) => {
    if (typeof registry.enqueueOperation === 'function') {
      return registry.enqueueOperation(fn);
    }
    return fn();
  };

  // ── archiveSession ────────────────────────────────────────────────
  registry.archiveSession = function archiveSession(sessionId, title) {
    return runInQueue(async () => {
      const state = registry.requireState?.();
      if (!state) return;
      const currentArchived = state.archivedSessionIds ?? [];
      const currentTitles = state.archivedTitles ?? {};
      if (!currentArchived.includes(sessionId)) {
        const newArchived = [...currentArchived, sessionId];
        const newTitles = { ...currentTitles };
        if (title) newTitles[sessionId] = title;
        await registry.setState({
          ...state,
          archivedSessionIds: newArchived,
          archivedTitles: newTitles,
        });
        notifyArchivedSessionsChanged(ctx, newArchived);
      }
    });
  };

  // ── unarchiveSession ──────────────────────────────────────────────
  registry.unarchiveSession = function unarchiveSession(sessionId) {
    return runInQueue(async () => {
      const state = registry.requireState?.();
      if (!state || !state.archivedSessionIds.includes(sessionId)) return;

      const newArchived = state.archivedSessionIds.filter((id) => id !== sessionId);
      await registry.setState({
        ...state,
        archivedSessionIds: newArchived,
      });

      notifyArchivedSessionsChanged(ctx, newArchived);
    });
  };

  // ── permanentlyDeleteSession ──────────────────────────────────────
  registry.permanentlyDeleteSession = async function permanentlyDeleteSession(sessionId) {
    // Live-session guard via the agents registry (the proven published-plugin
    // check): only an ACTIVE agent blocks deletion.
    const agents = ctx.get('agents');
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
    if (agent !== undefined && agent.status !== 'idle') {
      const err = new Error(`会话正在运行中，请等待结束后再删除`);
      err.code = 'SESSION_RUNNING';
      throw err;
    }

    // Physical deletion via `findLog`: scans ALL project directories directly,
    // ignoring cwd. If NO log exists on disk (a "ghost" session — an entry in
    // the workspace registry whose log was never materialized or already
    // removed), `logFound` stays false.
    let logFound = false;
    try {
      const logPath = await resolveSessionLogPath(persistence, sessionId);
      if (logPath) {
        logFound = true;
        const sessionDir = dirname(logPath);
        await rm(sessionDir, { recursive: true, force: true });
        const projectDir = dirname(sessionDir);
        try {
          const entries = await readdir(projectDir);
          if (entries.length === 0) await rmdir(projectDir);
        } catch { /* best effort */ }
      }
    } catch (error) {
      throw new Error(`failed to delete session log for '${sessionId}'`, { cause: error });
    }

    const cache = ctx.get('sessionProjectionCache');
    if (cache && typeof cache.remove === 'function') {
      await cache.remove(sessionId);
    }

    // Remove the session from the LIVE sessions service (the in-memory
    // session manager). Without this the session lingers as an "ungrouped"
    // sidebar entry until the next restart — the log is gone, so a restart
    // reconciles it away, but the user should see it vanish immediately.
    try {
      const sessions = ctx.get('sessions');
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined;
      if (session !== undefined && typeof sessions.liveEntryFor === 'function') {
        const entry = sessions.liveEntryFor(session);
        if (entry && typeof entry.detach === 'function') {
          entry.detach();
        }
      }
    } catch {
      // not live in the store — nothing to detach
    }

    return runInQueue(async () => {
      const state = registry.requireState?.();
      if (!state) return;

      let changed = false;
      if (state.archivedSessionIds.includes(sessionId)) {
        const newArchived = state.archivedSessionIds.filter((id) => id !== sessionId);
        await registry.setState({
          ...state,
          archivedSessionIds: newArchived,
        });
        changed = true;
      }

      // GHOST-session cleanup: only when no physical log exists should the
      // session be detached from every workspace record — it must DISAPPEAR,
      // not be "restored". A session WITH a log keeps its workspace slot (the
      // deleted log makes it invisible anyway, and detaching a still-listed
      // session would surface it under an ungrouped section).
      if (!logFound) {
        const entities = registry.entities;
        if (entities) {
          for (const entity of entities.values()) {
            if (entity.record?.sessionIds?.includes(sessionId)) {
              try {
                await entity.detachSession(sessionId);
              } catch {
                // best effort
              }
            }
          }
        }
      }

      if (changed) {
        const archived = registry.requireState?.()?.archivedSessionIds ?? [];
        notifyArchivedSessionsChanged(ctx, archived);
      }
    });
  };

  // ── emptyArchivedSessions ─────────────────────────────────────────
  registry.emptyArchivedSessions = async function emptyArchivedSessions() {
    const state = registry.requireState?.();
    if (!state || state.archivedSessionIds.length === 0) return { deletedCount: 0 };

    const archivedIds = [...state.archivedSessionIds];
    let deletedCount = 0;
    const errors = [];

    for (const sessionId of archivedIds) {
      try {
        await registry.permanentlyDeleteSession(sessionId);
        deletedCount++;
      } catch (error) {
        errors.push({ sessionId, message: error.message });
      }
    }

    if (errors.length > 0 && deletedCount === 0) {
      throw new Error(`failed to empty recycle bin: ${errors[0].message}`);
    }

    return { deletedCount, total: archivedIds.length };
  };

  // ── listArchivedSessions ──────────────────────────────────────────
  registry.listArchivedSessions = async function listArchivedSessions() {
    const state = registry.requireState?.();
    if (!state) return [];

    const archivedIds = state.archivedSessionIds ?? [];
    if (archivedIds.length === 0) return [];

    /** 提取用户消息中的真实对话内容，过滤掉系统上下文、skills 等注入内容 */
    function extractUserText(raw) {
      if (!raw) return '';
      // content 是 ContentBlock[]，每个 block 有 type 和 text 字段
      if (Array.isArray(raw)) {
        return raw
          .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .filter(Boolean)
          .join('\n')
          .trim();
      }
      if (typeof raw !== 'string') return '';
      let str = raw;
      // 提取 <USER_REQUEST> 内的内容（用户真实输入）
      const userReqMatch = str.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
      if (userReqMatch) return userReqMatch[1].trim();
      // 去掉已知的 XML 标签
      str = str.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
      str = str.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
      str = str.replace(/<SKILL>[\s\S]*?<\/SKILL>/gi, '');
      str = str.replace(/<SYSTEM_CONTEXT>[\s\S]*?<\/SYSTEM_CONTEXT>/gi, '');
      str = str.replace(/<WORKSPACE>[\s\S]*?<\/WORKSPACE>/gi, '');
      // 去掉所有剩余的 HTML/XML 标签
      str = str.replace(/<[^>]+>/g, '');
      return str.trim();
    }

    let headers = [];
    try {
      headers = ((await persistence?.list?.()) ?? []).map(normalizeStoredHeader).filter(Boolean);
    } catch {
      // Persistence list fallback
    }

    const byId = new Map(headers.map((h) => [h.id, h]));

    const workspaceBySession = new Map();
    const entities = registry.entities;
    if (entities) {
      for (const entity of entities.values()) {
        for (const sid of entity.record?.sessionIds ?? []) {
          if (archivedIds.includes(sid) && !workspaceBySession.has(sid)) {
            workspaceBySession.set(sid, {
              workspacePath: entity.record.path,
              workspaceTitle: entity.record.title,
            });
          }
        }
      }
    }

    const items = await Promise.all(
      archivedIds.map(async (sessionId) => {
        const header = byId.get(sessionId);
        const ws = workspaceBySession.get(sessionId);

        let archivedAt = Date.now();
        let fileSize = 0;
        let turnCount = 0;
        let derivedTitle = '';

        try {
          const logPath = await resolveSessionLogPath(persistence, sessionId);
          if (logPath) {
            const fileStat = await stat(logPath).catch(() => null);
            if (fileStat) {
              archivedAt = fileStat.mtimeMs;
              fileSize = fileStat.size;
            }
          }
          // 读取已解压的会话事件（DSH 默认启用 Zstd 压缩，直接 readFile 读到的是
          // 二进制数据，无法解析为 JSON）。0.1.5 起 inspect 移除，改用
          // open(id, 'read') → handle.read()（见 readSessionEvents）。
          const events = await readSessionEvents(persistence, sessionId);
          if (Array.isArray(events)) {
            // 统计 turn/start 事件数量作为真实对话轮数
            turnCount = events.filter((e) => e.type === 'turn/start').length;
            // 提取第一条真实用户消息作为衍生标题（过滤掉系统上下文等非用户输入）
            const firstUserMsg = events.find((e) => e.type === 'user/message' && e.data?.source?.kind === 'user');
            if (firstUserMsg?.data?.content) {
              const text = extractUserText(firstUserMsg.data.content);
              if (text) {
                derivedTitle = text.split('\n')[0].substring(0, 50);
              }
            }
          }
        } catch {
          // best effort fallback
        }

        const savedTitle = state?.archivedTitles?.[sessionId];
        const finalTitle = savedTitle || ((header?.title && header.title !== sessionId)
          ? header.title
          : (derivedTitle || (header?.title ? header.title : '未命名会话')));

        return {
          sessionId,
          title: finalTitle,
          cwd: header?.cwd,
          workspacePath: ws?.workspacePath || ws?.cwd,
          workspaceTitle: ws?.workspaceTitle,
          archivedAt,
          fileSize,
          turnCount,
        };
      })
    );

    // 按工作区顺序排列（与左侧 sidebar 一致），每个工作区内按时间降序排列
    const workspaceOrder = [];
    const workspaceGrouped = new Map();
    if (entities) {
      for (const entity of entities.values()) {
        const path = entity.record.path;
        workspaceOrder.push(path);
        workspaceGrouped.set(path, { path, title: entity.record.title, items: [] });
      }
    }
    for (const item of items) {
      const key = item.workspacePath || item.cwd || '其他工作区';
      if (!workspaceGrouped.has(key)) {
        workspaceGrouped.set(key, { path: key, title: item.workspaceTitle || '其他项目', items: [] });
        workspaceOrder.push(key);
      }
      workspaceGrouped.get(key).items.push(item);
    }
    const ordered = [];
    for (const path of workspaceOrder) {
      const group = workspaceGrouped.get(path);
      if (!group || group.items.length === 0) continue;
      group.items.sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
      ordered.push(...group.items);
    }
    return ordered;
  };

  // Tag every method installed above with this install's token, then hand
  // back a disposer that removes exactly these methods on fiber unload —
  // but only those a newer instance has not since replaced (token check).
  const INSTALLED = [
    'archiveSession',
    'unarchiveSession',
    'permanentlyDeleteSession',
    'emptyArchivedSessions',
    'listArchivedSessions',
  ];
  for (const name of INSTALLED) {
    if (typeof registry[name] === 'function') {
      Object.defineProperty(registry[name], TRASH_PATCH, { value: token });
    }
  }
  return () => {
    for (const name of INSTALLED) {
      if (registry[name]?.[TRASH_PATCH] === token) delete registry[name];
    }
  };
}

/* ------------------------------------------------------------------ */
/*  HTTP routes (the browser transport)                                 */
/* ------------------------------------------------------------------ */
/*
 * The DSH host `/api` gateway only dispatches to its BUILD-TIME unary
 * route table (`UNARY_ROUTES`), so a plugin's runtime-registered typert
 * endpoints are never reachable from the browser (`HTTP 404`). The
 * supported extension path is registering routes directly on the
 * `webServer` service — exactly what published plugins (dsh-session-delete)
 * do. Routes live under /api/session-trash/* and non-GET requests must
 * carry the `x-dsh-plugin: session-trash` custom header as a minimal CSRF
 * defense (a custom header triggers a CORS preflight, which this server
 * never answers).
 */

const ROUTE_PREFIX = '/api/session-trash';
const PLUGIN_HEADER = 'x-dsh-plugin';
const PLUGIN_HEADER_VALUE = 'session-trash';

/**
 * Absolute path of the browser stylesheet shipped at the bundle root.
 * Resolved relative to this module (…/packages/session-trash-host/lib/),
 * which works for both npm-installed bundles and `plugin add link:`
 * development checkouts.
 */
const CLIENT_CSS_PATH = fileURLToPath(new URL('../../../client.css', import.meta.url));

function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw httpError(400, 'INVALID_BODY', 'request body is not valid JSON');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw httpError(400, 'INVALID_BODY', 'request body must be a JSON object');
  }
  return data;
}

function ok(res, data) {
  sendJson(res, 200, { ok: true, data });
}

/**
 * Wrap one route handler: CSRF header check for non-GET, then dispatch;
 * every thrown error becomes a JSON error envelope.
 */
function guard(handler) {
  return async (req, res) => {
    try {
      if (req.method !== 'GET' && req.headers[PLUGIN_HEADER] !== PLUGIN_HEADER_VALUE) {
        throw httpError(403, 'FORBIDDEN', `missing ${PLUGIN_HEADER} header`);
      }
      await handler(req, res);
    } catch (error) {
      sendJson(res, error?.statusCode ?? 500, {
        ok: false,
        error: { code: error?.code ?? 'INTERNAL', message: String(error?.message ?? error) },
      });
    }
  };
}

/**
 * Register the /api/session-trash/* routes on the webServer service.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns a disposer that unregisters every route, or null when the host
 *   composition has no webServer (e.g. the standalone test harness).
 */
function registerRoutes(ctx) {
  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') return null;

  const registry = ctx.workspaceRegistry;
  // Snapshot the injected services while the owning fiber is ACTIVE. The
  // route handlers below only live as long as the fiber (their disposers are
  // wired through ctx.effect), so resolving them per-request via ctx would
  // re-trap the dead-fiber guard on every call; the mount-time references are
  // the stable contract.
  const persistence = ctx.sessionPersistence;
  const disposers = [];

  /** Broadcast the current archive set after any mutation. */
  function broadcastArchived() {
    const archivedSessionIds = registry?.requireState?.()?.archivedSessionIds ?? [];
    notifyArchivedSessionsChanged(ctx, archivedSessionIds);
    return archivedSessionIds;
  }

  /** All sessions: persistence headers ∪ workspace membership, with archive flag. */
  async function allSessions() {
    const headers = ((await persistence?.list?.()) ?? []).map(normalizeStoredHeader).filter(Boolean);
    const archived = registry?.requireState?.()?.archivedSessionIds ?? [];
    const byId = new Map(headers.map((h) => [h.id, h]));
    const wsBySession = new Map();
    const entities = registry?.entities;
    if (entities) {
      for (const entity of entities.values()) {
        for (const sid of entity.record?.sessionIds ?? []) {
          if (!wsBySession.has(sid)) {
            wsBySession.set(sid, {
              workspacePath: entity.record.path,
              workspaceTitle: entity.record.title,
            });
          }
        }
      }
    }
    const ids = new Set([...byId.keys(), ...wsBySession.keys()]);
    return [...ids]
      .map((sessionId) => {
        const header = byId.get(sessionId);
        const ws = wsBySession.get(sessionId);
        return {
          sessionId,
          title: header?.title ?? ws?.workspaceTitle ?? String(sessionId),
          cwd: header?.cwd,
          workspacePath: ws?.workspacePath,
          workspaceTitle: ws?.workspaceTitle,
          archived: archived.includes(sessionId),
        };
      })
      .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
  }

  const routes = [
    // GET list — archived sessions (the recycle bin data source).
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/list`,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'GET only' } });
        const items = (await registry?.listArchivedSessions?.()) ?? [];
        ok(res, { items });
      }),
    },
    // GET sessions — every session with its workspace grouping + archive flag.
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/sessions`,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'GET only' } });
        ok(res, { items: await allSessions() });
      }),
    },
    // POST archive { sessionId, title } — move one session into the recycle bin.
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/archive`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } });
        const { sessionId, title } = await readBody(req);
        if (!sessionId) throw httpError(400, 'BAD_REQUEST', 'sessionId is required');
        const agents = ctx.get('agents');
        const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
        if (agent !== undefined && agent.status !== 'idle') {
          throw httpError(400, 'SESSION_RUNNING', '会话正在运行中，无法删除');
        }
        await registry?.archiveSession?.(sessionId, title);
        ok(res, { sessionId, archivedSessionIds: broadcastArchived() });
      }),
    },
    // POST unarchive { sessionId } — restore one session from the recycle bin.
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/unarchive`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } });
        const { sessionId } = await readBody(req);
        if (!sessionId) throw httpError(400, 'BAD_REQUEST', 'sessionId is required');
        await registry?.unarchiveSession?.(sessionId);
        ok(res, { sessionId, archivedSessionIds: broadcastArchived() });
      }),
    },
    // POST purge { sessionIds: [] } — permanently delete the given sessions.
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/purge`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } });
        const { sessionIds } = await readBody(req);
        const ids = Array.isArray(sessionIds) ? sessionIds.filter((id) => typeof id === 'string' && id) : [];
        if (ids.length === 0) throw httpError(400, 'BAD_REQUEST', 'sessionIds[] is required');
        const deleted = [];
        const errors = [];
        for (const sessionId of ids) {
          try {
            await registry?.permanentlyDeleteSession?.(sessionId);
            deleted.push(sessionId);
          } catch (error) {
            errors.push({ sessionId, code: error?.code ?? 'ERROR', message: error?.message ?? String(error) });
          }
        }
        if (deleted.length > 0) broadcastArchived();
        ok(res, { deletedCount: deleted.length, total: ids.length, errors });
      }),
    },
    // GET messages — read and parse messages for session preview modal.
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/messages`,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'GET only' } });
        if (!req.url) throw httpError(400, 'BAD_REQUEST', 'missing request URL');
        const url = new URL(req.url, 'http://localhost');
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) throw httpError(400, 'BAD_REQUEST', 'sessionId is required');

        const logPath = await resolveSessionLogPath(persistence, sessionId);
        const messages = [];

        /** 提取用户消息中的真实对话内容，过滤掉系统上下文、skills 等注入内容 */
        function extractUserText(raw) {
          if (!raw) return '';
          // content 是 ContentBlock[]，每个 block 有 type 和 text 字段
          if (Array.isArray(raw)) {
            return raw
              .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
              .map((part) => part.text)
              .filter(Boolean)
              .join('\n')
              .trim();
          }
          if (typeof raw !== 'string') return '';
          let str = raw;
          // 优先提取 <USER_REQUEST> 内的内容（用户真实输入）
          const userReqMatch = str.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
          if (userReqMatch) return userReqMatch[1].trim();
          // 去掉已知的 XML 标签
          str = str.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
          str = str.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
          str = str.replace(/<SKILL>[\s\S]*?<\/SKILL>/gi, '');
          str = str.replace(/<SYSTEM_CONTEXT>[\s\S]*?<\/SYSTEM_CONTEXT>/gi, '');
          str = str.replace(/<WORKSPACE>[\s\S]*?<\/WORKSPACE>/gi, '');
          // 去掉所有剩余的 HTML/XML 标签
          str = str.replace(/<[^>]+>/g, '');
          return str.trim();
        }

        /** 提取助手消息中的真实回复内容，过滤掉 reasoning 思考块、tool-call 等 */
        function extractAssistantText(content) {
          if (!content) return '';
          // content 是 ContentBlock[]，过滤出 type 为 'text' 的块（排除 reasoning/tool-call/tool-result）
          if (Array.isArray(content)) {
            return content
              .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
              .map((part) => part.text)
              .filter(Boolean)
              .join('\n')
              .trim();
          }
          // 内容为字符串：去掉 thinking 块（兼容旧格式）
          if (typeof content === 'string') {
            let str = content;
            str = str.replace(/```thinking[\s\S]*?```/g, '');
            str = str.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
            return str.trim();
          }
          return '';
        }

        function parseRole(obj) {
          if (!obj) return null;
          const raw = String(obj.role || obj.type || obj.kind || obj.event || '').toUpperCase();
          if (raw.includes('USER') || raw.includes('HUMAN') || raw.includes('INPUT')) return 'user';
          if (raw.includes('ASSISTANT') || raw.includes('PLANNER') || raw.includes('RESPONSE') || raw.includes('MODEL') || raw.includes('AGENT') || raw.includes('OUTPUT')) return 'assistant';
          return null;
        }

        function cleanText(raw) {
          if (typeof raw !== 'string') return '';
          let str = raw;
          str = str.replace(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi, '$1');
          str = str.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
          str = str.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
          return str.trim();
        }

        function extractAnyText(val) {
          if (!val) return '';
          if (typeof val === 'string') return cleanText(val);
          if (Array.isArray(val)) {
            return val.map(extractAnyText).filter(Boolean).join('\n');
          }
          if (typeof val === 'object') {
            if (typeof val.text === 'string') return cleanText(val.text);
            if (val.content) return extractAnyText(val.content);
            if (typeof val.value === 'string') return cleanText(val.value);
            if (typeof val.prompt === 'string') return cleanText(val.prompt);
            if (typeof val.message === 'string') return cleanText(val.message);
            if (val.payload) return extractAnyText(val.payload);
            if (val.data) return extractAnyText(val.data);
          }
          return '';
        }

        function parseContent(obj) {
          if (!obj) return '';
          return extractAnyText(obj.content ?? obj.text ?? obj.prompt ?? obj.message ?? obj.query ?? obj.payload ?? obj);
        }

        // 优先读取已解压的会话事件（DSH 默认启用 Zstd 压缩，直接 readFile 读到的是
        // 二进制数据）。0.1.5 起 inspect 移除，改用 open(id, 'read') → handle.read()
        // （见 readSessionEvents）。
        try {
          const events = await readSessionEvents(persistence, sessionId);
          if (Array.isArray(events)) {
            for (const event of events) {
              if (event.type === 'user/message') {
                // 只保留 source.kind === 'user' 的真实用户输入，
                // 排除 plugin 注入的上下文（skills、系统上下文、工具结果等）
                const sourceKind = event.data?.source?.kind;
                if (sourceKind && sourceKind !== 'user') continue;
                // 用户消息：提取 ContentBlock[] 中的 text 块，过滤掉系统上下文
                const content = extractUserText(event.data?.content);
                if (content) {
                  messages.push({
                    role: 'user',
                    content,
                    timestamp: event.createdAt || Date.now(),
                  });
                }
              } else if (event.type === 'assistant/message') {
                // 助手消息：只取 text 块，过滤掉 reasoning 思考块、tool-call 等
                const content = extractAssistantText(event.data?.message?.content);
                if (content) {
                  messages.push({
                    role: 'assistant',
                    content,
                    timestamp: event.createdAt || Date.now(),
                  });
                }
              }
            }
          }
        } catch {
          // inspect 失败后回退到直接读取日志文件（兼容未压缩的日志）
        }

        // 回退方案：直接读取日志文件（仅当事件读取未返回任何消息时）
        if (messages.length === 0) {
          // logPath 已由 resolveSessionLogPath 解析（findLog → locate → 目录扫描）；
          // 此处只保留最后的广谱候选路径扫描（兼容活跃日志、回收站归档日志及 profiles 目录）。
          let resolvedLogPath = logPath;

          if (!resolvedLogPath) {
            const home = process.env.HOME || process.env.USERPROFILE || '';
            const candidates = [
              join(home, '.dsh', 'profiles', 'web', 'trash', `${sessionId}.jsonl`),
              join(home, '.dsh', 'profiles', 'default', 'trash', `${sessionId}.jsonl`),
              join(home, '.dsh', 'trash', `${sessionId}.jsonl`),
              join(home, '.dsh', 'logs', `${sessionId}.jsonl`),
              join(process.cwd(), 'trash', `${sessionId}.jsonl`),
            ];
            for (const p of candidates) {
              if (!p) continue;
              const exists = await stat(p).then((s) => s.isFile()).catch(() => false);
              if (exists) {
                resolvedLogPath = p;
                break;
              }
            }
          }

          if (resolvedLogPath) {
            try {
              const content = await readFile(resolvedLogPath, 'utf8');
              const lines = content.split('\n');
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const obj = JSON.parse(line);
                  const typeStr = String(obj.type || '').toUpperCase();
                  if (typeStr.includes('SETTINGS') || typeStr.includes('NOTIFICATION')) continue;

                  const role = parseRole(obj);
                  const text = parseContent(obj);
                  if (role && text) {
                    messages.push({
                      role,
                      content: text,
                      timestamp: obj.timestamp || obj.time || obj.created_at || Date.now(),
                    });
                  } else if (Array.isArray(obj.messages)) {
                    for (const m of obj.messages) {
                      const r = parseRole(m);
                      const t = parseContent(m);
                      if (r && t) {
                        messages.push({
                          role: r,
                          content: t,
                          timestamp: m.timestamp || m.time || Date.now(),
                        });
                      }
                    }
                  }
                } catch {}
              }
              // Fallback: 如果广谱识别未匹配到 user/assistant
              if (messages.length === 0) {
                for (const line of lines) {
                  if (!line.trim()) continue;
                  try {
                    const obj = JSON.parse(line);
                    const typeStr = String(obj.type || '').toUpperCase();
                    if (typeStr.includes('SETTINGS') || typeStr.includes('NOTIFICATION')) continue;
                    const text = parseContent(obj);
                    if (text) {
                      messages.push({
                        role: String(obj.type || obj.role || 'system').toUpperCase().includes('USER') ? 'user' : 'assistant',
                        content: text,
                        timestamp: obj.timestamp || obj.time || Date.now(),
                      });
                    }
                  } catch {}
                }
              }
            } catch {}
          }
        }

        ok(res, { sessionId, messages });
      }),
    },
    // POST purge-workspace { workspacePath, sessionIds? } — permanently delete all archived sessions in a workspace.
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/purge-workspace`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } });
        const { workspacePath, sessionIds } = await readBody(req);
        let targetIds = Array.isArray(sessionIds) ? sessionIds : [];

        if (targetIds.length === 0 && workspacePath) {
          const archived = (await registry?.listArchivedSessions?.()) ?? [];
          targetIds = archived.filter((item) => item.workspacePath === workspacePath || item.cwd === workspacePath).map((item) => item.sessionId);
        }

        if (targetIds.length === 0) {
          return ok(res, { deletedCount: 0, total: 0, errors: [] });
        }

        const deleted = [];
        const errors = [];
        for (const sessionId of targetIds) {
          try {
            await registry?.permanentlyDeleteSession?.(sessionId);
            deleted.push(sessionId);
          } catch (error) {
            errors.push({ sessionId, code: error?.code ?? 'ERROR', message: error?.message ?? String(error) });
          }
        }

        if (deleted.length > 0) broadcastArchived();
        ok(res, { deletedCount: deleted.length, total: targetIds.length, errors });
      }),
    },
    // POST empty — permanently delete every archived session.
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/empty`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } });
        const result = (await registry?.emptyArchivedSessions?.()) ?? { deletedCount: 0, total: 0 };
        broadcastArchived();
        ok(res, result);
      }),
    },
    // GET client.css — the plugin stylesheet (light/dark adaptive design
    // tokens). client.js injects it as a <link rel="stylesheet">. Read
    // lazily per request so stylesheet edits show up after a browser
    // refresh without restarting the profile process.
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/client.css`,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'GET only' } });
        let css;
        try {
          css = await readFile(CLIENT_CSS_PATH, 'utf8');
        } catch {
          throw httpError(404, 'CSS_NOT_FOUND', `client.css is missing at ${CLIENT_CSS_PATH}`);
        }
        res.writeHead(200, {
          'content-type': 'text/css; charset=utf-8',
          'cache-control': 'no-cache',
        });
        res.end(css);
      }),
    },
  ];

  for (const route of routes) {
    try {
      disposers.push(webServer.register(route));
    } catch (error) {
      // The webServer rejects duplicate paths. The only way one of OUR paths
      // can already be taken is a stale bundle that leaked its routes on
      // fiber unload (<= v0.3.0 stored the disposer where cordis never calls
      // it). That leaked state only clears on a profile-process restart, so
      // fail with an actionable message instead of a bare duplicate error.
      throw new Error(
        `session-trash-host: cannot register ${route.path}: ${error?.message ?? error}`
        + ' — a route leaked by a previous instance still occupies this path;'
        + ' restart dsh web to clean up',
        { cause: error },
      );
    }
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // best effort
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/*  SessionTrashHost — Cordis plugin entry point                       */
/* ------------------------------------------------------------------ */

export class SessionTrashHost extends ServiceClass {
  static inject = [
    'sessionPersistence',
    'sessionProjectionCache',
    'workspaceRegistry',
    'webServer',
  ];

  #routesDisposer;

  constructor(ctx) {
    super(ctx, 'sessionTrashHost');
  }

  async [ServiceClass.init || Symbol.for('cordis.init')]() {
    const ctx = this.ctx;

    // v0.3.2: every service patch is now REVERSIBLE. Each installer returns a
    // disposer bound to this fiber, and a stale patch left behind by an
    // earlier fiber is detected via its TRASH_PATCH tag and replaced with one
    // closing over the live context. Before this, uninstalling + reinstalling
    // without a restart left the registry methods of the DEAD fiber in place
    // (the old 'typeof x !== function' guards refused to re-patch), so the
    // recycle-bin list kept calling listArchivedSessions() whose closure held
    // an inactive ctx — ctx.sessionPersistence threw inside the per-session
    // try/catch and every turn count silently read 0 — while the preview
    // (routes rebuilt per mount, snapshotting services) worked fine.
    const undoPatches = [];

    const persistence = ctx.sessionPersistence;
    if (persistence) undoPatches.push(patchSessionPersistenceDelete(persistence));

    const cache = ctx.get('sessionProjectionCache');
    if (cache) undoPatches.push(patchProjectionCacheRemove(cache));

    const registry = ctx.workspaceRegistry;
    if (registry) undoPatches.push(patchWorkspaceRegistry(registry, ctx));

    const disposeRoutes = registerRoutes(ctx);
    const disposeAll = () => {
      try { disposeRoutes?.(); } catch { /* best effort */ }
      for (const undo of undoPatches) {
        try { undo?.(); } catch { /* best effort */ }
      }
    };

    // v0.3.1 fix, extended: bind BOTH the routes and the service patches to
    // THIS fiber's lifecycle — cordis's "register() disposer contract".
    // @deepseek-ai/cordis@4 never calls a class instance's dispose(); only
    // effects collected via ctx.effect unwind on fiber unload. Without this
    // any in-process reload (reinstalling the plugin without restarting dsh
    // web, a loader config update, a dependency service restart) leaked the
    // old routes bound to the now-inactive context — ctx.sessionPersistence
    // then threw "cannot get required service ... in inactive context" and
    // the reloaded instance died on webServer.register's duplicate-path
    // throw. disposeAll is idempotent (token checks), so the defensive
    // dispose() below can share it.
    this.#routesDisposer = disposeAll;

    if (typeof ctx.effect === 'function') {
      ctx.effect(() => disposeAll, 'session-trash-host: /api/session-trash/* routes + service patches');
    }
  }

  dispose() {
    this.#routesDisposer?.();
    this.#routesDisposer = undefined;
  }
}

export default SessionTrashHost;