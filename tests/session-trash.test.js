import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionTrashHost } from '../packages/session-trash-host/lib/index.js';

describe('Session Trash Host Plugin Test Suite', () => {
  let mockCtx;
  let mockPersistence;
  let mockCache;
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
    mockCache = {
      requireTable: () => mockTable,
      markClean: (id) => {},
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

  test('8. Dual-cohort: 0.1.5-shape persistence (snapshot list + open/read handle) works', async () => {
    // Simulate DSH 0.1.5-rc.1: list() returns SessionPersistenceSnapshot[]
    // ({ header, ... }), inspect() is REMOVED, findLog is not on the service,
    // locate() still computes a candidate path, and events come from
    // open(id) -> handle.read() -> { events }.
    const sessDir = join(tempDir, 'sess-v3');
    await mkdir(sessDir, { recursive: true });
    const logPath = join(sessDir, 'session.v3.jsonl');

    const events = [
      { type: 'session/start', createdAt: 100 },
      { type: 'user/message', createdAt: 110, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好，帮我重构' }] } },
      { type: 'turn/start', createdAt: 120 },
      { type: 'assistant/message', createdAt: 130, data: { message: { content: [{ type: 'text', text: '好的' }] } } },
      { type: 'turn/start', createdAt: 140 },
    ];
    await writeFile(logPath, JSON.stringify(events[0]) + '\n', 'utf8'); // physical log exists (locate candidate valid)

    const bShapePersistence = {
      // 0.1.5: list returns snapshots wrapping the header.
      list: async () => [
        { header: { id: 'sess-v3', title: 'V3 Session', cwd: '/work/proj3' }, revision: 1, eventCount: 5 },
        { header: { id: 'sess-2', title: 'Session 2', cwd: '/work/proj2' }, revision: 1 },
      ],
      // 0.1.5: no inspect, no service-level findLog; locate still computes a path.
      locate: (meta) => ({ kind: 'jsonl', path: join(tempDir, meta.id, 'session.v3.jsonl') }),
      // 0.1.5: handle-based reads. The access argument is part of the
      // contract — the real backend treats anything but 'read' as a
      // single-writer claim.
      open: async (id, access) => {
        assert.strictEqual(id, 'sess-v3');
        assert.strictEqual(access, 'read', 'reads must open with read access');
        return {
          id,
          read: async () => ({ eventState: 'exclusive', events }),
          close: async () => {},
        };
      },
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

    // listArchivedSessions: snapshot headers normalized + events read via open/read.
    mockState.archivedSessionIds = ['sess-v3', 'sess-2'];
    const items = await mockCtx.workspaceRegistry.listArchivedSessions();
    const v3 = items.find((i) => i.sessionId === 'sess-v3');
    assert.ok(v3, 'sess-v3 listed');
    assert.strictEqual(v3.title, 'V3 Session', 'title from normalized snapshot header');
    assert.strictEqual(v3.turnCount, 2, 'turnCount from handle.read() events');
    assert.ok(v3.fileSize > 0, 'fileSize from locate-resolved physical file');

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

  test('10. Regression: reading a session the host still owns must not zero the turn count', async () => {
    // Real 0.1.5 backend contract (lib/index.js of
    // @deepseek-ai/dsh-session-persistence-jsonl): open(id, access) branches on
    // `access === 'read'`; anything else — including a missing argument — takes
    // the single-writer path (tracker.claimWrite + an exclusive lease) and
    // throws SessionAlreadyOwnedError when the host still holds the session
    // open. A trashed conversation is usually still loaded, so `open(id)` made
    // BOTH the recycle-bin turn count and the preview read empty; the plugin
    // swallowed the error. This mock reproduces that backend semantics.
    const events = [
      { type: 'session/start', createdAt: 1 },
      { type: 'user/message', createdAt: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真实用户提问' }] } },
      { type: 'turn/start', createdAt: 3 },
      { type: 'assistant/message', createdAt: 4, data: { message: { content: [{ type: 'text', text: '回答' }] } } },
      { type: 'turn/start', createdAt: 5 },
    ];
    const openCalls = [];
    const ownershipPersistence = {
      // Header title falls back to the id (never-titled session) so the row
      // exercises the derived-title path built from the stored events.
      list: async () => [{ header: { id: 'sess-owned', title: 'sess-owned', cwd: '/work/proj10' }, revision: 1 }],
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
    const ownedCtx = { ...mockCtx, sessionPersistence: ownershipPersistence };
    mockCtx.workspaceRegistry.entities = entities;
    const ownedPlugin = new SessionTrashHost(ownedCtx);
    await ownedPlugin[Symbol.for('cordis.init')]();

    mockState.archivedSessionIds = ['sess-owned'];
    const items = await mockCtx.workspaceRegistry.listArchivedSessions();
    const owned = items.find((i) => i.sessionId === 'sess-owned');

    assert.ok(owned, 'host-owned session still listed');
    assert.deepStrictEqual(openCalls, ['read'], 'every read must ask for read access');
    assert.strictEqual(owned.turnCount, 2, 'turn count survives a host-owned session');
    assert.strictEqual(owned.title, '真实用户提问', 'derived title survives a host-owned session');
  });
});
