/**
 * The plugin's own surfaces: HTTP routes, the agent tool and `/worktree`.
 *
 * These run against REAL git in throwaway repositories and drive the routes the
 * way the button does — a synthetic request in, parsed JSON out — so the whole
 * chain is covered without a Cordis composition and without a browser. The
 * assertions are about what a user receives: the state a control renders, a
 * stable reason code on refusal, and the guarantee that matters most, that no
 * remote is ever created and no network is ever used.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { createApi, normalizeConfig, ROUTES, safeDirectory, screenRequest } from '../src/index.js';
import { commit, git, gitSoft, makeRepo, removeAll, writeFile } from './fixture.mjs';

const cleanups = [];

after(async () => {
	for (const path of cleanups) await rm(path, { recursive: true, force: true });
	await removeAll();
});

/** A temp directory that is not a repository, cleaned up by this file. */
async function looseDir(prefix = 'loose-') {
	const base = join(tmpdir(), `dsh-local-worktree-impl-${process.pid}`);
	// The base must exist before `mkdtemp` can make a sibling inside it.
	await mkdir(base, { recursive: true });
	const path = await mkdtemp(join(base, prefix));
	cleanups.push(path);
	return path;
}

/**
 * A fake Cordis context carrying exactly what `install` reaches for.
 *
 * `inject` resolves synchronously by calling back with this same context: the
 * plugin's nested injects exist so an absent service is survivable, and a test
 * that wants to exercise the optional surfaces has to provide them here.
 */
function fakeContext({ withTool = true, withCommand = true, withSession = true, workspaces = [] } = {}) {
	const routes = new Map();
	const tools = [];
	const commands = [];
	const sessions = [];
	const warnings = [];
	// Every directory this plugin asked the workspace registry to register. The
	// sidebar only groups a Session under a Workspace whose path IS its directory,
	// so this list is what "the worktree appears in the sidebar" reduces to.
	const registeredWorkspaces = [];
	const entries = workspaces.map((entry) => ({
		id: `ws-${entry.path}`,
		path: entry.path,
		title: entry.title ?? entry.path,
		createdAt: '',
		updatedAt: '',
		sessionIds: []
	}));
	const normalize = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

	const ctx = {
		logger: {
			info: () => {},
			warn: (message) => warnings.push(String(message))
		},
		webServer: {
			register: (route) => {
				if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
				routes.set(route.path, route);
				return () => routes.delete(route.path);
			}
		},
		effect: (callback) => { callback(); },
		inject: (_services, callback) => { callback(ctx); },
		get: (name) => {
			if (name === 'tools') return withTool ? { register: (definition) => { tools.push(definition); return () => {}; } } : undefined;
			if (name === 'commands') return withCommand ? { register: (definition) => { commands.push(definition); return () => {}; } } : undefined;
			if (name === 'workspaceRegistry') {
				return {
					list: () => entries.slice(),
					// The real registry resolves by CANONICAL path and returns undefined when
					// the directory has no record yet; the plugin calls both this way.
					resolveByPath: async (path) => entries.find((entry) => normalize(entry.path) === normalize(path)),
					create: async (path) => {
						registeredWorkspaces.push(path);
						const entity = {
							id: `ws-${path}`,
							path,
							title: basename(path),
							createdAt: '',
							updatedAt: '',
							sessionIds: []
						};
						entries.push(entity);
						return entity;
					}
				};
			}
			if (name === 'sessionController') {
				return withSession
					? {
						create: async (request) => { sessions.push(request); return { sessionId: `session-test-${sessions.length}` }; },
						rename: async () => ({ title: 'x', seq: 1 })
					}
					: undefined;
			}
			return undefined;
		},
		reflect: undefined
	};
	return { ctx, routes, tools, commands, sessions, warnings, registeredWorkspaces };
}

/** One route call, as the button makes it. */
async function call(harness, path, { method = 'GET', query = {}, body = undefined } = {}) {
	const route = harness.routes.get(path);
	assert.ok(route !== undefined, `route ${path} is registered`);
	const search = new URLSearchParams(query).toString();
	const req = {
		method,
		url: search === '' ? path : `${path}?${search}`,
		async *[Symbol.asyncIterator]() {
			if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8');
		}
	};
	let status = 0;
	let headers = {};
	let text = '';
	const res = {
		writeHead: (code, values) => { status = code; headers = values ?? {}; },
		end: (chunk) => { if (typeof chunk === 'string') text += chunk; }
	};
	await route.handler(req, res);
	return { status, headers, body: text === '' ? null : JSON.parse(text) };
}

