/**
 * Client-half regression: the plugin surfaces must follow the DSH shell font.
 *
 * Background: `client.css` used to pin its own stacks —
 *     :root { --dstrb-font: -apple-system, …; }
 * and the settings page rendered every label with that stack, so
 * Settings → 字体 (dsh-ui-font) changed the whole app except 会话回收站.
 *
 * The shell paints <body> with `font-family: var(--dsw-font-family, …)` and
 * dsh-ui-font swaps `--dsw-font-family` / `--ds-font-family-code` on <body>.
 * A plugin token that aliases those at :root would NOT pick the body-level
 * override up: a custom property's var() references are substituted at
 * computed-value time on the element that declares it, and that computed
 * value is what inherits. So the host tokens have to be referenced at the
 * point of use (or the value inherited outright).
 *
 * These assertions pin that routing so the page cannot silently fall back to
 * a hardcoded face again.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, '..', 'client.css'), 'utf8');

/** CSS with comments removed, so documentation examples cannot satisfy (or
 *  trip) a declaration assertion. */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** Body of the first rule whose selector list matches `selector` exactly. */
function ruleBody(selector) {
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}',
  );
  const m = CODE.match(re);
  return m ? m[1] : null;
}

describe('client.css font routing (follows the DSH shell font)', () => {
  test('does not pin a hardcoded UI/mono stack as a plugin token', () => {
    // The old bug in one line: --dstrb-font declared with a literal stack.
    assert.doesNotMatch(CODE, /--dstrb-font\s*:/, '--dstrb-font must not be declared (it would freeze the stack)');
    assert.doesNotMatch(CODE, /--dstrb-mono\s*:/, '--dstrb-mono must not be declared (it would freeze the stack)');
  });

  test('keeps concrete fallback stacks for hosts without the shell tokens', () => {
    assert.match(CODE, /--dstrb-font-fallback\s*:\s*[^;]*sans-serif/, 'a concrete UI fallback stack is required');
    assert.match(CODE, /--dstrb-mono-fallback\s*:\s*[^;]*monospace/, 'a concrete mono fallback stack is required');
  });

  test('routes the settings container and the portaled toast through --dsw-font-family', () => {
    const body = ruleBody('.dsh-trash-container,\n.dsh-trash-toast');
    assert.ok(body, 'the .dsh-trash-container, .dsh-trash-toast font rule must exist');
    assert.match(
      body,
      /font-family\s*:\s*var\(--dstrb-font,\s*var\(--dsw-font-family,\s*var\(--dstrb-font-fallback\)\)\)/,
      'UI text must resolve --dsw-font-family (the token the shell paints <body> with)',
    );
  });

  test('routes every code/mono use through --ds-font-family-code', () => {
    const monoUses = CODE.match(/font-family\s*:\s*var\(--dstrb-mono[^;]*/g) ?? [];
    assert.ok(monoUses.length >= 4, `expected the mono use sites, found ${monoUses.length}`);
    for (const use of monoUses) {
      assert.match(use, /var\(--ds-font-family-code,/, `mono use must fall back to the shell code token: ${use}`);
    }
  });

  test('the explicit-light branch does not re-declare the font tokens', () => {
    const light = ruleBody('body:not([data-ds-dark-theme])');
    assert.ok(light, 'the explicit-light palette block must exist');
    assert.doesNotMatch(light, /--dstrb-(font|mono)/, 'fonts are not palette state; re-declaring them here re-pins the stack');
  });
});
