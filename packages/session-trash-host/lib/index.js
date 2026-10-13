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
import { rm, readdir, rmdir, stat, readFile, open as openFile } from 'node:fs/promises';
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
 * Normalize one persistence.list() item to `{ header, sizeBytes }` across
 * cohorts. `sizeBytes` is a free field of the 0.1.5+ listing snapshot;
 * normalizeStoredHeader unwrapped it away, which is why the recycle bin used
 * to `stat()` every log just to recover a number the header listing already
 * carried.
 * @param {object|undefined} item
 * @returns {{header: object, sizeBytes: number|undefined}|undefined}
 */
function normalizeStoredSnapshot(item) {
  if (!item) return undefined;
  if (item.header && typeof item.header.id === 'string') {
    const size = item.sizeBytes;
    return { header: item.header, sizeBytes: typeof size === 'number' ? size : undefined };
  }
  if (typeof item.id === 'string') return { header: item, sizeBytes: undefined };
  return undefined;
}

/**
 * Read the listing facts the recycle bin needs straight out of the Session
 * projection cache — DSH's documented ZERO-I/O listing read
 * (`SessionProjectionCache.cachedSnapshot`, "the zero-I/O listing read").
 * The stock session list (`api-session-controller.projectionsFor`) reads the
 * same faces; this is not a private API.
 *
 * WHY THIS REPLACES THE LOG READ (v0.4.4):
 *
 * Until v0.4.3 the list derived `turnCount` and a fallback title by opening
 * every archived session's log and decoding its whole JSONL/Zstd frame
 * chain (`readSessionEvents`). Measured on the reference store (569 MB, 474
 * sessions, p50 416 KB compressed, max 30 MB): a 6.7 MB log (3728 frames,
 * 21.4 MB plaintext, 6493 events) cost ~198 ms of decompress+parse, and the
 * median band 10-19 ms — per session, per request, on the web server's own
 * thread. Decoding the first frame alone (the header) measured ~1 ms, which
 * is what the stock listing pays.
 *
 * The header carries NO title — SessionHeader has had no `title` field since
 * 0.2 — so the projection cache is also the only correct title source: the
 * same `title` unit DSH renders in the sidebar.
 *
 * TWO FACES, AND WHY BOTH ARE NEEDED:
 *
 * A checkpoint is bound to the Session FORMAT GENERATION that folded it.
 * `cachedSnapshot` accepts only a record at the host's CURRENT generation
 * (`currentLifecycleMatches`: stored formatVersion === header.version), while
 * `cachedPredecessorTitle` accepts a strictly older one. That is not
 * academic: on the reference store the host moved from format 3 to 4 and the
 * cache still held 481 v3 records plus 39 with no generation, against only 4
 * v4 ones. Reading `cachedSnapshot` alone would have rejected ~99% of the
 * corpus and silently blanked nearly every title. The predecessor face is
 * the one DSH ships for exactly this upgrade window.
 *
 * It exposes the TITLE ONLY, by design — "format normalization can change
 * their current meaning" is the cache's own note about other predecessor
 * projections — so a pre-upgrade `turns` count is deliberately NOT readable.
 * A missing `turns` therefore means UNKNOWN, never zero: callers must not
 * render it as 0.
 *
 * @param {object|undefined} cache ctx.sessionProjectionCache
 * @param {object} header stored SessionHeader (the lifecycle identity witness)
 * @returns {{title: string|undefined, turns: number|undefined}}
 */
function readCachedSessionFacts(cache, header) {
  const facts = { title: undefined, turns: undefined };
  if (!header || !cache) return facts;

  /** Fold one viewed block in, never overwriting an already-known fact. */
  const take = (block) => {
    const values = block?.values;
    if (!values || typeof values !== 'object') return;
    if (facts.title === undefined) {
      const title = values.title;
      if (typeof title === 'string' && title.length > 0) facts.title = title;
    }
    if (facts.turns === undefined) {
      const turns = values.sessionStats?.turns;
      if (typeof turns === 'number' && Number.isFinite(turns)) facts.turns = turns;
    }
  };

  try {
    if (typeof cache.cachedSnapshot === 'function') {
      take(cache.cachedSnapshot(header, ['title', 'sessionStats']));
    }
  } catch {
    // A cache miss or contract drift must never fail the list.
  }
  try {
    if (typeof cache.cachedPredecessorTitle === 'function') {
      take(cache.cachedPredecessorTitle(header));
    }
  } catch {
    // Same: the row renders without the cached facts.
  }
  return facts;
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
/*  Sub-session lineage: child enumeration and cascade deletion        */
/* ------------------------------------------------------------------ */
/*
 * A subagent session is a SIBLING directory of the session that spawned it
 * (~/.dsh/sessions/<project>/<childId>/) and its id NEVER enters the workspace
 * registry — record.sessionIds holds root sessions only. The parent link lives
 * in the child's own header (`origin: "subagent"`, `parentSession`,
 * `delegationDepth`) and nowhere else, so every fact below is derived from that
 * header. A store that cannot be enumerated degrades to "no children" instead
 * of failing the request: a missing badge beats a wrong one.
 */

/** Log names inside one session directory (legacy plain + 0.1.5 generations). */
const SESSION_LOG_FILE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/;

/**
 * Is this session's agent working right now? The ONLY liveness witness this
 * bundle trusts: `session.lock` outlives the session that wrote it, so its
 * presence proves nothing, while the agents registry drops an entry once the
 * session unloads. An absent entry is a session that is simply not loaded.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 * @returns {boolean}
 */
function isSessionLive(ctx, sessionId) {
  const agents = ctx.get('agents');
  const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
  return agent !== undefined && agent.status !== 'idle';
}

/** Keep the non-empty string ids a request body may carry. */
function normalizeSessionIds(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id) : [];
}

