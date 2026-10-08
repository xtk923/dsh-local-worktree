/**
 * dsh-local-worktree — isolate the work with git, then deliver it back locally.
 *
 * The plugin's whole job, in three verbs:
 *
 *   CREATE   cut a linked worktree beside the repository, on its own `dsh/wt/*`
 *            branch, and record which branch it came from. Nothing is copied and
 *            nothing is fetched: a linked worktree shares the repository's object
 *            database, so the commits made in it are already reachable from the
 *            main tree — no remote, no bundle, no GitHub.
 *   COMMIT   commit whatever is uncommitted in the directory the session is in —
 *            the worktree when it stands in one, the repository root otherwise.
 *            The subject is generated from the changed file names unless the
 *            caller supplies one. This is the button that makes "commit" a
 *            decision the user takes, rather than a side effect of merging.
 *   DELIVER  merge that branch back into the branch it was cut from, in the MAIN
 *            working tree, fast-forwarding when the base has not moved and
 *            creating a merge commit when it has. A conflict is DETECTED FIRST
 *            (with `merge-tree`, which touches nothing) and reported; if one ever
 *            lands anyway, the main tree is restored with `merge --abort`.
 *            When the merge succeeds the worktree is REMOVED by default — its
 *            directory and its own `dsh/wt/*` branch — unless the caller says to
 *            keep it (`cleanup: false`); the button asks that question on every
 *            merge, with removal as the default answer.
 *
 * Three surfaces, one implementation (`Workspace` in `workspace.js`):
 *
 *   HTTP   `/api/dsh-local-worktree/*` for the button in the Web UI;
 *   TOOL   `git_worktree` so the agent can drive the same three verbs;
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
import { describeMerge, freshId, normalizeWorktreeLayout, samePath, suggestCommitMessage } from './git.js';
import {
	defaultRegistryPath,
	findByPath,
	listWorktrees,
	loadRegistry,
	patchWorktree,
	putWorktree,
	dropWorktree,
	saveRegistry
} from './registry.js';
import { bothText, committedText, deliveredText, reasonText } from './text.js';
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
	commit: `${API_PREFIX}/commit`,
	deliver: `${API_PREFIX}/deliver`,
	discard: `${API_PREFIX}/discard`,
	open: `${API_PREFIX}/open`,
	session: `${API_PREFIX}/session`,
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
		commitIgnoredArtifacts: {
			type: 'boolean',
			description:
				'Stage paths `.gitignore` excludes in the checkpoint commit, so an ignored build artifact survives the worktree being removed. Off by default: the same ignore rules that keep `node_modules/` out of a repository are what keep a `.env` out of it, and a commit cannot be taken back with another click.'
		},
		commitMessage: { type: 'string', description: 'Subject used for the automatic checkpoint commit.' },
		registerTool: { type: 'boolean', description: 'Expose the git_worktree tool to the agent.' },
		worktreeLayout: {
			type: 'string',
			enum: ['sibling', 'inside'],
			description:
				'Where a worktree lands: `inside` (default) is `<repo>/.dsh-worktrees/<name>`, so the Web sidebar can nest it under the repository\'s own group; `sibling` is the older `<parent>/<repo>_worktrees/<name>`.'
		},
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
		// OFF by default. `git add --all` already stages every tracked change and every
		// untracked file that is not ignored, which is exactly the set the plugin
		// reports as "dirty"; forcing the ignored paths in as well committed files the
		// user excluded on purpose (a `.env`, a `node_modules/`) into their branch.
		commitIgnoredArtifacts: bool(input.commitIgnoredArtifacts, false),
		commitMessage: typeof input.commitMessage === 'string' && input.commitMessage.trim() !== ''
			? input.commitMessage.trim()
			: 'wip: dsh worktree checkpoint',
		registerTool: bool(input.registerTool, true),
		// `inside` by default: it is the only layout whose worktree can appear
		// inside the repository's own sidebar group, and a worktree that is hard
		// to find is the problem this plugin exists to remove.
		worktreeLayout: input.worktreeLayout === undefined ? 'inside' : normalizeWorktreeLayout(input.worktreeLayout),
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

	// The primary action. In a usable repository the MAIN working tree offers
	// CREATE unconditionally: the fresh id per worktree makes duplicates distinct
	// objects rather than a collision, so there is nothing to refuse there. Existing
	// worktrees are offered beside it, not instead of it. A session standing inside
	// a worktree gets DELIVER instead — and `create` below, which is the entry that
	// goes quiet in that case.
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

	// May THIS directory mint another worktree, and if not, why not.
	//
	// Reported separately from `action`, because the two answer different
	// questions. `action` is the primary verb this directory offers, and inside a
	// worktree that is already `deliver`; this is the menu's own "create" entry,
	// which a session that is ALREADY ISOLATED must not be offered. A second
	// worktree cut from inside the first nests one isolation in another and leaves
	// the worktree that session exists for undelivered — the user's next move is to
	// deliver or discard the one they are in, not to make a third.
	//
	// Advisory, deliberately: `createAction` itself stays open, because its other
	// callers are not this directory's session. The Hero picker starts a worktree
	// in a repository the user CHOSE, which may itself be a worktree this plugin
	// registered, and `/worktree create` and the `git_worktree` tool are surfaces a
	// caller drives on purpose. Refusing there would break the picker without
	// protecting anything this rule is about.
	//
	// `state.worktree` is any linked worktree containing the session's directory,
	// not only one of ours, which is the same breadth the deliver branch above
	// already uses: whatever a session is standing in is what it has to finish.
	const insideWorktree = state.worktree !== null && state.worktree.present === true;
	const createReason = state.repo.present !== true || state.repo.usable !== true
		? state.repo.reason
		: !api.config.enabled
			? 'disabled'
			: insideWorktree
				? 'already-in-worktree'
				: 'ok';
	const create = {
		enabled: createReason === 'ok',
		reason: createReason,
		reasonText: bothText(createReason)
	};

	const merge = state.worktree !== null && state.worktree.present === true
		? describeMerge({ baseAhead: state.worktree.baseAhead })
		: null;

	// The COMMIT decision, beside the merge one.
	//
	// `inside` — the directory a commit lands in — is the worktree when the session
	// stands in one and the repository root otherwise. That mirrors where the
	// automatic checkpoint of a delivery writes, so the button and the merge can
	// never disagree about which directory they are about.
	//
	// It is reported for BOTH places rather than only inside a worktree because a
	// session working directly on a branch is the same problem with fewer steps:
	// changes that need committing before anything can be merged anywhere.
	const commitDirectory = insideWorktree ? state.worktree.path : state.repoRoot;
	const commitStatus = state.repo.present !== true
		? null
		: await api.workspace.status(commitDirectory);
	const commitChanges = commitStatus === null
		? 0
		: Number(commitStatus.staged ?? 0) + Number(commitStatus.unstaged ?? 0) + Number(commitStatus.untracked ?? 0);
	const commitReason = state.repo.present !== true || state.repo.usable !== true
		? state.repo.reason
		: !api.config.enabled
			? 'disabled'
			: (commitStatus?.conflicted ?? 0) > 0
				? 'worktree-conflicted'
				: commitChanges === 0
					? 'nothing-to-commit'
					: 'ok';
	const commit = {
		enabled: commitReason === 'ok',
		reason: commitReason,
		reasonText: bothText(commitReason),
		path: commitDirectory,
		changes: commitChanges,
		staged: Number(commitStatus?.staged ?? 0),
		unstaged: Number(commitStatus?.unstaged ?? 0),
		untracked: Number(commitStatus?.untracked ?? 0)
	};

	return {
		ok: true,
		version: 1,
		cwd: directory,
		enabled: api.config.enabled,
		// Stated by the Host because it changes what a click will put in the user's
		// history, and the client can only warn about what it is told.
		commitIgnoredArtifacts: api.config.commitIgnoredArtifacts === true,
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
		// the moment a second worktree exists. Taken from the inspection itself
		// rather than recomputed, so the layout cannot be applied in one place and
		// forgotten in the other.
		worktreeContainer: state.repoRoot === null ? null : state.container,
		base,
		merge,
		// The commit verb, decided by the Host for the same reason `create` is: it
		// is a statement about git state, not about markup.
		commit,
		// The primary verb, and the separate answer to "may this directory cut
		// another worktree". The menu renders both; only the second one goes quiet
		// once the session is already inside a worktree.
		action,
		create
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
	const workspace = new Workspace(runner, { onWarn: warn, layout: config.worktreeLayout });
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
		calls: { status: 0, create: 0, commit: 0, deliver: 0, discard: 0, session: 0, workspaces: 0 }
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

	/**
	 * Remember which session is working in an existing worktree.
	 *
	 * Needed because the browser may be the side that creates that session (it has
	 * to be: only there can the new Session be both registered and navigated to),
	 * and the host would otherwise never learn its id — which is what the control's
	 * "go back to that worktree" entry and the status payload read.
	 */
	const rememberSession = async (repoKeyValue, worktreePathValue, ownerSessionId) => {
		if (typeof ownerSessionId !== 'string' || ownerSessionId === '') return null;
		if (typeof worktreePathValue !== 'string' || worktreePathValue === '') return null;
		const current = await ensureRegistry();
		const entry = findByPath(current, repoKeyValue, worktreePathValue);
		if (entry === null) return null;
		registry = patchWorktree(current, repoKeyValue, entry.branch, { sessionId: ownerSessionId });
		await saveRegistry(registryPath, registry, { onWarn: warn });
		return entry.branch;
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
	 * `session` says WHO starts that session, and the distinction is the whole
	 * reason this plugin used to feel broken:
	 *
	 *   `'client'`  the BROWSER starts it. It is the only side that can register
	 *               the Workspace in its own projection and drive the sidebar and
	 *               the main area, and a session IT creates is addressable
	 *               synchronously — a session created here is unknown to the
	 *               client until a later list refresh, so the navigation that
	 *               follows it throws `sessions.retain: unknown session`.
	 *   `'host'`    this process starts it, for the tool and the command, where
	 *               no browser exists at all.
	 *   `'none'`    the directory only (a test, a script).
	 *
	 * `open` is the older spelling of the same decision, still honoured: every
	 * caller of this action is a deliberate click or an explicit `/worktree
	 * create`, never a speculative render.
	 */
	const createAction = async ({ cwd, sessionId, session, open, requested = true } = {}) => {
		if (!config.enabled) return { ok: false, reason: 'disabled' };
		const directory = safeDirectory(cwd);
		if (directory === null) return { ok: false, reason: 'invalid-path' };
		const seat = session === 'host' || session === 'client' || session === 'none'
			? session
			: (typeof open === 'boolean' ? (open ? 'host' : 'none') : (requested === true ? 'host' : 'none'));

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

			// Give the new directory a Workspace record before anything is asked to
			// display it: DSH's sidebar groups a Session by the registered Workspace
			// whose path IS the Session's directory, so without this the worktree's
			// session lands in "Ungrouped" and only appears after a restart rebuilds
			// the grouping from session history.
			const registered = await ensureWorkspace(ctx, created.path);

			// The session is started FIRST, so the record can name the session that
			// will actually be working in this worktree. Recording the CALLER's
			// session instead — the one that asked for the worktree — would make
			// "open that worktree's session" navigate back to where the user already
			// was, which is the bug this ordering exists to prevent.
			let opened = null;
			if (seat === 'host') opened = await openSession(ctx, created.path, state0.repoRoot, warn);

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

			log(`dsh-local-worktree: created ${created.path} on ${created.branch}${opened?.sessionId ? ` (session ${opened.sessionId})` : ` (session: ${seat})`}`);
			return {
				ok: true,
				created: {
					path: created.path,
					branch: created.branch,
					base: created.base,
					reused: created.reused === true
				},
				// What the caller needs to make the new worktree reachable: the path
				// for its own Workspace registration and navigation, and whether this
				// side already registered it.
				workspace: {
					path: created.path,
					layout: config.worktreeLayout,
					registered: registered.ok === true,
					workspaceId: registered.workspaceId ?? null
				},
				session: opened,
				seat,
				text: `已创建 worktree：${created.path}（分支 ${created.branch}） / worktree created: ${created.path} (branch ${created.branch})`
			};
		});
	};

	/**
	 * Start a session in an existing worktree (or repository) and remember it.
	 *
	 * This is the browser's fallback: when the client's own `workspaces` /
	 * `sessions` services are unavailable it cannot create the session itself, so
	 * it asks here — which is exactly the older behaviour, kept as the degradation
	 * path rather than as the main one.
	 */
	const openSessionAction = async ({ cwd, sessionId } = {}) => {
		if (!config.enabled) return { ok: false, reason: 'disabled' };
		const directory = safeDirectory(cwd);
		if (directory === null) return { ok: false, reason: 'invalid-path' };

		const state0 = await workspace.inspect(directory);
		if (state0.repo.present !== true) return { ok: false, reason: state0.repo.reason };
		const target = state0.worktree !== null && state0.worktree.present === true ? state0.worktree.path : state0.repoRoot;
		if (typeof target !== 'string' || target === '') return { ok: false, reason: 'worktree-missing' };

		const opened = await openSession(ctx, target, state0.repoRoot, warn);
		if (opened.ok !== true) return opened;
		if (state0.repoKey !== null) await rememberSession(state0.repoKey, target, opened.sessionId);

		const seat = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
		log(`dsh-local-worktree: session ${opened.sessionId} opened in ${target}${seat === null ? '' : ` (asked by ${seat})`}`);
		return {
			ok: true,
			session: opened,
			text: `已在 ${target} 打开新会话 / new session opened in ${target}`
		};
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
					commitIgnored: config.commitIgnoredArtifacts,
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

			// The record is a promise about a worktree that is still THERE. One the user
			// chose to keep — or one whose removal git refused — is still a directory
			// with a session in it, and may well be where the next commit is made, so
			// it keeps its base branch, its session id and its entry in the menu.
			// Forgetting it here would make "merge and keep" quietly forget the very
			// thing the user asked to keep.
			const removed = result.cleanup !== null && result.cleanup !== undefined && result.cleanup.removed === true;
			if (removed) await forget(key, entry.branch);
			log(`dsh-local-worktree: delivered ${result.commits} commit(s) from ${entry.branch} into ${result.base} (${result.strategy})${removed ? '' : ', worktree kept'}`);
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

	/**
	 * Commit what is uncommitted in this directory — the button's own verb.
	 *
	 * Deliberately NOT routed through `deliver`: the whole point of a button is
	 * that committing and merging are two decisions. A delivery that checkpoints
	 * the worktree (because `autoCommit` is on) is still the fallback for callers
	 * that cannot press anything, and this action changes nothing about it.
	 *
	 * There is no `withLock` here. The lock serializes create and deliver against
	 * each other, where two interleaved operations could leave a branch half
	 * merged; a commit is a single atomic git command over one index, and making
	 * the button wait behind a merge the user did not ask for would be worse.
	 */
	const commitAction = async ({ cwd, message } = {}) => {
		if (!config.enabled) return { ok: false, reason: 'disabled' };
		const directory = safeDirectory(cwd);
		if (directory === null) return { ok: false, reason: 'invalid-path' };

		const state0 = await workspace.inspect(directory);
		if (state0.repo.present !== true) return { ok: false, reason: state0.repo.reason };

		// The same directory the status payload named, recomputed from this read
		// rather than taken from the caller: the caller's `cwd` may be a
		// subdirectory, and only the inspection knows where the worktree begins.
		const target = state0.worktree !== null && state0.worktree.present === true ? state0.worktree.path : state0.repoRoot;
		if (typeof target !== 'string' || target === '') return { ok: false, reason: 'worktree-missing' };

		const result = await workspace.commit(target, { message, commitIgnored: config.commitIgnoredArtifacts });
		if (result.ok !== true) {
			return {
				ok: false,
				reason: result.reason,
				reasonText: bothText(result.reason),
				changes: result.changes ?? 0,
				quoted: result.quoted ?? ''
			};
		}

		log(`dsh-local-worktree: committed ${result.changes} change(s) in ${target} as ${result.head ?? '?'}`);
		return {
			ok: true,
			path: target,
			changes: result.changes,
			message: result.message,
			head: result.head ?? null,
			text: committedText(result)
		};
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
	api.commitAction = commitAction;
	api.deliverAction = deliverAction;
	api.discardAction = discardAction;
	api.openAction = openAction;
	api.openSessionAction = openSessionAction;
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
 * Register a directory as a DSH Workspace, on the host.
 *
 * Best-effort, and deliberately not the only path: the Web client does the same
 * thing through its own `workspaces` service immediately before it navigates,
 * which is the copy that must also update the CLIENT projection (a Workspace
 * registered here reaches the sidebar through the projection stream, a few
 * milliseconds later). This call is what gives the surfaces without a browser —
 * the `git_worktree` tool and `/worktree create` — the same grouping, so a
 * worktree never sits in the sidebar's "Ungrouped" bucket.
 *
 * `resolveByPath` first, because registration is idempotent by canonical path and
 * a second call for the same directory must not be an error.
 */
async function ensureWorkspace(ctx, path) {
	const registry = ctx.get?.('workspaceRegistry');
	if (registry === undefined || registry === null) return { ok: false, reason: 'workspace-api-unavailable' };
	try {
		const existing = typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(path) : undefined;
		if (existing !== undefined && existing !== null) {
			return { ok: true, created: false, workspaceId: existing.id ?? null };
		}
		const created = await registry.create(path);
		return { ok: true, created: true, workspaceId: created?.id ?? null };
	} catch (error) {
		// The worktree is on disk and remembered either way; only its sidebar
		// grouping is lost, which is not worth failing a click over.
		ctx.logger?.warn?.(`dsh-local-worktree: could not register ${path} as a workspace: ${error?.message ?? error}`);
		return { ok: false, reason: 'workspace-create-failed', detail: String(error?.message ?? error) };
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
		// `session` defaults to 'client': the browser is the caller, and only it can
		// register the Workspace in its own projection and navigate to the new
		// Session. A caller that wants this side to start the Session (a script, or
		// the browser's own fallback) passes 'host'.
		return api.createAction({
			cwd: body.cwd,
			sessionId: body.sessionId ?? null,
			session: body.session === undefined ? 'client' : body.session,
			open: body.open === undefined ? undefined : body.open === true
		});
	}, 'dsh-local-worktree: POST create');

	route(ROUTES.session, 'POST', async (req) => {
		api.state.calls.session = (api.state.calls.session ?? 0) + 1;
		const body = await readBody(req);
		// The browser's degradation path: it could not create the Session itself
		// (no `workspaces`/`sessions` client service), so it asks here.
		return api.openSessionAction({ cwd: body.cwd, sessionId: body.sessionId ?? null });
	}, 'dsh-local-worktree: POST session');

	route(ROUTES.commit, 'POST', async (req) => {
		api.state.calls.commit += 1;
		const body = await readBody(req);
		return api.commitAction({ cwd: body.cwd, message: body.message });
	}, 'dsh-local-worktree: POST commit');

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
			commitIgnoredArtifacts: api.config.commitIgnoredArtifacts,
			registerTool: api.config.registerTool,
			worktreeLayout: api.config.worktreeLayout,
			gitTimeoutMs: api.config.gitTimeoutMs
		}
	}));

	ctx.logger?.info?.(`dsh-local-worktree: serving ${ROUTES.status} .. ${ROUTES.health}`);
}

