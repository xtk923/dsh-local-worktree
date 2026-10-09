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
 *
 * `windowExtra` adds to the page's `window` itself — `localStorage`, which the
 * sidebar merge reads to decide whether it is on. It is separate from `extra`
 * because `window` is a global the harness already owns: a test supplies the
 * members it cares about, rather than a whole replacement that would have to
 * carry the module loader again.
 */
function loadDefinition(extra = {}, windowExtra = {}) {
	new Script(SOURCE, { filename: CLIENT_PATH });
	let registered = null;
	const sandbox = {
		window: { __ModuleLoader__: { load: (definition) => { registered = definition; } }, ...windowExtra },
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
async function mountControl({ services = {}, cwd = undefined, session = {}, routes = null, window: windowExtra = {} } = {}) {
	const calls = [];
	// Filled in by the test once its route answers exist; the bundle's `fetch` reads
	// through this, because it lives in its own VM context.
	const fetcher = { current: null };
	const definition = loadDefinition({
		document: { addEventListener: () => {}, removeEventListener: () => {} },
		// The control aborts a superseded status read with a real AbortController.
		// This sandbox is a bare V8 context, so the page's own global is handed in —
		// it only became reachable here once a test mounted a session that HAS a
		// working directory and therefore actually reads git state.
		AbortController,
		fetch: (url, options) => {
			if (fetcher.current === null) throw new Error(`unexpected fetch: ${url}`);
			return fetcher.current(url, options);
		}
	}, windowExtra);
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
	// A session that already has a working directory must have its FIRST status read
	// answered, because the state it renders is what decides the menu. Those routes
	// therefore go in before mounting; the picker tests install theirs afterwards,
	// which is correct for a control that starts with no cwd at all.
	if (routes !== null) fetcher.current = stubFetch(routes, calls);
	// The store the control subscribes to. It is handed over as-is (not copied) so a
	// test can MOVE a session — the turn ending, a new prompt — and re-render, which
	// is the only way to exercise the clock that decides when git state is re-read.
	const store = cwd === undefined
		? { byId: {}, ids: [] }
		: { byId: { 'session-me': { cwd, ...session } }, ids: ['session-me'] };
	const props = {
		sessionId: 'session-me',
		useSessions: (select) => select(store)
	};
	await driver.mount(component, props);
	return {
		driver,
		calls,
		component,
		props,
		store,
		/** Render again with the current store — what a store notification does. */
		rerender: () => driver.mount(component, props),
		useFetch: (impl) => { fetcher.current = impl; }
	};
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

/* ------------------------------------------- already inside a worktree -- */

/** The status route that answers the control's own read, as it calls it. */
const statusRoute = (cwd) => `status?cwd=${encodeURIComponent(cwd)}`;

/** A status payload for a session that is standing INSIDE a worktree. */
function insideWorktreeStatus(create, { commitChanges = 0 } = {}) {
	return {
		ok: true,
		version: 1,
		cwd: WORKTREE_PATH,
		enabled: true,
		repo: {
			present: true, usable: true, reason: 'ok', reasonText: 'ok',
			root: REPO_PATH, localRoot: WORKTREE_PATH, branch: 'main',
			head: 'aaa', dirty: commitChanges > 0, modified: commitChanges, untracked: 0
		},
		worktree: {
			present: true, path: WORKTREE_PATH, branch: 'dsh/wt/repo_abc123', base: 'main',
			ahead: 0, baseAhead: 0, dirty: commitChanges > 0, modified: commitChanges, untracked: 0,
			deliverable: false,
			state: 'no-changes', reason: 'no-new-commits', sessionId: 'session-me'
		},
		worktreeSession: 'session-me',
		myWorktrees: [],
		worktreeContainer: 'C:\\repo\\.dsh-worktrees',
		base: null,
		merge: null,
		// The Host's own commit decision; `commitChanges` is how a test says "there is
		// something to commit here" without restating where it would land.
		commit: {
			enabled: commitChanges > 0,
			reason: commitChanges > 0 ? 'ok' : 'nothing-to-commit',
			reasonText: commitChanges > 0 ? 'ready' : 'nothing to commit',
			path: WORKTREE_PATH,
			changes: commitChanges,
			staged: 0,
			unstaged: commitChanges,
			untracked: 0
		},
		action: { kind: 'deliver', enabled: false, reason: 'no-new-commits' },
		create
	};
}

/** Open the `⋯` menu of a mounted control and return its entries. */
async function openMenu(harness) {
	const more = findAll(harness.driver.tree, (node) => node.props.className === 'dshwt-more');
	assert.equal(more.length, 1, 'the control has one more-actions button');
	await harness.driver.click(more[0]);
	return findAll(harness.driver.tree, (node) => typeof node.props.className === 'string'
		&& node.props.className.includes('dshwt-item'));
}

test('inside a worktree the create entry is disabled, and says why', async () => {
	const harness = await mountControl({
		cwd: WORKTREE_PATH,
		routes: {
			[statusRoute(WORKTREE_PATH)]: insideWorktreeStatus({
				enabled: false,
				reason: 'already-in-worktree',
				reasonText: '已经在一个 worktree 里了：先把它合并回去或丢弃它 / already inside a worktree — deliver or discard it first'
			})
		}
	});

	const entries = await openMenu(harness);
	const create = entries[0];
	assert.match(textOf(create), /创建 worktree/);
	// The whole point: a session that is already isolated is not offered a second
	// isolation, and the worktree it is standing in is what it has to finish.
	assert.equal(create.props.disabled, true, 'creating another worktree is not offered from inside one');
	// Disabled, never hidden: the entry stays put and explains itself, because a menu
	// that silently drops the thing the user came for reads as a bug.
	assert.match(textOf(create), /已经在.*worktree/);
	assert.match(create.props.title, /deliver or discard|合并回去|丢弃/);
});

test('the create entry survives a host half that does not report the decision yet', async () => {
	// The client bundle hot-reloads into a running page while the host half only
	// changes on a restart, so the entry has to reach the same verdict from what the
	// status payload has always carried.
	const inside = await mountControl({
		cwd: WORKTREE_PATH,
		routes: { [statusRoute(WORKTREE_PATH)]: insideWorktreeStatus(undefined) }
	});
	const insideEntries = await openMenu(inside);
	assert.match(textOf(insideEntries[0]), /创建 worktree/);
	assert.equal(insideEntries[0].props.disabled, true, 'the worktree the session is in is enough to refuse a second one');

	// And in the main working tree — no worktree around this session — creation stays
	// exactly as available as it was.
	const outside = await mountControl({
		cwd: REPO_PATH,
		routes: {
			[statusRoute(REPO_PATH)]: {
				...insideWorktreeStatus(undefined),
				cwd: REPO_PATH,
				repo: { ...insideWorktreeStatus(undefined).repo, localRoot: REPO_PATH },
				worktree: null,
				worktreeSession: null,
				action: { kind: 'create', enabled: true, reason: 'ok' }
			}
		}
	});
	const outsideEntries = await openMenu(outside);
	assert.equal(outsideEntries[0].props.disabled, false, 'the main tree still cuts worktrees');
});

/* ---------------------------------------------- the merge click's question -- */

/** The worktree with two commits waiting, so deliver is enabled. */
const READY_STATUS = {
	...insideWorktreeStatus(undefined),
	worktree: {
		...insideWorktreeStatus(undefined).worktree,
		ahead: 2, deliverable: true, state: 'ready', reason: 'ready', dirty: false
	},
	merge: { strategy: 'fast-forward', text: '可快进 / fast-forwardable' },
	action: { kind: 'deliver', enabled: true, reason: 'ready' }
};

/** Every `dshwt-item` on screen, in the order the menu renders them. */
const itemsOf = (tree) => findAll(tree, (node) => typeof node.props.className === 'string'
	&& node.props.className.includes('dshwt-item'));

/** The heading that asks the merge question. */
const questionOf = (tree) => findAll(tree, (node) => node.props.className === 'dshwt-head')
	.map(textOf).join('\n');

/** The primary button — the merge path when the session stands in a worktree. */
const primaryOf = (tree) => findAll(tree, (node) => typeof node.props.className === 'string'
	&& node.props.className.startsWith('dshwt-btn')
	&& !node.props.className.includes('dshwt-btn--commit'))[0];

/** The commit button, which stands beside the primary one in the same row. */
const commitOf = (tree) => findAll(tree, (node) => typeof node.props.className === 'string'
	&& node.props.className.includes('dshwt-btn--commit'))[0];

/**
 * The question a merge begins with.
 *
 * The worktree is where the user's session lives, so removing it is the user's
 * decision — but the plugin still recommends removal, and that is what "default"
 * has to mean in code: FIRST entry, marked, and focused, so Enter takes it.
 */
test('the merge click asks first, and removing the worktree is the default answer', async () => {
	const harness = await mountControl({
		cwd: WORKTREE_PATH,
		routes: {
			[statusRoute(WORKTREE_PATH)]: READY_STATUS,
			deliver: { ok: true, strategy: 'fast-forward', text: '已把 2 个提交快进到 main', cleanup: { removed: true } }
		}
	});

	// It used to merge the instant it was clicked; now it asks. Nothing has been
	// merged when the question appears, so cancelling costs nothing.
	await harness.driver.click(primaryOf(harness.driver.tree));
	assert.deepEqual(harness.calls.map((entry) => entry.path), [statusRoute(WORKTREE_PATH)],
		'the click opens the question; no merge was started');

	assert.match(questionOf(harness.driver.tree), /worktree 怎么处理|what about the worktree/, 'the menu states the question');
	const items = itemsOf(harness.driver.tree);
	// The DEFAULT: first, marked, and focused, so Enter on the open question removes.
	assert.match(textOf(items[0]), /合并并删除|merge, then remove/);
	assert.match(textOf(items[0]), /默认|default/);
	assert.equal(items[0].props.autoFocus, true, 'the default answer is the one Enter takes');
	// The way out of the default sits right beside it, and cancelling is below both.
	assert.match(textOf(items[1]), /保留|keep/);
	assert.match(textOf(items[2]), /取消|cancel/);

	await harness.driver.click(items[0]);
	const deliver = harness.calls.find((entry) => entry.path === 'deliver');
	assert.deepEqual(deliver.body, { cleanup: true, cwd: WORKTREE_PATH },
		'the default answer tells the host to remove the worktree');
	assert.match(textOf(harness.driver.tree), /已删除|was removed/, 'the user is told what happened to the worktree');
});

test('the same question offers to keep the worktree, and that choice is sent', async () => {
	const harness = await mountControl({
		cwd: WORKTREE_PATH,
		routes: {
			[statusRoute(WORKTREE_PATH)]: READY_STATUS,
			// `cleanup: null` is what the host answers when removal was not asked for.
			deliver: { ok: true, strategy: 'fast-forward', text: '已把 2 个提交快进到 main', cleanup: null }
		}
	});

	await harness.driver.click(primaryOf(harness.driver.tree));
	await harness.driver.click(itemsOf(harness.driver.tree)[1]);

	const deliver = harness.calls.find((entry) => entry.path === 'deliver');
	assert.deepEqual(deliver.body, { cleanup: false, cwd: WORKTREE_PATH },
		'keeping is stated to the host rather than left to a configuration flag');
	assert.match(textOf(harness.driver.tree), /已保留|was kept/);
});

test('the menu entry for deliver asks the same question as the button', async () => {
	const harness = await mountControl({
		cwd: WORKTREE_PATH,
		routes: {
			[statusRoute(WORKTREE_PATH)]: READY_STATUS,
			deliver: { ok: true, text: '已合并', cleanup: { removed: false, reason: 'git-error' } }
		}
	});

	const entries = await openMenu(harness);
	const entry = entries.find((node) => textOf(node).includes('合并到原分支'));
	assert.equal(entry.props.disabled, false, 'there is something to merge');
	await harness.driver.click(entry);
	assert.equal(harness.calls.some((recorded) => recorded.path === 'deliver'), false,
		'the entry asks instead of merging');
	assert.match(textOf(itemsOf(harness.driver.tree)[0]), /合并并删除|merge, then remove/);

	// A removal the host was ASKED for and git refused is not a choice to keep: the
	// directory is still on disk, and saying "kept" would misreport that.
	await harness.driver.click(itemsOf(harness.driver.tree)[0]);
	assert.match(textOf(harness.driver.tree), /未能删除|could not be removed/);
});

/* ------------------------------------- uncommitted work, said BEFORE the click -- */

/** A worktree holding ONLY uncommitted work: deliverable, with `ahead` 0. */
const DIRTY_ONLY_STATUS = {
	...insideWorktreeStatus(undefined),
	worktree: {
		...insideWorktreeStatus(undefined).worktree,
		ahead: 0, deliverable: true, state: 'uncommitted-only', reason: 'uncommitted-changes',
		dirty: true, modified: 1
	},
	commit: { ...insideWorktreeStatus(undefined).commit, enabled: true, reason: 'ok', reasonText: 'ready', changes: 1, unstaged: 1 },
	action: { kind: 'deliver', enabled: true, reason: 'ready' }
};

test('uncommitted work is disclosed before the merge, not discovered after it', async () => {
	const harness = await mountControl({
		cwd: WORKTREE_PATH,
		routes: { [statusRoute(WORKTREE_PATH)]: DIRTY_ONLY_STATUS }
	});

	// The button says the ACTION and the state together: a merge that will commit
	// first. "待提交" on its own read as a reason not to press an ENABLED button.
	const primary = primaryOf(harness.driver.tree);
	assert.equal(primary.props.disabled, false, 'uncommitted work is deliverable — the click checkpoints it');
	assert.match(textOf(primary), /合并 · 待提交/);
	assert.match(primary.props.title, /点合并会先自动提交一次|commits them first/);

	// The question counts the commit the merge is about to make, instead of asking
	// about "0 commit(s)" over a worktree that plainly holds work.
	await harness.driver.click(primary);
	assert.deepEqual(harness.calls.map((entry) => entry.path), [statusRoute(WORKTREE_PATH)], 'asking merges nothing');
	assert.match(questionOf(harness.driver.tree), /合并 1 个提交/, 'the checkpoint is counted');
	assert.match(questionOf(harness.driver.tree), /含 1 个先自动提交的 checkpoint/);
});

test('a build that forces ignored files in says so before the click', async () => {
	const harness = await mountControl({
		cwd: WORKTREE_PATH,
		routes: { [statusRoute(WORKTREE_PATH)]: { ...DIRTY_ONLY_STATUS, commitIgnoredArtifacts: true } }
	});

	// The paths most often hidden by `.gitignore` are the ones a user would least want
	// in history, so a build configured to include them names that up front.
	assert.match(primaryOf(harness.driver.tree).props.title, /\.gitignore/);
	await harness.driver.click(primaryOf(harness.driver.tree));
	assert.match(questionOf(harness.driver.tree), /会把 \.gitignore 的文件一起提交/);
});

/* ------------------------------------------------------- the commit button -- */

test('commit is its own button beside merge, and pressing it commits', async () => {
	const harness = await mountControl({
		cwd: WORKTREE_PATH,
		routes: {
			[statusRoute(WORKTREE_PATH)]: insideWorktreeStatus(undefined, { commitChanges: 3 }),
			commit: { ok: true, changes: 3, message: 'wip: dsh worktree checkpoint: a.js, b.js', head: 'bbb', text: '已提交' }
		}
	});

	// Both verbs are on the row at once: the user's two decisions do not share a
	// button, so committing never has to go through a merge and vice versa.
	const commit = commitOf(harness.driver.tree);
	assert.ok(commit !== undefined, 'the commit button is rendered');
	assert.equal(commit.props.disabled, false, 'there are three changes to commit');
	assert.match(textOf(commit), /提交 · 3/, 'the label carries how much there is to commit');
	assert.ok(primaryOf(harness.driver.tree) !== commit, 'the merge button is a separate element');

	await harness.driver.click(commit);
	const sent = harness.calls.find((entry) => entry.path === 'commit');
	assert.deepEqual(sent.body, { cwd: WORKTREE_PATH }, 'the commit names the directory it acts on');
	assert.equal(harness.calls.some((entry) => entry.path === 'deliver'), false, 'committing does not merge');
	assert.match(textOf(harness.driver.tree), /已提交 3 处改动/, 'the user is told what was committed');
});

test('with nothing to commit the button is disabled and its tooltip is the reason', async () => {
	const harness = await mountControl({
		cwd: WORKTREE_PATH,
		routes: { [statusRoute(WORKTREE_PATH)]: insideWorktreeStatus(undefined, { commitChanges: 0 }) }
	});

	const commit = commitOf(harness.driver.tree);
	assert.equal(commit.props.disabled, true, 'an empty tree is not a commit');
	assert.match(commit.props.title, /没有需要提交的改动|nothing to commit/);
	// Disabled, never hidden: the row keeps its shape, so the merge button beside it
	// does not move under the cursor when the tree becomes clean.
	assert.match(textOf(commit), /提交/);
});

test('the commit decision falls back to the drift the status payload already carries', async () => {
	// A client bundle hot-reloads into a running page while the host half only
	// changes on a restart, so between the two the button must still reach a verdict
	// from the worktree counts the payload has always reported.
	const legacy = insideWorktreeStatus(undefined);
	delete legacy.commit;
	const harness = await mountControl({
		cwd: WORKTREE_PATH,
		routes: { [statusRoute(WORKTREE_PATH)]: legacy }
	});

	assert.equal(commitOf(harness.driver.tree).props.disabled, true, 'no changes means nothing to commit');

	const dirty = insideWorktreeStatus(undefined);
	delete dirty.commit;
	dirty.worktree = { ...dirty.worktree, dirty: true, modified: 2 };
	const busy = await mountControl({
		cwd: WORKTREE_PATH,
		routes: { [statusRoute(WORKTREE_PATH)]: dirty }
	});
	assert.equal(commitOf(busy.driver.tree).props.disabled, false, 'the worktree counts are enough to offer a commit');
});

test('the menu offers the same two verbs as the row', async () => {
	const harness = await mountControl({
		cwd: WORKTREE_PATH,
		routes: { [statusRoute(WORKTREE_PATH)]: insideWorktreeStatus(undefined, { commitChanges: 1 }) }
	});

	const entries = await openMenu(harness);
	const labels = entries.map(textOf);
	assert.ok(labels.some((label) => label.includes('提交 / commit')), 'the menu can commit too');
	assert.ok(labels.some((label) => label.includes('合并到原分支')), 'and merge');
});

/* ---------------------------------------------------- when git state is read -- */

/** How many times the control has read this directory's git state. */
const statusReads = (harness) => harness.calls.filter((entry) => entry.path === statusRoute(WORKTREE_PATH)).length;

/**
 * The staleness this control shipped with.
 *
 * It read git state once, at mount, and after its OWN clicks. An agent's turn is
 * neither: the files it writes and the commits it makes changed the directory while
 * the row kept rendering the snapshot from when the session was opened — "提交 · 0"
 * over a dirty tree — until the user switched to another conversation and back,
 * which remounted the control and happened to re-read. The store's own clock for the
 * session (`api-session/status`) is the signal that fixes it.
 */
test('the agent\'s turn ending re-reads git state instead of leaving the row stale', async () => {
	const routes = { [statusRoute(WORKTREE_PATH)]: insideWorktreeStatus(undefined, { commitChanges: 0 }) };
	const harness = await mountControl({
		cwd: WORKTREE_PATH,
		session: { running: true, updatedAt: 10 },
		routes
	});
	assert.equal(statusReads(harness), 1, 'the mount is the first read');
	assert.equal(commitOf(harness.driver.tree).props.disabled, true, 'nothing was dirty when the session was opened');

	// The turn ends: the Host publishes `api-session/status`, the store moves, and
	// the worktree now holds what the agent did during that turn.
	harness.store.byId['session-me'].running = false;
	routes[statusRoute(WORKTREE_PATH)] = insideWorktreeStatus(undefined, { commitChanges: 2 });
	await harness.rerender();

	const commit = commitOf(harness.driver.tree);
	assert.equal(statusReads(harness), 2, 'the turn boundary is what re-reads the directory');
	assert.equal(commit.props.disabled, false, 'the re-read is what makes the button live');
	assert.match(textOf(commit), /提交 · 2/, 'and the count on it is the new one');
});

test('a recorded prompt is the other movement that re-reads', async () => {
	// `api-session/activity` advances when a durable user message lands: the prompt
	// is the moment a session moves without its turn having ended yet.
	const routes = { [statusRoute(WORKTREE_PATH)]: insideWorktreeStatus(undefined, { commitChanges: 0 }) };
	const harness = await mountControl({
		cwd: WORKTREE_PATH,
		session: { running: false, updatedAt: 10 },
		routes
	});

	harness.store.byId['session-me'].updatedAt = 20;
	routes[statusRoute(WORKTREE_PATH)] = insideWorktreeStatus(undefined, { commitChanges: 1 });
	await harness.rerender();

	assert.equal(statusReads(harness), 2);
	assert.match(textOf(commitOf(harness.driver.tree)), /提交 · 1/);
});

test('a re-render that carries no session movement does not re-read git state', async () => {
	// The row re-renders as often as the page does. Reading git state on each of
	// those renders would turn a store notification into a git status loop, so the
	// clock is a dependency rather than an unconditional effect.
	const harness = await mountControl({
		cwd: WORKTREE_PATH,
		session: { running: false, updatedAt: 7 },
		routes: { [statusRoute(WORKTREE_PATH)]: insideWorktreeStatus(undefined, { commitChanges: 1 }) }
	});

	await harness.rerender();
	await harness.rerender();
	assert.equal(statusReads(harness), 1, 'one directory, one read, until something says it moved');
});

/* ------------------------------------------------------- the sidebar merge -- */

/**
 * A projection source shaped like `ctx.workspaces.list` and `ctx.sessions.list`:
 * one stable object per change, subscribed to rather than polled.
 */
function projection(initial) {
	let snapshot = initial;
	return {
		getSnapshot: () => snapshot,
		subscribe: () => () => {},
		/** Publish a replacement the way a model does: a NEW snapshot object. */
		publish(next) {
			snapshot = next;
			return snapshot;
		}
	};
}

/** One Workspace row, as the Host projects it. */
function workspaceRow(workspaceId, path, sessionIds = []) {
	return {
		workspaceId,
		path,
		title: path.replace(/\\/g, '/').split('/').pop(),
		sessionIds,
		createdAt: '2026-10-09T00:00:00.000Z',
		updatedAt: '2026-10-09T00:00:00.000Z'
	};
}

/** The Workspace projection's snapshot shape. */
function workspaceProjection(items) {
	return { items, archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null };
}

/** The Session projection's snapshot shape, keyed the way the sidebar keys it. */
function sessionProjection(summaries) {
	const byId = {};
	for (const summary of summaries) byId[summary.id] = summary;
	return { ids: summaries.map((summary) => summary.id), byId, phase: 'ready', projectionsBySession: {} };
}

const sessionRow = (id, cwd, updatedAt = 1) => ({ id, cwd, updatedAt });

/**
 * A sandbox-created value as this realm's own.
 *
 * The bundle runs in its own V8 context, so an array it builds carries that
 * context's prototypes and `deepStrictEqual` — correctly — refuses to call it
 * equal to one built here. Comparing the VALUES is the point; the realm they were
 * built in is not.
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Apply the bundle against the services a page provides, and hand them back. */
function applyPlugin(services, windowExtra = {}) {
	const definition = loadDefinition({}, windowExtra);
	const plugin = definition.factory(() => ({ createElement: () => null, Fragment: 'Fragment' }));
	plugin.apply({
		uiWorkspace: services.uiWorkspace ?? null,
		workspaces: services.workspaces ?? null,
		sessions: services.sessions ?? null,
		get: (name) => services[name] ?? undefined,
		slots: { inject: (_key, callback) => callback(), register: () => () => {} }
	});
	return services;
}

/** The repository plus one worktree, as the Host reports both. */
function repoAndWorktree() {
	const workspaces = projection(workspaceProjection([
		workspaceRow('ws-repo', REPO_PATH, ['session-repo']),
		workspaceRow('ws-wt', WORKTREE_PATH, ['session-wt'])
	]));
	const sessions = projection(sessionProjection([
		sessionRow('session-repo', REPO_PATH, 1),
		sessionRow('session-wt', WORKTREE_PATH, 2)
	]));
	return { workspaces, sessions };
}

test('a worktree Workspace is folded into the repository group, and its own group is gone', () => {
	// The membership rule is the Host's and cannot be argued with: a Session is
	// accounted by the Workspace whose PATH equals its `cwd`, so a Session running
	// in a worktree can only ever belong to the worktree's own Workspace — and the
	// tree then nests that Workspace under the repository. The one seam left to a
	// plugin is the projection every Workspace surface renders from.
	const { workspaces, sessions } = repoAndWorktree();
	applyPlugin({ workspaces: { list: workspaces }, sessions: { list: sessions } });

	const merged = workspaces.getSnapshot();
	assert.equal(merged.items.length, 1, 'the worktree is not a second Workspace in the sidebar');
	assert.equal(merged.items[0].workspaceId, 'ws-repo');
	assert.deepEqual(plain(merged.items[0].sessionIds), ['session-wt', 'session-repo'],
		"the worktree's session sits in the repository group, where the child group used to be");
	// Everything else about the row stays the Host's: only membership was rewritten.
	assert.equal(merged.items[0].path, REPO_PATH);
	assert.equal(merged.items[0].title, 'repo');
	assert.equal(merged.phase, 'ready');
});

test('the merged projection is one stable object until a source changes', () => {
	// React reads this through `useSyncExternalStore`: an object rebuilt on every
	// read is a render loop, not a projection.
	const { workspaces, sessions } = repoAndWorktree();
	applyPlugin({ workspaces: { list: workspaces }, sessions: { list: sessions } });

	const first = workspaces.getSnapshot();
	assert.equal(workspaces.getSnapshot(), first, 'the same source snapshot maps to the same merged snapshot');

	// A Session appears in the worktree: the row moves groups without any Workspace
	// event, which is why the memo is keyed on BOTH projections.
	sessions.publish(sessionProjection([
		sessionRow('session-repo', REPO_PATH, 1),
		sessionRow('session-wt', WORKTREE_PATH, 2),
		sessionRow('session-wt-2', WORKTREE_PATH, 3)
	]));
	assert.notEqual(workspaces.getSnapshot(), first, 'Session movement alone produces a new merged snapshot');
	assert.deepEqual(plain(workspaces.getSnapshot().items[0].sessionIds), ['session-wt-2', 'session-wt', 'session-repo']);
});

test('the browser can switch the merge off, and then the projection is untouched', () => {
	const raw = workspaceProjection([
		workspaceRow('ws-repo', REPO_PATH, ['session-repo']),
		workspaceRow('ws-wt', WORKTREE_PATH, ['session-wt'])
	]);
	const workspaces = projection(raw);
	const sessions = projection(sessionProjection([sessionRow('session-wt', WORKTREE_PATH, 1)]));
	applyPlugin({ workspaces: { list: workspaces }, sessions: { list: sessions } }, { localStorage: { getItem: () => 'off' } });

	assert.equal(workspaces.getSnapshot(), raw, "the Host's own projection is passed through, identity and all");
});

test('without a Session projection the merge is not installed at all', () => {
	// `openWorkspace` — the older way this plugin started a worktree Session —
	// resolves its Workspace out of this very projection. A composition that cannot
	// answer where a Session runs must therefore be left alone, not half-merged.
	const raw = workspaceProjection([
		workspaceRow('ws-repo', REPO_PATH, ['session-repo']),
		workspaceRow('ws-wt', WORKTREE_PATH, ['session-wt'])
	]);
	const workspaces = projection(raw);
	applyPlugin({ workspaces: { list: workspaces } });

	assert.equal(workspaces.getSnapshot(), raw);
	assert.equal(Object.hasOwn(workspaces, '__dshLocalWorktreeMerge'), false, 'no wrapper was installed');
});

test('a worktree Session the Host left ungrouped is adopted by the repository group', () => {
	// Sessions started with a bare `cwd` — the `git_worktree` tool, `/worktree`,
	// the Host fallback — are attached to no Workspace at all, so the Host would
	// show them under Ungrouped while their directory plainly belongs to the repo.
	const workspaces = projection(workspaceProjection([workspaceRow('ws-repo', REPO_PATH, ['session-repo'])]));
	const sessions = projection(sessionProjection([
		sessionRow('session-repo', REPO_PATH, 1),
		sessionRow('session-host-wt', WORKTREE_PATH, 2)
	]));
	applyPlugin({ workspaces: { list: workspaces }, sessions: { list: sessions } });

	assert.deepEqual(plain(workspaces.getSnapshot().items[0].sessionIds), ['session-host-wt', 'session-repo']);
});

test('a Session elsewhere keeps whatever group the sidebar gives it', () => {
	// The container test is positional and name-based on purpose. A merge that
	// swallowed every directory below the repository would hide real Workspaces,
	// and DSH's own managed checkouts are another plugin's rows, not this one's.
	const lookalike = `${REPO_PATH}\\src\\.dsh-worktrees\\repo_x`;
	const elsewhere = [
		sessionRow('session-repo', REPO_PATH, 1),
		sessionRow('session-dsh', 'C:\\Users\\someone\\.dsh\\worktrees\\proj-abc\\fix', 2),
		sessionRow('session-plain', `${REPO_PATH}\\src`, 3),
		sessionRow('session-lookalike', lookalike, 4)
	];
	const workspaces = projection(workspaceProjection([workspaceRow('ws-repo', REPO_PATH, ['session-repo'])]));
	const sessions = projection(sessionProjection(elsewhere));
	applyPlugin({ workspaces: { list: workspaces }, sessions: { list: sessions } });

	assert.deepEqual(plain(workspaces.getSnapshot().items[0].sessionIds), ['session-repo'],
		'only a directory DIRECTLY under a container this plugin owns is a worktree of it');
});

test('a worktree of a worktree resolves to the outermost group, not to a vanishing one', () => {
	const inner = `${WORKTREE_PATH}\\.dsh-worktrees\\repo_nested`;
	const workspaces = projection(workspaceProjection([
		workspaceRow('ws-repo', REPO_PATH, []),
		workspaceRow('ws-wt', WORKTREE_PATH, []),
		workspaceRow('ws-inner', inner, ['session-inner'])
	]));
	const sessions = projection(sessionProjection([sessionRow('session-inner', inner, 1)]));
	applyPlugin({ workspaces: { list: workspaces }, sessions: { list: sessions } });

	const merged = workspaces.getSnapshot();
	assert.equal(merged.items.length, 1, 'both worktree rows are folded away');
	assert.equal(merged.items[0].workspaceId, 'ws-repo');
	assert.deepEqual(plain(merged.items[0].sessionIds), ['session-inner']);
});

test('joining a new worktree starts its Session through the Session Controller', async () => {
	// With the merge installed, `openWorkspace(worktreeId)` cannot be the call that
	// starts the Session: it resolves the Workspace out of the merged projection,
	// where the worktree is deliberately absent, so it would fail AFTER the
	// directory was created. The openWorkspace below throws for exactly that reason
	// — a regression here is a failed click, not a silent difference.
	const opened = [];
	const registered = [];
	const created = [];
	const workspaces = projection(workspaceProjection([workspaceRow('ws-repo', REPO_PATH, [])]));
	const sessions = projection(sessionProjection([sessionRow('session-repo', REPO_PATH, 1)]));
	const harness = await mountControl({
		services: {
			uiWorkspace: {
				openSession: (sessionId) => { opened.push(sessionId); },
				openWorkspace: async (workspaceId) => { throw new Error(`unknown workspace ${workspaceId}`); }
			},
			workspaces: {
				create: async (input) => {
					registered.push(input.path);
					return workspaceRow('ws-wt', input.path, []);
				},
				list: workspaces
			},
			sessions: {
				list: sessions,
				create: async (options) => {
					created.push(options);
					return 'session-new';
				}
			}
		}
	});

	const tree = await createThroughPicker(harness, {
		create: {
			ok: true,
			created: { path: WORKTREE_PATH, branch: 'dsh/wt/repo_abc123', base: 'main', reused: false },
			workspace: { path: WORKTREE_PATH, layout: 'inside', registered: true, workspaceId: 'ws-wt' },
			session: null,
			seat: 'client',
			text: 'created'
		}
	});

	assert.deepEqual(registered, [WORKTREE_PATH], 'the directory is still registered as a Workspace on the Host');
	// Rooted in the worktree AND attached to its Workspace: the Session is created
	// through that Workspace, which is what keeps its working directory the worktree.
	assert.deepEqual(plain(created), [{ workspaceId: 'ws-wt' }]);
	assert.deepEqual(opened, ['session-new'], 'the client creates it, so it is addressable at once and can be selected');
	assert.match(textOf(tree), /已进入该 worktree 的新会话/);
});

test('with the merge off, the shipped openWorkspace call is still the one used', async () => {
	const opened = [];
	const harness = await mountControl({
		window: { localStorage: { getItem: () => 'off' } },
		services: {
			uiWorkspace: {
				openSession: () => { throw new Error('openSession must not be the path while the merge is off'); },
				openWorkspace: async (workspaceId) => { opened.push(workspaceId); }
			},
			workspaces: {
				create: async (input) => workspaceRow('ws-wt', input.path, []),
				list: projection(workspaceProjection([workspaceRow('ws-repo', REPO_PATH, [])]))
			}
		}
	});

	const tree = await createThroughPicker(harness, {
		create: {
			ok: true,
			created: { path: WORKTREE_PATH, branch: 'dsh/wt/repo_abc123', base: 'main', reused: false },
			workspace: { path: WORKTREE_PATH, layout: 'inside', registered: true, workspaceId: 'ws-wt' },
			session: null,
			seat: 'client',
			text: 'created'
		}
	});

	assert.deepEqual(opened, ['ws-wt']);
	assert.match(textOf(tree), /已进入该 worktree 的新会话/);
});

test('a worktree whose group was merged away is still reached by where its session runs', async () => {
	// The jump entry used to answer by path in the Workspace projection. With the
	// merge installed that projection no longer holds the worktree's row at all, so
	// the lookup has to fall back to where the Session RUNS — otherwise "go to an
	// existing worktree" would claim there is no session on record while that very
	// session sits in the sidebar.
	const other = `${REPO_PATH}\\.dsh-worktrees\\repo_other`;
	const opened = [];
	const status = insideWorktreeStatus(undefined);
	status.myWorktrees = [{ path: other, branch: 'dsh/wt/repo_other', base: 'main', ahead: 2, dirty: false }];
	const harness = await mountControl({
		cwd: WORKTREE_PATH,
		routes: { [statusRoute(WORKTREE_PATH)]: status },
		services: {
			uiWorkspace: { openSession: (sessionId) => opened.push(sessionId) },
			// The projection as it looks AFTER the merge: the other worktree is not a
			// Workspace row here any more, so a lookup by path cannot find it.
			workspaces: { list: projection(workspaceProjection([workspaceRow('ws-repo', REPO_PATH, ['session-me'])])) },
			sessions: {
				list: projection(sessionProjection([
					sessionRow('session-elsewhere', REPO_PATH, 1),
					sessionRow('session-in-other-worktree', other, 5)
				]))
			}
		}
	});

	const entries = await openMenu(harness);
	const jump = entries.find((entry) => textOf(entry).includes('跳回已有 worktree'));
	assert.ok(jump !== undefined, 'the worktree this plugin made is still offered');
	await harness.driver.click(jump);

	assert.deepEqual(opened, ['session-in-other-worktree'], 'the session is found by its working directory');
	assert.match(textOf(harness.driver.tree), /已切换到该 worktree 的会话/);
});
