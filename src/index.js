/**
 * dsh-local-worktree — isolate the work with git, then deliver it back locally.
 *
 * The plugin's whole job, in two verbs:
 *
 *   CREATE   cut a linked worktree beside the repository, on its own `dsh/wt/*`
 *            branch, and record which branch it came from. Nothing is copied and
 *            nothing is fetched: a linked worktree shares the repository's object
 *            database, so the commits made in it are already reachable from the
 *            main tree — no remote, no bundle, no GitHub.
 *   DELIVER  merge that branch back into the branch it was cut from, in the MAIN
 *            working tree, fast-forwarding when the base has not moved and
 *            creating a merge commit when it has. A conflict is DETECTED FIRST
 *            (with `merge-tree`, which touches nothing) and reported; if one ever
 *            lands anyway, the main tree is restored with `merge --abort`.
 *
 * Three surfaces, one implementation (`Workspace` in `workspace.js`):
 *
 *   HTTP   `/api/dsh-local-worktree/*` for the button in the Web UI;
 *   TOOL   `git_worktree` so the agent can drive the same two verbs;
 *   CMD    `/worktree` for a user who does not want to move the mouse.
 *
 * Every route and every tool call answers with the SAME error shape
 * (`{ok:false, reason, ...}`) where `reason` is a stable code from `git.js`, so
 * the UI never has to print raw git output and the agent never has to guess what
 * went wrong.
 *
 * @module dsh-local-worktree
 */

import { dirname, join, resolve } from 'node:path';
import { stat } from 'node:fs/promises';

import { createGitRunner } from './git-runner.js';
import { describeMerge, freshId, samePath, suggestCommitMessage, worktreeContainer } from './git.js';
import {
	defaultRegistryPath,
	findByPath,
	listWorktrees,
	loadRegistry,
	putWorktree,
	dropWorktree,
	saveRegistry
} from './registry.js';
import { bothText, deliveredText, reasonText } from './text.js';
import { GitFailure, Workspace } from './workspace.js';

export const name = 'dsh-local-worktree';

/**
 * Only `webServer` is required: the plugin is useless without somewhere for the
 * button to call. `commands` and `tools` are reached through NESTED injects
 * instead, because a composition without a command layer or without agent tools
 * must still mount this plugin rather than leave the entry pending forever.
 */
export const inject = ['webServer'];

/** Route prefix. Every path below is exact, so the SPA fallback never sees it. */
export const API_PREFIX = '/api/dsh-local-worktree';

export const ROUTES = Object.freeze({
	status: `${API_PREFIX}/status`,
	create: `${API_PREFIX}/create`,
	deliver: `${API_PREFIX}/deliver`,
	discard: `${API_PREFIX}/discard`,
	open: `${API_PREFIX}/open`,
	workspaces: `${API_PREFIX}/workspaces`,
	health: `${API_PREFIX}/health`
});

/** Config as a plain JSON schema, consumed by `normalizeConfig`. */
export const configSchema = {
	type: 'object',
	properties: {
		enabled: { type: 'boolean', description: 'Keep the surfaces but refuse every action with a reason when false.' },
		autoCommit: {
			type: 'boolean',
			description: 'Commit uncommitted worktree work (a checkpoint commit) before merging, instead of refusing.'
		},
		autoCleanup: {
			type: 'boolean',
			description: 'After a successful merge, remove the worktree and delete its own branch when it is fully merged.'
		},
		commitMessage: { type: 'string', description: 'Subject used for the automatic checkpoint commit.' },
		registerTool: { type: 'boolean', description: 'Expose the git_worktree tool to the agent.' },
		gitTimeoutMs: { type: 'number', description: 'Wall-clock budget for one git command.' },
		registryPath: { type: 'string', description: 'Override the remembered-worktree file location.' }
	},
	additionalProperties: false
};

/** Accepted config, filled from the defaults with every value type-checked. */
export function normalizeConfig(raw) {
	const input = raw !== null && typeof raw === 'object' ? raw : {};
	const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
	const positive = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);
	return {
		enabled: bool(input.enabled, true),
		autoCommit: bool(input.autoCommit, true),
		autoCleanup: bool(input.autoCleanup, true),
		commitMessage: typeof input.commitMessage === 'string' && input.commitMessage.trim() !== ''
			? input.commitMessage.trim()
			: 'wip: dsh worktree checkpoint',
		registerTool: bool(input.registerTool, true),
		gitTimeoutMs: positive(input.gitTimeoutMs, 60_000),
		registryPath: typeof input.registryPath === 'string' && input.registryPath !== '' ? input.registryPath : null
	};
}