/**
 * One lineage index entry: the parent link the cascade walks, plus the header
 * the display facts are read from.
 * @param {object|undefined} item a listing record — the header itself, a
 *   0.1.5 snapshot wrapping it, or a sessionQuery record whose `header` holds it.
 * @returns {{id: string, parentSession: string|undefined, delegationDepth: number,
 *            header: object, sizeBytes: number|undefined, logPath: string|undefined}|undefined}
 */
function toLineageEntry(item) {
  const header = item?.header && typeof item.header.id === 'string' ? item.header : item;
  if (!header || typeof header.id !== 'string') return undefined;
  const size = typeof item.sizeBytes === 'number' ? item.sizeBytes
    : (typeof header.sizeBytes === 'number' ? header.sizeBytes : undefined);
  const parentSession = typeof header.parentSession === 'string' && header.parentSession
    ? header.parentSession
    : undefined;
  // A session that names a parent is at least depth 1; 0 would claim it is a
  // root session, and the panel renders this number.
  const delegationDepth = Number.isFinite(header.delegationDepth) ? header.delegationDepth : (parentSession ? 1 : 0);
  return {
    id: header.id,
    parentSession,
    delegationDepth,
    header,
    sizeBytes: size,
    // Only the physical rung knows the path up front; carrying it saves the
    // size fallback a second resolution round.
    logPath: typeof item.logPath === 'string' ? item.logPath : undefined,
  };
}

function indexLineage(items) {
  const entries = new Map();
  for (const item of items) {
    const entry = toLineageEntry(item);
    if (entry) entries.set(entry.id, entry);
  }
  return entries;
}

/** The header inside an inspect()/read() result, across cohort shapes. */
function firstHeader(result) {
  const candidate = result?.header ?? (Array.isArray(result?.events) ? result.events[0] : undefined);
  return candidate && typeof candidate.id === 'string' ? candidate : undefined;
}

/**
 * Read one session's header record. The decode rides the existing header
 * convention (persistence.inspect → open(id, 'read')) because a .zstd log
 * cannot be read as text; an uncompressed log is read directly, bounded to its
 * first line.
 * @returns {Promise<object|undefined>} the stored header record.
 */
async function readSessionHeaderRecord(persistence, sessionId, logPath) {
  try {
    if (typeof persistence?.inspect === 'function') {
      const header = firstHeader(await persistence.inspect(sessionId));
      if (header) return header;
    }
  } catch { /* the handle API is the next rung */ }

  try {
    if (typeof persistence?.open === 'function') {
      const handle = await persistence.open(sessionId, 'read');
      try {
        const header = firstHeader(await handle.read());
        if (header) return header;
      } finally {
        if (typeof handle?.close === 'function') await handle.close().catch(() => {});
      }
    }
  } catch { /* an uncompressed log is still readable below */ }

  if (logPath.endsWith('.zstd')) return undefined;
  try {
    const handle = await openFile(logPath, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0]);
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Physical fallback rung: enumerate ~/.dsh/sessions/<project>/<sessionId>/ and
 * read each session's first record. A directory whose header stays unreadable
 * still ENTERS the index under its directory name — it is a session with a log
 * on disk, and that is exactly what decides whether a child's parent is a live
 * row or an orphan.
 * @returns {Promise<Array|undefined>} listing items, or undefined when the
 *   session store itself cannot be listed.
 */
async function scanSessionDirectories(persistence) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return undefined;
  const root = join(home, '.dsh', 'sessions');
  let projects;
  try {
    projects = await readdir(root);
  } catch {
    return undefined;
  }
  const items = [];
  for (const project of projects) {
    const projectDir = join(root, project);
    for (const sessionId of await readdir(projectDir).catch(() => [])) {
      const sessionDir = join(projectDir, sessionId);
      const names = await readdir(sessionDir).catch(() => []);
      const logName = names.find((name) => SESSION_LOG_FILE.test(name));
      if (!logName) continue;
      const logPath = join(sessionDir, logName);
      const read = await readSessionHeaderRecord(persistence, sessionId, logPath);
      const header = read && typeof read.id === 'string' ? read : { id: sessionId };
      const sizeBytes = await stat(logPath).then((s) => s.size).catch(() => undefined);
      items.push({ header, sizeBytes, logPath });
    }
  }
  return items;
}

