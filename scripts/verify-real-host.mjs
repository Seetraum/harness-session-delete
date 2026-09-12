/**
 * Sandbox runtime verification for dsh-session-recycle-bin (host half).
 *
 * Mounts the plugin against a REAL DSH package tree (not mocks) and drives the
 * full recycle-bin flow through its own HTTP routes:
 *
 *   create session (persistence.create -> handle.append/flush)
 *     -> POST /archive -> GET /list -> GET /messages -> POST /purge
 *
 * The services are composed exactly as DSH's own bundle patches declare
 * (dsh-base / dsh-web-app cordis.patch.yml):
 *
 *   dsh-storage -> dsh-storage-json -> dsh-storage-domain
 *     -> dsh-session-persistence-jsonl -> dsh-workspace
 *
 * Only the host-plane webServer and the sessionProjectionCache are stubbed —
 * the routes are captured and invoked directly.
 *
 * Everything happens inside the repository (no writes outside it).
 *
 * Usage:
 *   node scripts/verify-real-host.mjs --packages <dir-with-@deepseek-ai/node_modules>
 *
 * Obtain <dir> from an audit run:  dsh-upgrade-audit <from> <to>  produces
 * tmp/<pair>/b/node_modules (the "to" tree). Exit code 0 = all checks passed.
 */
import { createRequire } from 'node:module';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const argv = process.argv.slice(2);
const pkgFlag = argv.indexOf('--packages');
if (pkgFlag === -1 || !argv[pkgFlag + 1]) {
  console.error('usage: node scripts/verify-real-host.mjs --packages <dir containing @deepseek-ai/*>');
  process.exit(2);
}
const PKG_ROOT = resolve(argv[pkgFlag + 1]);
const req = createRequire(join(PKG_ROOT, 'anchor.cjs'));
const ROOT = join(REPO, '.tmp', 'verify-real-host', 'home');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
};

const versionOf = (name) => {
  try { return JSON.parse(readFileSync(join(PKG_ROOT, name, 'package.json'), 'utf8')).version; }
  catch { return '?'; }
};

const { Context } = req('@deepseek-ai/cordis');
const Storage = req('@deepseek-ai/dsh-storage').default;
const storageJson = req('@deepseek-ai/dsh-storage-json');
const storageDomain = req('@deepseek-ai/dsh-storage-domain');
const JsonlSessionPersistence = req('@deepseek-ai/dsh-session-persistence-jsonl').default;
const WorkspaceRegistry = req('@deepseek-ai/dsh-workspace').default;
const { SessionTrashHost } = await import(join(REPO, 'packages/session-trash-host/lib/index.js'));

console.log('host packages: dsh-session ' + versionOf('@deepseek-ai/dsh-session')
  + ', dsh-workspace ' + versionOf('@deepseek-ai/dsh-workspace')
  + ', persistence-jsonl ' + versionOf('@deepseek-ai/dsh-session-persistence-jsonl') + '\n');

await rm(ROOT, { recursive: true, force: true });
await mkdir(join(ROOT, 'storages'), { recursive: true });
await mkdir(join(ROOT, 'sessions'), { recursive: true });

const routes = [];
const ctx = new Context();
ctx.plugin(Storage);
ctx.plugin({ name: storageJson.name, inject: storageJson.inject, apply: storageJson.apply }, { root: join(ROOT, 'storages') });
ctx.plugin({ name: storageDomain.name, inject: storageDomain.inject, apply: storageDomain.apply }, { backend: 'json' });
const sessionPkg = req('@deepseek-ai/dsh-session');
const SessionStore = sessionPkg.default;
// Stamp the header with the HOST's own format version (0 on <=0.1.2, 3 on 0.1.5).
const HOST_FORMAT_VERSION = sessionPkg.SESSION_FORMAT_VERSION;
const backendInject = JsonlSessionPersistence.inject ?? [];
if (backendInject.includes('sessions')) ctx.plugin(SessionStore); // <=0.1.2 cohort
ctx.plugin(JsonlSessionPersistence, { root: join(ROOT, 'sessions'), compression: 'none' });
ctx.plugin(WorkspaceRegistry);
ctx.plugin({
  name: 'webServer',
  apply(c) {
    c.provide('webServer', {
      register(route) {
        if (routes.some((r) => r.path === route.path)) throw new Error('duplicate route ' + route.path);
        routes.push(route);
        return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); };
      },
    });
  },
});
ctx.plugin({
  name: 'sessionProjectionCache-stub',
  apply(c) { c.provide('sessionProjectionCache', { requireTable: () => ({ delete: async () => {} }), markClean: () => {} }); },
});
await new Promise((r) => setTimeout(r, 300));

