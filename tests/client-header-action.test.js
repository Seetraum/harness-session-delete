/**
 * Client-half regression: the session-header "删除会话" action must resolve the
 * active session and reach POST /archive on BOTH host cohorts.
 *
 * Background (found on DSH 0.1.5-rc.1): the header button rendered but clicking
 * it did nothing, because
 *   1. currentTitle() was declared INSIDE the TrashTab component while the
 *      module-level DeleteSessionAction called it → synchronous ReferenceError
 *      inside the click handler (no request, no toast);
 *   2. that branch is only reached when the slot omits `session` — which is
 *      exactly what the 0.1.5 slot runtime does (its standard props no longer
 *      carry sessionId/session; the active id lives in the sessions.list
 *      snapshot's `current` field).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', 'client.js');
const CURRENT = 'sess-current-1';

function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], style: {}, dataset: {}, attributes: {},
    className: '', textContent: '', nodeType: 1, parentNode: null,
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    insertBefore(c, ref) { const i = ref ? this.children.indexOf(ref) : -1; if (i >= 0) this.children.splice(i, 0, c); else this.children.push(c); c.parentNode = this; return c; },
    prepend(c) { this.children.unshift(c); c.parentNode = this; return c; },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    hasAttribute(k) { return k in this.attributes; },
    removeAttribute(k) { delete this.attributes[k]; },
    remove() { this.parentNode?.removeChild(this); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}, closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    classList: { add() {}, remove() {}, contains() { return false; } },
  };
  el.firstElementChild = null;
  return el;
}

/** Load the browser bundle and return its exports plus the captured registrations. */
function loadClient(language = 'en-US', services = {}) {
  const documentStub = {
    body: makeEl('body'), head: makeEl('head'), documentElement: makeEl('html'),
    createElement: (t) => makeEl(t), getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  globalThis.document = documentStub;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = (fn) => { try { fn(); } catch { /* stub */ } return 0; };
  globalThis.cancelAnimationFrame = () => {};

  let definition = null;
  globalThis.window = {
    navigator: { language, languages: [language] },
    __ModuleLoader__: { load(def) { definition = def; } },
  };
  const code = readFileSync(CLIENT, 'utf8');
  new Function('window', 'document', code)(globalThis.window, documentStub);

  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    Fragment: 'Fragment',
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {}, useMemo: (f) => f(), useCallback: (f) => f, useRef: (v) => ({ current: v }),
  };
  const registrations = {};
  const registrationOptions = {};
  const ctx = {
    effect: (fn) => { try { fn(); } catch { /* stub */ } },
    get: (name) => services[name],
    on: () => () => {}, typert: { on: () => () => {} },
    sessions: {
      list: { getSnapshot: () => ({ ids: [CURRENT], byId: { [CURRENT]: { id: CURRENT, title: 'T' } }, current: CURRENT, phase: 'ready' }) },
      refresh: () => {},
    },
    workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [] }) }, refresh: () => {} },
    slots: {
      inject: (name, fn) => { fn(); },
      register: (opts, component) => { registrations[opts.name] = component; registrationOptions[opts.name] = opts; return () => {}; },
    },
  };
  const mod = definition.factory((name) => (name === 'react' ? React : {}));
  mod.apply(ctx);
  return { registrations, registrationOptions, ctx };
}

/**
 * Minimal stand-in for @deepseek-ai/dsh-client-locale's service face: it resolves
 * an explicitly chosen locale, registers plugin dictionaries, and binds a
 * translate function that reads the CURRENT active locale through the chain.
 */
function makeLocaleService(active) {
  const dicts = new Map();
  return {
    active,
    registered: [],
    register(ns, table) {
      if (dicts.has(ns)) throw new Error(`locale namespace "${ns}" already has locale "zh"`);
      dicts.set(ns, table);
      this.registered.push({ ns, table });
      return () => dicts.delete(ns);
    },
    bind(ns) {
      return (key, params = {}) => {
        const table = dicts.get(ns) ?? {};
        const template = table[this.active]?.[key] ?? table.en?.[key] ?? key;
        return String(template).replace(/\{(\w+)\}/g, (_m, name) => String(params[name] ?? ''));
      };
    },
    getLocale() { return { active: this.active }; },
  };
}


/** Invoke the header action's click handler and report the archive request. */
async function clickHeaderAction(props) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url,
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body ? JSON.parse(options.body) : undefined,
    });
    return { ok: true, status: 200, async json() { return { ok: true, data: {} }; } };
  };
  const { registrations, ctx } = loadClient();
  const Component = registrations['conversation.session.header.actions'];
  assert.equal(typeof Component, 'function', 'header action must register');
  const element = Component({ ...props, ctx });
  assert.equal(typeof element.props.onClick, 'function', 'button must have a click handler');
  await element.props.onClick({ stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 50));
  return calls.find((c) => c.url.includes('/archive'));
}

