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

/**
 * Load the bundle in a sandbox and return the definition it registers.
 *
 * `extra` adds globals the bundle expects the PAGE to provide and this sandbox
 * therefore lacks — `document` for the menu's Escape listener, `fetch` for the
 * routes the control calls. They must go into the sandbox's own global: the
 * bundle runs in a separate V8 context, so the test file's `globalThis` is not
 * what its code sees.
 */
function loadDefinition(extra = {}) {
	new Script(SOURCE, { filename: CLIENT_PATH });
	let registered = null;
	const sandbox = {
		window: { __ModuleLoader__: { load: (definition) => { registered = definition; } } },
		console,
		...extra
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
	// `workspaces` is what registers the new directory as a Workspace (the row the
	// sidebar groups by) and `sessions` is what `uiWorkspace.openWorkspace` starts
	// the new session through, so both are declared and waited for.
	assert.deepEqual([...plugin.inject].sort(), ['sessions', 'slots', 'uiWorkspace', 'workspaces']);
	// The client manifest's own inject list is package names for ordering; it must
	// name the packages whose client halves provide those three services.
	for (const pkg of [
		'@deepseek-ai/dsh-client-ui-workspace',
		'@deepseek-ai/dsh-api-workspace-controller',
		'@deepseek-ai/dsh-api-session-controller'
	]) {
		assert.ok(PACKAGE.dsh.client.inject.includes(pkg), `${pkg} is declared so its client half is activated first`);
	}
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

/* --------------------------------------------------- the create click path -- */

/**
 * A React stand-in: enough to mount ONE function component and click it.
 *
 * React is not installed here (the page supplies it through the module table), so
 * this suite brings the smallest thing that behaves like it for a single mounted
 * component — hook slots in call order, dependency-aware effects, a re-render per
 * state change. What is under test is the SEQUENCE of service calls the control
 * makes when a worktree is created, not React's rendering.
 */
function createReactStub() {
	const state = { slots: [], index: 0, effects: [], dirty: false };
	const sameDeps = (left, right) => Array.isArray(left) && Array.isArray(right)
		&& left.length === right.length && left.every((value, at) => Object.is(value, right[at]));

	const React = {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
		Fragment: 'Fragment',
		useState(initial) {
			const at = state.index++;
			if (!(at in state.slots)) state.slots[at] = typeof initial === 'function' ? initial() : initial;
			return [state.slots[at], (next) => {
				const value = typeof next === 'function' ? next(state.slots[at]) : next;
				if (!Object.is(value, state.slots[at])) {
					state.slots[at] = value;
					state.dirty = true;
				}
			}];
		},
		useRef(initial) {
			const at = state.index++;
			if (!(at in state.slots)) state.slots[at] = { current: initial };
			return state.slots[at];
		},
		useCallback(callback, deps) {
			const at = state.index++;
			const previous = state.slots[at];
			// Memoised by dependency, like React: an identity that changed every render
			// would re-run every effect that names it, and this control's effects fetch.
			if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value;
			state.slots[at] = { deps, value: callback };
			return callback;
		},
		useEffect(effect, deps) {
			const at = state.index++;
			const previous = state.slots[at];
			if (previous !== undefined && sameDeps(previous.deps, deps)) return;
			state.effects.push({ at, deps, effect });
		}
	};

	const render = (component, props) => {
		state.index = 0;
		state.effects = [];
		const tree = component(props);
		for (const entry of state.effects) {
			const cleanup = entry.effect();
			state.slots[entry.at] = { deps: entry.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
		}
		return tree;
	};

	const driver = {
		component: null,
		props: null,
		tree: null,
		/** Render, run effects, and settle every promise they started. */
		async flush() {
			for (let round = 0; round < 40; round += 1) {
				await new Promise((resolve) => { setTimeout(resolve, 0); });
				if (state.dirty) {
					state.dirty = false;
					driver.tree = render(driver.component, driver.props);
					continue;
				}
				if (round >= 2) return driver.tree;
			}
			return driver.tree;
		},
		async mount(component, props) {
			driver.component = component;
			driver.props = props;
			driver.tree = render(component, props);
			return driver.flush();
		},
		async click(node) {
			node.props.onClick();
			return driver.flush();
		}
	};
	return { React, driver };
}

/** Every element in a rendered tree that matches, without descending into components. */
function findAll(node, matches, out = []) {
	if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return out;
	if (Array.isArray(node)) {
		for (const child of node) findAll(child, matches, out);
		return out;
	}
	if (typeof node.type === 'function') return out;
	if (matches(node)) out.push(node);
	for (const child of node.children ?? []) findAll(child, matches, out);
	return out;
}

/** The rendered text of a tree, so a test can read what the user is told. */
function textOf(node) {
	if (node === null || node === undefined || typeof node === 'boolean') return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(textOf).join('');
	if (typeof node.type === 'function') return '';
	return (node.children ?? []).map(textOf).join('');
}

const WORKTREE_PATH = 'C:\\repo\\.dsh-worktrees\\repo_abc123';
const REPO_PATH = 'C:\\repo';

/** A fetch that answers this plugin's own routes, and records the calls. */
function stubFetch(routes, calls) {
	return async (url, options) => {
		const path = String(url).replace('api/dsh-local-worktree/', '');
		calls.push({ path, body: options?.body === undefined ? null : JSON.parse(options.body) });
		const value = routes[path];
		if (value === undefined) throw new Error(`unexpected call: ${path}`);
		return { ok: true, json: async () => value };
	};
}

/** Mount the control with the services and route answers a Web page would give it. */
async function mountControl({ services = {} } = {}) {
	const calls = [];
	// Filled in by the test once its route answers exist; the bundle's `fetch` reads
	// through this, because it lives in its own VM context.
	const fetcher = { current: null };
	const definition = loadDefinition({
		document: { addEventListener: () => {}, removeEventListener: () => {} },
		fetch: (url, options) => {
			if (fetcher.current === null) throw new Error(`unexpected fetch: ${url}`);
			return fetcher.current(url, options);
		}
	});
	const { React, driver } = createReactStub();
	const plugin = definition.factory((name) => {
		if (name === 'react') return React;
		throw new Error(`unexpected require: ${name}`);
	});
	let component = null;
	const resolved = {
		uiWorkspace: null,
		workspaces: null,
		...services
	};
	plugin.apply({
		uiWorkspace: resolved.uiWorkspace,
		workspaces: resolved.workspaces,
		get: (name) => resolved[name] ?? undefined,
		slots: {
			inject: (_key, callback) => callback(),
			register: (_meta, value) => { component = value; return () => {}; }
		}
	});
	const props = { sessionId: 'session-me', useSessions: (select) => select({ byId: {}, ids: [] }) };
	await driver.mount(component, props);
	return { driver, calls, component, props, useFetch: (impl) => { fetcher.current = impl; } };
}

/** The create click, start to finish: picker → repository → the answer. */
async function createThroughPicker(harness, routes) {
	const { driver, calls } = harness;
	harness.useFetch(stubFetch({
		workspaces: { ok: true, version: 1, items: [{ path: REPO_PATH, title: 'repo', git: true, repoRoot: REPO_PATH }] },
		...routes
	}, calls));

	// The composer control with no working directory: its primary click opens the
	// repository picker rather than acting on a directory it does not have.
	const primary = findAll(driver.tree, (node) => typeof node.props.className === 'string'
		&& node.props.className.startsWith('dshwt-btn'));
	await driver.click(primary[0]);
	const repos = findAll(driver.tree, (node) => typeof node.props.className === 'string'
		&& node.props.className.includes('dshwt-item'));
	await driver.click(repos[0]);
	return driver.tree;
}

test('creating a worktree registers it as a Workspace, then opens its new session', async () => {
	const opened = [];
	const created = [];
	const harness = await mountControl({
		services: {
			// openSession is the OLD path: it throws for a session the client has never
			// seen, which is exactly why the success path must not use it.
			uiWorkspace: {
				openSession: () => { throw new Error('sessions.retain: unknown session'); },
				openWorkspace: async (workspaceId) => { opened.push(workspaceId); }
			},
			workspaces: {
				create: async (input) => {
					created.push(input.path);
					return { workspaceId: 'ws-1', path: input.path, title: 'repo_abc123', sessionIds: [] };
				},
				list: { getSnapshot: () => ({ items: [] }) }
			}
		}
	});

	const tree = await createThroughPicker(harness, {
		create: {
			ok: true,
			created: { path: WORKTREE_PATH, branch: 'dsh/wt/repo_abc123', base: 'main', reused: false },
			workspace: { path: WORKTREE_PATH, layout: 'inside', registered: true, workspaceId: 'ws-1' },
			session: null,
			seat: 'client',
			text: 'created'
		}
	});
	const calls = harness.calls;

	// The directory becomes a Workspace first — that is what puts it in the sidebar —
	// and only then is its session opened, through the sidebar's own call.
	assert.deepEqual(created, [WORKTREE_PATH]);
	assert.deepEqual(opened, ['ws-1']);
	assert.deepEqual(calls.map((entry) => entry.path), ['workspaces', 'create']);
	// The host is not asked to start the session: it would be unknown to this client
	// until a later list refresh, and the jump would silently do nothing.
	assert.equal(calls[1].body.session, undefined, 'the browser keeps the session to itself');
	assert.match(textOf(tree), /已进入该 worktree 的新会话/);
});

test('a client with no workspaces service degrades to the host-side session', async () => {
	const openedSessions = [];
	const harness = await mountControl({
		services: {
			// No `workspaces` at all, so the client cannot register or create anything.
			uiWorkspace: { openSession: (id) => { openedSessions.push(id); } }
		}
	});

	const tree = await createThroughPicker(harness, {
		create: {
			ok: true,
			created: { path: WORKTREE_PATH, branch: 'dsh/wt/repo_abc123', base: 'main', reused: false },
			workspace: { path: WORKTREE_PATH, layout: 'inside', registered: true, workspaceId: 'ws-1' },
			session: null,
			seat: 'client',
			text: 'created'
		},
		session: { ok: true, session: { ok: true, sessionId: 'session-host-1', cwd: WORKTREE_PATH } }
	});

	// The host is asked to start it, and the client jumps if it can.
	assert.deepEqual(harness.calls.map((entry) => entry.path), ['workspaces', 'create', 'session']);
	assert.deepEqual(openedSessions, ['session-host-1']);
	assert.match(textOf(tree), /已切换到该 worktree 的新会话/);
});