/* ----------------------------------------------------------------- helpers -- */

/** Collect a request body, bounded, so a huge POST cannot exhaust the host. */
async function readBody(req, { maxBytes = 64 * 1024 } = {}) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > maxBytes) throw new Error('request body too large');
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString('utf8').trim();
	if (text === '') return {};
	const parsed = JSON.parse(text);
	return parsed !== null && typeof parsed === 'object' ? parsed : {};
}

/** One JSON answer, never cached. */
function sendJson(res, status, value) {
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store'
	});
	res.end(JSON.stringify(value));
}

/** Only the method a route documents is accepted; anything else is a 405. */
export function screenRequest(req, { method }) {
	if (req.method === method) return undefined;
	return { status: 405, body: { ok: false, reason: 'method-not-allowed', allow: method } };
}

/**
 * A safe `cwd` from a query string or body.
 *
 * The value is used as a directory to inspect and never interpolated into a
 * command line (`execFile` takes it as one argv element), so the only thing to
 * guard is that it is a plausible absolute path rather than something like a
 * URL or an empty string that would silently fall back to the host's own cwd.
 */
export function safeDirectory(value) {
	if (typeof value !== 'string' || value.trim() === '') return null;
	if (value.includes('\0')) return null;
	const resolved = resolve(value);
	return resolved === '' ? null : resolved;
}

/** The register the UI renders, computed from one inspected directory. */
export async function buildStatus(api, cwd) {
	const directory = safeDirectory(cwd);
	if (directory === null) return { ok: false, reason: 'invalid-path' };

	const state = await api.workspace.inspect(directory);
	const base = state.repoKey === null ? null : api.registryEntry(state.repoKey, state.worktree);
	// The session this worktree belongs to, remembered at creation time. It is what
	// lets the UI offer "go to that worktree's session" when the automatic jump was
	// not possible — a session that exists but is not on screen is otherwise just a
	// row the user has to hunt for.
	const worktreeSession = base !== null && typeof base.sessionId === 'string' && base.sessionId !== ''
		? base.sessionId
		: null;

	// THIS PLUGIN'S other live worktrees for this repository.
	//
	// Identified from the REGISTRY, never from `git worktree list` alone: a
	// repository's worktree list also holds worktrees this plugin did not create —
	// DSH's own managed checkouts live under `~/.dsh/worktrees/`, and a user may
	// have hand-made ones. Treating those as ours once disabled the create button
	// outright in a repository that had one, which is worse than any duplication it
	// was meant to prevent.
	//
	// Registered entries whose directory is gone are dropped, so a stale record
	// cannot block anything either.
	const mine = state.repoKey === null
		? []
		: (await api.registryWorktrees(state.repoKey))
			.filter((record) => typeof record?.path === 'string' && record.path !== '')
			.filter((record) => !samePath(record.path, state.worktree?.path ?? ''))
			.filter((record) => state.worktrees.some((entry) => samePath(entry.path, record.path)))
			.map((record) => ({
				path: record.path,
				branch: typeof record.branch === 'string' ? record.branch : null,
				sessionId: typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : null
			}));

	// The primary action. CREATING is always available in a usable repository: the
	// fresh id per worktree makes duplicates distinct objects rather than a
	// collision, so there is nothing to refuse. Existing worktrees are offered
	// beside it, not instead of it.
	const action = state.repo.present !== true
		? { kind: 'none', enabled: false, reason: state.repo.reason }
		: state.worktree !== null && state.worktree.present === true
			? {
				kind: 'deliver',
				enabled: state.worktree.deliverable === true && api.config.enabled,
				reason: state.worktree.deliverable === true ? 'ready' : state.worktree.reason,
				worktree: state.worktree
			}
			: {
				kind: 'create',
				enabled: state.repo.usable === true && api.config.enabled,
				reason: state.repo.usable === true ? 'ok' : state.repo.reason
			};

	const merge = state.worktree !== null && state.worktree.present === true
		? describeMerge({ baseAhead: state.worktree.baseAhead })
		: null;

	return {
		ok: true,
		version: 1,
		cwd: directory,
		enabled: api.config.enabled,
		repo: {
			present: state.repo.present === true,
			usable: state.repo.usable === true,
			reason: state.repo.reason,
			reasonText: bothText(state.repo.reason),
			root: state.repoRoot,
			localRoot: state.localRoot,
			branch: state.repo.branch,
			head: state.repo.head,
			dirty: state.repo.dirty === true,
			modified: state.repo.modified ?? 0,
			untracked: state.repo.untracked ?? 0
		},
		worktree: state.worktree === null ? null : { ...state.worktree, sessionId: worktreeSession },
		worktreeSession,
		// The plugin's OWN other worktrees for this repository, each reachable from
		// the menu. Everything else in `git worktree list` is deliberately not
		// reported: those are somebody else's and are none of this control's business.
		myWorktrees: mine,
		// The fixed part of where a new worktree will land. The full path now carries
		// a fresh id per worktree, so the UI shows the CONTAINER plus the fact that a
		// new directory is minted each time, rather than a path that would be wrong
		// the moment a second worktree exists.
		worktreeContainer: state.repoRoot === null ? null : worktreeContainer(state.repoRoot),
		base,
		merge,
		action
	};
}

