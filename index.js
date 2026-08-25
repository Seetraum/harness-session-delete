import { SessionTrashHost } from './packages/session-trash-host/lib/index.js';

/**
 * Node half of the session-trash bundle.
 *
 * Mounted by the loader row `session-trash` (see cordis.patch.yml) in the
 * host plane of the profile process. Applies the host backend patches:
 * physical session-log deletion, projection-cache cleanup, workspace
 * unarchive / permanent-delete / empty / list, plus the /api/session-trash/*
 * webserver routes the browser half calls.
 *
 * IMPORTANT — no `export default` here. The loader's `unwrapExports`
 * collapses `exports.default ?? exports`, so a default export would discard
 * the module namespace — and with it the named `inject` export — leaving
 * the plugin mounted with no dependencies: `apply()` would run immediately,
 * before the host services exist, and the plugin would silently no-op.
 * With the namespace preserved, cordis sees `{ apply, inject }` and waits
 * for the injected services, exactly like published bundles.
 */
export const inject = ['sessionPersistence', 'workspaceRegistry', 'webServer'];

/**
 * Mount the host service. Runs only after the injected services are up.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // 防重复：sessionTrashHost 是本插件自身提供的服务，不能声明为 inject，
  // 用 ctx.get() 安全访问（不触发 cordis 属性守卫）。
  if (ctx.get('sessionTrashHost')) return;
  ctx.plugin(SessionTrashHost);
}