/** A plugin mounted on a fake context, with the registry kept inside a temp dir. */
async function mount(options = {}, config = {}) {
	const harness = fakeContext(options);
	const { install } = await import('../src/index.js');
	const api = install(harness.ctx, {
		registryPath: join(await looseDir('registry-'), 'worktrees.json'),
		...config
	});
	return { ...harness, api };
}

/* ------------------------------------------------------------------- pure -- */

test('normalizeConfig fills defaults and rejects nonsense', () => {
	const defaults = normalizeConfig(undefined);
	assert.equal(defaults.enabled, true);
	assert.equal(defaults.autoCommit, true);
	assert.equal(defaults.autoCleanup, true);
	assert.equal(defaults.registerTool, true);
	assert.equal(defaults.gitTimeoutMs, 60_000);
	assert.equal(defaults.commitMessage, 'wip: dsh worktree checkpoint');

	const given = normalizeConfig({ enabled: false, gitTimeoutMs: -5, commitMessage: '   ', autoCommit: 'yes' });
	assert.equal(given.enabled, false);
	assert.equal(given.gitTimeoutMs, 60_000, 'a non-positive timeout falls back rather than disabling git');
	assert.equal(given.commitMessage, 'wip: dsh worktree checkpoint', 'blank text falls back');
	assert.equal(given.autoCommit, true, 'a non-boolean falls back');
});

test('safeDirectory accepts absolute paths and rejects the unusable', () => {
	assert.equal(safeDirectory(''), null);
	assert.equal(safeDirectory(null), null);
	assert.equal(safeDirectory('   '), null);
	assert.equal(safeDirectory('C:\\a\0b'), null, 'a NUL byte is never a directory');
	assert.ok(safeDirectory('C:\\Workspace').length > 0);
});

test('screenRequest allows only the documented method', () => {
	assert.equal(screenRequest({ method: 'GET' }, { method: 'GET' }), undefined);
	const refused = screenRequest({ method: 'DELETE' }, { method: 'GET' });
	assert.equal(refused.status, 405);
	assert.equal(refused.body.reason, 'method-not-allowed');
});

/* ------------------------------------------------------------------ routes -- */

test('every documented route is registered exactly once', async () => {
	const harness = await mount();
	for (const path of Object.values(ROUTES)) {
		assert.ok(harness.routes.has(path), `${path} is registered`);
		assert.equal(harness.routes.get(path).kind, 'exact', 'an exact route never reaches the SPA fallback');
	}
});

test('GET health reports the configuration without a repository', async () => {
	const harness = await mount({}, { autoCommit: false });
	const answer = await call(harness, ROUTES.health);
	assert.equal(answer.status, 200);
	assert.equal(answer.body.ok, true);
	assert.equal(answer.body.plugin, 'dsh-local-worktree');
	assert.equal(answer.body.config.autoCommit, false);
	assert.equal(answer.headers['cache-control'], 'no-store');
});

test('GET status outside a repository says so, with a reason the UI can print', async () => {
	const harness = await mount();
	const dir = await looseDir('bare-');
	const answer = await call(harness, ROUTES.status, { query: { cwd: dir } });
	assert.equal(answer.status, 200);
	assert.equal(answer.body.ok, true);
	assert.equal(answer.body.repo.present, false);
	assert.equal(answer.body.repo.reason, 'not-a-repository');
	assert.equal(answer.body.action.kind, 'none');
	assert.equal(answer.body.action.enabled, false);
	// The menu's create entry follows the repository, not the primary verb: outside a
	// repository there is nothing to cut a worktree from either.
	assert.equal(answer.body.create.enabled, false);
	assert.equal(answer.body.create.reason, 'not-a-repository');
	assert.match(answer.body.repo.reasonText, /not a git repository|\u4e0d\u662f git/);
});