/**
 * Register the agent tool.
 *
 * The same operations the buttons offer, with the same reasons on failure, so an
 * agent can isolate its own work instead of being told to.
 */
function attachTool(ctx, api) {
	const tools = ctx.get?.('tools');
	if (tools === undefined || tools === null || typeof tools.register !== 'function') return;

	const tool = {
		name: 'git_worktree',
		description: [
			'Create and deliver a git worktree, entirely locally (no remote, no network).',
			'"create" cuts a linked worktree under the repository on its own dsh/wt/* branch, registers its directory as a Workspace, and starts a session rooted there.',
			'"status" reports whether the current directory is inside such a worktree and how far it has drifted.',
			'"commit" commits everything uncommitted in this directory (the worktree when the session is inside one), with a subject generated from the changed file names unless `message` is given.',
			'"deliver" merges the worktree\'s commits back into the branch it was cut from, in the main working tree: it fast-forwards when that branch has not moved and creates a merge commit when it has.',
			'A conflict is detected before anything is written and reported with the paths involved; the main working tree is never left half-merged.'
		].join(' '),
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['status', 'commit', 'create', 'deliver', 'discard'], description: 'Which operation to run.' },
				cwd: { type: 'string', description: 'Directory to act on; defaults to the session working directory.' },
				message: { type: 'string', description: 'Commit subject, for `commit` and for the checkpoint commit a `deliver` may make.' },
				cleanup: {
					type: 'boolean',
					description:
						'Remove the worktree after a successful delivery (deliver only). Defaults to the configured `autoCleanup`, which is to remove it; pass false to keep the directory and its branch.'
				}
			},
			required: ['action'],
			additionalProperties: false
		},
		handler: async (args, execution) => {
			const cwd = typeof args?.cwd === 'string' && args.cwd !== ''
				? args.cwd
				: (execution?.cwd ?? execution?.agent?.cwd ?? process.cwd());			const action = String(args?.action ?? 'status');
			const answer = action === 'create'
				// 'host': an agent asking for a worktree has no browser to hand the
				// Session to, so this side starts it and reports its id.
				? await api.createAction({ cwd, session: 'host' })
				: action === 'commit'
					? await api.commitAction({ cwd, message: args?.message })
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
 * Deliberately tiny: the command reports state and runs the three verbs, so a
 * user who prefers typing is not a second-class citizen and — more usefully — so
 * the feature can be exercised in a composition where the UI half never loaded.
 */
function attachCommand(ctx, api) {
	const commands = ctx.get?.('commands');
	if (commands === undefined || commands === null || typeof commands.register !== 'function') return;

	const COMMAND = {
		name: 'worktree',
		description: 'git worktree：创建隔离工作区、提交，并一键合并回原分支 / create an isolated git worktree, commit in it, and merge it back',
		usage: '用法 / usage: /worktree | /worktree create | /worktree commit [msg] | /worktree deliver [keep]'
	};

	const handler = async (invocation) => {
		// The verb is matched case-insensitively; the rest of the line is kept as
		// typed, because for `commit <subject>` it IS the user's text.
		const typed = String(invocation?.rawInput ?? '').trim();
		const raw = typed.toLowerCase();
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
			// 'host': a typed command has no browser to hand the Session to.
			const answer = await api.createAction({ cwd, session: 'host' });
			if (answer.ok !== true) return { kind: 'error', text: answer.reasonText ?? reasonText(answer.reason, { lang: 'both' }) };
			return { kind: 'success', text: answer.text + (answer.session?.sessionId ? `\n新会话 / new session: ${answer.session.sessionId}` : '') };
		}
		if (raw === 'commit' || raw.startsWith('commit ')) {
			// The rest of the line is the subject, so a typed commit can say something
			// the file names cannot. Empty means the generated subject.
			const message = typed.slice('commit'.length).trim();
			const answer = await api.commitAction({ cwd, message: message === '' ? undefined : message });
			if (answer.ok !== true) return { kind: 'error', text: answer.reasonText ?? reasonText(answer.reason, { lang: 'both' }) };
			return { kind: 'success', text: answer.text };
		}
		if (raw === 'deliver' || raw === 'deliver keep' || raw === 'deliver --keep') {
			// A typed command cannot show a question, so the choice is an argument and
			// its DEFAULT is the same one the button offers: merge, then remove the
			// worktree. `keep` is the way out of that default.
			const answer = await api.deliverAction({ cwd, cleanup: raw === 'deliver' });
			if (answer.ok !== true) {
				return { kind: 'error', text: `${answer.reasonText ?? reasonText(answer.reason, { lang: 'both' })}${answer.hint ? `\n${answer.hint}` : ''}` };
			}
			// The same three outcomes the button reports, for the same reason: a
			// requested removal that git refused must not read as "kept on purpose".
			const outcome = answer.cleanup === null || answer.cleanup === undefined
				? '\nworktree 已保留 / the worktree was kept'
				: answer.cleanup.removed === true
					? '\nworktree 已删除 / the worktree was removed'
					: '\nworktree 未能删除，已保留 / the worktree could not be removed and was kept';
			return { kind: 'success', text: `${answer.text}${outcome}` };
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
				commit: (options) => api.commitAction(options),
				openSession: (options) => api.openSessionAction(options),
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
