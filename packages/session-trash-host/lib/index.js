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
import { rm, readdir, rmdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
/*  Patch: SessionPersistence.delete(id)                               */
/*  Adds physical deletion and memory index cleanup.                     */
/* ------------------------------------------------------------------ */

/**
 * Patch SessionPersistence to add a durable `delete` method.
 * @param {import('@deepseek-ai/dsh-session-persistence').SessionPersistence} persistence
 */
function patchSessionPersistenceDelete(persistence) {
  const originalDelete = persistence.delete;
  persistence.delete = async function deleteSession(id) {
    if (typeof originalDelete === 'function') {
      try {
        await originalDelete.call(this, id);
      } catch { /* best effort */ }
    }

    try {
      const logPath = typeof this.findLog === 'function' ? await this.findLog(id) : undefined;
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
}

/* ------------------------------------------------------------------ */
/*  Patch: SessionProjectionCache.remove(id)                           */
/*  Adds fail-soft cache record removal.                                */
/* ------------------------------------------------------------------ */

/**
 * Patch the SessionProjectionCache to add a `remove` method.
 * @param {import('@deepseek-ai/dsh-session-projection-cache').SessionProjectionCache} cache
 */
function patchProjectionCacheRemove(cache) {
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
}

/* ------------------------------------------------------------------ */
/*  Patch: WorkspaceRegistry — unarchive / permanentlyDelete / empty   */
/* ------------------------------------------------------------------ */

/**
 * Patch the WorkspaceRegistry with new methods.
 * @param {import('@deepseek-ai/dsh-workspace').WorkspaceRegistry} registry
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function patchWorkspaceRegistry(registry, ctx) {
  const runInQueue = (fn) => {
    if (typeof registry.enqueueOperation === 'function') {
      return registry.enqueueOperation(fn);
    }
    return fn();
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
      throw new Error(`cannot permanently delete session '${sessionId}': session is currently running`);
    }

    // Physical deletion via `findLog`: scans ALL project directories directly,
    // ignoring cwd. If NO log exists on disk (a "ghost" session — an entry in
    // the workspace registry whose log was never materialized or already
    // removed), `logFound` stays false.
    let logFound = false;
    try {
      const persistence = ctx.sessionPersistence;
      const logPath = typeof persistence?.findLog === 'function'
        ? await persistence.findLog(sessionId)
        : undefined;
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

    let headers = [];
    try {
      headers = (await ctx.sessionPersistence?.list?.()) ?? [];
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
  const disposers = [];

  /** Broadcast the current archive set after any mutation. */
  function broadcastArchived() {
    const archivedSessionIds = registry?.requireState?.()?.archivedSessionIds ?? [];
    notifyArchivedSessionsChanged(ctx, archivedSessionIds);
    return archivedSessionIds;
  }

  /** All sessions: persistence headers ∪ workspace membership, with archive flag. */
  async function allSessions() {
    const headers = (await ctx.sessionPersistence?.list?.()) ?? [];
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
    // POST archive { sessionId } — move one session into the recycle bin.
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/archive`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } });
        const { sessionId } = await readBody(req);
        if (!sessionId) throw httpError(400, 'BAD_REQUEST', 'sessionId is required');
        await registry?.archiveSession?.(sessionId);
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
  ];

  for (const route of routes) {
    disposers.push(webServer.register(route));
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

    const persistence = ctx.sessionPersistence;
    if (persistence) {
      patchSessionPersistenceDelete(persistence);
    }

    const cache = ctx.get('sessionProjectionCache');
    if (cache && typeof cache.remove !== 'function') {
      patchProjectionCacheRemove(cache);
    }

    const registry = ctx.workspaceRegistry;
    if (registry && typeof registry.unarchiveSession !== 'function') {
      patchWorkspaceRegistry(registry, ctx);
    }

    this.#routesDisposer = registerRoutes(ctx);
  }

  dispose() {
    this.#routesDisposer?.();
    this.#routesDisposer = undefined;
  }
}

export default SessionTrashHost;