/**
 * The plugin's own API, built once per activation.
 *
 * Kept separate from `apply` so a test can drive the whole thing — routes, tool
 * and command alike — against a real repository without a Cordis composition.
 */
export function createApi(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);
	const log = (...args) => {
		try {
			ctx.logger?.info?.(...args);
		} catch {
			/* logging is never worth a failed request */
		}
	};
	const warn = (...args) => {
		try {
			ctx.logger?.warn?.(...args);
		} catch {
			/* as above */
		}
	};

	const runner = createGitRunner({ timeoutMs: config.gitTimeoutMs });
	const workspace = new Workspace(runner, { onWarn: warn });
	const registryPath = config.registryPath ?? defaultRegistryPath(process.env.DSH_HOME);
	let registry = null;
	let registryReady = null;
	// Delivery and creation are serialized per repository: two clicks racing each
	// other must not interleave a merge with a merge.
	const locks = new Map();

	const state = {
		config,
		workspace,
		registryPath,
		lastError: null,
		calls: { status: 0, create: 0, deliver: 0, discard: 0, workspaces: 0 }
	};

	/** Load the registry once, lazily, and remember the failure rather than retrying. */
	const ensureRegistry = async () => {
		if (registry !== null) return registry;
		if (registryReady === null) {
			registryReady = loadRegistry(registryPath, { onWarn: warn }).then((loaded) => {
				registry = loaded;
				state.registryLoaded = true;
				state.registryCount = (loaded.repositories === null || typeof loaded.repositories !== 'object')
					? 0
					: Object.keys(loaded.repositories).length;
				return loaded;
			});
		}
		return registryReady;
	};

	const remember = async (repoKeyValue, record) => {
		const current = await ensureRegistry();
		registry = putWorktree(current, repoKeyValue, record);
		const written = await saveRegistry(registryPath, registry, { onWarn: warn });
		if (written.ok !== true) warn(`dsh-local-worktree: could not persist ${registryPath}`);
		return registry;
	};

	const forget = async (repoKeyValue, branch) => {
		const current = await ensureRegistry();
		registry = dropWorktree(current, repoKeyValue, branch);
		await saveRegistry(registryPath, registry, { onWarn: warn });
	};

	const withLock = async (key, operation) => {
		const previous = locks.get(key) ?? Promise.resolve();
		let release;
		const gate = new Promise((resolveGate) => { release = resolveGate; });
		locks.set(key, previous.then(() => gate));
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (locks.get(key) === undefined) locks.delete(key);
		}
	};

	/** The remembered record for one worktree path, if any. */
	const registryEntry = (repoKeyValue, worktree) => {
		if (worktree === null || worktree === undefined || registry === null) return null;
		return findByPath(registry, repoKeyValue, worktree.path) ?? null;
	};

	/** The plugin's OWN recorded worktrees for one repository, loaded on demand. */
	const registryWorktrees = async (repoKeyValue) => {
		if (typeof repoKeyValue !== 'string' || repoKeyValue === '') return [];
		const loaded = await ensureRegistry();
		return listWorktrees(loaded, repoKeyValue);
	};

	const api = {
		config,
		state,
		registryPath,
		workspace,
		ensureRegistry,
		remember,
		forget,
		withLock,
		registryEntry: (key, worktree) => registryEntry(key, worktree),
		registryWorktrees,
		statusOf: (cwd) => buildStatus(api, cwd)
	};

	/* ------------------------------------------------------------- actions -- */

	/**
	 * Create the worktree and open a session rooted in it.
	 *
	 * The session is what makes the isolation REAL: an agent session's working
	 * directory is fixed when the session is created (`SessionCreateRequest.cwd`),
	 * so the plugin cannot move the current conversation into the worktree — it
	 * starts the next one there. The new session is registered in the workspace
	 * registry, so it appears in the sidebar under the worktree directory.
	 */
	/**
	 * Create the worktree, and optionally start a session rooted in it.
	 *
	 * `open` defaults to FALSE and `requested` to true, which is the honest
	 * reading of "the user asked for a worktree": every caller of this action is
	 * a deliberate click or a `/worktree create`, never a speculative render. A
	 * caller that only wants the directory on disk (a test, a script) passes
	 * `requested: false`.
	 */
	const createAction = async ({ cwd, sessionId, open, requested = true } = {}) => {
		if (!config.enabled) return { ok: false, reason: 'disabled' };
		const directory = safeDirectory(cwd);
		if (directory === null) return { ok: false, reason: 'invalid-path' };
		const openSessionNow = typeof open === 'boolean' ? open : requested === true;

		const state0 = await workspace.inspect(directory);
		if (state0.repo.present !== true) return { ok: false, reason: state0.repo.reason };

		const key = state0.repoKey;
		return withLock(key, async () => {
			let created;
			try {
				// A fresh id per call: the directory and the branch both carry it, so a
				// second click is a SECOND worktree rather than a no-op.
				created = await workspace.create(state0.repoRoot, { id: freshId() });
			} catch (error) {
				if (error instanceof GitFailure) {
					state.lastError = error.toJSON();
					return { ...error.toJSON(), reasonText: bothText(error.reason) };
				}
				throw error;
			}

			// The session is started FIRST, so the record can name the session that
			// will actually be working in this worktree. Recording the CALLER's
			// session instead — the one that asked for the worktree — would make
			// "open that worktree's session" navigate back to where the user already
			// was, which is the bug this ordering exists to prevent.
			let opened = null;
			if (openSessionNow) opened = await openSession(ctx, created.path, state0.repoRoot, warn);

			const ownerSession = opened !== null && typeof opened.sessionId === 'string' && opened.sessionId !== ''
				? opened.sessionId
				: (typeof sessionId === 'string' && sessionId !== '' ? sessionId : null);

			const record = {
				path: created.path,
				branch: created.branch,
				base: created.base,
				startOid: created.startOid,
				// The session working in this worktree, when one exists.
				sessionId: ownerSession,
				// The session that asked for it, kept separately so a caller can still
				// tell where the request came from.
				requestedBySessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
				createdAt: new Date().toISOString(),
				localRoot: created.localRoot ?? state0.repoRoot
			};
			await remember(key, record);

			log(`dsh-local-worktree: created ${created.path} on ${created.branch}${opened?.sessionId ? ` (session ${opened.sessionId})` : ''}`);
			return {
				ok: true,
				created: {
					path: created.path,
					branch: created.branch,
					base: created.base,
					reused: created.reused === true
				},
				session: opened,
				text: `已创建 worktree：${created.path}（分支 ${created.branch}） / worktree created: ${created.path} (branch ${created.branch})`
			};
		});
	};

	/** Merge the worktree's commits into the branch it came from. */
	const deliverAction = async ({ cwd, message, cleanup } = {}) => {
		if (!config.enabled) return { ok: false, reason: 'disabled' };
		const directory = safeDirectory(cwd);
		if (directory === null) return { ok: false, reason: 'invalid-path' };

		const state0 = await workspace.inspect(directory);
		if (state0.repo.present !== true) return { ok: false, reason: state0.repo.reason };
		if (state0.worktree === null || state0.worktree.present !== true) {
			return { ok: false, reason: 'worktree-missing', reasonText: bothText('worktree-missing') };
		}

		const key = state0.repoKey;
		const record = await ensureRegistry().then((loaded) => findByPath(loaded, key, state0.worktree.path));
		const entry = { path: state0.worktree.path, branch: state0.worktree.branch, base: record?.base ?? state0.repo.branch };

		return withLock(key, async () => {
			let result;
			try {
				result = await workspace.deliver(state0.repoRoot, entry, {
					base: entry.base,
					message,
					autoCommit: config.autoCommit,
					cleanup: typeof cleanup === 'boolean' ? cleanup : config.autoCleanup
				});
			} catch (error) {
				if (error instanceof GitFailure) {
					state.lastError = error.toJSON();
					return { ...error.toJSON(), reasonText: bothText(error.reason) };
				}
				throw error;
			}

			if (result.ok !== true) {
				return {
					ok: false,
					reason: result.reason,
					reasonText: bothText(result.reason),
					detail: result.detail ?? '',
					conflictPaths: result.conflictPaths ?? [],
					detectedBy: result.detectedBy ?? null,
					kept: true,
					worktree: result.worktree ?? null,
					hint: result.reason === 'merge-conflict'
						? '在 worktree 里执行 git merge <base> 解决冲突后再点一次 / run `git merge <base>` inside the worktree, resolve, then deliver again'
						: null
				};
			}

			await forget(key, entry.branch);
			log(`dsh-local-worktree: delivered ${result.commits} commit(s) from ${entry.branch} into ${result.base} (${result.strategy})`);
			return {
				ok: true,
				strategy: result.strategy,
				strategyText: result.strategyText,
				base: result.base,
				branch: result.branch,
				commits: result.commits,
				mainHead: result.mainHead,
				preCommitted: result.preCommitted === true,
				cleanup: result.cleanup ?? null,
				text: deliveredText(result)
			};
		});
	};

	/** Throw the worktree away without merging (force, and only our own branch). */
	const discardAction = async ({ cwd } = {}) => {
		if (!config.enabled) return { ok: false, reason: 'disabled' };
		const directory = safeDirectory(cwd);
		if (directory === null) return { ok: false, reason: 'invalid-path' };

		const state0 = await workspace.inspect(directory);
		if (state0.repo.present !== true) return { ok: false, reason: state0.repo.reason };
		if (state0.worktree === null || state0.worktree.present !== true) return { ok: false, reason: 'worktree-missing' };

		const key = state0.repoKey;
		const entry = { path: state0.worktree.path, branch: state0.worktree.branch };
		return withLock(key, async () => {
			const result = await workspace.discard(state0.repoRoot, entry);
			await forget(key, entry.branch);
			return {
				ok: result.ok === true,
				removed: result.removed === true,
				branchDeleted: result.branchDeleted === true,
				reason: result.reason ?? null,
				text: result.ok === true ? '已丢弃 worktree / worktree discarded' : null
			};
		});
	};

	/**
	 * The known workspaces that are git repositories.
	 *
	 * This is what makes the control usable BEFORE a session has a working
	 * directory: the Hero offers no repository of its own, so the plugin lists the
	 * ones the user already works in and lets them pick. The git check is a plain
	 * filesystem probe (an ancestor holding `.git`) rather than a `git` spawn per
	 * workspace, because this route is called on every render of a menu.
	 *
	 * A non-git workspace is reported rather than hidden: a menu that silently
	 * omits the directory the user just picked is worse than one that says why.
	 */
	const workspacesAction = async () => {
		const registry = ctx.get?.('workspaceRegistry');
		if (registry === undefined || registry === null || typeof registry.list !== 'function') {
			return { ok: false, reason: 'workspace-api-unavailable' };
		}
		let entities = [];
		try {
			entities = registry.list() ?? [];
		} catch (error) {
			return { ok: false, reason: 'git-failed', detail: String(error?.message ?? error) };
		}

		const items = [];
		for (const entity of entities) {
			const path = typeof entity?.path === 'string' ? entity.path : null;
			if (path === null) continue;
			const root = await gitRootOf(path);
			items.push({
				path,
				title: typeof entity?.title === 'string' && entity.title !== '' ? entity.title : path,
				git: root !== null,
				repoRoot: root
			});
		}
		// Directories that ARE repositories come first: they are the ones this
		// control can act on.
		items.sort((left, right) => Number(right.git) - Number(left.git) || left.title.localeCompare(right.title));
		return { ok: true, version: 1, items };
	};

	/** Open a path in the OS file manager, through whatever the host offers. */
	const openAction = async ({ cwd } = {}) => {		const directory = safeDirectory(cwd);
		if (directory === null) return { ok: false, reason: 'invalid-path' };

		const controller = ctx.get?.('sessionController');
		if (controller === undefined || controller === null || typeof controller.openWorkspacePath !== 'function') {
			return { ok: false, reason: 'unsupported-platform' };
		}
		try {
			await controller.openWorkspacePath({ path: directory }, new AbortController().signal);
			return { ok: true };
		} catch (error) {
			return { ok: false, reason: 'git-failed', detail: String(error?.message ?? error) };
		}
	};

	api.createAction = createAction;
	api.deliverAction = deliverAction;
	api.discardAction = discardAction;
	api.openAction = openAction;
	api.workspacesAction = workspacesAction;

	return api;
}