test('GET status in a fresh repository offers CREATE and names the worktree container', async () => {
	const root = await makeRepo({ name: 'impl-status' });
	const harness = await mount();
	const answer = await call(harness, ROUTES.status, { query: { cwd: root } });
	assert.equal(answer.body.repo.present, true);
	assert.equal(answer.body.repo.usable, true);
	assert.equal(answer.body.action.kind, 'create');
	assert.equal(answer.body.action.enabled, true);
	assert.equal(answer.body.repo.branch, 'main');
	// The CONTAINER is the stable part: each worktree inside it carries a fresh id
	// of its own, so promising one exact path would be wrong by the second click.
	// The default layout is `inside`, which is what lets the sidebar nest the
	// worktree inside the repository's own group.
	assert.equal(answer.body.worktreeContainer, join(root, '.dsh-worktrees'), 'the UI is told where worktrees land');
	assert.deepEqual(answer.body.myWorktrees, [], 'this plugin has made none yet');
	assert.equal(answer.body.worktree, null);
});

test('GET status rejects a missing cwd instead of guessing one', async () => {
	const harness = await mount();
	const answer = await call(harness, ROUTES.status);
	assert.equal(answer.body.ok, false);
	assert.equal(answer.body.reason, 'invalid-path');
});

test('GET workspaces separates git repositories from everything else', async () => {
	const repo = await makeRepo({ name: 'impl-known-repo' });
	const plain = await looseDir('impl-known-plain-');
	const harness = await mount({ workspaces: [
		{ path: plain, title: 'notes' },
		{ path: repo, title: 'the repo' }
	] });

	const answer = await call(harness, ROUTES.workspaces);
	assert.equal(answer.body.ok, true);
	assert.equal(answer.body.items.length, 2);
	// Repositories come first: they are the ones this control can act on.
	assert.equal(answer.body.items[0].git, true);
	assert.equal(answer.body.items[0].title, 'the repo');
	assert.equal(answer.body.items[0].repoRoot, repo);
	assert.equal(answer.body.items[1].git, false);
	assert.equal(answer.body.items[1].repoRoot, null);
});

test('GET workspaces reports a missing workspace registry instead of failing', async () => {
	const harness = fakeContext();
	harness.ctx.get = () => undefined;
	const { install } = await import('../src/index.js');
	install(harness.ctx, { registryPath: join(await looseDir('registry3-'), 'w.json') });
	const answer = await call(harness, ROUTES.workspaces);
	assert.equal(answer.body.ok, false);
	assert.equal(answer.body.reason, 'workspace-api-unavailable');
});

test('a workspace that IS a worktree still counts as a git repository', async () => {
	const repo = await makeRepo({ name: 'impl-known-wt' });
	const creator = await mount({ workspaces: [] });
	// Built straight through the engine, so this test does not depend on the route
	// shape it is not testing.
	const worktree = await creator.api.workspace.create(repo, { id: 'probe-0001' });

	// The worktree holds a `.git` FILE, not a directory; the probe must accept both.
	const harness = await mount({ workspaces: [{ path: worktree.path, title: 'worktree' }] });
	const answer = await call(harness, ROUTES.workspaces);
	assert.equal(answer.body.items[0].git, true, 'a linked worktree must count as a repository');
});

test('a repository is found from a workspace in a SUBDIRECTORY of it', async () => {
	const repo = await makeRepo({ name: 'impl-known-sub' });
	const { mkdir } = await import('node:fs/promises');
	const deep = join(repo, 'packages', 'app');
	await mkdir(deep, { recursive: true });
	const harness = await mount({ workspaces: [{ path: deep, title: 'app' }] });
	const answer = await call(harness, ROUTES.workspaces);
	assert.equal(answer.body.items[0].git, true);
	assert.equal(answer.body.items[0].repoRoot, repo, 'the walking probe reports the repository root');
});

test('an existing worktree of this plugin never disables CREATE, and is offered beside it', async () => {
	const root = await makeRepo({ name: 'impl-existing' });
	const harness = await mount();

	const created = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root, sessionId: 'session-abc', session: 'host' } });
	assert.equal(created.body.ok, true);

	const status = await call(harness, ROUTES.status, { query: { cwd: root } });
	assert.equal(status.body.action.kind, 'create', 'creating another one is always available');
	assert.equal(status.body.action.enabled, true);
	// The existing one is reported ALONGSIDE, with the session that owns it, so the
	// menu can go there. It is not a substitute for creating.
	assert.equal(status.body.myWorktrees.length, 1);
	assert.equal(status.body.myWorktrees[0].path, created.body.created.path);
	assert.equal(status.body.myWorktrees[0].branch, created.body.created.branch);
	// The remembered session is the one the NEW worktree session created, not the
	// caller that pressed the button — otherwise "go to that worktree" would
	// navigate back to where the user already was.
	assert.equal(status.body.myWorktrees[0].sessionId, created.body.session.sessionId);
	assert.notEqual(status.body.myWorktrees[0].sessionId, 'session-abc');
});

