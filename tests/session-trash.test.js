import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionTrashHost } from '../packages/session-trash-host/lib/index.js';

/** Minimal Node response recorder for driving one registered route handler. */
function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(chunk) { this.body = chunk ?? ''; },
  };
}

describe('Session Trash Host Plugin Test Suite', () => {
  let mockCtx;
  let mockPersistence;
  let mockCache;
  let projectionRows;
  let mockRegistry;
  let mockTypert;
  let mockSessions;
  let mockState;
  let tempDir;
  let plugin;

  beforeEach(async () => {
    tempDir = join(process.cwd(), '.tmp', `dsh-trash-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
    await mkdir(tempDir, { recursive: true });

    mockSessions = new Map();

    mockPersistence = {
      locate: (header) => ({ path: join(tempDir, header.id, 'session.jsonl') }),
      findLog: async (id) => join(tempDir, id, 'session.jsonl'),
      list: async () => [
        { id: 'sess-1', title: 'Session 1', cwd: '/work/proj1' },
        { id: 'sess-2', title: 'Session 2', cwd: '/work/proj2' },
        { id: 'sess-active', title: 'Active Session', cwd: '/work/proj3' },
      ],
    };

    const mockTable = {
      delete: async (id) => {
        if (id === 'error-id') throw new Error('DB Table error');
      },
    };
    // The listing facts the recycle bin now reads with zero log I/O: the same
    // `cachedSnapshot(header, keys)` face DSH's own session list uses. The real
    // cache validates the header against the stored lifecycle identity; this
    // fake keys on the header id and answers only for rows a test seeds.
    projectionRows = new Map();
    mockCache = {
      requireTable: () => mockTable,
      markClean: (id) => {},
      cachedSnapshot: (header) => {
        const row = projectionRows.get(header?.id);
        if (!row) return undefined;
        return { asOfSeq: 1, values: { title: row.title, sessionStats: { turns: row.turns } } };
      },
    };

    mockState = {
      archivedSessionIds: ['sess-1', 'sess-2'],
    };
    const mockEntities = new Map([
      [
        'ws-1',
        {
          record: { path: '/work/proj1', title: 'Proj 1', sessionIds: ['sess-1'] },
          detachSession: async (sid) => {
            const idx = mockEntities.get('ws-1').record.sessionIds.indexOf(sid);
            if (idx >= 0) mockEntities.get('ws-1').record.sessionIds.splice(idx, 1);
          },
        },
      ],
    ]);

    mockRegistry = {
      requireState: () => mockState,
      setState: async (newState) => {
        Object.assign(mockState, newState);
      },
      enqueueOperation: async (fn) => fn(),
      entities: mockEntities,
      archivedSessionIds: mockState.archivedSessionIds,
    };

    const localMethods = new Map();
    mockTypert = {
      local: localMethods,
      broadcast: (event, payload) => {},
    };

    mockCtx = {
      sessionPersistence: mockPersistence,
      sessionProjectionCache: mockCache,
      workspaceRegistry: mockRegistry,
      typert: mockTypert,
      provide: () => {},
      reflect: {
        provide: () => {},
      },
      get: (key) => {
        if (key === 'sessionProjectionCache') return mockCache;
        if (key === 'agents') return {
          get: (id) => (id === 'sess-active' ? { status: 'running' } : undefined),
        };
        return undefined;
      },
      emit: () => {},
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    };

    plugin = new SessionTrashHost(mockCtx);
    const initSymbol = Symbol.for('cordis.init');
    if (typeof plugin[initSymbol] === 'function') {
      await plugin[initSymbol]();
    }
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('1. SessionProjectionCache.remove - Fail-Soft Behavior', async () => {
    await mockCache.remove('sess-1');

    await assert.doesNotReject(async () => {
      await mockCache.remove('error-id');
    });
  });

  test('3. WorkspaceRegistry.unarchiveSession', async () => {
    await mockRegistry.unarchiveSession('sess-1');

    const state = mockRegistry.requireState();
    assert.deepStrictEqual(state.archivedSessionIds, ['sess-2']);
  });

  test('4. WorkspaceRegistry.permanentlyDeleteSession Guarding Live Sessions', async () => {
    await assert.rejects(
      async () => {
        await mockRegistry.permanentlyDeleteSession('sess-active');
      },
      { message: /会话正在运行中，请等待结束后再删除/ }
    );
  });

  test('5. WorkspaceRegistry.permanentlyDeleteSession & emptyArchivedSessions', async () => {
    await mockRegistry.permanentlyDeleteSession('sess-1');

    let state = mockRegistry.requireState();
    assert.deepStrictEqual(state.archivedSessionIds, ['sess-2']);
    // The workspace record keeps its sessionIds slot (an invisible ghost once
    // the log is gone); detaching would surface still-listed sessions under
    // an ungrouped section instead of deleting them.
    assert.deepStrictEqual(mockRegistry.entities.get('ws-1').record.sessionIds, ['sess-1']);

    const emptyRes = await mockRegistry.emptyArchivedSessions();
    assert.strictEqual(emptyRes.deletedCount, 1);

    state = mockRegistry.requireState();
    assert.deepStrictEqual(state.archivedSessionIds, []);
  });

  test('6. Ghost session (no log on disk) is detached, not restored', async () => {
    // ghost-sess is archived AND in the workspace record, but has NO physical
    // log — findLog returns undefined for it.
    mockState.archivedSessionIds.push('ghost-sess');
    mockRegistry.entities.get('ws-1').record.sessionIds.push('ghost-sess');
    const originalFindLog = mockPersistence.findLog;
    mockPersistence.findLog = async (id) => (id === 'ghost-sess' ? undefined : originalFindLog(id));

    await mockRegistry.permanentlyDeleteSession('ghost-sess');

    const state = mockRegistry.requireState();
    assert.ok(!state.archivedSessionIds.includes('ghost-sess'), 'ghost should be removed from archive set');
    assert.ok(!mockRegistry.entities.get('ws-1').record.sessionIds.includes('ghost-sess'), 'ghost should be detached from workspace');
  });

  test('7. listArchivedSessions returns archived sessions with workspace info and metadata', async () => {
    const items = await mockRegistry.listArchivedSessions();

    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].sessionId, 'sess-1');
    assert.strictEqual(items[0].title, 'Session 1');
    assert.strictEqual(items[0].workspacePath, '/work/proj1');
    assert.strictEqual(items[0].workspaceTitle, 'Proj 1');
    assert.ok(typeof items[0].archivedAt === 'number');
    assert.ok(typeof items[0].fileSize === 'number');
    assert.strictEqual(items[1].sessionId, 'sess-2');
    // sess-2 is not accounted in any workspace record
    assert.strictEqual(items[1].workspacePath, undefined);
  });

  test('8. Dual-cohort: 0.1.5-shape persistence (snapshot list) works', async () => {
    // Simulate DSH 0.1.5-rc.1: list() returns SessionPersistenceSnapshot[]
    // ({ header, sizeBytes, ... }) instead of bare SessionHeader[]. That shape
    // is now the ONLY cohort difference the list depends on — it resolves the
    // header (lifecycle witness) and the free sizeBytes from it.
    const sessDir = join(tempDir, 'sess-v3');
    await mkdir(sessDir, { recursive: true });
    const logPath = join(sessDir, 'session.v3.jsonl');

    // The physical log only has to EXIST: the list no longer reads it, and
    // permanentlyDeleteSession resolves and removes it by path.
    await writeFile(logPath, JSON.stringify({ type: 'session/start', createdAt: 100 }) + '\n', 'utf8');

    const bShapePersistence = {
      // 0.1.5: list returns snapshots wrapping the header, and sizeBytes is a
      // free field of that snapshot — the panel shows it without stat()ing.
      list: async () => [
        { header: { id: 'sess-v3', title: 'V3 Session', cwd: '/work/proj3' }, revision: 1, eventCount: 5, sizeBytes: 4096 },
        { header: { id: 'sess-2', title: 'Session 2', cwd: '/work/proj2' }, revision: 1 },
      ],
      // 0.1.5: no inspect, no service-level findLog; locate still computes a path.
      // No `open` either: since v0.4.4 the LIST never reads a log, so the
      // handle API is no longer part of this path. Its read-access contract is
      // covered where it now lives — the preview route (test 10).
      locate: (meta) => ({ kind: 'jsonl', path: join(tempDir, meta.id, 'session.v3.jsonl') }),
    };

    // Reuse the plugin's own patching through a fresh host instance.
    const patchCtx = { ...mockCtx, sessionPersistence: bShapePersistence };
    const entities = new Map([
      ['ws-3', { record: { path: '/work/proj3', title: 'Proj 3', sessionIds: ['sess-v3'] }, detachSession: async (sid) => {} }],
    ]);
    mockCtx.workspaceRegistry.entities = entities;
    const bPlugin = new SessionTrashHost(patchCtx);
    const initSymbol = Symbol.for('cordis.init');
    await bPlugin[initSymbol]();

    // listArchivedSessions: snapshot headers normalized, and every listing
    // fact served from state + the projection cache — the log is not touched.
    projectionRows.set('sess-v3', { turns: 2 });
    mockState.archivedSessionIds = ['sess-v3', 'sess-2'];
    const items = await mockCtx.workspaceRegistry.listArchivedSessions();
    const v3 = items.find((i) => i.sessionId === 'sess-v3');
    assert.ok(v3, 'sess-v3 listed');
    assert.strictEqual(v3.title, 'V3 Session', 'title from the normalized snapshot header');
    assert.strictEqual(v3.turnCount, 2, 'turnCount from the projection cache');
    assert.strictEqual(v3.fileSize, 4096, 'fileSize from the listing snapshot sizeBytes (no stat)');

    // permanentlyDeleteSession: locate resolves the existing log -> workspace slot kept.
    mockState.archivedSessionIds = ['sess-v3'];
    await mockCtx.workspaceRegistry.permanentlyDeleteSession('sess-v3');
    assert.ok(!mockState.archivedSessionIds.includes('sess-v3'), 'sess-v3 removed from archive');
    assert.deepStrictEqual(entities.get('ws-3').record.sessionIds, ['sess-v3'], 'workspace slot kept (log existed)');
  });

  test('9. Dual-cohort: 0.1.5 findLog returns a generation descriptor, not a path', async () => {
    // Regression found by the real-0.1.5 sandbox harness: on 0.1.1/0.1.2
    // findLog(id) returns a path STRING, but the 0.1.5 jsonl backend returns
    // { sourcePath, sourceVersion, currentPath }. Returning that object made
    // dirname() throw, so permanent delete failed and list metadata zeroed.
    const sessDir = join(tempDir, 'sess-desc');
    await mkdir(sessDir, { recursive: true });
    const logPath = join(sessDir, 'session.v3.jsonl');
    await writeFile(logPath, '{"type":"turn/start"}\n', 'utf8');

    const descriptorPersistence = {
      // 0.1.5 shape: a generation descriptor object.
      findLog: async () => ({ sourcePath: logPath, sourceVersion: 3, currentPath: logPath }),
      locate: () => ({ kind: 'jsonl', path: logPath }),
      list: async () => [{ header: { id: 'sess-desc', title: 'Desc Session', cwd: '/work/proj9' }, revision: 1, sizeBytes: 21 }],
    };

    const entities = new Map([
      ['ws-9', { record: { path: '/work/proj9', title: 'Proj 9', sessionIds: ['sess-desc'] }, detachSession: async () => {} }],
    ]);
    const descCtx = { ...mockCtx, sessionPersistence: descriptorPersistence };
    mockCtx.workspaceRegistry.entities = entities;
    const p = new SessionTrashHost(descCtx);
    await p[Symbol.for('cordis.init')]();

    // listArchivedSessions must resolve fileSize from the descriptor's path.
    mockState.archivedSessionIds = ['sess-desc'];
    const items = await mockCtx.workspaceRegistry.listArchivedSessions();
    const it = items.find((x) => x.sessionId === 'sess-desc');
    assert.ok(it, 'sess-desc listed');
    assert.ok(it.fileSize > 0, 'fileSize resolved from the descriptor path, got ' + it.fileSize);

    // permanentlyDeleteSession must delete the directory the descriptor names.
    await mockCtx.workspaceRegistry.permanentlyDeleteSession('sess-desc');
    assert.ok(!mockState.archivedSessionIds.includes('sess-desc'), 'removed from archive set');
    const stillThere = await stat(sessDir).then(() => true).catch(() => false);
    assert.strictEqual(stillThere, false, 'physical session dir deleted via the descriptor path');
  });

  test('10. Regression: the list opens no log, the preview opens with read access', async () => {
    // Real 0.1.5 backend contract (lib/index.js of
    // @deepseek-ai/dsh-session-persistence-jsonl): open(id, access) branches on
    // `access === 'read'`; anything else — including a missing argument — takes
    // the single-writer path (tracker.claimWrite + an exclusive lease) and
    // throws SessionAlreadyOwnedError when the host still holds the session
    // open. A trashed conversation is usually still loaded.
    //
    // Since v0.4.4 the LIST reads no log at all, so that contract can no longer
    // zero a turn count. This test pins BOTH halves: the list must open
    // nothing, and the preview — the one remaining log reader — must still ask
    // for read access. This mock reproduces the backend semantics.
    const events = [
      { type: 'session/start', createdAt: 1 },
      { type: 'user/message', createdAt: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真实用户提问' }] } },
      { type: 'turn/start', createdAt: 3 },
      { type: 'assistant/message', createdAt: 4, data: { message: { content: [{ type: 'text', text: '回答' }] } } },
      { type: 'turn/start', createdAt: 5 },
    ];
    const openCalls = [];
    const ownershipPersistence = {
      list: async () => [{
        header: { id: 'sess-owned', version: 3, createdAt: 7, cwd: '/work/proj10', isSeeded: false },
        revision: 1,
        sizeBytes: 512,
      }],
      locate: () => ({ kind: 'jsonl', path: join(tempDir, 'sess-owned', 'session.v3.jsonl') }),
      // Semantics of the real backend while the host holds the write handle.
      open: async (id, access) => {
        openCalls.push(access);
        if (access !== 'read') {
          const error = new Error(`session "${id}" is already owned by an active write handle`);
          error.name = 'SessionAlreadyOwnedError';
          throw error;
        }
        return { id, read: async () => ({ eventState: 'shared-frozen', events }), close: async () => {} };
      },
    };

    const entities = new Map([
      ['ws-10', { record: { path: '/work/proj10', title: 'Proj 10', sessionIds: ['sess-owned'] }, detachSession: async () => {} }],
    ]);
    const routeTable = new Map();
    const ownedCtx = {
      ...mockCtx,
      sessionPersistence: ownershipPersistence,
      webServer: {
        register(route) {
          routeTable.set(route.path, route);
          return () => routeTable.delete(route.path);
        },
      },
    };
    mockCtx.workspaceRegistry.entities = entities;
    const ownedPlugin = new SessionTrashHost(ownedCtx);
    await ownedPlugin[Symbol.for('cordis.init')]();

    // The list: zero log I/O — turns from the projection cache, size from the
    // listing snapshot's own sizeBytes.
    projectionRows.set('sess-owned', { turns: 2 });
    mockState.archivedSessionIds = ['sess-owned'];
    const items = await mockCtx.workspaceRegistry.listArchivedSessions();
    const owned = items.find((i) => i.sessionId === 'sess-owned');

    assert.ok(owned, 'host-owned session still listed');
    assert.deepStrictEqual(openCalls, [], 'the recycle-bin list must not open any session log');
    assert.strictEqual(owned.turnCount, 2, 'turn count survives a host-owned session');
    assert.strictEqual(owned.fileSize, 512, 'fileSize from the listing snapshot, not a stat');
    // A session whose header title is just its id and whose title projection is
    // absent renders the placeholder. v0.3 derived this from the first user
    // message, which is what forced the whole-log read; the measured corpus
    // carries a title row for 521/524 sessions, so this is the rare case.
    assert.strictEqual(owned.title, '未命名会话', 'untitled session renders the placeholder');

    // The preview is the remaining log reader, and where the access contract
    // now lives.
    const messagesRoute = routeTable.get('/api/session-trash/messages');
    assert.ok(messagesRoute, 'preview route registered');
    const res = makeRes();
    await messagesRoute.handler(
      { method: 'GET', url: '/api/session-trash/messages?sessionId=sess-owned', headers: {} },
      res,
    );
    assert.strictEqual(res.statusCode, 200, 'preview responds 200');
    assert.deepStrictEqual(openCalls, ['read'], 'the preview must open with read access');
    const payload = JSON.parse(res.body);
    assert.ok(Array.isArray(payload.data.messages), 'preview returns a message list');
  });

  test('11. Regression: the registry keeps its own archive API, and its options never become a title', async () => {
    // DSH calls `WorkspaceRegistry.archiveSession(sessionId, options)` with
    // `{ stopActivity: true }` or `{}` (api-workspace-controller), while this
    // plugin's own /archive route passes a title STRING in the same slot.
    // Until v0.4.4 the patch read that slot as a title, so DSH's `{}` was
    // truthy and got stored as one — the panel then read it back as
    // `savedTitle` and rendered an object as a React child, which throws.
    // (The two `{...: {}}` entries still sitting in workspace.json are its
    // residue.) The same patch REPLACED the registry method outright, dropping
    // its session-existence check, its `workspace/session-activity` gate, its
    // `stopActivity` hand-off and its pin drop.
    const calls = [];
    const delegatingRegistry = {
      requireState: () => mockState,
      setState: async (next) => { Object.assign(mockState, next); },
      enqueueOperation: async (fn) => fn(),
      entities: new Map(),
      // The registry's own implementation, as dsh-workspace ships it.
      archiveSession: async (sessionId, options) => {
        calls.push(['archive', sessionId, options]);
        mockState.archivedSessionIds = [...(mockState.archivedSessionIds ?? []), sessionId];
      },
      unarchiveSession: async (sessionId) => {
        calls.push(['unarchive', sessionId]);
        mockState.archivedSessionIds = (mockState.archivedSessionIds ?? []).filter((id) => id !== sessionId);
      },
    };
    mockState.archivedSessionIds = [];
    mockState.archivedMeta = {};

    const ctx = { ...mockCtx, workspaceRegistry: delegatingRegistry };
    const p = new SessionTrashHost(ctx);
    await p[Symbol.for('cordis.init')]();

    // DSH's own path: an options object, no title.
    await delegatingRegistry.archiveSession('sess-1', {});
    assert.deepStrictEqual(calls, [['archive', 'sess-1', {}]], 'the registry method must receive the options object');
    assert.deepStrictEqual(mockState.archivedSessionIds, ['sess-1'], 'the registry write is the authoritative one');
    assert.strictEqual(
      mockState.archivedMeta['sess-1'].title,
      undefined,
      'an options object must never be stored as a title',
    );
    assert.ok(Number.isFinite(mockState.archivedMeta['sess-1'].at), 'the real archive time is recorded');

    // The plugin's own path: a title string, forwarded as empty options.
    mockState.archivedSessionIds = [];
    await delegatingRegistry.archiveSession('sess-2', '我的会话');
    assert.deepStrictEqual(calls[1], ['archive', 'sess-2', {}], 'a title string is not forwarded as options');
    assert.strictEqual(mockState.archivedMeta['sess-2'].title, '我的会话', 'a title string is stored as-is');

    // stopActivity must reach the registry untouched (the "stop and archive"
    // confirmation depends on it).
    mockState.archivedSessionIds = [];
    await delegatingRegistry.archiveSession('sess-3', { stopActivity: true });
    assert.deepStrictEqual(calls[2], ['archive', 'sess-3', { stopActivity: true }], 'stopActivity must be forwarded');

    // Unarchive delegates, and drops the display facts it no longer needs.
    await delegatingRegistry.unarchiveSession('sess-2');
    assert.deepStrictEqual(calls[3], ['unarchive', 'sess-2'], 'unarchive delegates to the registry');
    assert.ok(!('sess-2' in mockState.archivedMeta), 'unarchive must drop the archivedMeta entry');
  });

  test('12. A checkpoint from an older Session format generation still yields its title', async () => {
    // Regression found against the real 0.2.0-rc.2 store: a projection-cache
    // checkpoint is bound to the format generation that folded it, and
    // `cachedSnapshot` accepts only the host's CURRENT generation
    // (currentLifecycleMatches: stored formatVersion === header.version). The
    // reference store had moved 3 -> 4 while 481 of its 524 cache records were
    // still v3 and 39 carried no generation at all — so reading that face
    // alone rejected ~99% of the corpus and blanked nearly every title.
    // `cachedPredecessorTitle` is the face DSH ships for that upgrade window.
    mockCache = {
      requireTable: () => mockTable,
      markClean: () => {},
      // Current generation: nothing (the record predates the upgrade).
      cachedSnapshot: () => undefined,
      // Predecessor generation: the title is still legitimate.
      cachedPredecessorTitle: (header) => (header?.id === 'sess-legacy'
        ? { asOfSeq: 12, values: { title: '升级前的会话' } }
        : undefined),
    };
    mockPersistence.list = async () => [{
      header: { id: 'sess-legacy', version: 4, createdAt: 5, cwd: '/work/legacy', isSeeded: false },
      revision: 'rev-legacy',
      sizeBytes: 128,
    }];

    const ctx = { ...mockCtx, sessionProjectionCache: mockCache };
    const p = new SessionTrashHost(ctx);
    await p[Symbol.for('cordis.init')]();

    mockState.archivedSessionIds = ['sess-legacy'];
    const items = await mockCtx.workspaceRegistry.listArchivedSessions();
    const row = items.find((i) => i.sessionId === 'sess-legacy');

    assert.ok(row, 'pre-upgrade session still listed');
    assert.strictEqual(row.title, '升级前的会话', 'a predecessor-generation title is served');
    // A predecessor checkpoint deliberately exposes the title only, so the
    // turn count is UNKNOWN. It must be null, never 0: the panel omits the
    // chip rather than claiming a long session had no turns.
    assert.strictEqual(row.turnCount, null, 'an unreadable turn count is null, not 0');
    assert.strictEqual(row.fileSize, 128, 'sizeBytes still comes from the listing');
  });
});
