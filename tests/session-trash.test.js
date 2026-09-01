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
});