/**
 * The git working tree that owns `path`, or null.
 *
 * A plain filesystem walk: a repository (or a linked worktree) has a `.git`
 * entry — a directory in the first case, a `gitdir:` FILE in the second. The
 * probe must accept both, or a directory that IS a worktree would be reported as
 * not a repository and the control would refuse to act on it.
 */
async function gitRootOf(path) {
	let current = resolve(String(path));
	for (;;) {
		try {
			await stat(join(current, '.git'));
			return current;
		} catch {
			/* keep walking up */
		}
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Start a session rooted in the worktree.
 *
 * Failure here is NOT a failed creation: the worktree exists and is remembered,
 * and the user can open a session on it by hand. That is why the caller reports
 * the worktree as created and carries the session failure alongside it.
 */
async function openSession(ctx, worktreeDir, repoRoot, warn) {
	const controller = ctx.get?.('sessionController');
	if (controller === undefined || controller === null || typeof controller.create !== 'function') {
		return { ok: false, reason: 'session-api-unavailable' };
	}
	try {
		const created = await controller.create({ cwd: worktreeDir });
		const sessionId = created?.sessionId ?? null;
		// Make the new session easy to find in the sidebar.
		const renamed = typeof controller.rename === 'function' && sessionId !== null
			? controller.rename({ sessionId, title: `worktree: ${worktreeDir.split(/[\\/]/).pop()}` }).catch(() => null)
			: Promise.resolve(null);
		await renamed;
		return { ok: true, sessionId, cwd: worktreeDir, repoRoot };
	} catch (error) {
		warn(`dsh-local-worktree: the worktree was created but its session was not: ${error?.message ?? error}`);
		return { ok: false, reason: 'session-create-failed', detail: String(error?.message ?? error), cwd: worktreeDir };
	}
}

/* -------------------------------------------------------------- surfaces -- */

/** Register the HTTP routes. Exact paths, so the SPA fallback never sees them. */
function attachRoutes(ctx, api) {
	const webServer = ctx.webServer;
	if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
		ctx.logger?.warn?.('dsh-local-worktree: this composition has no web server; the button has nowhere to call');
		return;
	}

	const route = (path, method, handle, label) => {
		const register = () => webServer.register({
			kind: 'exact',
			path,
			handler: async (req, res) => {
				const refused = screenRequest(req, { method });
				if (refused !== undefined) {
					sendJson(res, refused.status, refused.body);
					return;
				}
				try {
					const answer = await handle(req);
					// Always 200: the answer carries `ok`, and a refusal is a normal
					// outcome of asking ("that branch moved"), not a transport error the
					// client has to distinguish from a crash.
					sendJson(res, 200, answer);
				} catch (error) {
					// A failed action is this plugin's problem, never the harness's:
					// answer with the reason and keep the session usable.
					ctx.logger?.warn?.(`dsh-local-worktree: ${path} failed: ${error?.message ?? error}`);
					sendJson(res, 200, { ok: false, reason: 'git-failed', detail: String(error?.message ?? error) });
				}
			}
		});
		if (typeof ctx.effect === 'function') ctx.effect(register, label);
		else register();
	};

	route(ROUTES.status, 'GET', async (req) => {
		api.state.calls.status += 1;
		const url = new URL(req.url ?? '/', 'http://localhost');
		return api.statusOf(url.searchParams.get('cwd'));
	}, 'dsh-local-worktree: GET status');
	route(ROUTES.create, 'POST', async (req) => {
		api.state.calls.create += 1;
		const body = await readBody(req);
		// `open` defaults on: every caller of this route is a deliberate click, and
		// the whole point of the worktree is the session that goes with it. A
		// caller that only wants the directory passes `open: false` explicitly.
		return api.createAction({
			cwd: body.cwd,
			sessionId: body.sessionId ?? null,
			open: body.open === undefined ? true : body.open === true
		});
	}, 'dsh-local-worktree: POST create');

	route(ROUTES.deliver, 'POST', async (req) => {
		api.state.calls.deliver += 1;
		const body = await readBody(req);
		return api.deliverAction({ cwd: body.cwd, message: body.message, cleanup: body.cleanup });
	}, 'dsh-local-worktree: POST deliver');

	route(ROUTES.discard, 'POST', async (req) => {
		api.state.calls.discard += 1;
		const body = await readBody(req);
		return api.discardAction({ cwd: body.cwd });
	}, 'dsh-local-worktree: POST discard');

	route(ROUTES.open, 'POST', async (req) => {
		const body = await readBody(req);
		return api.openAction({ cwd: body.cwd });
	}, 'dsh-local-worktree: POST open');

	route(ROUTES.workspaces, 'GET', async () => {
		api.state.calls.workspaces = (api.state.calls.workspaces ?? 0) + 1;
		return api.workspacesAction();
	}, 'dsh-local-worktree: GET workspaces');

	route(ROUTES.health, 'GET', async () => ({
		ok: true,
		version: 1,
		plugin: name,
		enabled: api.config.enabled,
		registryPath: api.registryPath,
		registryLoaded: api.state.registryLoaded === true,
		calls: api.state.calls,
		lastError: api.state.lastError,
		config: {
			autoCommit: api.config.autoCommit,
			autoCleanup: api.config.autoCleanup,
			registerTool: api.config.registerTool,
			gitTimeoutMs: api.config.gitTimeoutMs
		}
	}));

	ctx.logger?.info?.(`dsh-local-worktree: serving ${ROUTES.status} .. ${ROUTES.health}`);
}

/**
 * Register the agent tool.
 *
 * The same two operations the button offers, with the same reasons on failure,
 * so an agent can isolate its own work instead of being told to.
 */
function attachTool(ctx, api) {
	const tools = ctx.get?.('tools');
	if (tools === undefined || tools === null || typeof tools.register !== 'function') return;

	const tool = {
		name: 'git_worktree',
		description: [
			'Create and deliver a git worktree, entirely locally (no remote, no network).',
			'"create" cuts a linked worktree beside the repository on its own dsh/wt/* branch and starts a session rooted there.',
			'"status" reports whether the current directory is inside such a worktree and how far it has drifted.',
			'"deliver" merges the worktree\'s commits back into the branch it was cut from, in the main working tree: it fast-forwards when that branch has not moved and creates a merge commit when it has.',
			'A conflict is detected before anything is written and reported with the paths involved; the main working tree is never left half-merged.'
		].join(' '),
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['status', 'create', 'deliver', 'discard'], description: 'Which operation to run.' },
				cwd: { type: 'string', description: 'Directory to act on; defaults to the session working directory.' },
				message: { type: 'string', description: 'Commit subject for the automatic checkpoint commit (deliver only).' },
				cleanup: { type: 'boolean', description: 'Remove the worktree after a successful delivery (deliver only).' }
			},
			required: ['action'],
			additionalProperties: false
		},
		handler: async (args, execution) => {
			const cwd = typeof args?.cwd === 'string' && args.cwd !== ''
				? args.cwd
				: (execution?.cwd ?? execution?.agent?.cwd ?? process.cwd());			const action = String(args?.action ?? 'status');
			const answer = action === 'create'
				? await api.createAction({ cwd, open: true })
				: action === 'deliver'
					? await api.deliverAction({ cwd, message: args?.message, cleanup: args?.cleanup })
					: action === 'discard'
						? await api.discardAction({ cwd })
						: await api.statusOf(cwd);
			return { content: [{ type: 'text', text: JSON.stringify(answer, null, 2) }] };
		}
	};

	const register = () => tools.register(tool);
	if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-local-worktree tool');
	else register();
}