test('a worktree this plugin did NOT create is invisible here and blocks nothing', async () => {
	const root = await makeRepo({ name: 'impl-foreign-wt' });
	const harness = await mount();

	// Exactly the shape of DSH's own managed checkout: a worktree under a path this
	// plugin never writes, on a branch it does not own, absent from its registry.
	const { mkdir } = await import('node:fs/promises');
	const foreign = join(root, '..', `${basename(root)}_foreign`);
	await mkdir(foreign, { recursive: true });
	await git(root, ['worktree', 'add', '-b', 'wt/foreign', foreign, 'HEAD']);

	const status = await call(harness, ROUTES.status, { query: { cwd: root } });
	assert.equal(status.body.action.kind, 'create', 'a foreign worktree must not disable the button');
	assert.equal(status.body.action.enabled, true);
	assert.deepEqual(status.body.myWorktrees, [], 'only this plugin\'s own worktrees are reported');

	// And creating still works with the foreign one on disk.
	const created = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root, sessionId: null } });
	assert.equal(created.body.ok, true);
	assert.notEqual(created.body.created.path, foreign);
});

test('a stale registry record does not block creation either', async () => {
	const root = await makeRepo({ name: 'impl-stale' });
	const harness = await mount();
	const created = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root, sessionId: null } });

	// The directory disappears while the registry still remembers it.
	const { rm } = await import('node:fs/promises');
	await rm(created.body.created.path, { recursive: true, force: true });
	await git(root, ['worktree', 'prune']);

	const status = await call(harness, ROUTES.status, { query: { cwd: root } });
	assert.deepEqual(status.body.myWorktrees, [], 'a record whose directory is gone is dropped');
	assert.equal(status.body.action.enabled, true);
});

test('delivering the worktree removes it from the offered list', async () => {
	const root = await makeRepo({ name: 'impl-delivered-away' });
	const harness = await mount();
	const created = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root, sessionId: 'session-abc' } });
	const worktreePath = created.body.created.path;

	await writeFile(join(worktreePath, 'f.txt'), 'x\n');
	await git(worktreePath, ['add', '-A']);
	await commit(worktreePath, 'work');
	const delivered = await call(harness, ROUTES.deliver, { method: 'POST', body: { cwd: worktreePath } });
	assert.equal(delivered.body.ok, true);

	const status = await call(harness, ROUTES.status, { query: { cwd: root } });
	assert.equal(status.body.action.kind, 'create');
	assert.deepEqual(status.body.myWorktrees, [], 'the delivered worktree is forgotten');
});