/**
 * Index every stored session by id, walking the cohort ladder:
 * sessionQuery.listSessions() → persistence.list() → physical scan. Only a rung
 * that THROWS is skipped; `degraded` therefore means every rung threw, and the
 * caller reports empty groups rather than guessing.
 * @returns {Promise<{entries: Map<string, object>, degraded: boolean}>}
 */
async function collectLineage(ctx, persistence) {
  const query = ctx.get('sessionQuery');
  if (typeof query?.listSessions === 'function') {
    try {
      const records = await query.listSessions();
      if (Array.isArray(records)) return { entries: indexLineage(records), degraded: false };
    } catch { /* the listing below is the next rung */ }
  }
  try {
    const listed = await persistence?.list?.();
    if (Array.isArray(listed)) return { entries: indexLineage(listed), degraded: false };
  } catch { /* the physical scan below is the last rung */ }
  const scanned = await scanSessionDirectories(persistence);
  if (scanned) return { entries: indexLineage(scanned), degraded: false };
  return { entries: new Map(), degraded: true };
}

function descendantId(value) {
  if (typeof value === 'string') return value;
  if (typeof value?.id === 'string') return value.id;
  if (typeof value?.header?.id === 'string') return value.header.id;
  return undefined;
}

/**
 * Every descendant id of one session, at FULL depth, excluding the session
 * itself. sessionQuery.traceSession owns the walk when it exists (it also
 * answers for a missing ancestor); otherwise the header index is walked
 * recursively.
 * @returns {Promise<string[]>}
 */