/**
 * Register `/worktree`.
 *
 * Deliberately tiny: the command reports state and runs the two verbs, so a user
 * who prefers typing is not a second-class citizen and — more usefully — so the
 * feature can be exercised in a composition where the UI half never loaded.
 */
function attachCommand(ctx, api) {
	const commands = ctx.get?.('commands');
	if (commands === undefined || commands === null || typeof commands.register !== 'function') return;

	const COMMAND = {
		name: 'worktree',
		description: 'git worktree：创建隔离工作区并一键合并回原分支 / create an isolated git worktree and merge it back',
		usage: '用法 / usage: /worktree | /worktree create | /worktree deliver'
	};

	const handler = async (invocation) => {
		const raw = String(invocation?.rawInput ?? '').trim().toLowerCase();
		const cwd = invocation?.cwd ?? invocation?.agent?.cwd ?? process.cwd();
		if (raw === '' || raw === 'status') {
			const status = await api.statusOf(cwd);
			const action = status.action ?? { kind: 'none', reason: status.repo?.reason };
			return {
				kind: 'success',
				text: `${reasonText(action.reason, { lang: 'both' })}\n${JSON.stringify(status, null, 2)}`
			};
		}
		if (raw === 'create') {
			const answer = await api.createAction({ cwd, open: true });
			if (answer.ok !== true) return { kind: 'error', text: answer.reasonText ?? reasonText(answer.reason, { lang: 'both' }) };
			return { kind: 'success', text: answer.text + (answer.session?.sessionId ? `\n新会话 / new session: ${answer.session.sessionId}` : '') };
		}
		if (raw === 'deliver') {
			const answer = await api.deliverAction({ cwd });
			if (answer.ok !== true) {
				return { kind: 'error', text: `${answer.reasonText ?? reasonText(answer.reason, { lang: 'both' })}${answer.hint ? `\n${answer.hint}` : ''}` };
			}
			return { kind: 'success', text: answer.text };
		}
		return { kind: 'error', text: COMMAND.usage };
	};

	const register = () => commands.register({
		name: COMMAND.name,
		description: COMMAND.description,
		handler
	});
	if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-local-worktree command');
	else register();
}