test('the whole journey through the routes: create, status, deliver', async () => {
	const root = await makeRepo({ name: 'impl-journey' });
	const harness = await mount();

	const created = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root, sessionId: 'session-abc', session: 'host' } });
	assert.equal(created.body.ok, true);
	assert.equal(created.body.created.base, 'main');
	assert.equal(created.body.created.reused, false);
	const worktreePath = created.body.created.path;

	// The session half is real: a session was asked for, rooted in the worktree.
	assert.equal(harness.sessions.length, 1);
	assert.equal(harness.sessions[0].cwd, worktreePath);
	assert.equal(created.body.session.ok, true);
	assert.equal(created.body.session.sessionId, 'session-test-1');

	// A second press is a SECOND worktree, each with its own session. Answering it
	// with the first worktree would read as "the button did nothing".
	const again = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root, sessionId: 'session-xyz', session: 'host' } });
	assert.equal(again.body.ok, true);
	assert.notEqual(again.body.created.path, worktreePath, 'two presses must be two directories');
	assert.notEqual(again.body.created.branch, created.body.created.branch, 'two worktrees must be two branches');
	assert.equal(harness.sessions.length, 2, 'each worktree gets its own session');
	assert.equal(harness.sessions[1].cwd, again.body.created.path);
	// The first worktree is untouched: its session still points at its own directory.
	assert.equal((await call(harness, ROUTES.status, { query: { cwd: worktreePath } })).body.worktree.branch, created.body.created.branch);

	// A session standing INSIDE the worktree now sees the deliver action.
	const inside = await call(harness, ROUTES.status, { query: { cwd: worktreePath } });
	assert.equal(inside.body.action.kind, 'deliver');
	assert.equal(inside.body.action.enabled, false, 'nothing to deliver yet');
	assert.equal(inside.body.action.reason, 'no-new-commits');
	assert.equal(inside.body.repo.root, root, 'the main working tree is still named as the repository');

	// Work happens in the worktree, exactly as an isolated session would do it.
	await writeFile(join(worktreePath, 'feature.txt'), 'delivered\n');
	await git(worktreePath, ['add', '-A']);
	await commit(worktreePath, 'a feature from the worktree');

	const ready = await call(harness, ROUTES.status, { query: { cwd: worktreePath } });
	assert.equal(ready.body.action.enabled, true);
	assert.equal(ready.body.worktree.ahead, 1);
	assert.equal(ready.body.merge.strategy, 'fast-forward');

	const delivered = await call(harness, ROUTES.deliver, { method: 'POST', body: { cwd: worktreePath } });
	assert.equal(delivered.body.ok, true);
	assert.equal(delivered.body.strategy, 'fast-forward');
	assert.equal(delivered.body.commits, 1);
	assert.equal(delivered.body.cleanup.removed, true, 'the default configuration cleans up after itself');

	// The main tree has the work, and the worktree it came from is gone — the
	// second worktree made earlier is still there, because only the delivered one
	// is cleaned up.
	const log = await git(root, ['log', '--format=%s', '-1']);
	assert.equal(log.stdout.trim(), 'a feature from the worktree');
	const list = await git(root, ['worktree', 'list']);
	assert.equal(list.stdout.trim().split(/\r?\n/).length, 2, 'main tree plus the second worktree');
	// `git worktree list` prints `/`-separated paths even on Windows, so the
	// comparison normalises separators instead of assuming the platform spelling.
	const listed = list.stdout.replace(/\\/g, '/');
	assert.ok(!listed.includes(worktreePath.replace(/\\/g, '/')), 'the delivered worktree was removed');
	assert.ok(listed.includes(again.body.created.path.replace(/\\/g, '/')), 'the untouched worktree was kept');
});

test('a session already inside a worktree is not offered another one', async () => {
	const root = await makeRepo({ name: 'impl-inside-gate' });
	const harness = await mount();
	const created = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root, sessionId: 'session-abc' } });
	const wt = created.body.created.path;

	// The MAIN tree still offers create. The gate is about the directory the session
	// is standing in, not about a worktree existing somewhere in the repository — a
	// worktree this plugin made is reported beside the button, never instead of it.
	const outside = await call(harness, ROUTES.status, { query: { cwd: root } });
	assert.equal(outside.body.action.kind, 'create');
	assert.equal(outside.body.create.enabled, true);
	assert.equal(outside.body.create.reason, 'ok');

	// Standing INSIDE it, the primary verb is deliver and the create entry is refused
	// with a reason the menu can print: what that session has to finish is the
	// worktree it is in.
	const inside = await call(harness, ROUTES.status, { query: { cwd: wt } });
	assert.equal(inside.body.action.kind, 'deliver');
	assert.equal(inside.body.create.enabled, false);
	assert.equal(inside.body.create.reason, 'already-in-worktree');
	assert.match(inside.body.create.reasonText, /worktree/);
	assert.match(inside.body.create.reasonText, /\u5df2\u7ecf\u5728/, 'the Chinese half reaches the UI too');

	// Advisory on purpose: the ROUTE stays open, because its other callers are not
	// this directory's session. The Hero picker cuts a worktree in a repository the
	// user chose — which may itself be a worktree this plugin registered — and the
	// tool and `/worktree create` are surfaces a caller drives deliberately.
	const again = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: wt, sessionId: null } });
	assert.equal(again.body.ok, true, 'the picker, the tool and the command keep working');
});

test('the whole journey never creates a remote and never needs the network', async () => {
	const root = await makeRepo({ name: 'impl-noremote' });
	const harness = await mount();
	const created = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root } });
	await writeFile(join(created.body.created.path, 'f.txt'), 'x\n');
	await git(created.body.created.path, ['add', '-A']);
	await commit(created.body.created.path, 'local only');
	const delivered = await call(harness, ROUTES.deliver, { method: 'POST', body: { cwd: created.body.created.path } });
	assert.equal(delivered.body.ok, true);

	// `git remote -v` on an empty remote list exits 0 with no output; either way
	// there must be nothing configured, and no remote-tracking ref.
	const remotes = await git(root, ['remote', '-v']);
	assert.equal(remotes.stdout.trim(), '', 'no remote was configured by this plugin');
	const configRemotes = await gitSoft(root, ['config', '--get-regexp', '^remote\\.']);
	assert.notEqual(configRemotes.exitCode, 0, 'the repository has no remote.* configuration at all');
	const refs = await git(root, ['for-each-ref', '--format=%(refname)', 'refs/remotes']);
	assert.equal(refs.stdout.trim(), '', 'no remote-tracking refs exist');
});

