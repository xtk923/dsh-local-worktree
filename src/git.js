/**
 * git.js — every decision this plugin makes about git, and no I/O of its own.
 *
 * The module is deliberately split in two halves:
 *
 *   * a PURE half (`parseWorktreePorcelain`, `classifyRepo`, `classifyWorktree`,
 *     `planCreate`, `planMerge`, …) that turns git output into a decision;
 *   * a THIN shell (`gitArgs`, `statusArgs`, `frozenArgs`) that turns a
 *     decision into an argv.
 *
 * Nothing here spawns a process. `index.js` does that, so the interesting
 * logic — which ref to branch from, whether a merge can fast-forward, whether
 * it is safe to touch the main working tree at all — is unit-testable against
 * recorded git output instead of against a live repository.
 *
 * The plugin never talks to a remote. Every revision it needs is already in
 * the shared object database that a linked worktree and its main working tree
 * read from the same `.git` directory (`gitCommonDir`), so "deliver the
 * worktree's commits" is a local ref move, never a fetch or a push.
 *
 * @module dsh-local-worktree/git
 */

import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Flags prepended to EVERY git invocation.
 *
 *   * `--no-optional-locks`    — never take `index.lock` just to refresh a
 *                                stat cache; this plugin inspects repositories
 *                                that another agent may be writing to.
 *   * `-c core.quotepath=false`— report non-ASCII paths unescaped, so a repo
 *                                with Chinese file names stays readable.
 *   * `-c color.ui=false`      — machine-readable output even when the user's
 *                                global config forces colour.
 *   * `-c advice.detachedHead=false` — the detached-HEAD hint is noise on a
 *                                read-only probe.
 *   * `-c commit.gpgsign=false`— a machine-made commit must never block on a
 *                                signing key or a pinentry prompt.
 *   * `-c i18n.logOutputEncoding=utf-8` — keep commit subjects legible on a
 *                                non-UTF-8 Windows console.
 */
export const BASE_FLAGS = Object.freeze([
	'--no-optional-locks',
	'-c',
	'core.quotepath=false',
	'-c',
	'color.ui=false',
	'-c',
	'advice.detachedHead=false',
	'-c',
	'commit.gpgsign=false',
	'-c',
	'i18n.logOutputEncoding=utf-8'
]);

/**
 * The paths `git merge-tree --write-tree` named as conflicted.
 *
 * The output starts with the merged TREE OID on its own line, then one stage
 * entry per side per conflicted path (`100644 <oid> <stage>\t<path>`), then a
 * blank line and human-readable advice. Only the tab-separated path field is
 * kept, so the tree OID and the stage metadata can never be mistaken for files.
 */
export function conflictedPaths(raw) {
	const text = String(raw ?? '');
	const found = [];
	for (const line of text.split(/\r?\n/)) {
		const tab = line.indexOf('\t');
		if (tab === -1) continue;
		const path = line.slice(tab + 1).trim();
		if (path === '') continue;
		if (!found.includes(path)) found.push(path);
		if (found.length >= 8) break;
	}
	return found;
}

/**
 * Longest worktree path git will accept, measured in characters.
 *
 * Measured, not guessed: on Windows a linked worktree whose absolute path
 * exceeds ~210 characters fails inside git with `fatal: '$GIT_DIR' too big`,
 * and past ~250 with `could not create leading directories ... Filename too
 * long`. `core.longpaths=true` does NOT raise the ceiling (it changes the
 * message, not the outcome), and neither does the OS LongPathsEnabled setting,
 * because the limit is git's own path assembly. 200 leaves margin for the
 * `.git/worktrees/<name>` suffix git appends internally.
 */
export const PATH_CEILING = 200;

/** Where a shorter worktree root starts being worth suggesting to the user. */
export const PATH_COMFORT = 150;

/**
 * Whether git can build a worktree at `target`.
 *
 * Checked BEFORE spawning: discovering this from a failed `worktree add` would
 * leave the user reading `'$GIT_DIR' too big`, which names neither the limit nor
 * the way out.
 */
export function pathLengthCheck(target, { ceiling = PATH_CEILING, comfort = PATH_COMFORT } = {}) {
	const length = String(target ?? '').length;
	if (length > ceiling) {
		return { ok: false, reason: 'worktree-path-too-long', length, ceiling, comfort };
	}
	return { ok: true, length, comfort, tight: length > comfort };
}

/** The state branch prefix. Namespaced so a user's branches never collide. */
export const BRANCH_PREFIX = 'dsh/wt/';

/**
 * Sibling directory suffix that holds this repository's worktrees.
 *
 * `_worktrees` rather than a hyphenated form so the container reads as a
 * companion of `<repo>` on every platform and cannot be mistaken for a project
 * whose own name contains the suffix.
 */
export const WORKTREE_SUFFIX = '_worktrees';

