/**
 * Client-half regression: the sub-session badge, its inline list, and the
 * cascade delete that carries `excludeIds`.
 *
 * The panel is stateful, so these tests drive it through a small hook runtime
 * (useState / useMemo / useCallback / useRef / useEffect with deps) and a fake
 * `fetch` that answers /list, /children, /purge and /messages. That is what
 * makes the ASYNC contract testable: the first screen comes from /list alone,
 * the grouping is a second, cancelable request, and expanding must NOT issue
 * a third.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', 'client.js');
const SOURCE = readFileSync(CLIENT, 'utf8');
const CSS = readFileSync(join(HERE, '..', 'client.css'), 'utf8');

// The plugin toast holds for 6s before it removes itself. Testing a toast must
// not keep the runner alive that long, so only the long holds are clamped.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Number(ms) > 1000 ? 20 : ms, ...rest);

const STAMP = Date.parse('2025-01-02T03:04:00');
const ITEMS = [
  {
    sessionId: 'sess-a', title: 'Alpha', workspacePath: '/w/a', workspaceTitle: 'A',
    archivedAt: STAMP, turnCount: 4, fileSize: 2048,
    logPath: '/Users/seetraum/.dsh/profiles/web/sessions/--Users-seetraum-project-harness-session-delete--/session-004eb8f2/session.v4.jsonl.zstd',
  },
  {
    sessionId: 'sess-b', title: 'Beta', workspacePath: '/w/a', workspaceTitle: 'A',
    archivedAt: STAMP, turnCount: 2, fileSize: 1024,
  },
];

function makeEl(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(), children: [], dataset: {}, attributes: {},
    style: {
      setProperty(name, value) { this[name] = value; },
      removeProperty(name) { delete this[name]; },
      getPropertyValue(name) { return this[name] ?? ''; },
    },
    id: '', className: '', textContent: '', nodeType: 1, parentNode: null,
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    removeAttribute(k) { delete this.attributes[k]; },
    remove() { this.parentNode?.removeChild(this); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}, closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    classList: { add() {}, remove() {}, contains() { return false; } },
  };
}

/**
 * Document stub that remembers created nodes: the toast is the only observable
 * surface for "why did nothing happen", so its text has to be readable here.
 */
function makeDocument() {
  const doc = {
    body: makeEl('body'), head: makeEl('head'), documentElement: makeEl('html'),
    createElement: (tag) => makeEl(tag),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  const search = (node, id) => {
    if (node.id === id) return node;
    for (const child of node.children ?? []) {
      const hit = search(child, id);
      if (hit) return hit;
    }
    return null;
  };
  doc.getElementById = (id) => search(doc.body, id) ?? search(doc.head, id);
  // Listener registry: the info card's dismissals (Esc, outside click) are
  // registered on document/window and have to be dispatchable from a test.
  const listeners = new Map();
  doc.addEventListener = (type, handler) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
  };
  doc.removeEventListener = (type, handler) => { listeners.get(type)?.delete(handler); };
  doc.dispatch = (type, event = {}) => {
    for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
  };
  doc.listenerCount = (type) => (listeners.get(type) ?? new Set()).size;
  return doc;
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return textOf(node.children);
}

/** Text of a fake DOM node (the toast lives there, not in the React tree). */
function domText(node) {
  let out = node.textContent ?? '';
  for (const child of node.children ?? []) out += domText(child);
  return out;
}

function collect(node, out = []) {
  if (node == null || typeof node === 'boolean') return out;
  if (Array.isArray(node)) { for (const child of node) collect(child, out); return out; }
  if (typeof node !== 'object') return out;
  out.push(node);
  collect(node.children, out);
  return out;
}

const hasClass = (el, cls) => typeof el?.props?.className === 'string'
  && el.props.className.split(/\s+/).includes(cls);
const allByClass = (root, cls) => collect(root).filter((el) => hasClass(el, cls));
const oneByClass = (root, cls) => {
  const hits = allByClass(root, cls);
  assert.equal(hits.length, 1, `expected exactly one .${cls}`);
  return hits[0];
};

/** The card (never the inline list beside it) whose title is `title`. */
function cardByTitle(root, title) {
  const card = allByClass(root, 'dsh-trash-card')
    .find((el) => textOf(oneByClass(el, 'dsh-trash-card-title')) === title);
  assert.ok(card, `card "${title}" must render`);
  return card;
}

/** The inline list that follows a card: a sibling of it, so it is found from the top. */
function regionFor(root, cardKey) {
  const region = collect(root).find((el) => el.props?.id === `dsh-trash-children-${cardKey}`);
  assert.ok(region, `the inline list of ${cardKey} must render`);
  return region;
}

function click(el, extra = {}) {
  assert.equal(typeof el?.props?.onClick, 'function', 'the element must be clickable');
  return el.props.onClick({ stopPropagation() {}, preventDefault() {}, currentTarget: el, target: el, ...extra });
}

/** Click with spies, for assertions about propagation and default action. */
function clickSpy(el) {
  const seen = { stopped: 0, prevented: 0 };
  const result = el.props.onClick({
    stopPropagation() { seen.stopped += 1; },
    preventDefault() { seen.prevented += 1; },
    currentTarget: el,
    target: el,
  });
  return { seen, result };
}

function keydown(el, key) {
  assert.equal(typeof el?.props?.onKeyDown, 'function', 'the element must handle keydown');
  return el.props.onKeyDown({ key, stopPropagation() {}, preventDefault() {} });
}

function toggleCheckbox(el) {
  assert.equal(typeof el?.props?.onChange, 'function', 'the row must carry a checkbox');
  return el.props.onChange({ stopPropagation() {}, target: el, currentTarget: el });
}

// ── WCAG helpers: the contrast targets are asserted, not eyeballed ─────────
const channel = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const hex = (value) => [1, 3, 5].map((i) => parseInt(String(value).slice(i, i + 2), 16));
const rgba = (value) => {
  const parts = String(value).match(/[\d.]+/g).map(Number);
  return { rgb: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 };
};
const composite = ({ rgb, a }, background) => rgb.map((c, i) => Math.round(c * a + background[i] * (1 - a)));
/** Slice one CSS block out of the stylesheet (no nested braces in a palette). */
const cssBlock = (header) => {
  const start = CSS.indexOf(header);
  assert.ok(start >= 0, `client.css must declare ${header}`);
  return CSS.slice(start, CSS.indexOf('\n}', start));
};
/** Read a custom property out of one palette block of client.css. */

