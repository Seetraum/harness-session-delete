import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Node half of the session-trash bundle — a BYTE-STABLE loader shim.
 *
 * Mounted by the loader row `session-trash` (see cordis.patch.yml) in the
 * host plane of the profile process. All real logic lives in
 * ./packages/session-trash-host/lib/index.js ("the impl").
 *
 * WHY A SHIM WITH A CONTENT-HASHED DYNAMIC IMPORT (v0.3.3):
 *
 * Every in-process activation path — the market's hot mount (uninstall →
 * install), a loader entry update, a disable → enable cycle — imports this
 * package by the same module URL, so Node's ESM cache keeps returning the
 * FIRST module object this process ever loaded. A version installed over a
 * running dsh web therefore kept executing the OLD code (observed as:
 * reinstall left the recycle-bin list reading 0 轮对话 while the preview,
 * whose routes are rebuilt per mount, kept working — only a restart
 * reloaded the new files). The shim breaks that stale-module cycle:
 *
 *   - This file MUST NEVER CHANGE across versions. A cached old shim is
 *     harmless because its only job is to load the CURRENT impl from disk.
 *     (Any change to this file itself needs a process restart to apply.)
 *   - apply() imports the impl through `?<sha256-of-file>` — identical
 *     content reuses the cached module, changed content (a new version on
 *     disk) gets a fresh URL and therefore fresh code, in-process.
 *
 * IMPORTANT — no `export default` here. The loader's `unwrapExports`
 * collapses `exports.default ?? exports`, so a default export would discard
 * the module namespace — and with it the named `inject` export — leaving
 * the plugin mounted with no dependencies: `apply()` would run immediately,
 * before the host services exist, and the plugin would silently no-op.
 * With the namespace preserved, cordis sees `{ apply, inject }` and waits
 * for the injected services, exactly like published bundles.
 */

/** Implementation module, resolved next to this (possibly cached) shim. */
const IMPL_URL = new URL('./packages/session-trash-host/lib/index.js', import.meta.url);

/**
 * Import the impl, cache-busted by its own content hash. Falls back to the
 * plain URL when the file cannot be read (the import will then surface the
 * real error, or reuse the cached module — the pre-shim behaviour).
 */
async function loadImpl() {
  let href = IMPL_URL.href;
  try {
    const bytes = await readFile(IMPL_URL);
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    href = `${IMPL_URL.href}?v=${hash}`;
  } catch {
    // Unreadable impl: fall back to the plain URL so the import itself can
    // surface the real error. (Import failures must NEVER be swallowed
    // here — a fallback to the cached module would silently run old code.)
  }
  return await import(/* @vite-ignore */ href);
}

export const inject = ['sessionPersistence', 'workspaceRegistry', 'webServer'];

/**
 * Mount the host service. Runs only after the injected services are up.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export async function apply(ctx) {
  // 防重复：sessionTrashHost 是本插件自身提供的服务，不能声明为 inject，
  // 用 ctx.get() 安全访问（不触发 cordis 属性守卫）。
  if (ctx.get('sessionTrashHost')) return;
  const mod = await loadImpl();
  // Re-check after the await: a concurrent apply may have mounted meanwhile.
  if (ctx.get('sessionTrashHost')) return;
  // NOTE: deliberately NOT returned. A returned fiber is a thenable whose
  // resolved value is the fiber object itself, which cordis's effect
  // collector rejects with "Invalid effect" at boot; returning undefined
  // keeps the battle-tested pre-shim behaviour.
  ctx.plugin(mod.SessionTrashHost);
}