test('POST deliver refuses a dirty main tree with a printable reason', async () => {
	const root = await makeRepo({ name: 'impl-dirty' });
	const harness = await mount();
	const created = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root } });
	const wt = created.body.created.path;
	await writeFile(join(wt, 'f.txt'), 'x\n');
	await git(wt, ['add', '-A']);
	await commit(wt, 'feature');
	await writeFile(join(root, 'app.txt'), 'uncommitted\n');

	const answer = await call(harness, ROUTES.deliver, { method: 'POST', body: { cwd: wt } });
	assert.equal(answer.body.ok, false);
	assert.equal(answer.body.reason, 'main-dirty');
	assert.match(answer.body.reasonText, /\u672a\u63d0\u4ea4|uncommitted/);
	assert.equal(answer.body.kept, true);
});

test('POST deliver reports a conflict with the paths and a recovery hint', async () => {
	const root = await makeRepo({ name: 'impl-conflict' });
	const harness = await mount();
	const created = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root } });
	const wt = created.body.created.path;

	await writeFile(join(wt, 'app.txt'), 'worktree side\n');
	await git(wt, ['add', '-A']);
	await commit(wt, 'worktree edit');
	await writeFile(join(root, 'app.txt'), 'main side\n');
	await git(root, ['add', '-A']);
	await commit(root, 'main edit');

	const answer = await call(harness, ROUTES.deliver, { method: 'POST', body: { cwd: wt } });
	assert.equal(answer.body.ok, false);
	assert.equal(answer.body.reason, 'merge-conflict');
	assert.deepEqual(answer.body.conflictPaths, ['app.txt']);
	assert.match(answer.body.hint, /git merge/);
	assert.deepEqual(await git(root, ['status', '--porcelain']).then((r) => r.stdout.trim()), '', 'the main tree stayed clean');
});

test('POST create is refused for a repository with no commit, with a reason', async () => {
	const dir = await looseDir('impl-empty-');
	await git(dir, ['init', '-b', 'main', '--quiet']);
	const harness = await mount();
	const answer = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: dir } });
	assert.equal(answer.body.ok, false);
	assert.equal(answer.body.reason, 'no-commits-yet');
	assert.equal(harness.sessions.length, 0, 'no session is opened when the worktree was never created');
});

test('POST discard removes the worktree and keeps nothing behind', async () => {
	const root = await makeRepo({ name: 'impl-discard' });
	const harness = await mount();
	const created = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root } });
	const wt = created.body.created.path;
	await writeFile(join(wt, 'scratch.txt'), 'temporary\n');

	const answer = await call(harness, ROUTES.discard, { method: 'POST', body: { cwd: wt } });
	assert.equal(answer.body.ok, true);
	assert.equal(answer.body.removed, true);
	const list = await git(root, ['worktree', 'list']);
	assert.equal(list.stdout.trim().split(/\r?\n/).length, 1);
});

test('a wrong method is refused without running git', async () => {
	const harness = await mount();
	const route = harness.routes.get(ROUTES.create);
	let status = 0;
	let text = '';
	await route.handler(
		{ method: 'GET', url: ROUTES.create },
		{ writeHead: (code) => { status = code; }, end: (chunk) => { text += String(chunk ?? ''); } }
	);
	assert.equal(status, 405);
	assert.equal(JSON.parse(text).reason, 'method-not-allowed');
});

test('a disabled plugin answers every action with the disabled reason', async () => {
	const root = await makeRepo({ name: 'impl-disabled' });
	const harness = await mount({}, { enabled: false });
	const status = await call(harness, ROUTES.status, { query: { cwd: root } });
	assert.equal(status.body.enabled, false);
	assert.equal(status.body.action.enabled, false);
	assert.equal(status.body.create.enabled, false);
	assert.equal(status.body.create.reason, 'disabled');
	const created = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root } });
	assert.equal(created.body.ok, false);
	assert.equal(created.body.reason, 'disabled');
});

/* ------------------------------------------------------- tool and command -- */

