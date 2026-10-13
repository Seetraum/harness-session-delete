import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionTrashHost } from '../packages/session-trash-host/lib/index.js';

/**
 * Sub-session (child) coverage for the host side:
 *
 *  - POST /children — the sub-session rows of the given parents, plus the
 *    orphans whose parent id resolves to nothing.
 *  - POST /purge, /purge-workspace and /empty — deletion is a ROW operation:
 *    the primary session plus its full-depth descendants, minus excludeIds,
 *    refused as a whole while any descendant is live.
 *
 * A subagent session is a SIBLING directory of its parent and its id never
 * enters the workspace registry, so every test builds the on-disk layout
 * (~/.dsh/sessions/<project>/<id>/) under HOME pointed at a .tmp sandbox: the
 * real store is never touched, and the physical scan rung has something to
 * find.
 */
const INIT = Symbol.for('cordis.init');

function makeRes() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    end(text) { this.body = text === undefined ? null : JSON.parse(text); },
  };
}

function request(method, body, headers = {}) {
  const req = { method, headers };
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify(body ?? {}), 'utf8');
  };
  return req;
}

describe('Session Trash Host — sub-session cascade and /children', () => {
  let tempDir;
  let homeDir;
  let sessionsRoot;
  let savedHome;

  // Stored state every fake host reads from.
  let headers;
  let sizes;
  let logPaths;
  let staleLogPaths;
  let state;
  let liveIds;
  let cacheRows;
  let traceMap;
  let readCounts;
  let listingThrows;
  let markCleanIds;
  let routeTable;

  beforeEach(async () => {
    tempDir = join(process.cwd(), '.tmp', `dsh-trash-children-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    homeDir = join(tempDir, 'home');
    sessionsRoot = join(homeDir, '.dsh', 'sessions');
    await mkdir(sessionsRoot, { recursive: true });
    // ~/.dsh is resolved through HOME, so the sandbox home is what keeps every
    // scan (the plugin's and the test's) out of the real store.
    savedHome = process.env.HOME;
    process.env.HOME = homeDir;

    headers = new Map();
    sizes = new Map();
    logPaths = new Map();
    staleLogPaths = new Map();
    state = { archivedSessionIds: [], archivedMeta: {} };
    liveIds = new Set();
    cacheRows = new Map();
    traceMap = new Map();
    readCounts = { list: 0, inspect: 0, open: 0, query: 0, trace: 0 };
    listingThrows = false;
    markCleanIds = new Set();
    routeTable = new Map();
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  /** Create one session's directory + log and index its stored header. */
  async function seed(id, header = {}, content = 'log') {
    const dir = join(sessionsRoot, 'proj', id);
    await mkdir(dir, { recursive: true });
    const logPath = join(dir, 'session.v4.jsonl.zstd');
    await writeFile(logPath, content);
    logPaths.set(id, logPath);
    headers.set(id, { id, ...header });
    return logPath;
  }

  const dirExists = (id) => stat(join(sessionsRoot, 'proj', id)).then(() => true).catch(() => false);

  /** 0.1.5-style listing snapshots: the header plus its free sizeBytes. */
  const listingItems = () => [...headers.values()].map((header) => (
    sizes.has(header.id) ? { header, sizeBytes: sizes.get(header.id) } : { header }
  ));

  /** Mount the plugin over a fake host; the routes land in `routeTable`. */
  async function mount({ withQuery = false, entities = new Map() } = {}) {
    const persistence = {
      list: async () => {
        readCounts.list++;
        if (listingThrows) throw new Error('listing unavailable');
        return listingItems();
      },
      findLog: async (id) => logPaths.get(id) ?? staleLogPaths.get(id),
      locate: (meta) => ({ kind: 'jsonl', path: logPaths.get(meta.id) }),
      inspect: async (id) => {
        readCounts.inspect++;
        return { header: headers.get(id), events: [] };
      },
      open: async (id) => {
        readCounts.open++;
        return { read: async () => ({ header: headers.get(id), events: [] }), close: async () => {} };
      },
    };

    const registry = {
      requireState: () => state,
      setState: async (next) => { Object.assign(state, next); },
      enqueueOperation: async (fn) => fn(),
      entities,
      archiveSession: async (id) => {
        if (!state.archivedSessionIds.includes(id)) state.archivedSessionIds.push(id);
      },
      unarchiveSession: async (id) => {
        state.archivedSessionIds = state.archivedSessionIds.filter((x) => x !== id);
      },
    };

    const cache = {
      requireTable: () => ({ delete: async () => {} }),
      // markClean sits OUTSIDE the patch's try/catch, which is what lets a test
      // fail one id's cache step deterministically.
      markClean: (id) => {
        if (markCleanIds.has(id)) throw new Error(`cache offline for ${id}`);
      },
      cachedSnapshot: (header) => {
        const row = cacheRows.get(header?.id);
        return row ? { asOfSeq: 1, values: { title: row.title, sessionStats: { turns: row.turns } } } : undefined;
      },
    };

    const ctx = {
      sessionPersistence: persistence,
      sessionProjectionCache: cache,
      workspaceRegistry: registry,
      typert: { local: new Map(), broadcast: () => {} },
      webServer: {
        register: (route) => {
          routeTable.set(route.path, route);
          return () => routeTable.delete(route.path);
        },
      },
      provide: () => {},
      reflect: { provide: () => {} },
      emit: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      get: (key) => {
        if (key === 'sessionProjectionCache') return cache;
        if (key === 'agents') return { get: (id) => (liveIds.has(id) ? { status: 'running' } : undefined) };
        if (key === 'sessions') return new Map();
        if (key === 'sessionQuery' && withQuery) {
          return {
            listSessions: async () => {
              readCounts.query++;
              // The kernel's real projection (dsh-session-query): exactly
              // { header, live, persisted } — deliberately NO sizeBytes.
              return [...headers.values()].map((header) => ({
                header,
                live: liveIds.has(header.id) ? 'running' : 'idle',
                persisted: true,
              }));
            },
            traceSession: async (id) => {
              readCounts.trace++;
              return { target: id, ancestors: [], descendants: traceMap.get(id) ?? [] };
            },
          };
        }
        return undefined;
      },
    };

    const plugin = new SessionTrashHost(ctx);
    await plugin[INIT]();
    return { registry, persistence, cache };
  }

  async function call(path, body) {
    const res = makeRes();
    const route = routeTable.get(path);
    assert.ok(route, `route ${path} must be registered`);
    await route.handler(request('POST', body, { 'x-dsh-plugin': 'session-trash' }), res);
    return res;
  }

  test('1. cascade: purging a parent removes its whole sub-session tree', async () => {
    await seed('root-1', { createdAt: 1 });
    await seed('kid-1', { parentSession: 'root-1', origin: 'subagent', delegationDepth: 1, createdAt: 2 });
    await seed('grand-1', { parentSession: 'kid-1', origin: 'subagent', delegationDepth: 2, createdAt: 3 });
    await seed('unrelated-1', { createdAt: 4 });
    traceMap.set('root-1', ['kid-1', 'grand-1']);
    // Only the parent is in the recycle bin: the child ids never enter the
    // workspace registry, so the cascade is the only thing that can see them.
    state.archivedSessionIds = ['root-1'];
    state.archivedMeta = { 'root-1': { at: 10, title: '父会话' } };
    await mount({ withQuery: true });

    const res = await call('/api/session-trash/purge', { sessionIds: ['root-1'] });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.data.deletedCount, 3);
    assert.deepStrictEqual(res.body.data.deleted, ['root-1', 'kid-1', 'grand-1']);
    assert.deepStrictEqual(res.body.data.failed, []);
    assert.deepStrictEqual(res.body.data.kept, []);
    assert.strictEqual(await dirExists('root-1'), false, 'parent directory removed');
    assert.strictEqual(await dirExists('kid-1'), false, 'child directory removed');
    assert.strictEqual(await dirExists('grand-1'), false, 'grandchild directory removed');
    assert.strictEqual(await dirExists('unrelated-1'), true, 'the untouched sibling survives');
    assert.deepStrictEqual(state.archivedSessionIds, [], 'the archived parent leaves the recycle bin');
    assert.ok(!('root-1' in state.archivedMeta), 'its display metadata is dropped in the same write');
  });

  test('2. cascade without sessionQuery: the header map is walked recursively', async () => {
    await seed('root-1', { createdAt: 1 });
    await seed('kid-1', { parentSession: 'root-1', delegationDepth: 1, createdAt: 2 });
    await seed('grand-1', { parentSession: 'kid-1', delegationDepth: 2, createdAt: 3 });
    await mount({ withQuery: false });

    const res = await call('/api/session-trash/purge', { sessionIds: ['root-1'] });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.data.deleted, ['root-1', 'kid-1', 'grand-1']);
    assert.strictEqual(await dirExists('grand-1'), false, 'the walk reaches full depth without sessionQuery');
    assert.strictEqual(readCounts.trace, 0, 'the recursive rung runs when traceSession is absent');
  });

  test('3. excludeIds spares a child and reports it as kept', async () => {
    await seed('root-1', { createdAt: 1 });
    await seed('kid-1', { parentSession: 'root-1', delegationDepth: 1, createdAt: 2 });
    await seed('kid-2', { parentSession: 'root-1', delegationDepth: 1, createdAt: 3 });
    traceMap.set('root-1', ['kid-1', 'kid-2']);
    await mount({ withQuery: true });

    const res = await call('/api/session-trash/purge', { sessionIds: ['root-1'], excludeIds: ['kid-2'] });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.data.deleted, ['root-1', 'kid-1']);
    assert.deepStrictEqual(res.body.data.kept, ['kid-2']);
    assert.strictEqual(res.body.data.deletedCount, 2);
    assert.strictEqual(res.body.data.keptCount, 1);
    assert.strictEqual(await dirExists('root-1'), false);
    assert.strictEqual(await dirExists('kid-1'), false);
    assert.strictEqual(await dirExists('kid-2'), true, 'an excluded child stays on disk');
  });

  test('4. a live descendant refuses the whole row, names it, and deletes nothing', async () => {
    await seed('root-1', { createdAt: 1 });
    await seed('kid-1', { parentSession: 'root-1', delegationDepth: 1, createdAt: 2 });
    await seed('kid-2', { parentSession: 'root-1', delegationDepth: 1, createdAt: 3 });
    traceMap.set('root-1', ['kid-1', 'kid-2']);
    liveIds = new Set(['kid-2']);
    const { registry } = await mount({ withQuery: true });

    // Excluding the running child does NOT rescue the row: the store must not
    // be mutated underneath a running agent.
    await assert.rejects(
      () => registry.permanentlyDeleteSession('root-1', { excludeIds: ['kid-2'] }),
      (error) => {
        assert.strictEqual(error.code, 'SESSION_RUNNING');
        assert.match(error.message, /kid-2/, 'the message names the running child');
        assert.deepStrictEqual(error.runningSessionIds, ['kid-2']);
        return true;
      },
    );

    const res = await call('/api/session-trash/purge', { sessionIds: ['root-1'], excludeIds: ['kid-2'] });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.deletedCount, 0);
    assert.deepStrictEqual(res.body.data.deleted, []);
    assert.strictEqual(res.body.data.failed.length, 1);
    assert.strictEqual(res.body.data.failed[0].sessionId, 'root-1');
    assert.match(res.body.data.failed[0].message, /kid-2/);
    // Nothing was removed for this row — parent and BOTH children are intact.
    assert.strictEqual(await dirExists('root-1'), true, 'parent intact');
    assert.strictEqual(await dirExists('kid-1'), true, 'idle child intact');
    assert.strictEqual(await dirExists('kid-2'), true, 'running child intact');
  });

  test('5. /children groups children, resolves registry-only parents, and lists orphans', async () => {
    await seed('root-1', { delegationDepth: 0, createdAt: 1 });
    await seed('kid-1', { parentSession: 'root-1', origin: 'subagent', delegationDepth: 1, createdAt: 2 });
    await seed('kid-2', { parentSession: 'root-1', origin: 'subagent', delegationDepth: 1, createdAt: 3 });
    await seed('orphan-kid', { parentSession: 'gone-parent', delegationDepth: 1, createdAt: 4 });
    await seed('ws-kid', { parentSession: 'ws-only-parent', delegationDepth: 1, createdAt: 5 });
    sizes.set('kid-1', 4096);
    cacheRows.set('kid-1', { title: '子会话标题' });
    liveIds = new Set(['kid-2']);
    // A parent with no log of its own still resolves through the workspace
    // registry — the second half of the resolution rule.
    const entities = new Map([
      ['ws-1', { record: { path: '/work/proj', title: 'Proj', sessionIds: ['ws-only-parent'] }, detachSession: async () => {} }],
    ]);
    await mount({ withQuery: false, entities });

    const res = await call('/api/session-trash/children', {});

    assert.strictEqual(res.status, 200);
    const { groups, orphans, sessionCount, scannedAt, degraded } = res.body.data;
    assert.deepStrictEqual(Object.keys(groups).sort(), ['root-1', 'ws-only-parent']);
    assert.deepStrictEqual(Object.keys(orphans), ['gone-parent']);
    assert.strictEqual(sessionCount, 5);
    assert.strictEqual(typeof scannedAt, 'number');
    assert.strictEqual(degraded, undefined, 'a served scan is not degraded');

    assert.deepStrictEqual(groups['root-1'].map((c) => c.id), ['kid-1', 'kid-2']);
    assert.deepStrictEqual(groups['ws-only-parent'].map((c) => c.id), ['ws-kid']);
    assert.deepStrictEqual(orphans['gone-parent'].map((c) => c.id), ['orphan-kid']);

    const kid1 = groups['root-1'][0];
    assert.deepStrictEqual(kid1, {
      id: 'kid-1',
      title: '子会话标题',
      fileSize: 4096,
      createdAt: 2,
      delegationDepth: 1,
      live: false,
    });
    // No sizeBytes for kid-2 in this listing: the row is measured from its own
    // log file, never turned into a 0. Its title is genuinely unknown.
    const kid2 = groups['root-1'][1];
    assert.strictEqual(kid2.fileSize, 3, 'a missing listing size is measured from the log');
    assert.strictEqual(kid2.title, null);
    assert.strictEqual(kid2.live, true, 'a session whose agent is not idle is live');
  });

  test('6. /children narrows to the requested parents', async () => {
    await seed('root-1', { createdAt: 1 });
    await seed('kid-1', { parentSession: 'root-1', delegationDepth: 1, createdAt: 2 });
    await seed('orphan-kid', { parentSession: 'gone-parent', delegationDepth: 1, createdAt: 3 });
    await mount({ withQuery: false });

    const res = await call('/api/session-trash/children', { sessionIds: ['root-1'] });

    assert.deepStrictEqual(Object.keys(res.body.data.groups), ['root-1']);
    assert.deepStrictEqual(res.body.data.orphans, {}, 'an unrequested parent id is not reported');
  });

  test('7. /children degrades instead of throwing when no rung can enumerate', async () => {
    await seed('root-1', { createdAt: 1 });
    await seed('kid-1', { parentSession: 'root-1', delegationDepth: 1, createdAt: 2 });
    listingThrows = true;
    // A home with no session store at all: the physical rung fails too.
    const emptyHome = join(tempDir, 'empty-home');
    await mkdir(emptyHome, { recursive: true });
    process.env.HOME = emptyHome;
    await mount({ withQuery: false });

    const res = await call('/api/session-trash/children', {});

    assert.strictEqual(res.status, 200, 'a broken store must not fail the request');
    assert.strictEqual(res.body.ok, true);
    assert.deepStrictEqual(res.body.data.groups, {});
    assert.deepStrictEqual(res.body.data.orphans, {});
    assert.strictEqual(res.body.data.sessionCount, 0);
    assert.strictEqual(res.body.data.degraded, true);
  });

  test('8. the physical scan rung reads headers from disk when no listing works', async () => {
    await seed('root-1', { createdAt: 1 });
    await seed('kid-1', { parentSession: 'root-1', delegationDepth: 1, createdAt: 2 });
    listingThrows = true;
    await mount({ withQuery: false });

    const res = await call('/api/session-trash/children', {});

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.degraded, undefined, 'the scan rung serves the report');
    assert.deepStrictEqual(res.body.data.groups['root-1'].map((c) => c.id), ['kid-1']);
    assert.strictEqual(res.body.data.groups['root-1'][0].fileSize, 3, 'the scanned log supplies its own size');
    assert.strictEqual(readCounts.inspect > 0, true, 'the header comes from the existing header convention');
  });

  test('9. GET /list performs zero log I/O', async () => {
    const seeded = await seed('sess-l', { createdAt: 1 });
    sizes.set('sess-l', 2048);
    state.archivedSessionIds = ['sess-l'];
    await mount();

    const res = makeRes();
    await routeTable.get('/api/session-trash/list').handler({ method: 'GET', headers: {} }, res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.items.length, 1);
    assert.strictEqual(res.body.data.items[0].fileSize, 2048);
    // The new path field rides the resolver, which never decodes a log.
    assert.strictEqual(res.body.data.items[0].logPath, seeded, 'the row carries its real on-disk path');
    assert.strictEqual(readCounts.inspect, 0, 'the list must not inspect a session log');
    assert.strictEqual(readCounts.open, 0, 'the list must not open a session log');
    assert.strictEqual(readCounts.list, 1, 'it is served by the one header listing');
  });

  test('10. a partial failure deletes the good rows and reports the refused one', async () => {
    await seed('ok-root', { createdAt: 1 });
    await seed('live-root', { createdAt: 2 });
    await seed('live-kid', { parentSession: 'live-root', delegationDepth: 1, createdAt: 3 });
    traceMap.set('live-root', ['live-kid']);
    liveIds = new Set(['live-kid']);
    await mount({ withQuery: true });

    const res = await call('/api/session-trash/purge', { sessionIds: ['ok-root', 'live-root'] });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.deletedCount, 1);
    assert.deepStrictEqual(res.body.data.deleted, ['ok-root']);
    assert.strictEqual(res.body.data.total, 2);
    assert.strictEqual(res.body.data.failed.length, 1);
    assert.deepStrictEqual(res.body.data.failed[0], { sessionId: 'live-root', message: res.body.data.failed[0].message });
    assert.match(res.body.data.failed[0].message, /live-kid/);
    // The released client reads `errors[].sessionId` + `code`; both survive.
    assert.strictEqual(res.body.data.errors.length, 1);
    assert.strictEqual(res.body.data.errors[0].sessionId, 'live-root');
    assert.strictEqual(res.body.data.errors[0].code, 'SESSION_RUNNING');
    assert.strictEqual(await dirExists('ok-root'), false);
    assert.strictEqual(await dirExists('live-root'), true, 'the refused row is untouched');
    assert.strictEqual(await dirExists('live-kid'), true);
  });

  test('11. a mid-row failure never rolls back the ids already deleted', async () => {
    await seed('root-1', { createdAt: 1 });
    await seed('kid-1', { parentSession: 'root-1', delegationDepth: 1, createdAt: 2 });
    traceMap.set('root-1', ['kid-1']);
    markCleanIds = new Set(['kid-1']);
    await mount({ withQuery: true });

    const res = await call('/api/session-trash/purge', { sessionIds: ['root-1'] });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.data.deleted, ['root-1'], 'the ids removed before the failure are reported');
    assert.strictEqual(res.body.data.failed.length, 1);
    assert.strictEqual(res.body.data.failed[0].sessionId, 'root-1');
    assert.match(res.body.data.failed[0].message, /cache offline for kid-1/);
    assert.strictEqual(await dirExists('root-1'), false, 'no rollback');
  });

  test('12. /empty cascades every archived row and honours excludeIds', async () => {
    await seed('root-1', { createdAt: 1 });
    await seed('kid-1', { parentSession: 'root-1', delegationDepth: 1, createdAt: 2 });
    await seed('kid-2', { parentSession: 'root-1', delegationDepth: 1, createdAt: 3 });
    await seed('plain-1', { createdAt: 4 });
    traceMap.set('root-1', ['kid-1', 'kid-2']);
    state.archivedSessionIds = ['root-1', 'plain-1'];
    await mount({ withQuery: true });

    const res = await call('/api/session-trash/empty', { excludeIds: ['kid-2'] });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.deletedCount, 3);
    assert.deepStrictEqual(res.body.data.deleted, ['root-1', 'kid-1', 'plain-1']);
    assert.deepStrictEqual(res.body.data.kept, ['kid-2']);
    assert.strictEqual(await dirExists('kid-1'), false);
    assert.strictEqual(await dirExists('kid-2'), true, 'the excluded child survives the empty');
    assert.strictEqual(await dirExists('plain-1'), false);
    assert.deepStrictEqual(state.archivedSessionIds, []);
  });

  test('13. /purge-workspace takes the same excludeIds parameterization', async () => {
    await seed('root-1', { createdAt: 1 });
    await seed('kid-1', { parentSession: 'root-1', delegationDepth: 1, createdAt: 2 });
    traceMap.set('root-1', ['kid-1']);
    await mount({ withQuery: true });

    const res = await call('/api/session-trash/purge-workspace', {
      workspacePath: '/work/proj',
      sessionIds: ['root-1'],
      excludeIds: ['kid-1'],
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.deletedCount, 1);
    assert.deepStrictEqual(res.body.data.deleted, ['root-1']);
    assert.deepStrictEqual(res.body.data.kept, ['kid-1']);
    assert.strictEqual(await dirExists('root-1'), false);
    assert.strictEqual(await dirExists('kid-1'), true);
  });

  test('14. /children uses sessionQuery.listSessions() when the kernel exposes it', async () => {
    await seed('root-1', { createdAt: 1 });
    await seed('kid-1', { parentSession: 'root-1', delegationDepth: 1, createdAt: 2 });
    await mount({ withQuery: true });

    const res = await call('/api/session-trash/children', {});

    assert.strictEqual(res.status, 200);
    assert.strictEqual(readCounts.query, 1, 'the kernel listing is the first rung');
    assert.strictEqual(readCounts.list, 0, 'the header listing is not consulted once the kernel answers');
    assert.deepStrictEqual(res.body.data.groups['root-1'].map((c) => c.id), ['kid-1']);
  });

  test('15. /purge without sessionIds is rejected before any work', async () => {
    await mount();
    const res = await call('/api/session-trash/purge', { sessionIds: [] });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, 'BAD_REQUEST');
  });

  test('16. a sessionQuery record without sizeBytes still reports the real file size', async () => {
    // The kernel's listSessions() projects only { header, live, persisted }, so
    // on a host that has sessionQuery (every 0.2.0-rc.2 host) a report that
    // only trusted listing sizeBytes would read fileSize: null for EVERY row.
    // The row we actually return is measured instead — and the store-wide
    // header listing is still never consulted.
    await seed('root-1', { createdAt: 1 });
    const logPath = await seed('kid-1', { parentSession: 'root-1', delegationDepth: 1, createdAt: 2 }, 'x'.repeat(1234));
    await mount({ withQuery: true });

    const res = await call('/api/session-trash/children', {});

    assert.strictEqual(res.status, 200);
    const kid = res.body.data.groups['root-1'][0];
    assert.strictEqual(kid.fileSize, 1234);
    assert.strictEqual(kid.fileSize, (await stat(logPath)).size, 'the real byte count of the log');
    assert.strictEqual(readCounts.list, 0, 'the size is measured, never listed');
  });

  test('17. a child whose log is gone reports fileSize null, never 0', async () => {
    await seed('root-1', { createdAt: 1 });
    // A header with no session directory at all: the log the size would be
    // measured from does not exist.
    headers.set('gone-kid', { id: 'gone-kid', parentSession: 'root-1', delegationDepth: 1, createdAt: 2 });
    await mount({ withQuery: true });

    const res = await call('/api/session-trash/children', {});

    assert.strictEqual(res.status, 200);
    const kid = res.body.data.groups['root-1'][0];
    assert.strictEqual(kid.id, 'gone-kid');
    assert.strictEqual(kid.fileSize, null, 'an unmeasurable size is null, not zero');
  });

  test('18. /list reports each session\'s real on-disk log path', async () => {
    const logPath = await seed('sess-a', { createdAt: 1 });
    const otherPath = await seed('sess-b', { createdAt: 2 });
    state.archivedSessionIds = ['sess-a', 'sess-b'];
    await mount();

    const res = makeRes();
    await routeTable.get('/api/session-trash/list').handler({ method: 'GET', headers: {} }, res);

    assert.strictEqual(res.status, 200);
    const byId = new Map(res.body.data.items.map((i) => [i.sessionId, i]));
    assert.strictEqual(byId.get('sess-a').logPath, logPath, 'the resolved path is the real one');
    assert.strictEqual(byId.get('sess-b').logPath, otherPath);
    assert.strictEqual((await stat(byId.get('sess-a').logPath)).isFile(), true, 'the reported path exists');
    assert.strictEqual(byId.get('sess-a').title, '未命名会话', 'the other row fields are untouched');
    assert.strictEqual(readCounts.list, 1, 'resolving paths adds no listing');
    assert.strictEqual(readCounts.inspect + readCounts.open, 0, 'and opens no log');
  });

  test('19. /list reports logPath null for a session with no log on disk', async () => {
    // Registry-only ghost: no directory, no log, and findLog knows nothing.
    headers.set('ghost', { id: 'ghost', createdAt: 1 });
    // A stale resolver answer: findLog still knows a location whose file was
    // deleted behind the host's back (documented cohort behaviour). The field
    // promises a path ON DISK, so this is null too.
    headers.set('stale', { id: 'stale', createdAt: 2 });
    staleLogPaths.set('stale', join(sessionsRoot, 'proj', 'stale', 'session.v4.jsonl.zstd'));
    state.archivedSessionIds = ['ghost', 'stale'];
    await mount();

    const res = makeRes();
    await routeTable.get('/api/session-trash/list').handler({ method: 'GET', headers: {} }, res);

    assert.strictEqual(res.status, 200, 'a missing log must not fail the listing');
    const byId = new Map(res.body.data.items.map((i) => [i.sessionId, i]));
    assert.strictEqual(byId.get('ghost').logPath, null);
    assert.strictEqual(byId.get('stale').logPath, null, 'a location whose file is gone is not a path on disk');
  });
});