const token = (block, name) => (block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`)) ?? [])[1]?.trim();

const depsChanged = (prev, next) => !prev || !next || prev.length !== next.length
  || prev.some((value, i) => !Object.is(value, next[i]));

/**
 * Hook runtime: enough of React to run this component's state machine across
 * asynchronous renders (initial values, deps memoisation, effect cleanups).
 */
function createRuntime() {
  const runtime = { slots: [], cursor: 0, dirty: false, pending: [], tree: null };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'Fragment',
    useState(initial) {
      const i = runtime.cursor++;
      if (!(i in runtime.slots)) {
        runtime.slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      }
      const slot = runtime.slots[i];
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        runtime.dirty = true;
      }];
    },
    useRef(initial) {
      const i = runtime.cursor++;
      if (!(i in runtime.slots)) runtime.slots[i] = { value: { current: initial } };
      return runtime.slots[i].value;
    },
    useMemo(factory, deps) { return memo(runtime, factory, deps); },
    useCallback(fn, deps) { return memo(runtime, () => fn, deps); },
    useEffect(fn, deps) {
      const i = runtime.cursor++;
      const slot = runtime.slots[i] ?? (runtime.slots[i] = {});
      if (!depsChanged(slot.deps, deps)) return;
      slot.deps = deps;
      slot.fn = fn;
      runtime.pending.push(slot);
    },
  };
  return { runtime, React };
}

function memo(runtime, factory, deps) {
  const i = runtime.cursor++;
  const slot = runtime.slots[i] ?? (runtime.slots[i] = {});
  if (!('value' in slot) || depsChanged(slot.deps, deps)) {
    slot.value = factory();
    slot.deps = deps;
  }
  return slot.value;
}

/** Stand-in for the host locale service, copied from the header-action suite. */
function makeLocaleService(active) {
  const dicts = new Map();
  return {
    register(ns, table) { dicts.set(ns, table); return () => dicts.delete(ns); },
    bind(ns) {
      return (key, params = {}) => {
        const template = dicts.get(ns)?.[active]?.[key] ?? dicts.get(ns)?.en?.[key] ?? key;
        return String(template).replace(/\{(\w+)\}/g, (_m, name) => String(params[name] ?? ''));
      };
    },
    getLocale() { return { active }; },
  };
}

const okJson = (data) => ({ ok: true, status: 200, async json() { return { ok: true, data }; } });
const failJson = (message = 'boom') => ({
  ok: false, status: 500, async json() { return { ok: false, error: { message } }; },
});

function createHarness(options = {}) {
  const {
    items = ITEMS,
    childrenResponse = () => okJson({ groups: {}, orphans: {}, scannedAt: Date.now(), sessionCount: 0 }),
    services = {},
    getSelection = null,
    viewport = { width: 1280, height: 800 },
    tooltipBox = { width: 380, height: 90, top: 0, left: 0, right: 380, bottom: 90 },
  } = options;

  const doc = makeDocument();
  const state = { calls: [], items, childrenCalls: 0, pendingChildren: null, aborts: [] };
  const insideTarget = { value: null };
  const selection = { value: getSelection ?? '' };
  globalThis.document = doc;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = (fn) => { try { fn(); } catch { /* stub */ } return 0; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.AbortController = class {
    constructor() { this.signal = { aborted: false }; state.aborts.push(this); }
    abort() { this.signal.aborted = true; }
  };
  globalThis.fetch = async (url, request = {}) => {
    const call = {
      url,
      method: request.method || 'GET',
      body: request.body ? JSON.parse(request.body) : undefined,
      headers: request.headers,
    };
    state.calls.push(call);
    if (url.endsWith('/list')) return okJson({ items: state.items });
    if (url.endsWith('/children')) {
      state.childrenCalls += 1;
      return childrenResponse(state, call);
    }
    if (url.endsWith('/purge')) {
      // A real purge removes rows, and the next /list must not return them —
      // that difference is what the card's self-dismissal has to survive.
      const gone = new Set(call.body?.sessionIds ?? []);
      state.items = state.items.filter((item) => !gone.has(item.sessionId));
      return okJson({ deletedCount: gone.size, keptCount: 0, deleted: [...gone], kept: [], failed: [] });
    }
    if (url.includes('/messages')) return okJson({ messages: [] });
    return okJson({});
  };

  const windowListeners = new Map();
  globalThis.window = {
    navigator: {
      language: 'en-US',
      languages: ['en-US'],
    },
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    getSelection: () => ({ toString: () => selection.value }),
    addEventListener: (type, handler) => {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(handler);
    },
    removeEventListener: (type, handler) => { windowListeners.get(type)?.delete(handler); },
    __ModuleLoader__: { load() {} },
  };
  const dispatchWindow = (type, event = {}) => {
    for (const handler of [...(windowListeners.get(type) ?? [])]) handler(event);
  };
  let definition = null;
  globalThis.window.__ModuleLoader__ = { load(def) { definition = def; } };
  new Function('window', 'document', SOURCE)(globalThis.window, doc);

  const { runtime, React } = createRuntime();
  const registrations = {};
  const listeners = new Map();
  const ctx = {
    effect: (fn) => { try { fn(); } catch { /* stub */ } },
    get: (name) => services[name],
    on: (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event); },
    sessions: { list: { getSnapshot: () => ({ current: null, byId: {} }) }, refresh() {} },
    workspaces: { refresh() {} },
    slots: {
      inject: (name, fn) => { fn(); },
      register: (opts, component) => { registrations[opts.name] = component; return () => {}; },
    },
  };
  const mod = definition.factory((name) => (name === 'react' ? React : {}));
  mod.apply(ctx);
  const Component = registrations['settings.section'];
  assert.equal(typeof Component, 'function', 'the settings section must register');

  const renderOnce = () => {
    runtime.cursor = 0;
    runtime.pending = [];
    runtime.tree = Component({});
    // React hands the component a DOM node for every `ref`; the fake runtime
    // hands it a stub with the measured box, which is what the placement effect
    // reads (flip / clamp / outside-click containment).
    for (const el of collect(runtime.tree)) {
      const ref = el.props?.ref;
      if (ref && typeof ref === 'object' && 'current' in ref) {
        ref.current = {
          getBoundingClientRect: () => tooltipBox,
          contains: (target) => target !== undefined && target === insideTarget.value,
        };
      }
    }
    const pending = runtime.pending;
    runtime.pending = [];
    for (const slot of pending) {
      slot.cleanup?.();
      const cleanup = slot.fn();
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
  };

  const flush = async () => {
    for (let pass = 0; pass < 40; pass += 1) {
      runtime.dirty = false;
      renderOnce();
      await new Promise((resolve) => realSetTimeout(resolve, 0));
      if (!runtime.dirty) return runtime.tree;
    }
    throw new Error('the panel did not settle');
  };

  const unmount = () => {
    for (const slot of runtime.slots) slot?.cleanup?.();
    runtime.unmounted = true;
  };

  return {
    state,
    ctx,
    doc,
    flush,
    unmount,
    emit: (event) => listeners.get(event)?.(),
    dispatchDocument: doc.dispatch,
    dispatchWindow,
    setInsideTarget: (value) => { insideTarget.value = value; },
    setSelection: (text) => { selection.value = text; },
    setTooltipBox: (box) => { Object.assign(tooltipBox, box); },
    root: () => runtime.tree,
    bodyText: () => domText(doc.body),
    callsTo: (suffix) => state.calls.filter((call) => call.url.endsWith(suffix)),
    callsMatching: (fragment) => state.calls.filter((call) => call.url.includes(fragment)),
  };
}

const child = (id, extra = {}) => ({
  id, title: id, fileSize: 1024, createdAt: STAMP, delegationDepth: 1, live: false, ...extra,
});

describe('client sub-session badge', () => {
  test('a session with no sub-sessions renders no badge and no inline list', async () => {
    const harness = createHarness({
      childrenResponse: () => okJson({
        groups: { 'sess-b': [child('kid-b1')] }, orphans: {}, scannedAt: 1, sessionCount: 3,
      }),
    });
    const tree = await harness.flush();

    const badges = allByClass(tree, 'dsh-trash-badge--children');
    assert.equal(badges.length, 1, 'only the session with children carries the badge');
    assert.equal(textOf(badges[0]), '1', 'the badge shows the count');
    assert.equal(allByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-badge--children').length, 0,
      'N=0 renders nothing at all under the card');
    assert.equal(allByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-children').length, 0,
      'and no placeholder region either');
    // The meta row is unchanged for a childless session: time + size badge.
    assert.equal(allByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-badge').length, 1);
  });

  test('the count is backfilled by one deferred /children request, never by the first paint', async () => {
    const harness = createHarness({
      childrenResponse: () => okJson({
        groups: { 'sess-a': [child('kid-a1'), child('kid-a2')] },
        orphans: {},
        scannedAt: 1,
        sessionCount: 4,
      }),
    });
    const tree = await harness.flush();

    assert.deepEqual(harness.callsTo('/list').length, 1);
    assert.equal(harness.state.childrenCalls, 1, 'exactly one grouping request per list');
    assert.deepEqual(harness.callsTo('/children')[0].body, {},
      'no sessionIds: an unrequested parent id is never reported, so the kept children of a deleted parent could not arrive');
    assert.equal(harness.callsTo('/children')[0].method, 'POST');
    assert.equal(harness.callsTo('/children')[0].headers['x-dsh-plugin'], 'session-trash');

    const badge = oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-badge--children');
    assert.equal(textOf(badge), '2');
    assert.equal(badge.props['aria-expanded'], 'false');
    assert.equal(badge.props['aria-controls'], 'dsh-trash-children-sess-a');
    assert.match(badge.props['aria-label'], /Sub-sessions of this session: 2/);
  });

  test('expanding renders the sub-session rows without asking the host again', async () => {
    const harness = createHarness({
      childrenResponse: () => okJson({
        groups: { 'sess-a': [child('kid-a1'), child('kid-a2')] },
        orphans: {},
        scannedAt: 1,
        sessionCount: 4,
      }),
    });
    let tree = await harness.flush();

    const badge = oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-badge--children');
    await click(badge);
    tree = await harness.flush();

    const region = regionFor(tree, 'sess-a');
    const rows = allByClass(region, 'dsh-trash-child');
    assert.equal(rows.length, 2, 'one row per sub-session');
    assert.deepEqual(rows.map((row) => textOf(oneByClass(row, 'dsh-trash-child-title'))), ['kid-a1', 'kid-a2']);
    assert.match(textOf(rows[0]), /1\.0 KB · /, 'each row carries size · time');
    assert.equal(harness.state.childrenCalls, 1, 'expanding must not issue a second /children');
    assert.equal(oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-badge--children').props['aria-expanded'], 'true');
    // The list is a SIBLING of the row (full card width, no click-through), and
    // it lives inside the same rounded card list.
    assert.ok(collect(oneByClass(tree, 'dsh-trash-cards'))
      .some((el) => el.props?.id === 'dsh-trash-children-sess-a'));
    assert.equal(collect(cardByTitle(tree, 'Alpha'))
      .some((el) => el.props?.id === 'dsh-trash-children-sess-a'), false);

    // Every row offers View and Delete, and never Restore — the child never
    // entered the recycle bin. View is the TITLE itself (a real button, so it
    // stays reachable by Tab/Enter at widths a second text button cannot
    // afford) and delete is an always-visible icon button.
    const rowTitle = oneByClass(rows[0], 'dsh-trash-child-title');
    assert.equal(rowTitle.type, 'button', 'the title is the preview control');
    assert.match(rowTitle.props['aria-label'], /^Session: /, 'and it names that action');
    assert.equal(rowTitle.props.title, 'kid-a1', 'the full title stays in a tooltip');
    const rowDelete = oneByClass(rows[0], 'dsh-trash-child-delete');
    assert.equal(rowDelete.type, 'button');
    assert.equal(rowDelete.props['aria-label'], 'Permanently delete');
    assert.equal(rowDelete.props.title, 'Permanently delete');
    assert.equal(collect(rows[0]).some((el) => textOf(el) === 'Restore'), false,
      'a sub-session has nothing to restore');

    // Esc collapses the region it controls.
    keydown(oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-badge--children'), 'Escape');
    tree = await harness.flush();
    assert.equal(collect(tree).some((el) => el.props?.id === 'dsh-trash-children-sess-a'), false,
      'Escape collapses the inline list');
  });

  test('a running sub-session is dimmed, unselectable, and refuses the whole row', async () => {
    const harness = createHarness({
      childrenResponse: () => okJson({
        groups: { 'sess-a': [child('kid-a1'), child('kid-live', { live: true, title: 'Live kid' })] },
        orphans: {},
        scannedAt: 1,
        sessionCount: 3,
      }),
    });
    let tree = await harness.flush();
    await click(oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-badge--children'));
    tree = await harness.flush();

    const liveRow = allByClass(regionFor(tree, 'sess-a'), 'dsh-trash-child')
      .find((row) => textOf(row).includes('Live kid'));
    assert.ok(hasClass(liveRow, 'dsh-trash-child--live'), 'the running row is marked');
    assert.match(textOf(liveRow), /Running/, 'and labelled');
    assert.equal(oneByClass(liveRow, 'dsh-trash-child-check').props.title,
      'Can be deleted once it finishes', 'the tooltip explains why');
    assert.equal(oneByClass(liveRow, 'dsh-trash-child-live').props.title,
      'Can be deleted once it finishes', 'the pill carries it too');
    assert.match(liveRow.props.title, /^1\.0 KB · /, 'the row tooltip keeps the full meta');
    assert.deepEqual(oneByClass(liveRow, 'dsh-trash-child-check').props.disabled, true, 'its checkbox is disabled');
    assert.equal(oneByClass(liveRow, 'dsh-trash-child-check').props.checked, false);
    // Its own delete is disabled too: nothing may remove a running agent.
    const liveDelete = oneByClass(liveRow, 'dsh-trash-child-delete');
    assert.equal(liveDelete.props.disabled, true);
    await click(liveDelete);
    assert.equal(harness.callsTo('/purge').length, 0, 'a disabled row delete issues no request');

    // The card's own delete is refused before any request, and names the child.
    await click(oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-btn-danger-text'));
    tree = await harness.flush();
    assert.equal(harness.callsTo('/purge').length, 0, 'no /purge while a descendant is running');
    assert.equal(collect(tree).some((el) => hasClass(el, 'dsh-trash-modal')), false, 'no confirm dialog either');
    assert.match(harness.bodyText(), /Live kid/, 'the refusal names the running sub-session');
  });

  test('unchecked sub-sessions travel as excludeIds, and the dialog counts them out', async () => {
    const harness = createHarness({
      childrenResponse: () => okJson({
        groups: {
          'sess-a': [child('kid-1'), child('kid-2'), child('kid-3')],
        },
        orphans: {},
        scannedAt: 1,
        sessionCount: 4,
      }),
    });
    let tree = await harness.flush();
    await click(oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-badge--children'));
    tree = await harness.flush();

    const region = regionFor(tree, 'sess-a');
    const kid2 = allByClass(region, 'dsh-trash-child').find((row) => textOf(row).includes('kid-2'));
    toggleCheckbox(oneByClass(kid2, 'dsh-trash-child-check'));
    tree = await harness.flush();
    assert.equal(oneByClass(allByClass(regionFor(tree, 'sess-a'), 'dsh-trash-child')
      .find((row) => textOf(row).includes('kid-2')), 'dsh-trash-child-check').props.checked, false,
    'unchecking is reflected back into the row');

    await click(oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-btn-danger-text'));
    tree = await harness.flush();

    const dialog = oneByClass(tree, 'dsh-trash-modal');
    assert.match(textOf(oneByClass(dialog, 'dsh-trash-modal-title')), /Confirm permanent deletion/);
    assert.match(textOf(oneByClass(dialog, 'dsh-trash-modal-body')), /1 main session\(s\) \+ 2 sub-session\(s\)/);
    // 2 KB parent + kid-1 + kid-3, kid-2 excluded.
    assert.match(textOf(oneByClass(dialog, 'dsh-trash-modal-body')), /\(4\.0 KB in total\)/);
    assert.equal(allByClass(dialog, 'dsh-trash-modal-list').length, 0, 'a short cascade stays inline');

    await click(oneByClass(dialog, 'dsh-trash-btn-confirm'));
    tree = await harness.flush();

    const purge = harness.callsTo('/purge');
    assert.equal(purge.length, 1);
    assert.deepEqual(purge[0].body, { sessionIds: ['sess-a'], excludeIds: ['kid-2'] },
      'the parent is the row to purge and the unchecked child is what to spare');
  });

  test('the confirm dialog scrolls its own list past 8 doomed sub-sessions', async () => {
    const many = Array.from({ length: 10 }, (_v, i) => child(`kid-${i + 1}`));
    const harness = createHarness({
      childrenResponse: () => okJson({ groups: { 'sess-a': many }, orphans: {}, scannedAt: 1, sessionCount: 10 }),
    });
    let tree = await harness.flush();
    // Only the first 50 rows render inline, so 10 are all present.
    await click(oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-badge--children'));
    tree = await harness.flush();
    await click(oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-btn-danger-text'));
    tree = await harness.flush();

    const dialog = oneByClass(tree, 'dsh-trash-modal');
    assert.match(textOf(oneByClass(dialog, 'dsh-trash-modal-body')), /1 main session\(s\) \+ 10 sub-session\(s\)/);
    assert.equal(allByClass(dialog, 'dsh-trash-modal-list-item').length, 10,
      'every doomed sub-session is named inside the scrolling list');
  });

  test('more than 50 sub-sessions collapse behind an "N more" control', async () => {
    const many = Array.from({ length: 55 }, (_v, i) => child(`kid-${i + 1}`));
    const harness = createHarness({
      childrenResponse: () => okJson({ groups: { 'sess-a': many }, orphans: {}, scannedAt: 1, sessionCount: 55 }),
    });
    let tree = await harness.flush();
    await click(oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-badge--children'));
    tree = await harness.flush();

    assert.equal(allByClass(regionFor(tree, 'sess-a'), 'dsh-trash-child').length, 50);
    const more = oneByClass(regionFor(tree, 'sess-a'), 'dsh-trash-children-more');
    assert.equal(textOf(more), '5 more');

    await click(more);
    tree = await harness.flush();
    assert.equal(allByClass(regionFor(tree, 'sess-a'), 'dsh-trash-child').length, 55);
    assert.equal(allByClass(regionFor(tree, 'sess-a'), 'dsh-trash-children-more').length, 0);
    assert.equal(harness.state.childrenCalls, 1, 'revealing more rows is not a request either');
  });

  test('narrow panels drop the turn count and the timestamp, never a badge', () => {
    assert.match(CSS, /\.dsh-trash-cards \{[^}]*container-type:\s*inline-size/,
      'the card list must be the query container');
    assert.match(CSS, /@container \(max-width: 360px\)\s*\{\s*\.dsh-trash-card-meta-item--turns/,
      'the turn count is the first thing to go');
    assert.match(CSS, /@container \(max-width: 320px\)\s*\{\s*\.dsh-trash-card-meta-item--time/,
      'then the timestamp');
    const hideRules = CSS.match(/[^{}]*\{[^}]*display:\s*none[^}]*\}/g) ?? [];
    for (const rule of hideRules) {
      assert.doesNotMatch(rule, /dsh-trash-badge/, `a badge is never hidden: ${rule}`);
    }
  });

  test('the new sub-session styles follow the app font size', () => {
    const start = CSS.indexOf('Sub-session rows — full-width');
    const end = CSS.indexOf('Kept sub-sessions of a main session');
    assert.ok(start > 0 && end > start, 'the sub-session block must exist');
    const block = CSS.slice(start, end);
    assert.doesNotMatch(block, /font-size:\s*[\d.]+(?:px|pt|rem)/,
      'new styles must scale with the app, not pin a type size');
    assert.match(block, /font-size:\s*0\.92em/, 'the row scale stays relative');
    const badge = CSS.match(/\.dsh-trash-badge--children \{[^}]*\}/)?.[0] ?? '';
    assert.ok(badge, 'the sub-session badge rule must exist');
    assert.doesNotMatch(badge, /font-size/, 'the badge rests on .dsh-trash-badge for its size');
  });

  test('degraded and failed grouping render no badge and never crash the panel', async () => {
    const degraded = createHarness({
      childrenResponse: () => okJson({
        groups: { 'sess-a': [child('kid-a1')] }, orphans: {}, scannedAt: 1, sessionCount: 2, degraded: true,
      }),
    });
    let tree = await degraded.flush();
    assert.equal(allByClass(tree, 'dsh-trash-badge--children').length, 0, 'a degraded scan claims no count');
    assert.equal(allByClass(tree, 'dsh-trash-card').length, 2, 'the list itself still renders');
    assert.equal(degraded.state.childrenCalls, 1, 'and is not retried in a loop');

    const failed = createHarness({ childrenResponse: () => failJson('children unavailable') });
    tree = await failed.flush();
    assert.equal(allByClass(tree, 'dsh-trash-badge--children').length, 0, 'a failed request claims no count');
    assert.equal(allByClass(tree, 'dsh-trash-card').length, 2);

    const thrown = createHarness({
      childrenResponse: () => { throw new Error('network down'); },
    });
    tree = await thrown.flush();
    assert.equal(allByClass(tree, 'dsh-trash-badge--children').length, 0);
    assert.equal(thrown.state.childrenCalls, 1, 'a failure is not retried on its own');

    // The next /list refresh is the one place a new attempt is made — one, not
    // one per render and not one per failed request.
    thrown.emit('workspace/archived-sessions-changed');
    await thrown.flush();
    assert.equal(thrown.state.childrenCalls, 2, 'exactly one more attempt per refresh');
  });

  test('an expanded card holds its height with skeleton rows when grouping is not ready', async () => {
    let attempts = 0;
    const harness = createHarness({
      childrenResponse: () => {
        attempts += 1;
        if (attempts === 1) {
          return okJson({ groups: { 'sess-a': [child('kid-a1')] }, orphans: {}, scannedAt: 1, sessionCount: 2 });
        }
        return failJson('children unavailable');
      },
    });
    let tree = await harness.flush();
    await click(oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-badge--children'));
    tree = await harness.flush();
    assert.equal(allByClass(regionFor(tree, 'sess-a'), 'dsh-trash-child').length, 1);

    // A refresh re-asks; when that attempt fails the count is withdrawn (no
    // badge can claim it) but the open list keeps two placeholder rows instead
    // of collapsing under the pointer.
    harness.emit('workspace/archived-sessions-changed');
    tree = await harness.flush();
    assert.equal(allByClass(tree, 'dsh-trash-badge--children').length, 0);
    const region = regionFor(tree, 'sess-a');
    assert.equal(allByClass(region, 'dsh-trash-child--skeleton').length, 2);
  });

  test('orphan shells list the kept sub-sessions and offer no restore', async () => {
    const harness = createHarness({
      childrenResponse: () => okJson({
        groups: {},
        orphans: {
          'gone-parent': [child('orphan-1'), child('orphan-2', { fileSize: null, createdAt: null })],
          'empty-parent': [],
        },
        scannedAt: 1,
        sessionCount: 4,
      }),
    });
    let tree = await harness.flush();

    const shells = allByClass(tree, 'dsh-trash-card--orphan');
    assert.equal(shells.length, 1, 'one shell per deleted parent that kept children');
    assert.equal(textOf(oneByClass(shells[0], 'dsh-trash-card-title')),
      'Deleted main session · 2 sub-session(s) kept');
    assert.ok(textOf(shells[0]).includes('Kept'), 'the shell marks the rows as kept');
    assert.equal(allByClass(shells[0], 'dsh-trash-badge--children').length, 1);
    assert.equal(textOf(oneByClass(shells[0], 'dsh-trash-badge--children')), '2');

    const buttons = allByClass(shells[0], 'dsh-trash-btn-ghost')
      .concat(allByClass(shells[0], 'dsh-trash-btn-danger-text'));
    assert.deepEqual(buttons.map(textOf), ['View', 'Permanently delete'],
      'no Restore button: these sub-sessions never entered the recycle bin');

    await click(oneByClass(shells[0], 'dsh-trash-badge--children'));
    tree = await harness.flush();
    const rows = allByClass(regionFor(tree, 'orphan:gone-parent'), 'dsh-trash-child');
    assert.equal(rows.length, 2);
    // A size the host reported as null stays unreported — never "0 KB".
    const unknown = rows.find((row) => textOf(row).includes('orphan-2'));
    assert.equal(textOf(oneByClass(unknown, 'dsh-trash-child-meta')), '');

    // View reuses the /messages preview path.
    await click(allByClass(allByClass(tree, 'dsh-trash-card--orphan')[0], 'dsh-trash-btn-ghost')[0]);
    tree = await harness.flush();
    assert.equal(allByClass(tree, 'dsh-trash-preview').length, 1, 'the preview modal opens');
    assert.match(harness.callsMatching('/messages')[0].url, /sessionId=orphan-1/);
  });

  test('the orphan shell deletes exactly the checked kept sub-sessions', async () => {
    const harness = createHarness({
      childrenResponse: () => okJson({
        groups: {},
        orphans: { 'gone-parent': [child('orphan-1'), child('orphan-2')] },
        scannedAt: 1,
        sessionCount: 4,
      }),
    });
    let tree = await harness.flush();
    const shell = () => allByClass(harness.root(), 'dsh-trash-card--orphan')[0];

    await click(oneByClass(shell(), 'dsh-trash-badge--children'));
    tree = await harness.flush();
    const orphan2 = allByClass(regionFor(tree, 'orphan:gone-parent'), 'dsh-trash-child')
      .find((row) => textOf(row).includes('orphan-2'));
    toggleCheckbox(oneByClass(orphan2, 'dsh-trash-child-check'));
    tree = await harness.flush();

    await click(oneByClass(shell(), 'dsh-trash-btn-danger-text'));
    tree = await harness.flush();
    const body = textOf(oneByClass(tree, 'dsh-trash-modal-body'));
    assert.match(body, /0 main session\(s\) \+ 1 sub-session\(s\)/, 'a shell has no main session left to count');

    await click(oneByClass(tree, 'dsh-trash-btn-confirm'));
    await harness.flush();
    assert.deepEqual(harness.callsTo('/purge')[0].body, { sessionIds: ['orphan-1'], excludeIds: ['orphan-2'] });
  });

  test('closing the panel aborts the grouping request it can no longer use', async () => {
    let release;
    const harness = createHarness({
      childrenResponse: () => new Promise((resolve) => { release = resolve; }),
    });
    await harness.flush();
    assert.equal(harness.state.childrenCalls, 1, 'the request is in flight');
    assert.equal(harness.state.aborts.length, 1);

    harness.unmount();
    assert.equal(harness.state.aborts[0].signal.aborted, true, 'closing the section cancels it');

    // A grouping answer that lands after the close must not touch the panel.
    release(okJson({ groups: { 'sess-a': [child('kid-a1')] }, orphans: {}, scannedAt: 1, sessionCount: 2 }));
    await harness.flush();
    assert.equal(allByClass(harness.root(), 'dsh-trash-badge--children').length, 0);
  });

  test('both locale tables carry the sub-session vocabulary', () => {
    const keys = [
      'childrenCount', 'childrenBadgeLabel', 'childrenRunning', 'childrenRunningHint',
      'childrenMore', 'childrenEmpty', 'childrenRunningBlocked', 'childrenNoneSelected',
      'cascadeDeleteTitle', 'cascadeDeleteBody', 'orphanCardTitle', 'orphanKept', 'listSeparator',
      'storagePath',
    ];
    for (const key of keys) {
      const hits = SOURCE.match(new RegExp(`\\b${key}:`, 'g')) ?? [];
      assert.equal(hits.length, 2, `${key} must be declared in both the en and the zh table`);
    }
  });

  test('the zh locale renders the shell, the running tag and the cascade dialog', async () => {
    const harness = createHarness({
      services: { locale: makeLocaleService('zh') },
      childrenResponse: () => okJson({
        groups: { 'sess-a': [child('kid-a1'), child('kid-live', { live: true })] },
        orphans: { 'gone-parent': [child('orphan-1')] },
        scannedAt: 1,
        sessionCount: 3,
      }),
    });
    let tree = await harness.flush();

    assert.equal(textOf(oneByClass(allByClass(tree, 'dsh-trash-card--orphan')[0], 'dsh-trash-card-title')),
      '已删除的主会话 · 保留 1 个子会话');
    assert.ok(textOf(allByClass(tree, 'dsh-trash-card--orphan')[0]).includes('已保留'));

    await click(oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-badge--children'));
    tree = await harness.flush();
    assert.match(textOf(regionFor(tree, 'sess-a')), /运行中/, 'the running tag is localized');

    await click(oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-btn-danger-text'));
    tree = await harness.flush();
    assert.match(harness.bodyText(), /子会话「kid-live」仍在运行中/, 'the refusal is localized');
  });
});

/** A fixed "now" so the relative-age buckets are deterministic: local noon. */
/** Await-aware clock freeze: the render happens across await points. */
async function withFrozenNow(iso, fn) {
  const RealDate = Date;
  const fixed = new RealDate(iso).getTime();
  class FrozenDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  }
  globalThis.Date = FrozenDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** A card row's measured box, in the fixed viewport the harness reports. */
const ROW_RECT = { top: 400, bottom: 440, left: 120, right: 700, width: 580, height: 40 };
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

/** The card's hover trigger: the title, not the row. */
const titleOf = (card) => oneByClass(card, 'dsh-trash-card-title');

/** Hover the title and let the 200ms open delay elapse. */
async function openRowCard(harness, card, rect = ROW_RECT) {
  titleOf(card).props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => rect } });
  await sleep(230);
  return harness.flush();
}

/** Hover the title WITHOUT waiting: the delay must still be pending. */
function hoverTitle(card, rect = ROW_RECT) {
  titleOf(card).props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => rect } });
}

/** Leave the title (arms the 250ms close timer). */
function leaveTitle(tree) {
  titleOf(cardByTitle(tree, 'Alpha')).props.onMouseLeave();
}

describe('client hover info card', () => {
  test('deleting the last listed session takes its card down with it', async () => {
    const harness = createHarness({ items: [ITEMS[0]] });
    let tree = await harness.flush();
    tree = await openRowCard(harness, cardByTitle(tree, 'Alpha'));
    assert.equal(allByClass(tree, 'dsh-trash-tooltip').length, 1, 'the card is up before the delete');

    // Delete the only row through the normal flow.
    await click(oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-btn-danger-text'));
    tree = await harness.flush();
    await click(oneByClass(tree, 'dsh-trash-btn-confirm'));
    tree = await harness.flush();

    assert.equal(harness.callsTo('/purge').length, 1);
    assert.equal(allByClass(tree, 'dsh-trash-card').length, 0, 'the list is empty now');
    assert.equal(allByClass(tree, 'dsh-trash-tooltip').length, 0,
      'the card must not survive the row it describes (the row is gone, so its mouseleave can never fire)');
  });

  test('only the title opens the card, never the row controls', async () => {
    const harness = createHarness({ items: [ITEMS[0]] });
    const tree = await harness.flush();
    const card = cardByTitle(tree, 'Alpha');

    // Structurally: exactly one element inside the row can start the card, and
    // it is the title. Hovering the delete/view/restore buttons must leave their
    // own native `title` tooltips alone.
    const openers = collect(card).filter((el) => typeof el.props?.onMouseEnter === 'function');
    assert.deepEqual(openers.map((el) => el.props.className), ['dsh-trash-card-title']);
    const deleteButton = oneByClass(card, 'dsh-trash-btn-danger-text');
    assert.equal(deleteButton.props.onMouseEnter, undefined, 'hovering delete must not open the card');
    assert.equal(deleteButton.props.title, 'Permanently delete', 'its own tooltip stays');
    for (const cls of ['dsh-trash-checkbox--card', 'dsh-trash-badge', 'dsh-trash-btn-ghost', 'dsh-trash-btn-danger-text']) {
      const parts = allByClass(card, cls);
      assert.ok(parts.length > 0, `${cls} must exist to be checked`);
      for (const part of parts) {
        assert.equal(part.props.onMouseEnter, undefined, `${cls} must not open the card`);
      }
    }

    // Functionally: nothing else in the row opens it, even after the delay.
    await sleep(230);
    const after = await harness.flush();
    assert.equal(allByClass(after, 'dsh-trash-tooltip').length, 0);
  });

  test('the title opens the card after the 200ms delay, not instantly', async () => {
    const harness = createHarness({ items: [ITEMS[0]] });
    let tree = await harness.flush();
    hoverTitle(cardByTitle(tree, 'Alpha'));

    tree = await harness.flush();
    assert.equal(allByClass(tree, 'dsh-trash-tooltip').length, 0, 'not before the delay elapses');

    await sleep(230);
    tree = await harness.flush();
    assert.equal(allByClass(tree, 'dsh-trash-tooltip').length, 1);
  });

  test('a live text selection keeps the card open, and it closes once cleared', async () => {
    const harness = createHarness({ items: [ITEMS[0]] });
    let tree = await harness.flush();
    tree = await openRowCard(harness, cardByTitle(tree, 'Alpha'));
    assert.equal(allByClass(tree, 'dsh-trash-tooltip').length, 1);

    // Dragging a selection past the card edge is not a reason to take the text
    // away: pointer-events:auto + user-select:text only work if leaving the
    // card mid-selection does not dismiss it.
    harness.setSelection('归档与回收站优化分析');
    leaveTitle(tree);
    await sleep(320);
    tree = await harness.flush();
    assert.equal(allByClass(tree, 'dsh-trash-tooltip').length, 1, 'selection in progress');

    harness.setSelection('');
    leaveTitle(tree);
    await sleep(320);
    tree = await harness.flush();
    assert.equal(allByClass(tree, 'dsh-trash-tooltip').length, 0, 'once cleared, the next leave closes it');

    const cardRule = CSS.match(/\.dsh-trash-tooltip \{[^}]*\}/)[0];
    assert.match(cardRule, /pointer-events:\s*auto/);
    assert.match(cardRule, /user-select:\s*text/);
  });

  test('the card shows the session log path, abbreviated, full path in the title', async () => {
    const harness = createHarness({ items: [ITEMS[0]] });
    let tree = await harness.flush();
    tree = await openRowCard(harness, cardByTitle(tree, 'Alpha'));

    const rows = allByClass(oneByClass(tree, 'dsh-trash-tooltip'), 'dsh-trash-tooltip-sub');
    assert.equal(rows.length, 2, 'id + storage path');
    assert.equal(textOf(rows[0]), 'ID: sess-a');
    assert.equal(textOf(rows[1]),
      'Storage path: ~/.dsh/profiles/web/sessions/--Users-seetraum-project-harness-session-delete--/session-004eb8f2/session.v4.jsonl.zstd');
    assert.equal(rows[1].props.title, ITEMS[0].logPath,
      'the tooltip keeps the full absolute path for checking / copying');
    assert.ok(ITEMS[0].logPath.length >= 110, 'the fixture path is a realistic length');

    // The same abbreviation for the other shapes a DSH profile can live under.
    const shapes = [
      ['/home/dev/.dsh/sessions/s-1/session.v4.jsonl.zstd', '~/.dsh/sessions/s-1/session.v4.jsonl.zstd'],
      ['/root/.dsh/sessions/s-1/session.v4.jsonl.zstd', '~/.dsh/sessions/s-1/session.v4.jsonl.zstd'],
      ['C:\\Users\\dev\\.dsh\\sessions\\s-1\\session.v4.jsonl.zstd', '~\\.dsh\\sessions\\s-1\\session.v4.jsonl.zstd'],
      ['/opt/dsh/sessions/s-1/session.v4.jsonl.zstd', '/opt/dsh/sessions/s-1/session.v4.jsonl.zstd'],
    ];
    for (const [logPath, expected] of shapes) {
      const other = createHarness({ items: [{ ...ITEMS[0], logPath }] });
      let otherTree = await other.flush();
      otherTree = await openRowCard(other, cardByTitle(otherTree, 'Alpha'));
      const otherRows = allByClass(oneByClass(otherTree, 'dsh-trash-tooltip'), 'dsh-trash-tooltip-sub');
      assert.equal(textOf(otherRows[1]), `Storage path: ${expected}`, logPath);
      assert.equal(otherRows[1].props.title, logPath);
    }
  });

  test('a session with no log on disk renders no storage row', async () => {
    // ITEMS[1] carries no logPath at all; the null case goes through the same
    // branch, and neither may leave an empty row or a placeholder behind.
    for (const items of [[ITEMS[1]], [{ ...ITEMS[1], logPath: null }]]) {
      const harness = createHarness({ items });
      let tree = await harness.flush();
      tree = await openRowCard(harness, cardByTitle(tree, 'Beta'));
      const rows = allByClass(oneByClass(tree, 'dsh-trash-tooltip'), 'dsh-trash-tooltip-sub');
      assert.equal(rows.length, 1, 'only the ID row is rendered');
      assert.equal(textOf(rows[0]), 'ID: sess-b');
    }
  });

  test('an external list change closes the card of a session that no longer exists', async () => {
    const harness = createHarness({ items: [ITEMS[0], ITEMS[1]] });
    let tree = await harness.flush();
    tree = await openRowCard(harness, cardByTitle(tree, 'Alpha'));
    assert.equal(allByClass(tree, 'dsh-trash-tooltip').length, 1);

    // The session disappeared elsewhere (another window, a host event).
    harness.state.items = [ITEMS[1]];
    harness.emit('workspace/archived-sessions-changed');
    tree = await harness.flush();

    assert.equal(allByClass(tree, 'dsh-trash-tooltip').length, 0, 'the card follows its session, not the row');
    assert.equal(allByClass(tree, 'dsh-trash-card').length, 1);
  });

  test('the card survives the pointer travelling from the row onto it', async () => {
    const harness = createHarness({ items: [ITEMS[0]] });
    let tree = await harness.flush();
    tree = await openRowCard(harness, cardByTitle(tree, 'Alpha'));

    // Row -> card: the pointer leaves the row and lands on the card inside the
    // 250ms grace period. Before this, the row's mouseleave closed it instantly.
    leaveTitle(tree);
    tree = await harness.flush();
    oneByClass(tree, 'dsh-trash-tooltip').props.onMouseEnter();
    await sleep(320);
    tree = await harness.flush();
    assert.equal(allByClass(tree, 'dsh-trash-tooltip').length, 1, 'the hand-off must not drop the card');

    // Leaving the card does close it, after the same grace period.
    oneByClass(tree, 'dsh-trash-tooltip').props.onMouseLeave();
    await sleep(320);
    tree = await harness.flush();
    assert.equal(allByClass(tree, 'dsh-trash-tooltip').length, 0);
  });

  test('Esc, wheel, an outside press and a resize each close the card', async () => {
    const harness = createHarness({ items: [ITEMS[0]] });
    const open = async () => {
      let tree = await harness.flush();
      tree = await openRowCard(harness, cardByTitle(tree, 'Alpha'));
      return tree;
    };
    const isOpen = (tree) => allByClass(tree, 'dsh-trash-tooltip').length === 1;

    let tree = await open();
    harness.dispatchDocument('keydown', { key: 'Escape' });
    tree = await harness.flush();
    assert.equal(isOpen(tree), false, 'Esc closes it');

    tree = await open();
    harness.dispatchWindow('wheel', {});
    tree = await harness.flush();
    assert.equal(isOpen(tree), false, 'a wheel scroll closes it');

    tree = await open();
    harness.setInsideTarget(null);
    harness.dispatchDocument('pointerdown', { target: { outside: true } });
    tree = await harness.flush();
    assert.equal(isOpen(tree), false, 'a press outside closes it');

    tree = await open();
    harness.setInsideTarget(null);
    harness.dispatchWindow('resize', {});
    tree = await harness.flush();
    assert.equal(isOpen(tree), false, 'a viewport resize closes it');
  });

  test('a press inside the card does not close it', async () => {
    const harness = createHarness({ items: [ITEMS[0]] });
    let tree = await harness.flush();
    tree = await openRowCard(harness, cardByTitle(tree, 'Alpha'));

    const inside = { inside: true };
    harness.setInsideTarget(inside);
    tree = await harness.flush();
    harness.dispatchDocument('pointerdown', { target: inside });
    tree = await harness.flush();
    assert.equal(allByClass(tree, 'dsh-trash-tooltip').length, 1, 'selecting text or pressing a button keeps it');
  });

  test('the card is anchored to the row, flipped when there is no room above', async () => {
    const harness = createHarness({ items: [ITEMS[0]] });
    let tree = await harness.flush();
    const row = cardByTitle(tree, 'Alpha');
    assert.equal(row.props.onMouseMove, undefined, 'the card must not follow the pointer');

    // Room above: above the row, left edge on the anchor, translateY(-100%) does
    // the rest through CSS.
    tree = await openRowCard(harness, row);
    let card = oneByClass(tree, 'dsh-trash-tooltip');
    assert.ok(hasClass(card, 'dsh-trash-tooltip--above'));
    assert.deepEqual(card.props.style, { left: '120px', top: '392px' });

    // A row at the very top of the viewport flips the card below itself.
    harness.setTooltipBox({ width: 380, height: 90, top: 0, left: 0, right: 380, bottom: 90 });
    const topRow = { top: 4, bottom: 44, left: 120, right: 700, width: 580, height: 40 };
    leaveTitle(harness.root());
    tree = await harness.flush();
    await sleep(320);
    tree = await harness.flush();
    tree = await openRowCard(harness, cardByTitle(tree, 'Alpha'), topRow);
    card = oneByClass(tree, 'dsh-trash-tooltip');
    assert.ok(hasClass(card, 'dsh-trash-tooltip--below'), 'no room above -> below the row');
    assert.equal(card.props.style.top, '52px', 'anchor.bottom + 8');

    // A row near the right edge is clamped into the viewport (1280 wide).
    leaveTitle(harness.root());
    await sleep(320);
    tree = await harness.flush();
    const rightRow = { top: 400, bottom: 440, left: 1180, right: 1270, width: 90, height: 40 };
    tree = await openRowCard(harness, cardByTitle(tree, 'Alpha'), rightRow);
    card = oneByClass(tree, 'dsh-trash-tooltip');
    assert.equal(card.props.style.left, `${1280 - 380 - 8}px`, 'the card never leaves the viewport');
  });

});

describe('client sub-session row polish (P0)', () => {
  test('the age is relative with the absolute time kept in tooltips', async () => {
    const now = Date.parse('2026-06-15T12:00:00');
    const ages = [
      ['kid-now', now - 10 * 1000, 'Just now'],
      ['kid-min', now - 5 * 60 * 1000, '5 min ago'],
      ['kid-hour', now - 3 * 3600 * 1000, '3 h ago'],
      ['kid-day', now - 26 * 3600 * 1000, 'Yesterday'],
      ['kid-week', now - 3 * 24 * 3600 * 1000, 'This week'],
      ['kid-old', now - 40 * 24 * 3600 * 1000, 'Earlier'],
    ];
    const harness = createHarness({
      childrenResponse: () => okJson({
        groups: { 'sess-a': ages.map(([id, ts]) => child(id, { createdAt: ts })) },
        orphans: {},
        scannedAt: 1,
        sessionCount: 3,
      }),
    });
    // The rows are rendered across await points, so the clock stays frozen for
    // the whole interaction.
    let tree = await withFrozenNow('2026-06-15T12:00:00', () => harness.flush());
    await withFrozenNow('2026-06-15T12:00:00',
      () => click(oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-badge--children')));
    tree = await withFrozenNow('2026-06-15T12:00:00', () => harness.flush());
    const rows = allByClass(regionFor(tree, 'sess-a'), 'dsh-trash-child');

    for (const [index, [id, ts, expected]] of ages.entries()) {
      const row = rows.find((el) => textOf(el).includes(id));
      assert.equal(textOf(oneByClass(row, 'dsh-trash-child-meta')), `1.0 KB · ${expected}`,
        `${id} @${new Date(ts).toISOString()} must read as the "${expected}" bucket`);
      // The absolute timestamp is never lost: it rides the meta tooltip and the
      // row tooltip (the narrow panel hides the meta line).
      assert.match(oneByClass(row, 'dsh-trash-child-meta').props.title, /^2026\/\d+\/\d+ \d\d:\d\d$/);
      assert.match(row.props.title, /^1\.0 KB · 2026\/\d+\/\d+ \d\d:\d\d$/);
    }
    assert.equal(rows.length, ages.length);
  });

  test('the card checkbox scopes itself and never touches its sub-sessions', async () => {
    const harness = createHarness({
      childrenResponse: () => okJson({
        groups: { 'sess-a': [child('kid-a1'), child('kid-a2')] },
        orphans: {},
        scannedAt: 1,
        sessionCount: 3,
      }),
    });
    let tree = await harness.flush();
    await click(oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-badge--children'));
    tree = await harness.flush();

    const check = oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-checkbox--card');
    assert.equal(check.props['aria-label'], 'Selects this session only, not its sub-sessions');
    assert.equal(check.props.title, 'Selects this session only, not its sub-sessions');
    toggleCheckbox(check);
    tree = await harness.flush();

    assert.equal(allByClass(regionFor(tree, 'sess-a'), 'dsh-trash-child-check')
      .every((box) => box.props.checked === true), true,
    'batch-selecting the card must not touch the cascade scope of its children');
    assert.ok(hasClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-card--checked'));
  });

  test('every card action keeps an accessible name when only its icon is left', async () => {
    const harness = createHarness();
    const tree = await harness.flush();
    const actions = oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-card-actions');
    const buttons = allByClass(actions, 'dsh-trash-btn-ghost')
      .concat(allByClass(actions, 'dsh-trash-btn-danger-text'));
    assert.deepEqual(buttons.map((b) => b.props['aria-label']), ['View', 'Restore', 'Permanently delete']);
    assert.deepEqual(buttons.map((b) => b.props.title), ['View', 'Restore', 'Permanently delete']);
    for (const button of buttons) {
      const label = oneByClass(button, 'dsh-trash-btn-label');
      assert.equal(textOf(label), button.props['aria-label'],
        'the icon-only button still carries the same text in its label span');
    }
  });

  test('size and age stay in the accessible name when the narrow panel hides the line', async () => {
    const harness = createHarness({
      childrenResponse: () => okJson({
        groups: { 'sess-a': [child('kid-a1', { fileSize: 4096, createdAt: Date.now() - 5 * 60 * 1000 })] },
        orphans: {},
        scannedAt: 1,
        sessionCount: 2,
      }),
    });
    let tree = await harness.flush();
    await click(oneByClass(cardByTitle(tree, 'Alpha'), 'dsh-trash-badge--children'));
    tree = await harness.flush();

    const row = allByClass(regionFor(tree, 'sess-a'), 'dsh-trash-child')[0];
    const meta = oneByClass(row, 'dsh-trash-child-meta');
    const titleButton = oneByClass(row, 'dsh-trash-child-title');
    assert.equal(textOf(meta), '4.0 KB · 5 min ago');
    // <=360px hides the meta LINE, and `display: none` also removes it from the
    // accessibility tree — so the button's name has to carry both facts, at
    // every width, or a keyboard/screen-reader user loses them.
    assert.match(titleButton.props['aria-label'], /^Session: kid-a1 · 4\.0 KB · 5 min ago$/);
    // The visual line is aria-hidden so the same facts are not announced twice.
    assert.equal(meta.props['aria-hidden'], 'true');
    assert.match(meta.props.title, /^\d{4}\/\d+\/\d+ \d\d:\d\d$/, 'the absolute time stays in the tooltip');
  });

  test('the new row geometry is pinned in CSS (budget, priority, hit target)', () => {
    const block = CSS.slice(CSS.indexOf('Sub-session rows — full-width'),
      CSS.indexOf('Kept sub-sessions of a main session'));
    // Row rules only: the narrow-panel rules at the end DO hide things on purpose.
    const rowRules = block.slice(0, block.indexOf('Narrow panel'));
    // The meta may shrink, and it sits between the title and the buttons.
    assert.match(rowRules, /\.dsh-trash-child-meta \{[^}]*flex:\s*0 1 auto/);
    assert.match(rowRules, /\.dsh-trash-child-meta \{[^}]*min-width:\s*0/);
    assert.match(rowRules, /\.dsh-trash-child-meta \{[^}]*overflow:\s*hidden/);
    // The title takes the free space and leads the DOM (title before meta).
    assert.match(rowRules, /\.dsh-trash-child-title \{[^}]*flex:\s*1 1 auto/);
    // Delete is a 24x24 icon button, never hover-gated.
    assert.match(rowRules, /\.dsh-trash-child-delete \{[^}]*width:\s*24px/);
    assert.match(rowRules, /\.dsh-trash-child-delete \{[^}]*height:\s*24px/);
    // Its hit target and its visibility are unconditional: no hover gate, no
    // rule that could hide it (a touch device has no hover to reveal it).
    assert.doesNotMatch(rowRules, /opacity:\s*0(?!\.)/);
    assert.doesNotMatch(rowRules, /visibility:\s*hidden/);
    assert.doesNotMatch(rowRules, /display:\s*none/);
    // A smaller, secondary checkbox next to the card's own.
    assert.match(rowRules, /\.dsh-trash-child-check \{[^}]*width:\s*13px/);
    assert.match(rowRules, /\.dsh-trash-child-check \{[^}]*accent-color:\s*var\(--dstrb-text-faint\)/);
    // Title-first on the narrowest panel: the age is what gives way.
    assert.match(CSS, /@container \(max-width: 360px\)[\s\S]{0,2000}\.dsh-trash-child-meta \{\s*display:\s*none/);
  });

  test('the card title budget is width-independent (no wider-panel regression)', () => {
    // ONE card geometry: a per-width padding/gap, or an action label that comes
    // back once the panel grows, makes a WIDER panel show a NARROWER title
    // (measured: 400px container -> 97px title while 310px -> 178px).
    const cardRule = CSS.match(/\.dsh-trash-card \{[^}]*\}/)[0];
    assert.match(cardRule, /padding:\s*12px 10px/);
    assert.match(cardRule, /gap:\s*4px/);
    assert.equal((CSS.match(/\.dsh-trash-card \{/g) ?? []).length, 1,
      'the card row must not be re-declared per width');
    // The action labels are hidden by a BASE rule, never re-shown by width.
    assert.match(CSS, /\n\.dsh-trash-btn-label \{\s*display:\s*none;\s*\}/);
    // Nothing inside a container query may touch the card row geometry.
    // Only real at-rules: the word `@container` also appears inside comments.
    const containerBlocks = CSS.match(/(?:^|\n)@container[^{]*\{[\s\S]*?\n\}/g) ?? [];
    assert.ok(containerBlocks.length >= 2, 'the narrow-panel blocks must exist');
    for (const block of containerBlocks) {
      for (const selector of ['\.dsh-trash-card \{', '\.dsh-trash-card-actions', '\.dsh-trash-btn-ghost', '\.dsh-trash-btn-danger-text', '\.dsh-trash-btn-label', '\.dsh-trash-children \{']) {
        assert.doesNotMatch(block, new RegExp(selector),
          `the geometry must not change with the panel width: ${selector} in ${block.slice(0, 40)}`);
      }
    }
    // WCAG 2.5.8: the icon-only card actions keep a >=24x24 target.
    for (const rule of [CSS.match(/\.dsh-trash-btn-ghost \{[^}]*\}/)[0], CSS.match(/\.dsh-trash-btn-danger-text \{[^}]*\}/)[0]]) {
      assert.match(rule, /min-width:\s*24px/);
      assert.match(rule, /min-height:\s*24px/);
    }
  });

  test('every muted-token text use clears 4.5:1 on the surfaces it lands on', () => {
    // Small labels (badges, meta rows, sub-session size/age, the info card's
    // ID/path and the copy buttons) all render in --dstrb-text-muted. It has to
    // clear the 4.5:1 TEXT bar on each surface it can land on, in both themes —
    // #718096 measured 4.02:1 on the card and 3.83:1 on a badge.
    const blocks = {
      'root (light)': cssBlock(':root {'),
      'prefers-dark': cssBlock('@media (prefers-color-scheme: dark) {'),
      'app-dark': cssBlock('body[data-ds-dark-theme] {'),
      'explicit-light': cssBlock('body:not([data-ds-dark-theme]) {'),
    };
    for (const [name, block] of Object.entries(blocks)) {
      const muted = token(block, '--dstrb-text-muted');
      for (const surface of ['--dstrb-surface', '--dstrb-surface-subtle', '--dstrb-surface-hover']) {
        const ratio = contrast(hex(muted), hex(token(block, surface)));
        assert.ok(ratio >= 4.5,
          `${name}: ${muted} on ${surface} = ${ratio.toFixed(2)}:1 must be >= 4.5:1`);
      }
    }
  });

  test('the info card and the open badge keep their text above 4.5:1', () => {
    const light = cssBlock(':root {');
    // The card's secondary text falls back to the muted token, on the card
    // SURFACE (the host branch supplies its own label token).
    assert.match(CSS, /\.dsh-trash-tooltip-sub \{[^}]*color:\s*var\(--dstrb-text-muted\)/);
    // The card is a THEMED PANEL: no host-tooltip tokens on it (they are a dark
    // bubble in both themes).
    const cardRule = CSS.match(/\.dsh-trash-tooltip \{[^}]*\}/)[0];
    assert.match(cardRule, /background:\s*var\(--dstrb-surface\)/);
    assert.doesNotMatch(cardRule, /--dsw-alias-tooltip/);
    assert.ok(contrast(hex(token(light, '--dstrb-text-muted')), hex(token(light, '--dstrb-surface'))) >= 4.5);
    assert.ok(contrast(hex(token(light, '--dstrb-text-strong')), hex(token(light, '--dstrb-surface'))) >= 4.5);
    // The OPEN badge used --dstrb-accent for its 11px count: 3.22:1 on the
    // accent veil. The accent stays as the non-text cue (border + icon).
    const open = CSS.match(/\.dsh-trash-badge--children\[aria-expanded="true"\] \{[^}]*\}/)[0];
    assert.match(open, /^\s*color:\s*var\(--dstrb-text-strong\);$/m);
    assert.doesNotMatch(open, /^\s*color:\s*var\(--dstrb-accent\);$/m,
      'the count must not be the accent colour (3.22:1 on its own veil)');
    assert.match(CSS, /\.dsh-trash-badge--children\[aria-expanded="true"\] \.dsh-trash-icon-badge \{[^}]*color:\s*var\(--dstrb-accent\)/);
  });

  test('no text is left on the faint tier', () => {
    // --dstrb-text-faint (2.26:1 on white) stays available for borders,
    // accents and decorative GLYPHS, but no label reads through it any more.
    const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+\{[^{}]*\}/g) ?? [];
    const faintColored = rules.filter((rule) => /(^|[;{\s])color\s*:[^;]*--dstrb-text-faint/.test(rule));
    const labelled = faintColored.filter((rule) => !/icon/.test(rule.split('{')[0]));
    assert.deepEqual(labelled, [], 'only decorative icon rules may colour themselves with the faint tier');
    assert.ok(faintColored.length > 0, 'the search glyph still uses it');
  });

  test('the live row keeps its title readable and only dims the periphery', () => {
    const block = CSS.slice(CSS.indexOf('.dsh-trash-child--live {'),
      CSS.indexOf('.dsh-trash-child--live .dsh-trash-child-check'));
    assert.doesNotMatch(block, /opacity:\s*0?\.6/, 'no row-level opacity: it dragged the title to 2.81:1');
    assert.match(block, /cursor:\s*not-allowed/);
    assert.match(CSS, /\.dsh-trash-child--live \.dsh-trash-child-check,[\s\S]{0,200}opacity:\s*0\.55/);
    // WCAG: the title is --dstrb-text-secondary over the live row's effective
    // background (danger veil 8% composited on the card surface), light theme.
    const ratio = contrast(hex('#4a5568'), composite(rgba('rgba(229, 62, 62, 0.08)'), hex('#ffffff')));
    assert.ok(ratio >= 4.5, `live title contrast ${ratio.toFixed(2)}:1 must be >= 4.5:1`);
  });

  test('the hierarchy cue meets 3:1 against the card surface in every theme', () => {
    // Four palette blocks: a token added to only one of them silently leaks
    // another theme's value (the explicit-light branch is easy to forget).
    const blocks = {
      'root (light)': cssBlock(':root {'),
      'prefers-dark': cssBlock('@media (prefers-color-scheme: dark) {'),
      'app-dark': cssBlock('body[data-ds-dark-theme] {'),
      'explicit-light': cssBlock('body:not([data-ds-dark-theme]) {'),
    };
    for (const [name, block] of Object.entries(blocks)) {
      const surface = token(block, '--dstrb-surface');
      const structure = token(block, '--dstrb-structure');
      assert.ok(surface && structure, `${name} must declare both --dstrb-surface and --dstrb-structure`);
      const ratio = contrast(hex(structure), hex(surface));
      assert.ok(ratio >= 3, `${name}: rail ${structure} on card ${surface} = ${ratio.toFixed(2)}:1 must be >= 3:1`);
      // The rail is the boundary cue; the old decorative border token is not.
      assert.ok(contrast(hex(structure), hex(surface)) > contrast(hex(token(block, '--dstrb-border')), hex(surface)),
        `${name}: the structure token must be stronger than the decorative border`);
    }
  });
});