test('the agent tool is registered and drives the same two verbs', async () => {
	const root = await makeRepo({ name: 'impl-tool' });
	const harness = await mount();
	assert.equal(harness.tools.length, 1);
	const tool = harness.tools[0];
	assert.equal(tool.name, 'git_worktree');

	const status = await tool.handler({ action: 'status', cwd: root }, {});
	const parsed = JSON.parse(status.content[0].text);
	assert.equal(parsed.action.kind, 'create');

	const created = await tool.handler({ action: 'create', cwd: root }, {});
	const createdBody = JSON.parse(created.content[0].text);
	assert.equal(createdBody.ok, true);

	await writeFile(join(createdBody.created.path, 'f.txt'), 'x\n');
	await git(createdBody.created.path, ['add', '-A']);
	await commit(createdBody.created.path, 'via tool');

	const delivered = await tool.handler({ action: 'deliver', cwd: createdBody.created.path }, {});
	const deliveredBody = JSON.parse(delivered.content[0].text);
	assert.equal(deliveredBody.ok, true);
	assert.equal(deliveredBody.strategy, 'fast-forward');

	// The main tree received it: the tool and the button share one implementation.
	const log = await git(root, ['log', '--format=%s', '-1']);
	assert.equal(log.stdout.trim(), 'via tool');
});

test('the tool is not registered when the configuration turns it off', async () => {
	const harness = await mount({}, { registerTool: false });
	assert.equal(harness.tools.length, 0);
});

test('/worktree reports state, creates and delivers', async () => {
	const root = await makeRepo({ name: 'impl-command' });
	const harness = await mount();
	assert.equal(harness.commands.length, 1);
	const command = harness.commands[0];
	assert.equal(command.name, 'worktree');

	const empty = await command.handler({ rawInput: '', cwd: root });
	assert.equal(empty.kind, 'success');

	const created = await command.handler({ rawInput: 'create', cwd: root });
	assert.equal(created.kind, 'success');
	assert.match(created.text, /worktree/);
	const status = await command.handler({ rawInput: 'status', cwd: root });
	assert.equal(status.kind, 'success');

	// Everything above is a report; the delivery path is what must change state.
	const createdAnswer = await harness.api.createAction({ cwd: root, open: false });
	const wt = createdAnswer.created.path;
	await writeFile(join(wt, 'f.txt'), 'x\n');
	await git(wt, ['add', '-A']);
	await commit(wt, 'via command');
	const delivered = await command.handler({ rawInput: 'deliver', cwd: wt });
	assert.equal(delivered.kind, 'success');
	const log = await git(root, ['log', '--format=%s', '-1']);
	assert.equal(log.stdout.trim(), 'via command');
});

test('/worktree refuses an unknown subcommand with its usage', async () => {
	const root = await makeRepo({ name: 'impl-usage' });
	const harness = await mount();
	const answer = await harness.commands[0].handler({ rawInput: 'frobnicate', cwd: root });
	assert.equal(answer.kind, 'error');
	assert.match(answer.text, /usage/i);
});

/* ----------------------------------------------------------- degradation -- */

test('a composition without a web server, tool or command still mounts', async () => {
	const harness = fakeContext({ withTool: false, withCommand: false });
	harness.ctx.webServer = undefined;
	const { install } = await import('../src/index.js');
	const api = install(harness.ctx, { registryPath: join(await looseDir('registry2-'), 'w.json') });
	assert.equal(api.config.enabled, true);
	assert.ok(harness.warnings.some((line) => line.includes('no web server')));
});

test('a failing session API does not fail the creation', async () => {
	const root = await makeRepo({ name: 'impl-nosession' });
	const harness = await mount({ withSession: false });
	const answer = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root, session: 'host' } });
	assert.equal(answer.body.ok, true, 'the worktree exists and is remembered');
	assert.equal(answer.body.session.ok, false);
	assert.equal(answer.body.session.reason, 'session-api-unavailable');
});

