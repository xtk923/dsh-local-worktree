/**
 * The browser half, checked without a browser.
 *
 * A client plugin is a bundle the page evaluates, and the two ways it fails
 * silently are both invisible from the Host side:
 *
 *   * a SYNTAX or shape error blanks the whole slot entry — React's error
 *     boundary logs `slot entry crashed in '<slot>'` and the user sees nothing;
 *   * a CSS custom property that does not exist resolves to NOTHING, so a
 *     `background: var(--dsw-alias-that-was-never-defined)` renders a
 *     TRANSPARENT popover whose text fights the conversation behind it.
 *
 * The second one happened for real: the theme contract on this machine defines
 * 14 tokens, and the client had been written against invented names. So the
 * token list is asserted here, and an unknown `--dsw-*` reference fails the
 * suite instead of waiting for a human to notice.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createContext, runInContext, Script } from 'node:vm';

const ROOT = join(import.meta.dirname, '..');
const CLIENT_PATH = join(ROOT, 'client', 'client.js');
const SOURCE = readFileSync(CLIENT_PATH, 'utf8');
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/**
 * The theme tokens this build actually defines.
 *
 * Captured from the live page's `Theme.listTokens` Inspect query. A token that
 * is not on this list is not a "soft" reference: CSS resolves an undefined
 * custom property to nothing at all.
 */
const THEME_TOKENS = new Set([
	'--dsw-alias-bg-base',
	'--dsw-alias-bg-layer-1',
	'--dsw-alias-bg-layer-2',
	'--dsw-alias-bg-overlay',
	'--dsw-alias-border-l1',
	'--dsw-alias-border-l2',
	'--dsw-alias-brand-primary',
	'--dsw-alias-label-primary',
	'--dsw-alias-label-secondary',
	'--dsw-alias-state-error-primary',
	'--dsw-alias-state-idle-primary',
	'--dsw-alias-state-success-primary',
	'--dsw-alias-state-warn-primary',
	'--dsw-specific-sidebar-fill'
]);

/** Load the bundle in a sandbox and return the definition it registers. */
function loadDefinition() {
	new Script(SOURCE, { filename: CLIENT_PATH });
	let registered = null;
	const sandbox = {
		window: { __ModuleLoader__: { load: (definition) => { registered = definition; } } },
		console
	};
	runInContext(SOURCE, createContext(sandbox), { filename: CLIENT_PATH });
	return registered;
}

test('the client bundle parses as a plain script and registers one module', () => {
	const definition = loadDefinition();
	assert.ok(definition !== null, 'the bundle must call window.__ModuleLoader__.load');
	assert.equal(definition.id, PACKAGE.name, 'the loader id must equal the package name the roster scans for');
	assert.equal(typeof definition.factory, 'function');
});

test('the factory requires nothing but react from the browser module table', () => {
	const definition = loadDefinition();
	const required = [];
	const plugin = definition.factory((name) => {
		required.push(name);
		if (name === 'react') return { createElement: () => null, Fragment: 'Fragment' };
		throw new Error(`unexpected require: ${name}`);
	});
	// Registering is what pulls the requires, so drive `apply` with a slots stub.
	const registrations = [];
	plugin.apply({
		uiWorkspace: { openSession: () => {} },
		get: () => undefined,
		slots: { inject: (_key, callback) => callback(), register: (meta, component) => { registrations.push({ meta, component }); return () => {}; } }
	});
	assert.deepEqual([...new Set(required)], ['react']);
	// The shipped guidance forbids loading a Harness Client package directly: those
	// modules change without notice and a throwing component blanks the slot entry.
	assert.equal(CODE_ONLY.includes('dsh-client-ui-primitives'), false,
		'a Harness Client package must not be imported (comments mentioning it are fine)');
});

/**
 * The source with comments removed.
 *
 * The token check must look at CSS that will actually be evaluated: a dead token
 * named in a comment explaining why it is dead is documentation, not a bug.
 * (That is not hypothetical — the comment above `CSS` names the very token this
 * suite exists to catch.)
 */
const CODE_ONLY = SOURCE
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/^[ \t]*\/\/.*$/gm, '');