describe('client header action (dual cohort)', () => {
  test('0.1.5-rc.1 slot props (no sessionId/session) still archives the active session', async () => {
    const call = await clickHeaderAction({});
    assert.ok(call, 'POST /archive must be issued — a ReferenceError here was the "click does nothing" bug');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['x-dsh-plugin'], 'session-trash', 'the CSRF custom header the routes require');
    assert.equal(call.headers['x-dsh-locale'], undefined, 'no locale header: the host does not read one');
    assert.equal(call.body.sessionId, CURRENT, 'active id resolves from the sessions.list snapshot current');
  });

  test('<=0.1.2 slot props carrying sessionId keep working', async () => {
    const call = await clickHeaderAction({ sessionId: CURRENT });
    assert.ok(call, 'POST /archive must be issued');
    assert.equal(call.body.sessionId, CURRENT);
  });

  test('client bundle declares no module-level call to a component-scoped helper', () => {
    const code = readFileSync(CLIENT, 'utf8');
    // currentTitle is declared inside TrashTab; only in-component call sites may use it.
    const offenders = code.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /\bcurrentTitle\(/.test(line))
      .filter(({ line }) => !/const currentTitle =/.test(line));
    // The in-component call sites are indented by 8+ spaces; module-level ones by 4.
    const moduleLevel = offenders.filter(({ line }) => /^ {4}\S/.test(line));
    assert.deepEqual(moduleLevel, [], 'module-level code must not call the component-scoped currentTitle');
  });

  test('settings.section registration stays inside the always-visible nav band', () => {
    // DSH 0.1.5's settings panel pins its nav column to ~808px and clips the overflow:
    // the panel is overflow:hidden, the nav column overflow:visible, and there is no
    // scrollbar. Anything registered late enough to land at the bottom of that column
    // disappears on any window shorter than the panel — which is exactly why the
    // "会话回收站" entry was invisible while its registration was perfectly healthy.
    // Keep the order small so the entry sits in the top few rows.
    const { registrationOptions } = loadClient();
    const opts = registrationOptions['settings.section'];
    assert.ok(opts, 'settings.section must register');
    assert.equal(opts.id, 'trash');
    assert.equal(typeof opts.order, 'number', 'order must be an explicit number');
    assert.ok(
      opts.order < 100,
      `settings.section order must stay in the always-visible band (<100), got ${opts.order}:`
      + ' the host clips the tail of a fixed-height, non-scrollable nav column'
    );
    assert.equal(typeof opts.label, 'function', 'label thunk is accepted by both cohorts');
    assert.equal(opts.label(), 'Session Recycle Bin');
  });

  test('Chinese browser locales preserve the original labels', () => {
    const { registrationOptions } = loadClient('zh-CN');
    assert.equal(registrationOptions['settings.section'].label(), '会话回收站');
    assert.equal(registrationOptions['conversation.session.header.actions'].label(), '删除会话');
  });

  test('the host Language setting wins over the browser (and registers our dictionaries)', () => {
    // 0.1.5 mounts @deepseek-ai/dsh-client-locale as `locale`; its explicit
    // setting beats the browser, so an English browser with a Chinese host
    // setting must render Chinese — asking navigator directly got this wrong.
    const service = makeLocaleService('zh');
    const { registrationOptions } = loadClient('en-US', { locale: service });
    assert.equal(registrationOptions['settings.section'].label(), '会话回收站');
    assert.equal(registrationOptions['conversation.session.header.actions'].label(), '删除会话');
    assert.equal(service.registered.length, 1, 'dictionaries are published to the locale service');
    assert.equal(service.registered[0].ns, 'session-trash');
    assert.ok(service.registered[0].table.zh && service.registered[0].table.en, 'both locales are published');
  });

  test('an English host setting wins over a Chinese browser', () => {
    const service = makeLocaleService('en');
    const { registrationOptions } = loadClient('zh-CN', { locale: service });
    assert.equal(registrationOptions['settings.section'].label(), 'Session Recycle Bin');
  });

  test('a service that cannot resolve our namespace falls back to the built-in table', () => {
    // bind() without our dictionaries returns the raw key; the plugin must then
    // keep using its own table instead of rendering "recycleBin".
    const foreign = { register: () => () => {}, bind: () => (key) => key, getLocale: () => ({ active: 'zh' }) };
    const { registrationOptions } = loadClient('en-US', { locale: foreign });
    assert.equal(registrationOptions['settings.section'].label(), '会话回收站', 'falls back to the host locale, not the raw key');
  });

  test('client exports.inject must not declare unprovided services like typert (0.1.5 regression)', async () => {
    let definition = null;
    const documentStub = {
      head: { appendChild() {} },
      getElementById: () => null,
      createElement: () => ({ setAttribute() {}, appendChild() {} }),
      querySelectorAll: () => [],
    };
    const win = { navigator: { language: 'en-US' }, __ModuleLoader__: { load(def) { definition = def; } } };
    const code = readFileSync(CLIENT, 'utf8');
    new Function('window', 'document', code)(win, documentStub);
    const mod = definition.factory(() => ({}));

    assert.ok(Array.isArray(mod.inject), 'exports.inject must be an array');
    assert.ok(!mod.inject.includes('typert'), 'typert is not provided in DSH 0.1.5 client runtime; must not be in exports.inject');
    assert.ok(mod.inject.includes('slots'), 'slots service must be declared');
  });
});
