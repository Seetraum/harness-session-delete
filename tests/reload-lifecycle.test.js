import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, cp, rm, symlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Fiber-lifecycle regression tests (real cordis).
 *
 * v0.3.1 fixed the leaked webServer routes: disposers must be wired through
 * ctx.effect (the register() disposer contract), because @deepseek-ai/cordis@4
 * never calls a class instance's dispose().
 *
 * v0.3.2 fixed the sibling leak: methods patched ONTO SHARED SERVICES
 * (workspaceRegistry.listArchivedSessions and friends) stayed behind after
 * the owning fiber unloaded, and the next instance's 'typeof x !== function'
 * guards refused to re-patch — so after an uninstall+reinstall without a
 * restart the recycle-bin list kept calling a method whose closure held an
 * inactive ctx: ctx.sessionPersistence threw inside the per-session
 * try/catch and every turn count silently read 0, while the preview (routes
 * rebuilt per mount) kept working. Patches are now reversible (token-tagged)
 * and a fresh install replaces any stale one it finds.
 *
 * The plugin package has no cordis dependency (it imports it optionally), so
 * these tests discover a cordis copy inside the pnpm store, build a sandbox
 * whose node_modules exposes it, and import a copy of the host lib from
 * there — the lib's internal 'await import("@deepseek-ai/cordis")' then
 * resolves to the real Service base class. Skipped without a cordis copy.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function findCordisDir() {
  const pnpmDir = join(repoRoot, 'node_modules', '.pnpm');
  let entries;
  try {
    entries = await readdir(pnpmDir);
  } catch {
    return undefined;
  }
  for (const entry of entries.sort()) {
    if (!entry.startsWith('@deepseek-ai+cordis@')) continue;
    const dir = join(pnpmDir, entry, 'node_modules', '@deepseek-ai', 'cordis');
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return undefined;
}

const cordisDir = await findCordisDir();

/** Build a sandboxed copy of the host lib with a resolvable cordis. */
async function importHost() {
  const sandbox = join(repoRoot, '.tmp', 'dsh-reload-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  await mkdir(join(sandbox, 'node_modules', '@deepseek-ai'), { recursive: true });
  await symlink(cordisDir, join(sandbox, 'node_modules', '@deepseek-ai', 'cordis'), 'dir');
  await cp(join(repoRoot, 'packages', 'session-trash-host', 'lib', 'index.js'), join(sandbox, 'host.js'));
  try {
    return { mod: await import(pathToFileURL(join(sandbox, 'host.js'))), cleanup: () => rm(sandbox, { recursive: true, force: true }) };
  } catch (error) {
    await rm(sandbox, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Build a sandbox with the INSTALLED-BUNDLE layout: the entry shim at
 * node_modules/dsh-session-recycle-bin/index.js plus the impl beneath it,
 * with cordis resolvable. Re-importing the same shim URL from this process
 * then reproduces exactly what a running dsh web does across reinstalls:
 * the shim module object comes from the ESM cache, and only the shim's
 * content-hash-busted impl import can deliver the files currently on disk.
 */
async function importBundleShim() {
  const sandbox = join(repoRoot, '.tmp', 'dsh-reload-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  const pkgDir = join(sandbox, 'node_modules', 'dsh-session-recycle-bin');
  await mkdir(join(pkgDir, 'packages', 'session-trash-host', 'lib'), { recursive: true });
  await mkdir(join(sandbox, 'node_modules', '@deepseek-ai'), { recursive: true });
  await symlink(cordisDir, join(sandbox, 'node_modules', '@deepseek-ai', 'cordis'), 'dir');
  await cp(join(repoRoot, 'index.js'), join(pkgDir, 'index.js'));
  await cp(join(repoRoot, 'packages', 'session-trash-host', 'lib', 'index.js'), join(pkgDir, 'packages', 'session-trash-host', 'lib', 'index.js'));
  const shimUrl = pathToFileURL(join(pkgDir, 'index.js'));
  try {
    return {
      shimUrl,
      mod: await import(shimUrl),
      implPath: join(pkgDir, 'packages', 'session-trash-host', 'lib', 'index.js'),
      cleanup: () => rm(sandbox, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(sandbox, { recursive: true, force: true });
    throw error;
  }
}

/** Root context + the four injected services, with inspectable fakes. */
function createHarness(Context) {
  // persistence.inspect reports 3 turns and one real user message, so any
  // listArchivedSessions() bound to a LIVE context yields turnCount 3 and
  // the derived title '你好'. A stale (dead-context) closure swallows the
  // ctx.sessionPersistence throw and yields turnCount 0 — the user-visible
  // symptom these tests pin down.
  const persistence = {
    list: async () => [],
    findLog: async () => undefined,
    inspect: async () => ({
      events: [
        { type: 'turn/start' },
        { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
        { type: 'turn/start' },
        { type: 'turn/start' },
      ],
    }),
    delete: async () => { deleted++; },
  };
  let deleted = 0;
  const registry = {
    requireState: () => ({ archivedSessionIds: ['sess-1'] }),
    entities: new Map(),
  };
  const cache = {};
  const routeTable = new Map();
  const webServer = {
    register(route) {
      if (routeTable.has(route.path)) {
        throw new Error('webserver: duplicate ' + route.kind + ' route "' + route.path + '"');
      }
      routeTable.set(route.path, route);
      return () => routeTable.delete(route.path);
    },
  };
  const root = new Context();
  root.provide('sessionPersistence', persistence);
  root.provide('sessionProjectionCache', cache);
  root.provide('workspaceRegistry', registry);
  root.provide('webServer', webServer);
  return { root, persistence, registry, cache, routeTable, deletedCount: () => deleted };
}

describe('SessionTrashHost fiber lifecycle (real cordis)', { skip: !cordisDir && 'no @deepseek-ai/cordis copy found in node_modules/.pnpm' }, () => {
  test('restart keeps the route table consistent; unload unregisters every route', async () => {
    const { Context } = await import(pathToFileURL(join(cordisDir, 'lib', 'index.js')));
    const { mod, cleanup } = await importHost();
    try {
      const h = createHarness(Context);
      const fiber = h.root.plugin(mod.SessionTrashHost);
      await fiber;
      const mounted = h.routeTable.size;
      assert.ok(mounted >= 8, 'expected the full route set at mount, got ' + mounted);
      assert.ok(h.root.get('sessionTrashHost'), 'service should be provided at mount');
      assert.equal(typeof h.registry.listArchivedSessions, 'function', 'registry methods should be patched at mount');

      // In-process reload — what 'dsh plugin install' triggers on a running
      // web process. Must not throw duplicate-route and must re-register.
      await fiber.restart();
      await fiber;
      assert.equal(h.routeTable.size, mounted, 'restart must neither leak nor lose routes');
      assert.ok(h.root.get('sessionTrashHost'), 'service should be re-provided after restart');
      assert.equal((await h.registry.listArchivedSessions())[0].turnCount, 3, 'turn counts must survive a restart');

      // Full unload must unregister every route AND reverse the service
      // patches (register() disposer contract + token-tagged patch removal).
      await fiber.dispose();
      assert.equal(h.routeTable.size, 0, 'unload must unregister every route');
      assert.equal(h.registry.listArchivedSessions, undefined, 'unload must remove the patched registry methods');
      assert.equal(h.cache.remove, undefined, 'unload must remove the patched cache.remove');
      assert.equal(typeof h.persistence.delete, 'function', 'persistence.delete must stay a function after restore');
    } finally {
      await cleanup();
    }
  });

  test('uninstall + reinstall keeps listArchivedSessions on the live context (turn counts survive)', async () => {
    const { Context } = await import(pathToFileURL(join(cordisDir, 'lib', 'index.js')));
    const { mod, cleanup } = await importHost();
    try {
      const h = createHarness(Context);

      // First install.
      const fiberA = h.root.plugin(mod.SessionTrashHost);
      await fiberA;
      assert.equal((await h.registry.listArchivedSessions())[0].turnCount, 3, 'first install must count turns');

      // Uninstall (fiber A fully unloads; the loader then mounts a NEW fiber,
      // exactly like 'dsh plugin uninstall' + 'dsh plugin install').
      await fiberA.dispose();
      assert.equal(h.routeTable.size, 0, 'uninstall must unregister every route');
      assert.equal(h.registry.listArchivedSessions, undefined, 'uninstall must remove the patched registry methods');

      // Reinstall — a brand-new fiber. On the broken (<= v0.3.1) code the
      // stale listArchivedSessions closure survived and read 0 turns.
      const fiberB = h.root.plugin(mod.SessionTrashHost);
      await fiberB;
      assert.ok(h.routeTable.size >= 8, 'reinstall must re-register the routes');
      assert.ok(h.root.get('sessionTrashHost'), 'service must be re-provided after reinstall');
      const items = await h.registry.listArchivedSessions();
      assert.equal(items[0].turnCount, 3, 'turn counts must survive uninstall+reinstall');
      assert.equal(items[0].title, '你好', 'derived titles must survive uninstall+reinstall');
    } finally {
      await cleanup();
    }
  });

  test('mounting over stale (<= v0.3.1) registry methods heals them in place', async () => {
    const { Context } = await import(pathToFileURL(join(cordisDir, 'lib', 'index.js')));
    const { mod, cleanup } = await importHost();
    try {
      const h = createHarness(Context);

      // Simulate the state a <= v0.3.1 fiber leaves behind on uninstall:
      // untagged registry methods whose closures hold a DEAD context — their
      // listArchivedSessions silently degrades to turnCount 0 (the running
      // production symptom after the local->online reinstall).
      h.registry.archiveSession = async () => {};
      h.registry.unarchiveSession = async () => {};
      h.registry.permanentlyDeleteSession = async () => {};
      h.registry.emptyArchivedSessions = async () => ({ deletedCount: 0 });
      h.registry.listArchivedSessions = async () => [{ sessionId: 'sess-1', turnCount: 0 }];

      const fiber = h.root.plugin(mod.SessionTrashHost);
      await fiber;

      const items = await h.registry.listArchivedSessions();
      assert.equal(items[0].turnCount, 3, 'a fresh install must replace the stale dead-context methods');
      assert.equal(items[0].title, '你好', 'a fresh install must restore derived titles');

      await fiber.dispose();
      assert.equal(h.routeTable.size, 0, 'unload must unregister every route');
    } finally {
      await cleanup();
    }
  });

  test('a leaked listArchivedSessions keeps working (patch-time service snapshot)', async () => {
    const { Context } = await import(pathToFileURL(join(cordisDir, 'lib', 'index.js')));
    const { mod, cleanup } = await importHost();
    try {
      const h = createHarness(Context);
      const fiber = h.root.plugin(mod.SessionTrashHost);
      await fiber;
      assert.equal((await h.registry.listArchivedSessions())[0].turnCount, 3);

      // Keep a reference to the patched method, then fully unload the plugin
      // fiber — the reference simulates a method leaked onto the shared
      // registry by an older bundle. v0.3.3 snapshots persistence at patch
      // time, so the leaked method must keep counting turns; the per-call
      // ctx.sessionPersistence variant instead swallowed the dead-fiber throw
      // and reported 0 (the production symptom).
      const leakedList = h.registry.listArchivedSessions;
      await fiber.dispose();
      assert.equal(h.registry.listArchivedSessions, undefined, 'unload must remove the patched methods');
      const items = await leakedList();
      assert.equal(items[0].turnCount, 3, 'a leaked patch must stay functional (no dead-context throw)');
      assert.equal(items[0].title, '你好', 'a leaked patch must keep deriving titles');
    } finally {
      await cleanup();
    }
  });

  test('the entry shim loads the impl CURRENTLY on disk despite the ESM module cache', async () => {
    const { Context } = await import(pathToFileURL(join(cordisDir, 'lib', 'index.js')));
    const { readFile, writeFile: writeImplFile } = await import('node:fs/promises');
    const { mod: shimFirst, shimUrl, implPath, cleanup } = await importBundleShim();
    try {
      // First mount: the bundle on disk is the repo's current code.
      const h1 = createHarness(Context);
      await h1.root.plugin(shimFirst);
      assert.ok(h1.routeTable.has('/api/session-trash/list'), 'the shim must mount the impl and register its routes');
      assert.ok(h1.root.get('sessionTrashHost'), 'the shim must provide the service');

      // Simulate an overwrite-install: REPLACE the impl file on disk with a
      // different build (recognisable route prefix), while the process keeps
      // running — then re-import the shim by the SAME URL. Node's ESM cache
      // returns the cached shim object (asserted below), so only the shim's
      // content-hash-busted impl import can pick up the new file.
      const implSource = await readFile(implPath, 'utf8');
      assert.ok(implSource.includes("const ROUTE_PREFIX = '/api/session-trash';"), 'impl copy must carry the stock route prefix');
      await writeImplFile(implPath, implSource.replace("const ROUTE_PREFIX = '/api/session-trash';", "const ROUTE_PREFIX = '/api/session-trash-v2';"));

      const shimSecond = await import(shimUrl);
      assert.equal(shimSecond, shimFirst, 'the shim module must come from the ESM cache (same object)');

      const h2 = createHarness(Context);
      await h2.root.plugin(shimSecond);
      assert.ok(h2.routeTable.has('/api/session-trash-v2/list'), 'the cached shim must load the NEW impl from disk');
      assert.ok(!h2.routeTable.has('/api/session-trash/list'), 'the new mount must not register the old build\'s routes');
      assert.ok(h2.root.get('sessionTrashHost'), 'the new impl must provide the service');
    } finally {
      await cleanup();
    }
  });
});