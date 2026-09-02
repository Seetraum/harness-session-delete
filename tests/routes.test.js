import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionTrashHost } from '../packages/session-trash-host/lib/index.js';

/**
 * Route-layer tests: the browser reaches the host through /api/session-trash/*
 * webserver routes (the DSH /api gateway does NOT dispatch runtime typert
 * endpoints — that was the HTTP 404 regression). A mock webServer captures
 * the registered handlers, which are then invoked with fake req/res objects.
 */
describe('Session Trash Host HTTP Routes', () => {
  let mockCtx;
  let plugin;
  let routes;

  function jsonResponse() {
    const res = {
      status: 200,
      body: null,
      writeHead(status) {
        this.status = status;
      },
      end(text) {
        this.body = text === undefined ? null : JSON.parse(text);
      },
    };
    return res;
  }

  function request(method, body, headers = {}) {
    const req = { method, headers };
    req[Symbol.asyncIterator] = async function* () {
      yield Buffer.from(JSON.stringify(body ?? {}), 'utf8');
    };
    return req;
  }

  /** Find the registered handler for an exact route path. */
  function handlerFor(path) {
    const route = routes.find((r) => r.kind === 'exact' && r.path === path);
    assert.ok(route, `route ${path} should be registered`);
    return route.handler;
  }

  let tempDir;

  beforeEach(async () => {
    tempDir = join(process.cwd(), '.tmp', `dsh-routes-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await mkdir(tempDir, { recursive: true });

    const mockPersistence = {
      locate: (header) => ({ path: join(tempDir, header.id, 'session.jsonl') }),
      findLog: async (id) => join(tempDir, id, 'session.jsonl'),
      list: async () => [
        { id: 'sess-1', title: 'Session 1', cwd: '/work/proj1' },
        { id: 'sess-2', title: 'Session 2', cwd: '/work/proj2' },
        { id: 'sess-3', title: 'Session 3', cwd: '/work/proj1' },
      ],
    };

    const mockState = { archivedSessionIds: ['sess-1'] };
    const mockEntities = new Map([
      [
        'ws-1',
        {
          record: { path: '/work/proj1', title: 'Project One', sessionIds: ['sess-1', 'sess-3'] },
          detachSession: async () => {},
        },
      ],
      ['ws-2', { record: { path: '/work/proj2', title: 'Project Two', sessionIds: ['sess-2'] }, detachSession: async () => {} }],
    ]);

    const mockRegistry = {
      requireState: () => mockState,
      setState: async (newState) => {
        Object.assign(mockState, newState);
      },
      enqueueOperation: async (fn) => fn(),
      entities: mockEntities,
      archivedSessionIds: mockState.archivedSessionIds,
      archiveSession: async (sessionId) => {
        if (!mockState.archivedSessionIds.includes(sessionId)) {
          mockState.archivedSessionIds = [...mockState.archivedSessionIds, sessionId];
        }
      },
    };

    routes = [];
    const webServer = {
      register: (route) => {
        routes.push(route);
        return () => {
          routes = routes.filter((r) => r !== route);
        };
      },
    };

    mockCtx = {
      sessionPersistence: mockPersistence,
      sessionProjectionCache: { requireTable: () => ({ delete: async () => {} }), markClean: () => {} },
      workspaceRegistry: mockRegistry,
      typert: { local: new Map(), broadcast: () => {} },
      webServer,
      provide: () => {},
      reflect: { provide: () => {} },
      get: (key) => (key === 'sessions' ? new Map() : key === 'sessionProjectionCache' ? mockCtx.sessionProjectionCache : undefined),
      emit: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };

    plugin = new SessionTrashHost(mockCtx);
    await plugin[Symbol.for('cordis.init')]();
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('registers all /api/session-trash/* routes', () => {
    const paths = routes.map((r) => r.path).sort();
    assert.deepStrictEqual(paths, [
      '/api/session-trash/archive',
      '/api/session-trash/client.css',
      '/api/session-trash/empty',
      '/api/session-trash/list',
      '/api/session-trash/messages',
      '/api/session-trash/purge',
      '/api/session-trash/purge-workspace',
      '/api/session-trash/sessions',
      '/api/session-trash/unarchive',
    ]);
  });

  test('GET /client.css serves the plugin stylesheet as text/css', async () => {
    const res = {
      status: null,
      headers: null,
      body: null,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(text) {
        this.body = text;
      },
    };
    await handlerFor('/api/session-trash/client.css')(request('GET'), res);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/css/);
    // 组件类与设计令牌都在这一个文件里
    assert.match(res.body, /\.dsh-trash-container/);
    assert.match(res.body, /--dstrb-/);
    // 亮/暗双配色由同一组变量承载，暗色只是变量覆盖
    assert.match(res.body, /@media \(prefers-color-scheme: dark\)/);
    // 暗色解析优先跟随 DSH 应用主题（与 OS 媒体查询成“或”关系），
    // 应用明确浅色时恢复浅色令牌，避免“应用浅色 + OS 深色”时白字白底
    assert.match(res.body, /body\[data-ds-dark-theme\]/);
    assert.match(res.body, /body:not\(\[data-ds-dark-theme\]\)/);
  });

  test('GET /list returns archived sessions', async () => {
    const res = jsonResponse();
    await handlerFor('/api/session-trash/list')(request('GET'), res);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.data.items.length, 1);
    assert.strictEqual(res.body.data.items[0].sessionId, 'sess-1');
  });

  test('GET /sessions returns every session with workspace + archived flag', async () => {
    const res = jsonResponse();
    await handlerFor('/api/session-trash/sessions')(request('GET'), res);
    assert.strictEqual(res.status, 200);
    const items = res.body.data.items;
    assert.strictEqual(items.length, 3);
    const sess1 = items.find((i) => i.sessionId === 'sess-1');
    assert.strictEqual(sess1.archived, true);
    assert.strictEqual(sess1.workspacePath, '/work/proj1');
    const sess3 = items.find((i) => i.sessionId === 'sess-3');
    assert.strictEqual(sess3.archived, false);
    assert.strictEqual(sess3.workspaceTitle, 'Project One');
  });

  test('POST /archive moves a session into the recycle bin', async () => {
    const res = jsonResponse();
    await handlerFor('/api/session-trash/archive')(
      request('POST', { sessionId: 'sess-3' }, { 'x-dsh-plugin': 'session-trash' }),
      res
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(mockCtx.workspaceRegistry.requireState().archivedSessionIds, ['sess-1', 'sess-3']);
  });

  test('POST /archive rejects a running session with SESSION_RUNNING', async () => {
    mockCtx.get = (key) =>
      key === 'agents'
        ? { get: (id) => (id === 'sess-running' ? { status: 'running' } : undefined) }
        : key === 'sessionProjectionCache'
        ? mockCtx.sessionProjectionCache
        : undefined;
    const res = jsonResponse();
    await handlerFor('/api/session-trash/archive')(
      request('POST', { sessionId: 'sess-running' }, { 'x-dsh-plugin': 'session-trash' }),
      res
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.error.code, 'SESSION_RUNNING');
  });

  test('POST /unarchive restores a session', async () => {
    const res = jsonResponse();
    await handlerFor('/api/session-trash/unarchive')(
      request('POST', { sessionId: 'sess-1' }, { 'x-dsh-plugin': 'session-trash' }),
      res
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(mockCtx.workspaceRegistry.requireState().archivedSessionIds, []);
  });

  test('POST /purge permanently deletes the given sessions (live-session protected)', async () => {
    mockCtx.get = (key) =>
      key === 'agents'
        ? { get: (id) => (id === 'sess-live' ? { status: 'running' } : undefined) }
        : key === 'sessionProjectionCache'
        ? mockCtx.sessionProjectionCache
        : undefined;
    const res = jsonResponse();
    await handlerFor('/api/session-trash/purge')(
      request('POST', { sessionIds: ['sess-live', 'sess-1'] }, { 'x-dsh-plugin': 'session-trash' }),
      res
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.deletedCount, 1);
    assert.strictEqual(res.body.data.total, 2);
    assert.strictEqual(res.body.data.errors.length, 1);
    assert.strictEqual(res.body.data.errors[0].sessionId, 'sess-live');
  });

  test('POST /empty purges every archived session', async () => {
    const res = jsonResponse();
    await handlerFor('/api/session-trash/empty')(
      request('POST', {}, { 'x-dsh-plugin': 'session-trash' }),
      res
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.deletedCount, 1);
    assert.deepStrictEqual(mockCtx.workspaceRegistry.requireState().archivedSessionIds, []);
  });

  test('GET /messages retrieves session logs', async () => {
    const res = jsonResponse();
    const req = request('GET');
    req.url = '/api/session-trash/messages?sessionId=sess-1';
    await handlerFor('/api/session-trash/messages')(req, res);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.data.sessionId, 'sess-1');
  });

  test('POST /purge-workspace purges sessions in a workspace', async () => {
    const res = jsonResponse();
    await handlerFor('/api/session-trash/purge-workspace')(
      request('POST', { workspacePath: '/work/proj1', sessionIds: ['sess-1'] }, { 'x-dsh-plugin': 'session-trash' }),
      res
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.deletedCount, 1);
  });

  test('non-GET without the plugin header is rejected (CSRF seam)', async () => {
    const res = jsonResponse();
    await handlerFor('/api/session-trash/purge')(request('POST', { sessionIds: ['sess-1'] }), res);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.error.message, /x-dsh-plugin/);
  });

  test('invalid JSON body yields a 400 error envelope', async () => {
    const req = { method: 'POST', headers: { 'x-dsh-plugin': 'session-trash' } };
    req[Symbol.asyncIterator] = async function* () {
      yield Buffer.from('not-json', 'utf8');
    };
    const res = jsonResponse();
    await handlerFor('/api/session-trash/archive')(req, res);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.ok, false);
  });
});