test('POST create hands the session to the client and registers the directory as a workspace', async () => {
	const root = await makeRepo({ name: 'impl-client-seat' });
	const harness = await mount();

	// The button's own request: no `session`, because the browser is the caller and
	// only the browser can register the row it groups by and show the new session.
	const created = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root, sessionId: 'session-caller' } });
	assert.equal(created.body.ok, true);
	assert.equal(created.body.seat, 'client');
	assert.equal(created.body.session, null, 'the browser starts the session; the host does not');
	assert.deepEqual(harness.sessions, [], 'no host-side session was created');

	// Registration on the host side is what gives the non-browser surfaces (the tool
	// and `/worktree create`) the same sidebar grouping.
	assert.deepEqual(harness.registeredWorkspaces, [created.body.created.path]);
	assert.equal(created.body.workspace.path, created.body.created.path);
	assert.equal(created.body.workspace.registered, true);
	assert.equal(created.body.workspace.layout, 'inside');

	// A second press is a second directory, registered in its own right.
	const again = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root } });
	assert.equal(harness.registeredWorkspaces.length, 2);
	assert.notEqual(again.body.created.path, created.body.created.path);
});

test('POST session starts the host-side session in the worktree and remembers its id', async () => {
	const root = await makeRepo({ name: 'impl-session-route' });
	const harness = await mount();
	const created = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root } });
	const worktreePath = created.body.created.path;

	// The browser's degradation path: it could not start the session itself.
	const opened = await call(harness, ROUTES.session, { method: 'POST', body: { cwd: worktreePath, sessionId: 'session-caller' } });
	assert.equal(opened.body.ok, true);
	assert.equal(opened.body.session.cwd, worktreePath);
	assert.equal(harness.sessions.length, 1);

	// The id is remembered, so "go back to that worktree" has something to open even
	// when the browser was the side that started it.
	const status = await call(harness, ROUTES.status, { query: { cwd: root } });
	assert.equal(status.body.myWorktrees[0].sessionId, opened.body.session.sessionId);
});

test('the inside layout nests the worktree under the repository and keeps git blind to it', async () => {
	const root = await makeRepo({ name: 'impl-inside' });
	const harness = await mount({}, { worktreeLayout: 'inside' });
	const created = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root } });
	const worktreePath = created.body.created.path;

	// Nesting IS the feature: the sidebar nests a Workspace under its nearest
	// registered ancestor directory, so only a path under the repository can appear
	// inside the repository's own group.
	assert.equal(worktreePath.startsWith(`${root}\\`) || worktreePath.startsWith(`${root}/`), true,
		'the worktree lives under the repository');
	assert.equal(basename(dirname(worktreePath)), '.dsh-worktrees');

	// …and it must stay invisible to the main tree's git, or the next `git add -A`
	// there would commit an entire parallel checkout.
	const status = await git(root, ['status', '--porcelain']);
	assert.equal(status.stdout.trim(), '', 'the container does not dirty the repository');
	const exclude = await readFile(join(root, '.git', 'info', 'exclude'), 'utf8');
	assert.match(exclude, /^\.dsh-worktrees\/$/m);

	// It is still a real worktree git knows about, on the main tree's HEAD.
	const listed = await git(root, ['worktree', 'list', '--porcelain']);
	assert.match(listed.stdout, /\.dsh-worktrees/);

	// Discarding it takes the container with it, so the repository is left as found.
	const discarded = await call(harness, ROUTES.discard, { method: 'POST', body: { cwd: worktreePath } });
	assert.equal(discarded.body.ok, true);
	assert.equal(existsSync(join(root, '.dsh-worktrees')), false, 'an emptied container is not left behind');
});

test('the sibling layout is unchanged, and is one configuration away', async () => {
	const root = await makeRepo({ name: 'impl-sibling' });
	const harness = await mount({}, { worktreeLayout: 'sibling' });
	const created = await call(harness, ROUTES.create, { method: 'POST', body: { cwd: root } });
	assert.equal(basename(dirname(created.body.created.path)), `${basename(root)}_worktrees`);
	assert.equal(created.body.workspace.layout, 'sibling');
	const excludePath = join(root, '.git', 'info', 'exclude');
	const siblingExclude = existsSync(excludePath) ? await readFile(excludePath, 'utf8') : '';
	assert.equal(siblingExclude.includes('.dsh-worktrees'), false, 'the sibling layout excludes nothing');
});

test('a broken request body is answered, not crashed', async () => {
	const harness = await mount();
	const route = harness.routes.get(ROUTES.create);
	let status = 0;
	let text = '';
	await route.handler(
		{
			method: 'POST',
			url: ROUTES.create,
			async *[Symbol.asyncIterator]() { yield Buffer.from('{not json', 'utf8'); }
		},
		{ writeHead: (code) => { status = code; }, end: (chunk) => { text += String(chunk ?? ''); } }
	);
	assert.equal(status, 200);
	assert.equal(JSON.parse(text).ok, false);
});