test('every theme token the client uses is a token this build defines', () => {
	const used = [...new Set([...CODE_ONLY.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1]))];
	assert.ok(used.length > 0, 'the client styles itself with theme tokens');
	const unknown = used.filter((token) => !THEME_TOKENS.has(token));
	assert.deepEqual(unknown, [], `these custom properties do not exist and resolve to nothing: ${unknown.join(', ')}`);
});

test('the popover surface is opaque, so text is never read through', () => {
	// An undefined token plus no fallback is the exact bug that shipped: a menu
	// with a transparent background over the conversation.
	const menu = /\.dshwt-menu\{[^}]*\}/.exec(SOURCE.replace(/\n/g, ''));
	assert.ok(menu !== null, 'the menu rule exists');
	const rule = menu[0].replace(/\s+/g, ' ');
	assert.match(rule, /background:\s*var\(--dsw-alias-bg-overlay/);
	assert.match(rule, /light-dark\(/, 'the popover keeps an opaque fallback if the token ever goes away');
	assert.match(rule, /z-index:\s*\d{3,}/, 'the menu is opened over the composer, so it needs a high layer');
});

test('the control is registered in exactly ONE seat, so nothing can be rendered twice', () => {
	const definition = loadDefinition();
	const plugin = definition.factory(() => ({ createElement: () => null, Fragment: 'Fragment' }));
	const registrations = [];
	const injected = [];
	plugin.apply({
		uiWorkspace: { openSession: () => {} },
		get: () => undefined,
		slots: {
			inject: (key, callback) => { injected.push(key); callback(); },
			register: (meta, component) => { registrations.push({ meta, component }); return () => {}; }
		}
	});

	// One seat only. Two registrations of the same component mount it twice, with
	// two copies of its state, so every message it shows appears twice on screen —
	// which is precisely what happened. There is no per-seat switch to get wrong now.
	assert.deepEqual(injected, ['conversation.input.left']);
	assert.equal(registrations.length, 1);
	assert.equal(registrations[0].meta.id, PACKAGE.name);
	assert.equal(registrations[0].meta.name, 'conversation.input.left');
	// The composer toolbar is ambient, so it also covers the Hero — before there is
	// any session working directory — which the session header does not.
	assert.equal(CODE_ONLY.includes("conversation.session.header.utilities"), false,
		'the second seat is gone, not merely quieted');
	assert.equal(CODE_ONLY.includes('seat'), false, 'no per-seat switch is left to misread');
});

test('the declared injects cover what the component actually uses', () => {
	const definition = loadDefinition();
	const plugin = definition.factory(() => ({ createElement: () => null, Fragment: 'Fragment' }));
	assert.deepEqual([...plugin.inject].sort(), ['slots', 'uiWorkspace']);
	// The client manifest's own inject list is package names for ordering; it must
	// name the workspace package that provides uiWorkspace.
	assert.ok(
		PACKAGE.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'),
		'the workspace package is declared so its client half is activated first'
	);
});

test('no message is rendered from more than one place', () => {
	// The banner that made the layout messy existed because the component was
	// mounted twice and each mount kept its own notice state. With one seat there is
	// one notice, and this pins the invariant that made the difference.
	const noticeSites = [...CODE_ONLY.matchAll(/className: 'dshwt-note'/g)].length;
	assert.ok(noticeSites >= 1, 'the control reports outcomes somewhere');
	assert.equal(CODE_ONLY.includes('showMessages'), false, 'no conditional that could render the same text twice');
	assert.equal(CODE_ONLY.includes('reminded'), false, 'the standing reminder banner is gone');
	assert.match(CODE_ONLY, /mineWorktrees\(\)\.length > 0 \? h\('div', \{ key: 'mine-head'/,
		'the worktree reminder lives inside the menu');
});

test('a missing uiWorkspace costs the navigation, not the control', () => {
	const definition = loadDefinition();
	const plugin = definition.factory(() => ({ createElement: () => null, Fragment: 'Fragment' }));
	// No `uiWorkspace` anywhere: the control must still register and work, minus the
	// automatic jump.
	const registrations = [];
	assert.doesNotThrow(() => plugin.apply({
		slots: { inject: (_key, callback) => callback(), register: (meta, component) => { registrations.push(meta); return () => {}; } }
	}));
	assert.equal(registrations.length, 1);
	assert.equal(registrations[0].name, 'conversation.input.left');
});
