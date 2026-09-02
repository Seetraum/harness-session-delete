import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, cp, rm, symlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Fiber-lifecycle regression test (real cordis).
 *
 * Bug fixed in v0.3.1: route disposers lived on a class-instance field that
 * @deepseek-ai/cordis@4 never calls (the fork only unwinds effects collected
 * via ctx.effect). Any in-process fiber unload/reload — reinstalling the
 * plugin without restarting dsh web, a loader config update, or a dependency
 * service restart — therefore (1) leaked the old routes bound to an inactive
 * context ("cannot get required service ... in inactive context", turn
 * counts silently zeroed) and (2) made the reloaded instance die on
 * webServer.register's duplicate-path throw.
 *
 * This test runs the real plugin class against the real cordis runtime. The
 * plugin package itself has no cordis dependency (it imports it optionally),
 * so the test discovers a cordis copy inside the pnpm store, builds a tiny
 * sandbox whose node_modules exposes it, and imports a copy of the host lib
 * from there — that way the lib's internal 'await import("@deepseek-ai/
 * cordis")' resolves to the real Service base class. Skipped when no cordis
 * copy is installed.
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

describe('SessionTrashHost fiber lifecycle (real cordis)', { skip: !cordisDir && 'no @deepseek-ai/cordis copy found in node_modules/.pnpm' }, () => {
  test('restart keeps the route table consistent; unload unregisters every route', async () => {
    const { Context } = await import(pathToFileURL(join(cordisDir, 'lib', 'index.js')));

    // Sandbox: node_modules/@deepseek-ai/cordis -> discovered copy, plus a
    // copy of the host lib so its optional cordis import resolves for real.
    const sandbox = join(repoRoot, '.tmp', `dsh-reload-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    await mkdir(join(sandbox, 'node_modules', '@deepseek-ai'), { recursive: true });
    await symlink(cordisDir, join(sandbox, 'node_modules', '@deepseek-ai', 'cordis'), 'dir');
    await cp(join(repoRoot, 'packages', 'session-trash-host', 'lib', 'index.js'), join(sandbox, 'host.js'));

    try {
      const { SessionTrashHost } = await import(pathToFileURL(join(sandbox, 'host.js')));

      // Minimal webServer honouring the register() disposer contract, with
      // the same duplicate-path guard as the real host service.
      const routeTable = new Map();
      const webServer = {
        register(route) {
          if (routeTable.has(route.path)) {
            throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
          }
          routeTable.set(route.path, route);
          return () => routeTable.delete(route.path);
        },
      };

      const root = new Context();
      root.provide('sessionPersistence', { list: async () => [] });
      root.provide('sessionProjectionCache', {});
      root.provide('workspaceRegistry', {
        requireState: () => ({ archivedSessionIds: [] }),
        entities: new Map(),
      });
      root.provide('webServer', webServer);

      const fiber = root.plugin(SessionTrashHost);
      await fiber;
      const mounted = routeTable.size;
      assert.ok(mounted >= 8, `expected the full route set at mount, got ${mounted}`);
      assert.ok(root.get('sessionTrashHost'), 'service should be provided at mount');

      // In-process reload — what 'dsh plugin install' triggers on a running
      // web process. Must not throw duplicate-route and must re-register.
      await fiber.restart();
      await fiber;
      assert.equal(routeTable.size, mounted, 'restart must neither leak nor lose routes');
      assert.ok(root.get('sessionTrashHost'), 'service should be re-provided after restart');

      // Full unload must unregister every route (register() disposer contract).
      await fiber.dispose();
      assert.equal(routeTable.size, 0, 'unload must unregister every route');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