/**
 * Container INSIDE the repository, used by the `inside` layout.
 *
 * The dot keeps it out of the way visually, and it MUST be listed in the
 * repository's own `.git/info/exclude`: the container sits inside the main
 * working tree, so without that line `git status` reports it and a `git add -A`
 * in the main tree would commit a whole parallel checkout.
 */
export const INSIDE_CONTAINER = '.dsh-worktrees';

/** Accepted `worktreeLayout` values. */
export const WORKTREE_LAYOUTS = Object.freeze(['sibling', 'inside']);

/** Anything that is not an explicit `inside` reads as `sibling`. */
export function normalizeWorktreeLayout(value) {
	return value === 'inside' ? 'inside' : 'sibling';
}

/** The line this plugin adds to a repository's `.git/info/exclude`. */
export function containerExcludePattern() {
	return `${INSIDE_CONTAINER}/`;
}

/** Where the created worktree's branch name is remembered across restarts. */
export const META_FILE = '.dsh-worktree.json';

export const DEFAULT_COMMIT_MESSAGE = 'wip: dsh worktree checkpoint';

/** Hard ceiling on an auto-generated commit subject, in characters. */
const SUBJECT_MAX = 68;

/* ------------------------------------------------------------------ argv -- */

/**
 * The full argv for one git command, minus the executable.
 *
 * `cwd` is applied by the caller through `git -C` only when it differs from the
 * process working directory, so a command never becomes ambiguous when the
 * repository path contains spaces: `-C` takes the path as ONE argv element and
 * no shell ever sees it.
 */
export function gitArgs(args, { cwd, noBaseFlags = false } = {}) {
	const out = [];
	out.push(...(noBaseFlags ? [] : BASE_FLAGS));
	if (typeof cwd === 'string' && cwd !== '') out.push('-C', cwd);
	out.push(...args);
	return out;
}