const persistence = ctx.get('sessionPersistence');
const registry = ctx.get('workspaceRegistry');
check('real host services mounted (sessionPersistence + workspaceRegistry)', !!persistence && !!registry);
if (!persistence || !registry) process.exit(2);

const hasInspect = typeof persistence.inspect === 'function';
const hasHandle = ['open', 'stat', 'list'].every((m) => typeof persistence[m] === 'function');
check('host exposes an event/log API the plugin can read (either cohort)',
  (hasInspect && typeof persistence.list === 'function') || hasHandle,
  hasInspect ? '<=0.1.2 cohort: inspect() + list()' : '0.1.5 cohort: open/stat/list');

await ctx.plugin(SessionTrashHost);
await new Promise((r) => setTimeout(r, 300));
check('plugin mounted and registered its routes', !!ctx.get('sessionTrashHost') && routes.length > 0, routes.length + ' routes');

const NOW = Date.now();
const SID = 'verify-sess-1';
try {
  const events = [
    { type: 'turn/start', seq: 0, time: NOW, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: NOW, surfaceOp: 'append', data: { id: 'msg-u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第一条用户消息' }] } },
    { type: 'assistant/message', seq: 2, time: NOW, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'msg-a1', role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: [{ type: 'text', text: '助手回复内容' }] }, stream: [] } },
    // NOTE: no turn/end — a bare turn/end without its react-loop events is
    // rejected as malformed by the <=0.1.2 format layer; the plugin only
    // needs turn/start + the two messages.
  ];
  const created = await persistence.create({ version: HOST_FORMAT_VERSION, id: SID, createdAt: NOW, cwd: ROOT, isSeeded: false }, 0);
  if (created && typeof created.append === 'function') {
    // 0.1.5 handle API
    await created.append(events);
    await created.flush();
    await created.close();
  } else {
    // <=0.1.2 service API: create() materializes the header, append(id, events) writes
    await persistence.append(SID, events);
  }
  check('stored a real session through the host persistence API', true);
} catch (error) {
  check('stored a real session through the host persistence API', false, String(error.message).slice(0, 180));
}

function callRoute(path, { method = 'GET', body, query } = {}) {
  const route = routes.find((r) => r.path === path);
  if (!route) return Promise.resolve({ status: 404, body: null });
  const request = {
    method,
    url: path + (query ? '?' + query : ''),
    headers: { 'x-dsh-plugin': 'session-trash' },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
  };
  return new Promise((done) => {
    const response = {
      statusCode: 200,
      writeHead(code) { this.statusCode = code; },
      end(text) { done({ status: this.statusCode, body: text ? JSON.parse(text) : null }); },
    };
    route.handler(request, response).catch((error) => done({ status: 500, body: { error: String(error.message) } }));
  });
}

const archived = await callRoute('/api/session-trash/archive', { method: 'POST', body: { sessionId: SID, title: 'Verify Session' } });
check('POST /archive succeeds', archived.status === 200 && archived.body?.ok === true, JSON.stringify(archived.body).slice(0, 140));
check('archived set contains the session', (registry.requireState().archivedSessionIds || []).includes(SID));

const list = await callRoute('/api/session-trash/list');
const item = list.body?.data?.items?.find((i) => i.sessionId === SID);
check('GET /list lists the archived session', !!item);
check('title resolved from the stored header', item?.title === 'Verify Session', 'title=' + item?.title);
check('turnCount read through the host event API', item?.turnCount === 1, 'turnCount=' + item?.turnCount);
check('fileSize resolved from the physical log path', (item?.fileSize ?? 0) > 0, 'fileSize=' + item?.fileSize);

const messages = await callRoute('/api/session-trash/messages', { query: 'sessionId=' + SID });
const msgs = messages.body?.data?.messages ?? [];
check('GET /messages extracts user + assistant text',
  msgs.some((m) => String(m.content).includes('第一条用户消息')) && msgs.some((m) => String(m.content).includes('助手回复内容')),
  msgs.length + ' messages');

const purge = await callRoute('/api/session-trash/purge', { method: 'POST', body: { sessionIds: [SID] } });
check('POST /purge reports success', purge.body?.data?.deletedCount === 1, JSON.stringify(purge.body?.data).slice(0, 140));
await new Promise((r) => setTimeout(r, 200));

let stillOnDisk = false;
try {
  for (const project of await readdir(join(ROOT, 'sessions'))) {
    const entries = await readdir(join(ROOT, 'sessions', project)).catch(() => []);
    if (entries.includes(SID)) stillOnDisk = true;
  }
} catch { /* sessions root may be empty */ }
check('physical session directory removed', !stillOnDisk);
check('archive set no longer contains the session', !(registry.requireState().archivedSessionIds || []).includes(SID));

const failed = results.filter((r) => !r.ok);
console.log('\nRESULT: ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