async function collectDescendantIds(ctx, persistence, sessionId) {
  const query = ctx.get('sessionQuery');
  if (typeof query?.traceSession === 'function') {
    try {
      const trace = await query.traceSession(sessionId);
      if (Array.isArray(trace?.descendants)) {
        const ids = trace.descendants.map(descendantId).filter((id) => id && id !== sessionId);
        return [...new Set(ids)];
      }
    } catch { /* a partial lineage must not fail the delete: derive it below */ }
  }

  const { entries } = await collectLineage(ctx, persistence);
  const childrenOf = new Map();
  for (const entry of entries.values()) {
    if (!entry.parentSession) continue;
    const bucket = childrenOf.get(entry.parentSession);
    if (bucket) bucket.push(entry.id); else childrenOf.set(entry.parentSession, [entry.id]);
  }
  const ids = [];
  const seen = new Set([sessionId]);
  const queue = [...(childrenOf.get(sessionId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift();
    // A corrupt parent link that cycles back must not loop forever.
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    queue.push(...(childrenOf.get(id) ?? []));
  }
  return ids;
}

/** Workspace-record session ids: the second way a child's parent can resolve. */
function collectRegistrySessionIds(registry) {
  const ids = new Set();
  const entities = registry?.entities;
  if (entities) {
    for (const entity of entities.values()) {
      for (const sid of entity.record?.sessionIds ?? []) ids.add(sid);
    }
  }
  return ids;
}

/** Byte size of a session log, or undefined when no such file exists. */
async function logFileSize(path) {
  if (!path) return undefined;
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The display row for one child session.
 *
 * WHY A SIZE FALLBACK EXISTS: `sizeBytes` is a field of the persistence
 * listing only — the kernel's `sessionQuery.listSessions()` projects
 * `{ header, live, persisted }` and carries no size at all — so on a host that
 * HAS sessionQuery (the normal case) every row would otherwise report
 * `fileSize: null` and the panel could not show a single size. The fallback
 * measures ONLY the rows this report is about to return (never the whole
 * store), and a session with no log stays `null` rather than claiming 0 bytes.
 */
async function childInfo(ctx, persistence, projectionCache, entry) {
  const cached = readCachedSessionFacts(projectionCache, entry.header);
  const headerTitle = typeof entry.header.title === 'string' && entry.header.title && entry.header.title !== entry.id
    ? entry.header.title
    : undefined;
  const sizeBytes = typeof entry.sizeBytes === 'number'
    ? entry.sizeBytes
    : await logFileSize(entry.logPath ?? await resolveSessionLogPath(persistence, entry.id));
  return {
    id: entry.id,
    title: headerTitle ?? cached.title ?? null,
    fileSize: typeof sizeBytes === 'number' ? sizeBytes : null,
    createdAt: typeof entry.header.createdAt === 'number' ? entry.header.createdAt : null,
    delegationDepth: entry.delegationDepth,
    live: isSessionLive(ctx, entry.id),
  };
}

/**
 * Build the /children report: sub-sessions grouped under the parent they name,
 * and orphans grouped under a parent id that resolves to nothing (neither a log
 * nor a workspace-registry session id) so the panel can render its "残壳" rows.
 * `sessionIds` narrows the report to those parents; omitting it reports the
 * whole store.
 * @returns {Promise<{groups: object, orphans: object, scannedAt: number,
 *   sessionCount: number, degraded?: true}>}
 */
async function buildChildrenReport(ctx, persistence, sessionIds) {
  const { entries, degraded } = await collectLineage(ctx, persistence);
  const report = { groups: {}, orphans: {}, scannedAt: Date.now(), sessionCount: entries.size };
  if (degraded) return { ...report, degraded: true };

  const filter = Array.isArray(sessionIds) ? new Set(normalizeSessionIds(sessionIds)) : undefined;
  const registryIds = collectRegistrySessionIds(ctx.workspaceRegistry);
  const projectionCache = ctx.get('sessionProjectionCache');
  for (const entry of entries.values()) {
    const parentId = entry.parentSession;
    if (!parentId) continue;
    if (filter && !filter.has(parentId)) continue;
    const bucket = entries.has(parentId) || registryIds.has(parentId) ? report.groups : report.orphans;
    (bucket[parentId] ??= []).push(await childInfo(ctx, persistence, projectionCache, entry));
  }
  for (const bucket of [report.groups, report.orphans]) {
    for (const list of Object.values(bucket)) {
      list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
    }
  }
  return report;
}

/** Drop one session's live entry from the sessions store, when it has one. */
function detachLiveSession(ctx, sessionId) {
  try {
    const sessions = ctx.get('sessions');
    const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined;
    if (session !== undefined && typeof sessions.liveEntryFor === 'function') {
      const entry = sessions.liveEntryFor(session);
      if (entry && typeof entry.detach === 'function') entry.detach();
    }
  } catch {
    // not live in the store — nothing to detach
  }
}

/**
 * GHOST cleanup: a session with NO log on disk must DISAPPEAR, not come back as
 * an ungrouped row, so it is detached from every workspace record that lists it.
 */
async function detachFromWorkspaces(registry, sessionId) {
  const entities = registry?.entities;
  if (!entities) return;
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

/**
 * Remove one session's durable artifacts: its log directory, its projection
 * cache record, its live-store entry, and — when no log existed at all — its
 * workspace slots. Failures propagate: the cascade reports them per id instead
 * of rolling back.
 */
async function removeSessionArtifacts(ctx, persistence, projectionCache, registry, sessionId) {
  const logPath = await resolveSessionLogPath(persistence, sessionId);
  if (logPath) {
    try {
      const sessionDir = dirname(logPath);
      await rm(sessionDir, { recursive: true, force: true });
      const projectDir = dirname(sessionDir);
      try {
        const entries = await readdir(projectDir);
        if (entries.length === 0) await rmdir(projectDir);
      } catch { /* best effort */ }
    } catch (error) {
      throw new Error(`failed to delete session log for '${sessionId}'`, { cause: error });
    }
  }

  if (typeof projectionCache?.remove === 'function') await projectionCache.remove(sessionId);

  detachLiveSession(ctx, sessionId);
  if (!logPath) await detachFromWorkspaces(registry, sessionId);
}

/**
 * Purge rows of sessions through the registry's row-aware permanent delete.
 * Every failure is reported per ROW and never rolled back, and a row that
 * failed midway contributes the ids it did remove so the counts stay true.
 * `errors` is an alias of `failed` kept for the released client builds (they
 * read `.sessionId` and the SESSION_RUNNING `code`).
 */
async function purgeSessionRows(registry, sessionIds, excludeIds) {
  const rows = normalizeSessionIds(sessionIds);
  const exclude = normalizeSessionIds(excludeIds);
  const deleted = [];
  const kept = [];
  const failed = [];
  const errors = [];
  for (const sessionId of rows) {
    try {
      const result = await registry.permanentlyDeleteSession(sessionId, { excludeIds: exclude });
      deleted.push(...result.deleted);
      kept.push(...result.kept);
    } catch (error) {
      deleted.push(...(Array.isArray(error?.deleted) ? error.deleted : []));
      const message = String(error?.message ?? error);
      failed.push({ sessionId, message });
      errors.push({ sessionId, code: error?.code ?? 'ERROR', message });
    }
  }
  return {
    deletedCount: deleted.length,
    keptCount: kept.length,
    deleted,
    kept,
    failed,
    errors,
    total: rows.length,
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
  // Snapshotted exactly like persistence, and for the same reason: these
  // methods live on the SHARED registry and can outlive this fiber, so a
  // call-time `ctx.get('sessionProjectionCache')` would degrade to
  // `undefined` on a dead context and silently zero every turn count — the
  // v0.3.2 production symptom, just moved into the projection read. The
  // service is in `static inject`, so it is present while this runs.
  const projectionCache = ctx.get('sessionProjectionCache');
  const runInQueue = (fn) => {
    if (typeof registry.enqueueOperation === 'function') {
      return registry.enqueueOperation(fn);
    }
    return fn();
  };

  // The registry's OWN methods, captured before this patch replaces them.
  // Unwrapping TRASH_PATCH_ORIGINAL matters on an in-process re-mount
  // (loader update, uninstall → install): the registry is shared, so the
  // previous install's patch would otherwise be read back as "the original"
  // and the patch would recurse into itself forever.
  const currentArchive = registry.archiveSession;
  const currentUnarchive = registry.unarchiveSession;
  const originalArchive = currentArchive?.[TRASH_PATCH_ORIGINAL] ?? currentArchive;
  const originalUnarchive = currentUnarchive?.[TRASH_PATCH_ORIGINAL] ?? currentUnarchive;

  // ── archiveSession ────────────────────────────────────────────────
  //
  // TWO CALLERS, ONE ARGUMENT SLOT (v0.4.4):
  //
  // DSH calls `WorkspaceRegistry.archiveSession(sessionId, options)` — its
  // api-workspace-controller passes `{ stopActivity: true }` or `{}`. This
  // plugin's own /archive route passes a display TITLE string instead. The
  // pre-0.4.4 patch treated the second argument as a title, so DSH's `{}`
  // was truthy and got stored as one: the recycle bin then read that object
  // back as `savedTitle`, and rendering an object as a React child throws.
  // Any session archived from DSH's own hover button therefore broke the
  // panel, and the `{}` entries still sit in workspace.json. Split the two
  // shapes explicitly and never store a non-string.
  //
  // The pre-0.4.4 patch also REPLACED the registry method outright, silently
  // dropping four invariants DSH maintains there: the session-existence
  // check, the `workspace/session-activity` gate that refuses to archive a
  // session that is still working, `stopActivity` itself (so the "stop and
  // archive" confirmation stopped nothing), and the pin drop that keeps
  // pinning and archival mutually exclusive. Delegate to the registry's own
  // method and layer only the display facts on top.
  const parseArchiveArgs = (options) => {
    if (typeof options === 'string') return { title: options || undefined, dshOptions: {} };
    if (options && typeof options === 'object') return { title: undefined, dshOptions: options };
    return { title: undefined, dshOptions: {} };
  };

  /**
   * Pre-0.2 cohorts ship no registry archive API at all — this plugin is what
   * provides one there. The write mirrors the durable shape of
   * WorkspaceRegistry.archiveSession (archive set + dropped pin) minus the
   * activity gate those cohorts do not expose.
   */
  const archiveWithoutRegistryApi = (sessionId) => runInQueue(async () => {
    const state = registry.requireState?.();
    if (!state) return;
    const currentArchived = state.archivedSessionIds ?? [];
    if (currentArchived.includes(sessionId)) return;
    const next = { ...state, archivedSessionIds: [...currentArchived, sessionId] };
    if (Array.isArray(state.pinnedSessionIds)) {
      next.pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== sessionId);
    }
    await registry.setState(next);
    notifyArchivedSessionsChanged(ctx, next.archivedSessionIds);
  });

  /** Persist the recycle bin's display facts for one archived session. */
  const writeArchivedMeta = (sessionId, title) => runInQueue(async () => {
    const state = registry.requireState?.();
    if (!state) return;
    if (!(state.archivedSessionIds ?? []).includes(sessionId)) return;
    const current = state.archivedMeta ?? {};
    const previous = current[sessionId];
    const resolved = title ?? (typeof previous?.title === 'string' ? previous.title : undefined);
    const at = typeof previous?.at === 'number' ? previous.at : Date.now();
    const next = { ...current, [sessionId]: resolved === undefined ? { at } : { at, title: resolved } };
    await registry.setState({ ...state, archivedMeta: next });
    notifyArchivedSessionsChanged(ctx, state.archivedSessionIds);
  });

  /** Drop one archived session's display facts (unarchive or purge). */
  const dropArchivedMeta = (sessionId) => runInQueue(async () => {
    const state = registry.requireState?.();
    if (!state) return;
    const current = state.archivedMeta ?? {};
    if (!(sessionId in current)) return;
    const next = { ...current };
    delete next[sessionId];
    await registry.setState({ ...state, archivedMeta: next });
    notifyArchivedSessionsChanged(ctx, state.archivedSessionIds ?? []);
  });

  registry.archiveSession = function archiveSession(sessionId, options) {
    const { title, dshOptions } = parseArchiveArgs(options);
    // The registry's own method opens its own mutation-queue slot, so this
    // call must stay OUTSIDE runInQueue: enqueueOperation chains on the
    // current tail, and wrapping a queued call in another queued call
    // deadlocks the registry.
    const archive = typeof originalArchive === 'function'
      ? originalArchive.call(registry, sessionId, dshOptions)
      : archiveWithoutRegistryApi(sessionId);
    return archive.then(() => writeArchivedMeta(sessionId, title));
  };

  // ── unarchiveSession ──────────────────────────────────────────────
  registry.unarchiveSession = function unarchiveSession(sessionId) {
    const unarchive = typeof originalUnarchive === 'function'
      ? originalUnarchive.call(registry, sessionId)
      : runInQueue(async () => {
        const state = registry.requireState?.();
        if (!state || !(state.archivedSessionIds ?? []).includes(sessionId)) return;
        const nextArchived = state.archivedSessionIds.filter((id) => id !== sessionId);
        await registry.setState({ ...state, archivedSessionIds: nextArchived });
        notifyArchivedSessionsChanged(ctx, nextArchived);
      });
    // Restoring used to leave the session's stored title behind forever.
    return unarchive.then(() => dropArchivedMeta(sessionId));
  };

  /** Drop the deleted ids from the archive set and its display metadata. */
  const purgeArchivedSlots = (sessionIds) => runInQueue(async () => {
    const state = registry.requireState?.();
    if (!state) return false;
    const archived = state.archivedSessionIds ?? [];
    const removing = sessionIds.filter((id) => archived.includes(id));
    if (removing.length === 0) return false;
    // Drop the display facts in the SAME write: a purged session leaves no row
    // to render, and its archivedMeta entry would otherwise sit in the durable
    // record forever.
    const nextMeta = { ...(state.archivedMeta ?? {}) };
    for (const id of removing) delete nextMeta[id];
    await registry.setState({
      ...state,
      archivedSessionIds: archived.filter((id) => !removing.includes(id)),
      archivedMeta: nextMeta,
    });
    return true;
  });

  // ── permanentlyDeleteSession ──────────────────────────────────────
  //
  // A ROW, NOT AN ID (v0.5.0): a subagent session is a SIBLING directory of
  // the session that spawned it and never appears in the workspace registry
  // (record.sessionIds holds root sessions only), so deleting the parent alone
  // used to leave its whole child tree behind on disk. One row is therefore
  // "the session + ALL its descendants, minus excludeIds".
  //
  // A live descendant refuses the WHOLE row before a single file is removed,
  // and excluding a running child does NOT rescue the row: the store must
  // never be mutated underneath a running agent.
  //
  // @param {string} sessionId the row's primary session.
  // @param {{excludeIds?: string[]}} [options] descendants to spare.
  // @returns {Promise<{deleted: string[], kept: string[]}>}
  registry.permanentlyDeleteSession = async function permanentlyDeleteSession(sessionId, options) {
    // The proven published-plugin liveness check: only an ACTIVE agent blocks
    // deletion, and it names the offending session.
    if (isSessionLive(ctx, sessionId)) {
      const err = new Error(`会话正在运行中，请等待结束后再删除`);
      err.code = 'SESSION_RUNNING';
      throw err;
    }

    const exclude = new Set(normalizeSessionIds(options?.excludeIds));
    const descendants = await collectDescendantIds(ctx, persistence, sessionId);

    const running = descendants.filter((id) => isSessionLive(ctx, id)).sort();
    if (running.length > 0) {
      const err = new Error(`会话正在运行中，请等待结束后再删除（运行中的子会话：${running.join('、')}）`);
      err.code = 'SESSION_RUNNING';
      err.runningSessionIds = running;
      throw err;
    }

    const targets = [sessionId, ...descendants.filter((id) => !exclude.has(id))];
    const kept = descendants.filter((id) => exclude.has(id));

    const deleted = [];
    let failure;
    for (const id of targets) {
      try {
        await removeSessionArtifacts(ctx, persistence, projectionCache, registry, id);
      } catch (error) {
        // NO ROLLBACK: the ids already removed stay removed, and the caller is
        // handed exactly which ones they were so its counts stay true.
        error.deleted = deleted;
        failure = error;
        break;
      }
      deleted.push(id);
    }

    if (await purgeArchivedSlots(deleted)) {
      notifyArchivedSessionsChanged(ctx, registry.requireState?.()?.archivedSessionIds ?? []);
    }
    if (failure) throw failure;
    return { deleted, kept };
  };

  // ── emptyArchivedSessions ─────────────────────────────────────────
  registry.emptyArchivedSessions = async function emptyArchivedSessions(options) {
    const archivedIds = [...(registry.requireState?.()?.archivedSessionIds ?? [])];
    // Every row cascades to its sub-sessions exactly like /purge: emptying the
    // recycle bin must not leave orphaned child directories behind.
    const result = await purgeSessionRows(registry, archivedIds, normalizeSessionIds(options?.excludeIds));

    if (result.deletedCount > 0) {
      notifyArchivedSessionsChanged(ctx, registry.requireState?.()?.archivedSessionIds ?? []);
    }
    if (result.failed.length > 0 && result.deletedCount === 0) {
      throw new Error(`failed to empty recycle bin: ${result.failed[0].message}`);
    }
    return result;
  };

  // ── listArchivedSessions ──────────────────────────────────────────
  //
  // ZERO LOG I/O (v0.4.4). Until v0.4.3 every row opened its session log and
  // decoded the entire Zstd frame chain just to count `turn/start` events and
  // to derive a title from the first user message. On the reference store
  // that meant ~0.2 s of header listing plus 10-198 ms PER archived session,
  // on the web server's own thread, on every open and on every archive /
  // unarchive / purge broadcast. Every fact the panel shows now comes from
  // durable state or the projection cache:
  //
  //   title       archivedMeta.title → projection-cache `title` → legacy
  //               archivedTitles (string entries only) → '未命名会话'
  //   turnCount   projection-cache `sessionStats.turns`
  //   fileSize    the header listing's own sizeBytes
  //   archivedAt  archivedMeta.at — the REAL archive time. The old value was
  //               the log's mtime, i.e. last ACTIVITY, which the panel
  //               labelled "最近删除" and sorted by.
  registry.listArchivedSessions = async function listArchivedSessions() {
    const state = registry.requireState?.();
    if (!state) return [];

    const archivedIds = state.archivedSessionIds ?? [];
    if (archivedIds.length === 0) return [];

    const archivedMeta = state.archivedMeta ?? {};
    const legacyTitles = state.archivedTitles ?? {};

    // ONE listing for the whole set. Its snapshot also carries sizeBytes —
    // the field the panel used to stat() every log to recover.
    let snapshots = [];
    try {
      snapshots = ((await persistence?.list?.()) ?? []).map(normalizeStoredSnapshot).filter(Boolean);
    } catch {
      // Listing failed: every row still renders from state alone.
    }
    const byId = new Map(snapshots.map((snapshot) => [snapshot.header.id, snapshot]));

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

    // WHY ONE PATH RESOLUTION PER ROW IS BOUNDED: the hover card shows where a
    // session actually LIVES, and that path is only knowable through the same
    // resolver ladder permanentlyDeleteSession already walks per session —
    // findLog (a service query), locate() (pure path computation, no I/O) and,
    // only when neither answers, a directory scan. It never decodes a log, so
    // the listing still OPENS nothing (inspect/open stay at zero) and the
    // store-wide header listing above is still the ONE listing.
    //
    // findLog may name a location whose file is already gone (documented cohort
    // behaviour), while this field promises a path ON DISK: one fileExists
    // stat — the predicate locate() itself goes through — settles that, and a
    // session with no log at all reports null instead of a stale location.
    const items = await Promise.all(archivedIds.map(async (sessionId) => {
      const snapshot = byId.get(sessionId);
      const header = snapshot?.header;
      const ws = workspaceBySession.get(sessionId);
      const meta = archivedMeta[sessionId];
      const cached = readCachedSessionFacts(projectionCache, header);
      // `archivedTitles` predates archivedMeta and is also where the pre-0.4.4
      // options-object bug parked its `{}` values: only strings are titles.
      const legacyTitle = typeof legacyTitles[sessionId] === 'string' ? legacyTitles[sessionId] : undefined;

      const title = meta?.title
        || cached.title
        || legacyTitle
        || (header?.title && header.title !== sessionId ? header.title : undefined)
        || '未命名会话';

      const resolvedLogPath = await resolveSessionLogPath(persistence, sessionId);
      const logPath = resolvedLogPath && (await fileExists(resolvedLogPath)) ? resolvedLogPath : null;

      return {
        sessionId,
        title,
        cwd: header?.cwd,
        workspacePath: ws?.workspacePath || ws?.cwd,
        workspaceTitle: ws?.workspaceTitle,
        // Rows archived before archivedMeta existed fall back to the header's
        // createdAt: stable and monotonic without touching the disk.
        archivedAt: typeof meta?.at === 'number' ? meta.at : (header?.createdAt ?? 0),
        fileSize: snapshot?.sizeBytes ?? 0,
        // null, NOT 0, when the cache cannot serve a current-generation
        // `sessionStats` row: an unknown count and a zero count are different
        // facts, and the panel must not print "0 轮对话" over a long session
        // whose checkpoint predates a format upgrade. The client omits the
        // chip for null.
        turnCount: typeof cached.turns === 'number' ? cached.turns : null,
        logPath,
      };
    }));

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
  // The two patched registry methods ride ON TOP of the registry's own
  // implementations, so a later install must be able to unwrap them.
  const ORIGINALS = {
    archiveSession: originalArchive,
    unarchiveSession: originalUnarchive,
  };
  for (const name of INSTALLED) {
    if (typeof registry[name] === 'function') {
      Object.defineProperty(registry[name], TRASH_PATCH, { value: token });
      if (typeof ORIGINALS[name] === 'function') {
        Object.defineProperty(registry[name], TRASH_PATCH_ORIGINAL, { value: ORIGINALS[name] });
      }
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

/**
 * Translate a `WorkspaceRegistry.archiveSession` refusal into an HTTP error.
 *
 * The registry owns two checks this plugin no longer shadows: the
 * session-existence check and the `workspace/session-activity` gate, which
 * refuses to archive a session that any provider still reports as working.
 * Both are ordinary refusals, so without this mapping they would reach the
 * browser as an opaque 500.
 *
 * Matching on `name` (not `instanceof`) is deliberate: the registry classes
 * are not a dependency of this bundle, and both set `this.name` explicitly.
 *
 * @param {unknown} error - the thrown registry refusal.
 * @returns {Error} an httpError, or the original error when unrecognized.
 */
function mapArchiveRefusal(error) {
  if (error?.name === 'WorkspaceActiveSessionError') {
    return httpError(409, 'SESSION_RUNNING', '会话正在运行中，请先停止后再移入回收站');
  }
  if (error?.name === 'WorkspaceUnknownSessionError') {
    return httpError(404, 'UNKNOWN_SESSION', String(error?.message ?? error));
  }
  return error;
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
        try {
          // Only a string may become the durable display title: the registry
          // itself passes an OPTIONS object in this argument slot, and storing
          // that object is what corrupted archivedTitles before v0.4.4.
          await registry?.archiveSession?.(sessionId, typeof title === 'string' ? title : undefined);
        } catch (error) {
          throw mapArchiveRefusal(error);
        }
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
    // POST children { sessionIds? } — the sub-session rows of the given parent
    // sessions (the whole store when the list is omitted): children whose
    // parent resolves, plus the orphans whose parent id resolves to nothing.
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/children`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } });
        const { sessionIds } = await readBody(req);
        ok(res, await buildChildrenReport(ctx, persistence, sessionIds));
      }),
    },
    // POST purge { sessionIds: [], excludeIds?: [] } — permanently delete the
    // given sessions AND their full-depth sub-session trees.
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/purge`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } });
        const { sessionIds, excludeIds } = await readBody(req);
        const ids = normalizeSessionIds(sessionIds);
        if (ids.length === 0) throw httpError(400, 'BAD_REQUEST', 'sessionIds[] is required');
        const result = await purgeSessionRows(registry, ids, excludeIds);
        if (result.deletedCount > 0) broadcastArchived();
        ok(res, result);
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
    // POST purge-workspace { workspacePath, sessionIds?, excludeIds? } — permanently delete all archived sessions in a workspace.
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/purge-workspace`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } });
        const { workspacePath, sessionIds, excludeIds } = await readBody(req);
        let targetIds = normalizeSessionIds(sessionIds);

        if (targetIds.length === 0 && workspacePath) {
          const archived = (await registry?.listArchivedSessions?.()) ?? [];
          targetIds = archived.filter((item) => item.workspacePath === workspacePath || item.cwd === workspacePath).map((item) => item.sessionId);
        }

        if (targetIds.length === 0) {
          return ok(res, { deletedCount: 0, keptCount: 0, deleted: [], kept: [], failed: [], errors: [], total: 0 });
        }

        const result = await purgeSessionRows(registry, targetIds, excludeIds);
        if (result.deletedCount > 0) broadcastArchived();
        ok(res, result);
      }),
    },
    // POST empty { excludeIds? } — permanently delete every archived session.
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/empty`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } });
        const { excludeIds } = await readBody(req);
        const result = await registry.emptyArchivedSessions({ excludeIds: normalizeSessionIds(excludeIds) });
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