/* --------------------------------------------------------------- lifecycle -- */

/** Service name other plugins (and the tool) can read the API through. */
export const SERVICE_NAME = 'gitWorktree';

/** `apply`'s entry point, kept exported so a test can mount it on a fake context. */
export function install(ctx, rawConfig) {
	const api = createApi(ctx, rawConfig);
	attachRoutes(ctx, api);

	/**
	 * The optional surfaces, reached through ONE nested inject.
	 *
	 * `tools` and `commands` are deliberately absent from the module-level
	 * `inject`: a composition without a command layer (an SDK or headless run)
	 * must still mount this plugin rather than leave the entry pending forever.
	 * Requesting both in one call means the callback receives a context that
	 * carries both, with no need to fake a scoped context for the second one.
	 */
	const attachOptional = (scoped) => {
		if (api.config.registerTool === true) attachTool(scoped, api);
		attachCommand(scoped, api);
	};
	if (typeof ctx.inject === 'function') ctx.inject(['tools', 'commands'], attachOptional);
	else attachOptional(ctx);

	// Discoverable rather than hidden: another plugin can ask what the button
	// would do without re-deriving the inspection.
	if (typeof ctx.reflect?.provide === 'function') {
		try {
			ctx.reflect.provide(SERVICE_NAME, {
				version: 1,
				status: (cwd) => api.statusOf(cwd),
				create: (options) => api.createAction(options),
				deliver: (options) => api.deliverAction(options),
				discard: (options) => api.discardAction(options),
				registryPath: api.registryPath,
				config: api.config
			});
		} catch {
			/* the service is a convenience; the routes do not depend on it */
		}
	}

	return api;
}

/** Cordis entry point. */
export function apply(ctx, config) {
	return install(ctx, config);
}

export { suggestCommitMessage };
