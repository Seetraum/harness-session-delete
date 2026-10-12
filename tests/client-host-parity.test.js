/**
 * Host-parity regression for the plugin's two floating surfaces: the toast
 * layer and the header action's tooltip.
 *
 * WHY THE SPEC IS PORTED RATHER THAN IMPORTED:
 *
 * @deepseek-ai/dsh-client-ui-primitives declares no `dsh.client`, so it is not
 * a client module-graph row — Vite inlines it into every consumer. The module
 * loader resolves `require(spec)` only from the platform seed words, an
 * already-materialized module, or a registered package factory, so a
 * hand-written `__ModuleLoader__` bundle cannot reach `Tooltip` / `Toast` at
 * all. The only way to match the host is to port its CSS contract, which is
 * what these assertions pin.
 *
 * This is a stylesheet/behavioural contract test, not a rendering test: the
 * client harness stubs React (its `useState` setter is a no-op), so a browser
 * is the only place the bubble itself can be seen.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, '..', 'client.css'), 'utf8');
const JS = readFileSync(join(HERE, '..', 'client.js'), 'utf8');

/**
 * Every declaration block whose selector list names `selector`, joined.
 *
 * A class can appear in more than one block (`.dsh-trash-toast` is also named
 * in the shared font-routing selector list near the top of the stylesheet), and
 * the cascade makes all of them the element's effective style — so the union is
 * the correct thing to assert against. Extracting only the first match would
 * silently read the font rule instead of the surface rule.
 */
function rule(selector) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = CSS.indexOf(`${selector} {`, from);
    if (at < 0) break;
    const end = CSS.indexOf('}', at);
    if (end < 0) break;
    out.push(CSS.slice(at, end + 1));
    from = end;
  }
  return out.join('\n');
}

describe('client surfaces match the host (ported specs)', () => {
  test('the toast layer is top-centre, as the host toast is', () => {
    const container = rule('.dsh-trash-toast-container');
    assert.ok(container, 'the toast container rule must exist');
    assert.match(container, /top:\s*40px/, 'host anchors the banner at top: 40px');
    assert.match(container, /left:\s*50%/, 'host centres it horizontally');
    assert.match(container, /transform:\s*translateX\(-50%\)/, 'centring transform');
    assert.match(container, /z-index:\s*1100/, 'above the lightbox backdrop (1000)');
    assert.match(container, /pointer-events:\s*none/, 'announcements never intercept clicks');
    // The old surface was a bottom-right card.
    assert.doesNotMatch(container, /bottom:\s*24px/, 'the bottom-right placement must be gone');
  });

  test('the toast box uses the host tokens, with the plugin palette as fallback', () => {
    const toast = rule('.dsh-trash-toast');
    assert.ok(toast, 'the toast rule must exist');
    // Host tokens lead; the plugin's own --dstrb-* follow so older cohorts,
    // which publish no --dsw-* palette, still render a readable banner.
    assert.match(toast, /background:\s*var\(--dsw-alias-toast-bg,\s*var\(--dstrb-toast-bg\)\)/);
    assert.match(toast, /color:\s*var\(--dsw-alias-toast-label,\s*var\(--dstrb-toast-text\)\)/);
    assert.match(toast, /border-radius:\s*var\(--dsw-radius-lg,/);
    assert.match(toast, /box-shadow:\s*var\(--dsw-shadow-lv3,/);
    assert.match(toast, /padding:\s*12px 16px/);
    assert.match(toast, /font-size:\s*14px/);
    assert.match(toast, /line-height:\s*22px/);
    // One value drives the fade delay; the component sets it per notice.
    assert.match(toast, /var\(--dsh-toast-hold,\s*3000ms\)/);
    assert.match(JS, /--dsh-toast-hold/, 'the toast must publish its hold to CSS');
  });

  test('the toast is dark in both themes, like the host surface', () => {
    // The plugin's own --dstrb-toast-bg flips to a LIGHT panel under the dark
    // theme, the exact opposite of the host's always-dark toast. Leading with
    // the host token is what fixes that, so the fallback must never be the
    // primary declaration.
    const toast = rule('.dsh-trash-toast');
    assert.match(toast, /var\(--dsw-alias-toast-bg,/);
    assert.doesNotMatch(
      toast,
      /background(-color)?:\s*var\(--dstrb-toast-bg\)/,
      'the theme-flipping plugin token must not lead',
    );
  });

  test('the toast action matches the host action link', () => {
    const action = rule('.dsh-trash-toast-undo');
    assert.ok(action, 'the undo action rule must exist');
    assert.match(action, /color:\s*var\(--dsw-static-deepseek-400,/);
    assert.match(action, /font:\s*inherit/);
    assert.match(action, /margin-inline:\s*3px/);
    // The banner is click-through, so the action has to opt back in.
    assert.match(action, /pointer-events:\s*auto/);
  });

  test('the header tooltip matches the host tooltip spec', () => {
    const tip = rule('.dsh-trash-tooltip-host');
    assert.ok(tip, 'the header tooltip rule must exist');
    assert.match(tip, /position:\s*fixed/);
    assert.match(tip, /z-index:\s*100/);
    assert.match(tip, /padding:\s*3px 7px/);
    assert.match(tip, /border-radius:\s*var\(--dsw-radius-sm,/);
    assert.match(tip, /background:\s*var\(--dsw-alias-tooltip-bg,\s*var\(--dstrb-tooltip-bg\)\)/);
    assert.match(tip, /color:\s*var\(--dsw-static-neutral-bluish-00,/);
    assert.match(tip, /font-size:\s*13px/);
    assert.match(tip, /line-height:\s*20px/);
    assert.match(tip, /max-width:\s*50vw/);
    assert.match(tip, /pointer-events:\s*none/);
    // The host's side: bottom + align: end transform.
    assert.match(tip, /transform:\s*translateX\(-100%\)/);
    assert.match(tip, /animation:\s*dsh-trash-tooltip-in 150ms/);
  });

  test('reduced motion disables both entry animations', () => {
    assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}\.dsh-trash-toast/);
    assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}\.dsh-trash-tooltip-host/);
  });

  test('the header action no longer sets a native title attribute', () => {
    // The button's props object must not carry `title`; aria-label carries the
    // accessible name instead.
    assert.doesNotMatch(
      JS,
      /className: 'dsh-trash-header-action',\s*\n\s*title:/,
      'the native title attribute must not come back',
    );
    assert.match(JS, /'aria-label':\s*t\('moveToBin'\)/, 'aria-label keeps the accessible name');
  });

  test('the plugin toast hold matches the host long-toast hold', () => {
    // dsh-client-ui-workspace: LONG_TOAST_HOLD_MS = 6e3.
    assert.match(JS, /const TOAST_HOLD_MS = 6000;/);
    assert.match(JS, /const TOAST_FADE_MS = 1000;/, 'Toast.module.css fades over 1000ms');
    assert.match(JS, /const TOOLTIP_DELAY_MS = 500;/, 'the host delays an icon-button tooltip by 500ms');
  });
});