/** `git status --porcelain=v2 --branch` — branch, upstream and dirty in one call. */
export function statusArgs({ cwd } = {}) {
	return gitArgs(['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], { cwd });
}

/* ------------------------------------------------------------- pure parse -- */

/**
 * Parse `git worktree list --porcelain` (with or without `-z`).
 *
 * The two forms differ in a way that is easy to get wrong, and getting it wrong
 * is silent: in the `-z` form a key with a value is TWO NUL-separated tokens
 * (`branch\0refs/heads/x\0`), so reading only `key value` pairs makes the value
 * look like the next attribute. Empirically, `locked keep me` in the newline
 * form becomes `locked\0keep me\0` under `-z` — the reason is its own token.
 *
 * So the `-z` branch is parsed as: a record starts at `worktree`, and every
 * following token until the next `worktree` belongs to it.
 */
export function parseWorktreePorcelain(raw) {
	const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
	const nulSeparated = text.includes('\0');
	const records = nulSeparated ? splitNulRecords(text) : splitNewlineRecords(text);

	return records.map((record) => {
		const entry = { path: '', head: null, branch: null, detached: false, bare: false, locked: false, lockedReason: null, prunable: false };
		for (const [key, value] of record) {
			switch (key) {
				case 'worktree': entry.path = value; break;
				case 'HEAD': entry.head = value === '' ? null : value; break;
				case 'branch': entry.branch = value === '' ? null : value.replace(/^refs\/heads\//, ''); break;
				case 'locked': entry.locked = true; entry.lockedReason = value === '' ? null : value; break;
				case 'prunable': entry.prunable = true; break;
				case 'detached': entry.detached = true; break;
				case 'bare': entry.bare = true; break;
				// Unknown keys are ignored on purpose: a future git may add one,
				// and refusing to parse would take the whole feature with it.
				default: break;
			}
		}
		return {
			...entry,
			// git reports `/`-separated paths even on Windows; `resolve` gives the
			// native form every caller compares against.
			path: entry.path === '' ? '' : resolve(entry.path)
		};
	}).filter((entry) => entry.path !== '');
}

/** `-z` records: `worktree <path>\0<attr...>\0\0`, attributes as bare tokens. */
function splitNulRecords(text) {
	const tokens = text.split('\0');
	const records = [];
	let current = null;
	let pendingKey = null;
	for (const token of tokens) {
		if (token === '') { pendingKey = null; continue; }
		// The `-z` form keeps `<key> <value>` together for the FIRST attribute of
		// a line and puts a multi-word value on its own token, so the key is
		// whatever precedes the first space — matching a whole token against the
		// key table silently drops `HEAD <oid>` and `branch <ref>`.
		const space = token.indexOf(' ');
		const key = space === -1 ? token : token.slice(0, space);
		const inline = space === -1 ? '' : token.slice(space + 1);

		if (key === 'worktree') {
			current = [['worktree', inline]];
			records.push(current);
			pendingKey = null;
			continue;
		}
		if (current === null) continue;
		if (ATTR_KEYS.has(key)) {
			current.push([key, inline]);
			// An attribute without an inline value carries it as the next token
			// (`locked\0keep me\0`); with one (`branch refs/heads/x`) it does not.
			pendingKey = inline === '' && key !== 'detached' && key !== 'bare' ? key : null;
			continue;
		}
		if (pendingKey !== null) {
			const last = current[current.length - 1];
			if (last[1] === '') last[1] = token;
			else current.push([token, '']);
			pendingKey = null;
			continue;
		}
		// A key this build does not know: kept as data so the record survives,
		// and its own value (if any) is absorbed by the branch above.
		current.push([key, inline]);
		pendingKey = inline === '' ? key : null;
	}
	return records;
}

/** Newline records: `worktree <path>\nkey[ value]\n...\n\n`. */
function splitNewlineRecords(text) {
	const records = [];
	let current = null;
	for (const line of text.split(/\r?\n/)) {
		if (line === '') { current = null; continue; }
		const space = line.indexOf(' ');
		const key = space === -1 ? line : line.slice(0, space);
		const value = space === -1 ? '' : line.slice(space + 1);
		if (key === 'worktree') {
			current = [];
			records.push(current);
		}
		if (current === null) continue;
		current.push([key, value]);
	}
	return records;
}

/** Keys `git worktree list --porcelain` can emit. */
const ATTR_KEYS = new Set(['HEAD', 'branch', 'detached', 'bare', 'locked', 'prunable']);

/** Parse `git status --porcelain=v2 --branch` into branch/upstream/dirty facts. */
export function parseStatusV2(raw) {
	const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
	const result = {
		branch: null,
		head: null,
		upstream: null,
		ahead: 0,
		behind: 0,
		detached: false,
		unborn: false,
		dirty: false,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		conflicted: 0,
		entries: []
	};

	for (const line of text.split(/\r?\n/)) {
		if (line === '') continue;
		if (line.startsWith('# ')) {
			const body = line.slice(2);
			const space = body.indexOf(' ');
			const key = space === -1 ? body : body.slice(0, space);
			const value = space === -1 ? '' : body.slice(space + 1);
			if (key === 'branch.oid') result.head = value === '(initial)' ? null : value;
			else if (key === 'branch.head') {
				if (value === '(detached)') result.detached = true;
				else result.branch = value;
			} else if (key === 'branch.upstream') result.upstream = value;
			else if (key === 'branch.ab') {
				const match = /\+(\d+)\s+-(\d+)/.exec(value);
				if (match) {
					result.ahead = Number(match[1]);
					result.behind = Number(match[2]);
				}
			}
			continue;
		}
		const kind = line[0];
		if (kind === '1') {
			result.staged += 1;
			result.unstaged += 1;
			result.entries.push(line.slice(2));
		} else if (kind === '2') {
			// Renamed/copied entries carry the original path after a NUL; the
			// readable half is the new path, which is what a report should show.
			result.staged += 1;
			result.unstaged += 1;
			result.entries.push(line.slice(2).split('\0')[0]);
		} else if (kind === 'u') {
			result.conflicted += 1;
			result.entries.push(line.slice(2));
		} else if (kind === '?') {
			result.untracked += 1;
			result.entries.push(line.slice(2));
		} else if (kind === '!') {
			// Ignored entries are only listed with --ignored; kept for completeness.
			result.entries.push(line.slice(2));
		}
	}

	result.dirty = result.staged > 0 || result.unstaged > 0 || result.untracked > 0 || result.conflicted > 0;
	// An unborn HEAD reports the all-zero oid; treating that as "no commit yet"
	// is what turns `git worktree add` into a diagnosed refusal instead of a
	// confusing "invalid reference: HEAD".
	if (result.head !== null && /^0{40,64}$/.test(result.head)) {
		result.head = null;
		result.unborn = true;
	}
	if (result.head === null && result.branch !== null) result.unborn = true;
	return result;
}

/* --------------------------------------------------------------- identity -- */

/** Lower-case, path-safe slug for a repository name. */
export function slug(value, { max = 48 } = {}) {
	const cleaned = String(value ?? '')
		.normalize('NFKD')
		.replace(/[^\w.\-]+/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^[-.]+|[-.]+$/g, '');
	return (cleaned === '' ? 'worktree' : cleaned).slice(0, max);
}

/**
 * Stable short identity for one repository.
 *
 * Derived from the COMMON git dir, not from the working tree path: two clones
 * of the same project are different repositories and must not share a registry
 * entry, while a linked worktree and its main tree must.
 *
 * SHA-1 is used here as a NAME-MAKING hash, not as a security primitive: the
 * input is a local directory path the user already knows, the output only labels
 * a registry entry, and nothing is authenticated or protected by it. (Git itself
 * is SHA-1-based throughout, so a stronger digest here would protect nothing.)
 */
export function repoKey(gitCommonDir) {
	const normalised = String(gitCommonDir ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	// A name, not a guard: nothing is authenticated by this digest (see above).
	// secure-review-disable-next-line SEC-201
	return createHash('sha1').update(normalised).digest('hex').slice(0, 10);
}

/** Stable short identity for one worktree, derived from its branch name. */
export function worktreeId(name) {
	// Same name-making use of SHA-1 as `repoKey` above.
	// secure-review-disable-next-line SEC-201
	return createHash('sha1').update(String(name ?? '')).digest('hex').slice(0, 8);
}

/**
 * A fresh, sortable, collision-resistant id: `<time>-<random>`.
 *
 * Every worktree gets its OWN id rather than one derived from the repository,
 * for two reasons:
 *
 *   * the id is part of the DIRECTORY name, and two worktrees of one repository
 *     must not fight over one path — creating a second one used to reuse the
 *     first, which reads as "the button did nothing";
 *   * the id is part of the BRANCH name, and git refuses a duplicate branch, so a
 *     derived id would make the second creation fail outright.
 *
 * The timestamp is base-36 so it sorts lexically while staying short (~8 chars
 * for the next few decades), and the random suffix makes a same-millisecond
 * double click produce two distinct worktrees instead of one or an error.
 *
 * @param now - injectable clock, so a test can assert the format.
 * @param random - injectable randomness, for the same reason.
 */
export function freshId({ now = Date.now(), random = Math.random } = {}) {
	const stamp = Math.floor(now).toString(36);
	const noise = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0');
	return `${stamp}-${noise}`;
}

/**
 * Where this repository's worktrees live.
 *
 * `sibling` (the default) keeps them BESIDE the repository:
 *
 *   `C:\a\b\repo` -> `C:\a\b\repo_worktrees`
 *
 * `inside` puts them under the repository itself:
 *
 *   `C:\a\b\repo` -> `C:\a\b\repo\.dsh-worktrees`
 *
 * The choice is not cosmetic. DSH's sidebar groups Sessions by registered
 * Workspace directory and nests a Workspace under its nearest REGISTERED
 * ancestor path, so only an `inside` worktree can appear inside the
 * repository's own sidebar group (the "Workspace Tree" grouping mode); a
 * sibling container is always a parallel group however it is registered.
 */
export function worktreeContainer(localRoot, { layout } = {}) {
	const root = resolve(String(localRoot));
	return normalizeWorktreeLayout(layout) === 'inside'
		? join(root, INSIDE_CONTAINER)
		: join(dirname(root), `${basename(root)}${WORKTREE_SUFFIX}`);
}

/**
 * The directory a new worktree occupies inside the container.
 *
 * `<repo>_<id>`, so every worktree of one repository sorts together, is
 * recognisable at a glance as belonging to it, and never collides with a sibling
 * project of a similar name. The underscore is the separator on purpose: a hyphen
 * would read as part of a hyphenated project name, so `my-app_3f2a1b9c` names its
 * parent unambiguously while `my-app-3f2a1b9c` could be a repository called that.
 *
 * `id` is REQUIRED: a default would silently reintroduce the shared-path bug this
 * signature exists to prevent, so a caller that forgets it gets an error rather
 * than a worktree that collides with an earlier one.
 */
export function worktreePath(localRoot, id, { layout } = {}) {
	if (typeof id !== 'string' || id === '') throw new Error('worktreePath requires a fresh id');
	return join(worktreeContainer(localRoot, { layout }), `${slug(basename(resolve(String(localRoot))))}_${slug(id, { max: 24 })}`);
}

/**
 * Branch name for a worktree, e.g. `dsh/wt/repo_m3k8x1p2-a4f9`.
 *
 * Same rule as {@link worktreePath}: the id is required, because a branch name is
 * unique per repository and a derived one would make the second worktree of a
 * repository impossible to create.
 */
export function branchName(localRoot, id) {
	if (typeof id !== 'string' || id === '') throw new Error('branchName requires a fresh id');
	return `${BRANCH_PREFIX}${slug(basename(resolve(String(localRoot))))}_${slug(id, { max: 24 })}`;
}

/**
 * The container must hold the target, and nothing else in the repository may.
 *
 * For `sibling` that is "the target is outside the repository entirely". For
 * `inside` it is the narrower and stricter "the target is under the container
 * specifically": a worktree scattered into the repository's own tracked
 * directories is exactly what must not happen, because it would be committed by
 * the next `git add -A` in the main tree.
 */
export function assertOutside(localRoot, target, { layout } = {}) {
	const root = resolve(String(localRoot));
	const shape = normalizeWorktreeLayout(layout);
	const container = worktreeContainer(root, { layout: shape });
	if (!isAbsolute(target)) throw new Error('worktree path must be absolute');
	const inRepo = target === root || target.startsWith(root + sep());
	if (inRepo && shape !== 'inside') {
		throw new Error(`refusing to create a worktree inside the repository itself: ${target}`);
	}
	if (inRepo && !(target === container || target.startsWith(container + sep()))) {
		throw new Error(`refusing to create a worktree outside the container ${container}: ${target}`);
	}
	return { container, target };
}

/** Windows-safe `path.sep` without importing a second name. */
function sep() {
	return resolve('/') === '/' ? '/' : '\\';
}

/* ------------------------------------------------------------ pure decide -- */

/**
 * Can this directory host the feature at all?
 *
 * `present` is "there is a repository here"; `usable` adds "and it has a
 * commit to branch from". The two are separate because the UI must show a
 * DISABLED button with a reason, not no button, for a repository that cannot
 * be worktree'd yet.
 */
export function classifyRepo({ root, status, gitCommonDir } = {}) {
	if (typeof root !== 'string' || root === '' || gitCommonDir === undefined || gitCommonDir === null) {
		return { present: false, usable: false, reason: 'not-a-repository' };
	}
	if (status === undefined || status === null) {
		return { present: true, usable: false, reason: 'status-unavailable' };
	}
	if (status.conflicted > 0) return { present: true, usable: false, reason: 'merge-in-progress', branch: status.branch, head: status.head };
	if (status.unborn || status.head === null) {
		return { present: true, usable: false, reason: 'no-commits-yet', branch: status.branch, head: null };
	}
	if (status.detached) return { present: true, usable: true, reason: 'detached-head', branch: null, head: status.head };
	return { present: true, usable: true, reason: 'ok', branch: status.branch, head: status.head };
}

/**
 * The create decision.
 *
 * A start-point is ALWAYS passed explicitly (`HEAD`, or the recorded head oid)
 * rather than letting `git worktree add` default to HEAD: between the click and
 * the spawn the main tree can move, and the worktree must start where the UI
 * said it would.
 *
 * `id` is required and becomes BOTH the directory suffix and the branch suffix,
 * so two worktrees of one repository are two distinct paths on two distinct
 * branches. See {@link freshId} for why nothing here may be derived from the
 * repository alone.
 */
export function planCreate({ localRoot, id, branch, startPoint, path, layout } = {}) {
	if (typeof localRoot !== 'string' || localRoot === '') throw new Error('planCreate requires localRoot');
	if (typeof id !== 'string' || id === '') throw new Error('planCreate requires a fresh id');
	const shape = normalizeWorktreeLayout(layout);
	const name = typeof branch === 'string' && branch !== '' ? branch : branchName(localRoot, id);
	const target = typeof path === 'string' && path !== '' ? resolve(path) : worktreePath(localRoot, id, { layout: shape });
	assertOutside(localRoot, target, { layout: shape });
	// Measured against git's own ceiling BEFORE spawning: `worktree add` would
	// otherwise fail with `'$GIT_DIR' too big`, which explains nothing.
	const length = pathLengthCheck(target);
	if (length.ok !== true) {
		const error = new Error(`worktree path is ${length.length} characters; git refuses past ${length.ceiling}`);
		error.reason = length.reason;
		error.pathLength = length.length;
		error.ceiling = length.ceiling;
		throw error;
	}
	return {
		localRoot: resolve(localRoot),
		branch: name,
		startPoint: typeof startPoint === 'string' && startPoint !== '' ? startPoint : 'HEAD',
		path: target,
		container: worktreeContainer(localRoot, { layout: shape }),
		layout: shape,
		pathLength: length.length,
		pathTight: length.tight === true,
		args: ['worktree', 'add', '-b', name, '--', target, typeof startPoint === 'string' && startPoint !== '' ? startPoint : 'HEAD']
	};
}

/**
 * What is the worktree's relationship to the base it came from?
 *
 * `ahead` is counted with `--not <base>` so commits the base already contains
 * are excluded even after a partial delivery; `baseAhead` is the mirror image
 * and is what decides fast-forwardability.
 */
export function classifyWorktree({
	present,
	path,
	head,
	branch,
	status,
	base,
	baseHead,
	mainHead,
	ahead = 0,
	baseAhead = 0
} = {}) {
	if (present !== true) return { present: false, path: typeof path === 'string' ? path : null, state: 'missing', deliverable: false, reason: 'worktree-missing' };
	const facts = {
		present: true,
		// The path travels with the classification: every caller that shows or acts
		// on this worktree needs it, and a caller that had to re-supply it is a
		// caller that can supply the wrong one.
		path: typeof path === 'string' && path !== '' ? path : null,
		head: typeof head === 'string' && head !== '' ? head : null,
		branch: typeof branch === 'string' && branch !== '' ? branch : null,
		base: typeof base === 'string' && base !== '' ? base : null,
		baseHead: typeof baseHead === 'string' && baseHead !== '' ? baseHead : null,
		mainHead: typeof mainHead === 'string' && mainHead !== '' ? mainHead : null,
		ahead: Number(ahead) || 0,
		baseAhead: Number(baseAhead) || 0,
		dirty: status?.dirty === true,
		untracked: Number(status?.untracked ?? 0),
		modified: Number(status?.staged ?? 0) + Number(status?.unstaged ?? 0),
		conflicted: Number(status?.conflicted ?? 0)
	};

	if (facts.head === null) return { ...facts, state: 'empty', deliverable: false, reason: 'no-commits-yet' };
	if (facts.conflicted > 0) return { ...facts, state: 'conflicted', deliverable: false, reason: 'worktree-conflicted' };

	// `ahead` is measured against the base branch; a worktree with no new commit
	// has nothing to deliver, and saying so beats creating an empty merge commit.
	if (facts.ahead === 0 && !facts.dirty) {
		return { ...facts, state: 'no-changes', deliverable: false, reason: 'no-new-commits' };
	}
	if (facts.ahead === 0 && facts.dirty) {
		return { ...facts, state: 'uncommitted-only', deliverable: true, reason: 'uncommitted-changes' };
	}
	return { ...facts, state: 'ready', deliverable: true, reason: 'ok' };
}

/**
 * The merge decision, taken BEFORE anything is written.
 *
 * The order of these refusals is the safety property of the whole feature:
 *
 *   1. the worktree's branch must belong to this repository (`sameRepo`);
 *   2. the main tree must still be on the branch the worktree was cut from —
 *      a user who switched branches mid-flight must not silently receive the
 *      commits somewhere they did not ask for;
 *   3. nothing may be half-merged already;
 *   4. the main working tree must be clean, because `git merge` refuses on a
 *      dirty tree anyway and a "sometimes works" button is worse than a
 *      diagnosed one;
 *   5. uncommitted worktree work WITH `autoCommit` off is named as such, before
 *      the "already merged" test can mislabel it;
 *   6. an unborn main branch has nothing to fast-forward from.
 */
export function planMerge({
	sameRepo = true,
	mainBranch,
	base,
	mainHead,
	mainStatus,
	worktreeBranch,
	worktreeHead,
	worktreeDirty = false,
	commitMessage,
	autoCommit = true,
	commitIgnored = false,
	hasIdentity = true
} = {}) {
	const refuse = (reason, detail) => ({ ok: false, kind: 'refuse', reason, detail: detail ?? null });
	const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a !== '' && a === b;

	if (sameRepo !== true) return refuse('different-repository');
	// The merge target is decided before the source is inspected: a base branch
	// with no commit cannot receive anything, whatever the worktree holds.
	if (mainStatus?.unborn === true || mainStatus?.head === null) return refuse('main-unborn');
	if (typeof worktreeHead !== 'string' || worktreeHead === '') return refuse('worktree-missing');
	if (mainStatus?.conflicted > 0) return refuse('main-merge-in-progress');
	if (base !== null && base !== undefined && base !== '' && mainBranch !== null && mainBranch !== undefined && mainBranch !== '' && !same(mainBranch, base)) {
		return refuse('main-on-other-branch', `expected ${base}, found ${mainBranch}`);
	}
	if (mainStatus?.detached === true) return refuse('main-detached-head');
	if (mainStatus?.dirty === true) {
		return refuse('main-dirty', `${Number(mainStatus.staged ?? 0) + Number(mainStatus.unstaged ?? 0)} tracked, ${Number(mainStatus.untracked ?? 0)} untracked`);
	}

	const message = typeof commitMessage === 'string' && commitMessage.trim() !== ''
		? commitMessage.trim()
		: null;

	// Uncommitted worktree work is diagnosed BEFORE "already merged", because a
	// worktree whose only work is still uncommitted is NOT already merged: the base
	// does not contain it. Reading the same-commit test first reported that case as
	// `already-merged` — "the base branch already contains every worktree commit" —
	// which describes a merge that is nothing of the kind, when the user's next move
	// is to commit, or to turn `autoCommit` on.
	if (worktreeDirty === true && autoCommit !== true) {
		return refuse('worktree-dirty', 'the worktree has uncommitted changes and autoCommit is off');
	}
	// Reaching here with a dirty worktree means `autoCommit` is ON, so the checkpoint
	// commit below is what turns it into something deliverable and this refusal must
	// not pre-empt it. With a clean worktree, identical heads really is "nothing to
	// deliver", and saying THAT beats creating an empty merge commit.
	if (same(mainHead, worktreeHead) && worktreeDirty !== true) {
		return refuse('already-merged');
	}
	// Auto-committing without an identity fails with "Author identity unknown" —
	// and on a machine whose global config has no user.name this is the NORMAL
	// case, so it is diagnosed before the commit is attempted rather than after.
	if (worktreeDirty === true && hasIdentity !== true) {
		return refuse('identity-missing', 'git has no user.email, so the checkpoint commit cannot be made');
	}

	return {
		ok: true,
		kind: 'merge',
		// `--ff` is explicit: the user's global `merge.ff = false` must not turn
		// every delivery into an unnecessary merge commit.
		mergeFlag: '--ff',
		worktreeBranch,
		worktreeHead,
		commitMessage: message,
		// The caller turns this into an actual staging `add` + `commit`; planning it
		// here keeps the argv and the decision in one place.
		preCommit: worktreeDirty === true
			? { message: message ?? DEFAULT_COMMIT_MESSAGE, forceIgnored: commitIgnored === true }
			: null
	};
}

/** Whether `git merge` will fast-forward, said in words the UI can print. */
export function describeMerge({ baseAhead = 0 } = {}) {
	return Number(baseAhead) > 0
		? { strategy: 'merge-commit', text: '原分支有新提交，将产生一个 merge commit / the base has moved, a merge commit will be created' }
		: { strategy: 'fast-forward', text: '可以直接快进 / this will fast-forward' };
}

/**
 * Recover the message git would need if a merge has to be undone.
 *
 * Only ever `merge --abort`: it is the one command that restores the pre-merge
 * index and working tree exactly, so a conflict costs the user a retry rather
 * than a repair.
 */
export function planAbort() {
	return { args: ['merge', '--abort'] };
}

/**
 * argv for staging the checkpoint commit, in ONE place for both callers.
 *
 * `--force` is what makes `git add` accept paths that `.gitignore` excludes, and
 * it is OFF by default. The reason is not tidiness: the same ignore rules that
 * keep `node_modules/` out of a repository are the ones that keep a `.env` out of
 * it, so a checkpoint commit that forces them in writes files the user
 * deliberately excluded — secrets included — into the base branch's history,
 * where they cannot be removed by a later click. It also made the commit disagree
 * with the plugin's OWN verdict on the directory: `dirty` is decided with
 * `--exclude-standard` (ignored paths do not count), so a forced staging step
 * committed strictly more than the change list the button reported.
 *
 * `commitIgnored: true` restores the older behaviour for a caller who really
 * wants a build artifact committed before the worktree is removed — that is a
 * deliberate choice, so it is opt-in rather than the default.
 */
export function stageArgs({ forceIgnored = false } = {}) {
	return ['add', '--all', ...(forceIgnored === true ? ['--force'] : []), '--', '.'];
}

/**
 * argv for the merge itself, in the order the sequence needs them.
 *
 * Every element is a separate argv item — including the pathspec `.` and each
 * `-m` message — so git's own option parser never sees a message that starts
 * with a dash, an em dash, or a quote as anything other than data. Building a
 * command line as one string is how a commit subject becomes an option.
 */
export function mergeSteps(plan) {
	if (plan?.ok !== true) throw new Error('mergeSteps requires a successful plan');
	const steps = [];
	if (plan.preCommit) {
		steps.push({ id: 'stage', args: stageArgs({ forceIgnored: plan.preCommit.forceIgnored === true }) });
		// No `--no-verify`: a repository's own hooks (this machine's init template
		// installs a gitleaks pre-commit hook into every new repository) exist to
		// stop exactly this kind of automated commit, and skipping them would be
		// this plugin deciding that a user's secret scanner does not apply. A hook
		// refusal is reported as `hook-rejected` instead.
		steps.push({ id: 'commit', args: ['commit', '-m', plan.preCommit.message, '--'] });
	}
	steps.push({
		id: 'merge',
		args: [
			'merge',
			plan.mergeFlag ?? '--ff',
			'--no-edit',
			'-m', `Merge worktree ${plan.worktreeBranch}`,
			'--',
			plan.worktreeBranch
		],
		abortOnFailure: true
	});
	return steps;
}

/** argv for removing a finished worktree and its branch. */
export function cleanupSteps({ path, branch, force = false, deleteBranch = true } = {}) {
	const steps = [{ id: 'remove', args: ['worktree', 'remove', ...(force ? ['--force'] : []), '--', path] }];
	if (deleteBranch && typeof branch === 'string' && branch.startsWith(BRANCH_PREFIX)) {
		steps.push({ id: 'branch', args: ['branch', '-d', branch] });
	}
	steps.push({ id: 'prune', args: ['worktree', 'prune'] });
	return steps;
}

/**
 * A commit subject for changes a user never described.
 *
 * The file names are the only content available, so they are the message; the
 * result stays inside `SUBJECT_MAX` characters and never claims more than it
 * knows.
 */
export function suggestCommitMessage(status, { prefix = DEFAULT_COMMIT_MESSAGE } = {}) {
	const entries = Array.isArray(status?.entries) ? status.entries : [];
	// Porcelain v2 puts the path LAST on the line, after fields that can contain
	// spaces only in the description-free positions; the last whitespace-separated
	// token is therefore the path and nothing else.
	const names = entries
		.map((line) => String(line ?? '').trim().split(/\s+/).pop())
		.filter((name) => typeof name === 'string' && name !== '');
	if (names.length === 0) return prefix;
	const shown = names.slice(0, 3).join(', ');
	const more = names.length > 3 ? ` +${names.length - 3}` : '';
	const subject = `${prefix}: ${shown}${more}`;
	return subject.length <= SUBJECT_MAX ? subject : `${subject.slice(0, SUBJECT_MAX - 1)}…`;
}

/** One-line human summary of how far a worktree has drifted from its base. */
export function driftText({ ahead = 0, baseAhead = 0, dirty = false } = {}) {
	const parts = [`${Number(ahead) || 0} 个新提交 / ${Number(ahead) || 0} new commit(s)`];
	if (Number(baseAhead) > 0) parts.push(`原分支另有 ${Number(baseAhead)} 个提交 / base moved ${Number(baseAhead)}`);
	if (dirty === true) parts.push('有未提交改动 / uncommitted changes');
	return parts.join('，');
}

/* --------------------------------------------------------- path utilities -- */

/** Windows-safe separator, resolved without a second import. */
function pathSep() {
	return resolve('/') === '/' ? '/' : '\\';
}

/** Compare two filesystem paths the way git does: separators and case wide. */
export function samePath(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string') return false;
	const norm = (value) => resolve(value).replace(/[\\/]+$/, '').toLowerCase();
	return norm(a) === norm(b);
}

/**
 * The ancestors of `start`, itself first, up to the filesystem root.
 *
 * Used to find the repository a session is working inside: a session may sit in
 * `repo/packages/app` and still mean the repository at `repo`. Walking up beats
 * `git rev-parse` at every level, and it never spawns a process per ancestor.
 */
export function ancestors(start) {
	const list = [];
	let current = resolve(String(start));
	for (;;) {
		list.push(current);
		const parent = dirname(current);
		if (parent === current) return list;
		current = parent;
	}
}

/** Is `child` inside (or identical to) `parent`? */
export function within(parent, child) {
	if (typeof parent !== 'string' || typeof child !== 'string') return false;
	if (parent === '' || child === '') return false;
	const sep = pathSep();
	const norm = (value) => resolve(value).replace(/[\\/]+$/, '').toLowerCase();
	const p = norm(parent);
	const c = norm(child);
	return c === p || c.startsWith(p + sep);
}

/* ------------------------------------------------------- output classify -- */

/**
 * Turn a git failure into a stable reason code.
 *
 * The point is that the UI never shows raw git output as its explanation. Each
 * branch here is a failure a user can act on, and the order matters: the
 * conflict check comes first because a conflicted merge also prints advice.
 */
export function classifyGitFailure({ stderr = '', stdout = '', exitCode = 1 } = {}) {
	const all = `${stderr}\n${stdout}`;
	const has = (re) => re.test(all);

	if (has(/CONFLICT|Automatic merge failed|fix conflicts/i)) return 'merge-conflict';
	if (has(/not fully merged/i)) return 'branch-not-merged';
	// Checked BEFORE the generic dirty-tree pattern on purpose: git's "would be
	// overwritten" message also contains "dirty"-adjacent wording, and the
	// actionable answer is "commit or stash", not "the tree is dirty".
	if (has(/would be overwritten|Please commit your changes or stash|Refusing to lose/i)) return 'local-changes-would-be-lost';
	if (has(/contains modified or untracked files|is dirty/i)) return 'worktree-dirty';
	if (has(/is already used by worktree|already exists/i)) return 'worktree-exists';
	if (has(/not a git repository/i)) return 'not-a-repository';
	if (has(/invalid reference|unknown revision|bad revision/i)) return 'bad-reference';
	if (has(/unable to create directory|Permission denied|being used by another process|Access is denied/i)) return 'path-in-use';
	if (has(/Invalid path|is outside repository|not a working tree/i)) return 'invalid-path';
	if (has(/cannot lock ref|Unable to create .*\.lock|index\.lock/i)) return 'locked';
	if (has(/unrelated histories/i)) return 'unrelated-histories';
	if (has(/hook declined|pre-commit|pre-merge-commit/i)) return 'hook-rejected';
	if (has(/identity unknown|empty ident|unable to auto-detect email/i)) return 'identity-missing';
	if (has(/Not possible to fast-forward|not possible to fast-forward/i)) return 'not-fast-forwardable';
	if (exitCode === 128) return 'git-error';
	return 'git-failed';
}

/**
 * Search git's error text for a path git itself names.
 *
 * Failure text is shown next to the reason so a user can see WHICH path or ref
 * was the problem, without this module pretending to parse prose it does not
 * pin down. Only the first two quoted spans are kept, and only when short.
 */
export function quotedFromGit(raw) {
	const text = String(raw ?? '');
	const found = [];
	for (const match of text.matchAll(/'([^'\n]{1,160})'/g)) {
		found.push(match[1]);
		if (found.length === 2) break;
	}
	return found;
}

