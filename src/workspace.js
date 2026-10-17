/**
 * workspace.js — the repository operations, driven through one injected runner.
 *
 * Layering, deliberately:
 *
 *   `git.js`      decides WHAT to do and builds argv (pure, unit-tested);
 *   `workspace.js` runs argv, reads the repository, and orders the steps;
 *   `index.js`    exposes the result on HTTP, as a command and as a tool.
 *
 * The runner is injected (`run(args, { cwd })`) rather than imported, so every
 * test here drives real git in a throwaway repository without a mocked child
 * process, and the plugin's own process handling stays in one place.
 *
 * The single most important property of this module: a failed merge leaves the
 * user's main working tree byte-for-byte as it was. That is why `deliver`
 * verifies the main tree is clean BEFORE spawning anything, and why the only
 * failure recovery it performs is `git merge --abort`, which is the one command
 * that restores the pre-merge index and worktree exactly.
 *
 * @module dsh-local-worktree/workspace
 */

import { mkdir, readFile, readdir, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import {
	ancestors,
	branchName,
	classifyGitFailure,
	classifyRepo,
	classifyWorktree,
	cleanupSteps,
	conflictedPaths,
	containerExcludePattern,
	DEFAULT_COMMIT_MESSAGE,
	describeMerge,
	driftText,
	freshId,
	gitArgs,
	META_FILE,
	mergeSteps,
	normalizeWorktreeLayout,
	parseStatusV2,
	parseWorktreePorcelain,
	pathLengthCheck,
	planAbort,
	planCreate,
	planMerge,
	quotedFromGit,
	repoKey,
	samePath,
	stageArgs,
	statusArgs,
	suggestCommitMessage,
	within,
	worktreeContainer,
	worktreePath
} from './git.js';

/** The plugin's own branch namespace; only these are ever deleted. */
const OWN_BRANCH = /^dsh\/wt\//;

/**
 * How many times a removal that hit a busy path is retried, and how long the
 * retries wait.
 *
 * A directory held by a scanner, the search indexer or an exiting process is free
 * again in a few hundred milliseconds; a directory held by a running dev server is
 * not, and waiting longer would only make the click feel broken. Three attempts
 * spanning well under a second covers the first case and reports the second.
 */
const REMOVE_ATTEMPTS = 3;
const REMOVE_BACKOFF_MS = [150, 600];

/** Longest git error line kept as `detail`, so a payload stays readable. */
const DETAIL_MAX = 300;

/** A git invocation that failed, with the reason code the UI renders. */
export class GitFailure extends Error {
	constructor(reason, detail, { operation, args = [], exitCode = null, stderr = '', stdout = '' } = {}) {
		super(detail === '' || detail === undefined ? reason : detail);
		this.name = 'GitFailure';
		this.reason = reason;
		this.detail = detail ?? '';
		this.operation = operation ?? '';
		this.args = args;
		this.exitCode = exitCode;
		this.stderr = stderr;
		this.stdout = stdout;
	}

	/** The shape a route handler answers with. */
	toJSON() {
		return {
			ok: false,
			reason: this.reason,
			detail: this.detail,
			operation: this.operation,
			quoted: quotedFromGit(this.stderr !== '' ? this.stderr : this.stdout)
		};
	}
}

/* ------------------------------------------------------------------ reader -- */

/**
 * Reads a repository through one runner.
 *
 * Every read is fresh: the main tree, a worktree, or the branch list can change
 * between two clicks (another agent, another session, the user's own terminal),
 * so nothing is cached here — the caller decides when to reuse a snapshot.
 */
export class Workspace {
	/**
	 * @param run - `(args: string[], options?: { cwd?: string }) => Promise<{ exitCode, stdout, stderr }>`
	 * @param options.onWarn - sink for non-fatal problems, never a logger dependency.
	 * @param options.layout - `sibling` (default) or `inside`; see {@link worktreeContainer}.
	 * @param options.sleep - the wait between removal retries, injected so a test
	 *   can assert the retry without spending the backoff.
	 */
	constructor(run, { onWarn, layout, sleep } = {}) {
		if (typeof run !== 'function') throw new TypeError('Workspace requires a git runner');
		this.run = run;
		this.onWarn = typeof onWarn === 'function' ? onWarn : () => {};
		this.sleep = typeof sleep === 'function' ? sleep : (ms) => new Promise((done) => { setTimeout(done, ms); });
		// Fixed for the life of the instance: where a worktree lands decides the
		// repository's `.git/info/exclude` line and the path a session is rooted at,
		// so switching it halfway would leave both half-applied.
		this.layout = normalizeWorktreeLayout(layout);
	}

	/**
	 * The repository facts for one directory, or a diagnosed absence.
	 *
	 * A path inside a linked worktree reports the WORKTREE it belongs to as well
	 * as the repository, because both are needed to offer the right action: the
	 * main tree offers "create", the worktree offers "merge back".
	 */
	async inspect(cwd) {
		const start = resolve(String(cwd ?? process.cwd()));
		const inside = await this.#findRepositoryRoot(start);
		if (inside.root === null) {
			return {
				ok: true,
				path: start,
				repo: { present: false, usable: false, reason: inside.reason ?? 'not-a-repository' },
				repoRoot: null,
				localRoot: inside.localRoot ?? null,
				repoKey: null,
				container: null,
				worktree: null,
				worktrees: []
			};
		}

		const status = await this.status(inside.root);
		const classification = classifyRepo({ root: inside.root, status, gitCommonDir: inside.commonDir });
		const list = await this.listWorktrees(inside.root);

		// Which of the recorded worktrees, if any, contains the session's path —
		// `git worktree list` alone cannot say, because the session may sit in a
		// subdirectory of one. The MAIN working tree is in that same list and must
		// be excluded here: treating it as a worktree would offer "merge back" on an
		// ordinary checkout instead of "create", and would count its drift against
		// itself. The branch it was cut from is read back from the metadata written
		// at creation time; without it, drift would be counted against the wrong
		// side and always read as zero.
		const here = list.find((entry) => !samePath(entry.path, inside.mainTop) && within(entry.path, start)) ?? null;
		const record = here === null
			? null
			: await this.worktreeState(inside.root, here, { base: (await this.#readMeta(here.path))?.base });

		return {
			ok: true,
			path: start,
			// `repoRoot` is the MAIN working tree — the one that owns the branch a
			// delivery merges into. `localRoot` is where the session actually is,
			// which differs whenever the agent is working inside a worktree.
			repoRoot: inside.root,
			localRoot: inside.localRoot ?? inside.root,
			gitDir: inside.gitDir,
			gitCommonDir: inside.commonDir,
			repoKey: repoKey(inside.commonDir),
			container: worktreeContainer(inside.root, { layout: this.layout }),
			layout: this.layout,
			repo: {
				...classification,
				branch: status.branch,
				head: status.head,
				detached: status.detached,
				unborn: status.unborn,
				dirty: status.dirty,
				modified: status.staged + status.unstaged,
				untracked: status.untracked,
				conflicted: status.conflicted,
				ahead: status.ahead,
				behind: status.behind
			},
			worktree: record,
			worktrees: list
		};
	}

	/**
	 * `git status` for one repository or worktree, parsed, with `dirty` decided
	 * by CONTENT rather than by `status`'s entry list.
	 *
	 * Why that matters: `git status` can report an entry for a file whose
	 * stat information is stale relative to the index (a fresh checkout, a
	 * `core.autocrlf` filter, a filesystem with coarse timestamps). Treating such
	 * an entry as "the agent changed something" would make this plugin auto-commit
	 * and then merge a commit that contains NOTHING — history noise the user never
	 * asked for. `git diff --quiet` and `git diff --cached --quiet` compare real
	 * content and exit 1 only when there is a real difference.
	 *
	 * Uses the NON-throwing runner: a repository can disappear or be unreadable
	 * between two polls, and a status read is the one place that must degrade to
	 * "no repository here" instead of an error the UI has to special-case.
	 */
	async status(cwd) {
		const result = await this.#run(cwd, statusArgs({ cwd }));
		const status = result.exitCode !== 0 ? parseStatusV2('') : parseStatusV2(result.stdout);
		const real = await this.#realChanges(cwd);
		return {
			...status,
			dirty: real.dirty,
			// The file list keeps the status view (it has the nice porcelain paths)
			// but the counts follow the content check, so the two never disagree.
			staged: real.staged,
			unstaged: real.unstaged,
			untracked: real.untracked,
			entries: real.entries.length > 0 ? real.entries : status.entries
		};
	}

	/**
	 * Content-level change detection.
	 *
	 * `git diff --quiet` (1 = unstaged difference), `git diff --cached --quiet`
	 * (1 = staged difference) and `git ls-files --others --exclude-standard`
	 * (untracked files) together answer "would a commit or a merge lose, hide or
	 * create anything", without trusting stat data.
	 */
	async #realChanges(cwd) {
		const empty = { dirty: false, staged: 0, unstaged: 0, untracked: 0, entries: [] };
		if (!(await pathExists(cwd))) return empty;

		const [unstaged, staged, untracked] = await Promise.all([
			this.#run(cwd, gitArgs(['diff', '--quiet'], { cwd })),
			this.#run(cwd, gitArgs(['diff', '--cached', '--quiet'], { cwd })),
			this.#run(cwd, gitArgs(['ls-files', '--others', '--exclude-standard', '-z'], { cwd }))
		]);
		if (unstaged.exitCode !== 0 && unstaged.exitCode !== 1) return empty;

		const names = await this.#run(cwd, gitArgs(['diff', '--name-only'], { cwd }));
		const stagedNames = await this.#run(cwd, gitArgs(['diff', '--cached', '--name-only'], { cwd }));
		const untrackedNames = untracked.exitCode === 0
			? String(untracked.stdout ?? '').split('\0').filter((name) => name !== '')
			: [];

		const entries = [
			...splitLines(names.stdout).map((name) => `1 M. ${name}`),
			...splitLines(stagedNames.stdout).map((name) => `1 .M ${name}`),
			...untrackedNames.map((name) => `? ${name}`)
		];

		return {
			dirty: unstaged.exitCode === 1 || staged.exitCode === 1 || untrackedNames.length > 0,
			staged: splitLines(stagedNames.stdout).length,
			unstaged: splitLines(names.stdout).length,
			untracked: untrackedNames.length,
			entries
		};
	}

	/** Every linked worktree git knows about, main tree included. */
	async listWorktrees(cwd) {
		const result = await this.#run(cwd, gitArgs(['worktree', 'list', '--porcelain', '-z'], { cwd }));
		if (result.exitCode !== 0) return [];
		return parseWorktreePorcelain(result.stdout);
	}

	/**
	 * How far one worktree has drifted, and whether it can be delivered.
	 *
	 * `ahead`/`baseAhead` come from `rev-list --count` on the two sides; the base
	 * branch is supplied by the caller (it is recorded at creation time, because
	 * a later `HEAD` may not be the branch the worktree was cut from).
	 */
	async worktreeState(repoRoot, entry, { base } = {}) {
		const path = typeof entry === 'string' ? entry : entry?.path;
		const exists = await pathExists(path);
		if (!exists) {
			return classifyWorktree({ present: false, path, head: entry?.head ?? null, branch: entry?.branch ?? null, base: base ?? null });
		}
		const status = await this.status(path);
		const head = await this.head(path);
		const baseBranch = typeof base === 'string' && base !== '' ? base : null;

		let ahead = 0;
		let baseAhead = 0;
		let baseHead = null;
		if (baseBranch !== null) {
			baseHead = await this.head(repoRoot, baseBranch);
			if (baseHead !== null && head !== null) {
				ahead = await this.count(repoRoot, `${baseHead}..${head}`);
				baseAhead = await this.count(repoRoot, `${head}..${baseHead}`);
			}
		}

		return classifyWorktree({
			present: true,
			path,
			head,
			branch: entry?.branch ?? status.branch,
			status,
			base: baseBranch,
			baseHead,
			mainHead: await this.head(repoRoot),
			ahead,
			baseAhead
		});
	}

	/** The commit a ref points at, or null when it does not exist (yet). */
	async head(cwd, ref = 'HEAD') {
		const result = await this.#run(cwd, gitArgs(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd }));
		if (result.exitCode !== 0) return null;
		const value = String(result.stdout ?? '').trim();
		return value === '' ? null : value;
	}

	/** `rev-list --count <range>`, 0 when the range is unusable. */
	async count(cwd, range) {
		const result = await this.#run(cwd, gitArgs(['rev-list', '--count', range], { cwd }));
		if (result.exitCode !== 0) return 0;
		const value = Number.parseInt(String(result.stdout ?? '').trim(), 10);
		return Number.isFinite(value) ? value : 0;
	}

	/** Whether `ancestor` is already contained in `descendant` — fast-forwardability. */
	async isAncestor(cwd, ancestor, descendant) {
		if (typeof ancestor !== 'string' || typeof descendant !== 'string') return false;
		const result = await this.#run(cwd, gitArgs(['merge-base', '--is-ancestor', ancestor, descendant], { cwd }));
		return result.exitCode === 0;
	}

	/**
	 * Whether merging `branch` into the current HEAD would conflict.
	 *
	 * `git merge-tree --write-tree` computes the merge WITHOUT touching the
	 * working tree, the index, HEAD or MERGE_* state (verified on git 2.52), so
	 * the plugin can report a conflict while the user's main tree is still
	 * untouched — which is strictly better than merging and rolling back.
	 *
	 * Exit 1 means conflict; exit 0 means clean. Any OTHER exit code means this
	 * git cannot answer the question (`merge-tree --write-tree` needs 2.38+), so
	 * the answer is "unknown" and the caller falls back to merging and aborting.
	 */
	async conflictsWith(cwd, branch) {
		const result = await this.#run(cwd, gitArgs(['merge-tree', '--write-tree', 'HEAD', branch], { cwd }));
		if (result.exitCode === 0) return { known: true, conflict: false };
		if (result.exitCode === 1) {
			return { known: true, conflict: true, paths: conflictedPaths(`${result.stdout}\n${result.stderr}`) };
		}
		return { known: false, conflict: false };
	}

	/** Whether a commit has an author identity to use (user.email, then user.name). */
	async hasIdentity(cwd) {
		const email = await this.#run(cwd, gitArgs(['config', '--get', 'user.email'], { cwd }));
		if (email.exitCode === 0 && String(email.stdout ?? '').trim() !== '') return true;
		const name = await this.#run(cwd, gitArgs(['config', '--get', 'user.name'], { cwd }));
		return name.exitCode === 0 && String(name.stdout ?? '').trim() !== '';
	}

	/* ----------------------------------------------------------- operations -- */

	/**
	 * Create the worktree, and report where it is.
	 *
	 * Every call mints a FRESH identity, so pressing the button twice produces two
	 * worktrees rather than reusing one — a second click that silently returns the
	 * first worktree reads as "nothing happened", which is exactly the confusion
	 * this replaced. The identity is collision-checked against both the filesystem
	 * and git's own worktree list, with a small bounded retry, so a same-millisecond
	 * double click inside one process still yields two distinct worktrees.
	 *
	 * The start point is resolved to an OID first and passed explicitly: between
	 * the click and the spawn the main tree can move, and a worktree that starts
	 * somewhere else than the UI promised is a bug nobody can see afterwards.
	 */
	async create(repoRoot, { branch, path: targetPath, startPoint, id } = {}) {
		const root = resolve(String(repoRoot));

		// A caller that supplies BOTH a path and a branch is fully explicit (a test,
		// or a script re-creating a known worktree); otherwise an identity is minted.
		const explicit = typeof targetPath === 'string' && targetPath !== '' && typeof branch === 'string' && branch !== '';

		const status = await this.status(root);
		const classification = classifyRepo({ root, status, gitCommonDir: await this.#commonDir(root) });
		if (!classification.usable) throw new GitFailure(classification.reason, '', { operation: 'create' });
		if (status.detached) throw new GitFailure('detached-head', '', { operation: 'create' });

		const startOid = (await this.head(root, startPoint ?? 'HEAD')) ?? status.head;
		if (startOid === null) throw new GitFailure('no-commits-yet', '', { operation: 'create' });

		const known = new Map((await this.listWorktrees(root)).map((entry) => [entry.path.toLowerCase(), entry]));
		let plan = null;
		let lastRefusal = null;
		for (let attempt = 0; attempt < 8 && plan === null; attempt += 1) {
			const candidateId = explicit ? 'explicit' : (typeof id === 'string' && id !== '' ? id : freshId());
			const candidatePath = explicit ? resolve(targetPath) : worktreePath(root, candidateId, { layout: this.layout });
			const candidateBranch = explicit ? branch : branchName(root, candidateId);

			// A path git cannot build is not worth a probe, and the refusal must name
			// the real limit rather than let git say `'$GIT_DIR' too big`.
			const length = pathLengthCheck(candidatePath);
			if (length.ok !== true) {
				throw new GitFailure(length.reason, `${length.length} characters (git refuses past ${length.ceiling})`, {
					operation: 'create'
				});
			}

			const taken = known.get(candidatePath.toLowerCase()) !== undefined || (await pathExists(candidatePath));
			const branchTaken = (await this.branchExists(root, candidateBranch)) === true;
			if (taken || branchTaken) {
				lastRefusal = new GitFailure('worktree-exists', candidatePath, { operation: 'create' });
				if (explicit) throw lastRefusal;
				continue;
			}
			plan = planCreate({
				localRoot: root,
				id: candidateId,
				branch: candidateBranch,
				startPoint: startOid,
				path: candidatePath,
				layout: this.layout
			});
		}
		if (plan === null) throw lastRefusal ?? new GitFailure('worktree-exists', '', { operation: 'create' });

		// The container is ignored BEFORE it exists: `git worktree add` is what
		// creates it, and a `git add -A` in the main tree racing between the two
		// would commit an entire parallel checkout.
		await this.#ignoreContainer(root, plan.container);

		await this.#must(root, gitArgs(plan.args, { cwd: root }), 'worktree-add');
		await this.#writeMeta(plan.path, {
			version: 1,
			branch: plan.branch,
			base: status.branch,
			startOid,
			localRoot: root,
			createdAt: new Date().toISOString(),
			plugin: 'dsh-local-worktree'
		});

		return {
			ok: true,
			reused: false,
			path: plan.path,
			branch: plan.branch,
			base: status.branch,
			baseHead: status.head,
			startOid,
			container: plan.container
		};
	}

	/** Whether a local branch already exists. */
	async branchExists(repoRoot, branch) {
		if (typeof branch !== 'string' || branch === '') return false;
		const result = await this.#run(repoRoot, gitArgs(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot }));
		return result.exitCode === 0;
	}

	/**
	 * Merge the worktree's commits into the main tree's branch, then clean up.
	 *
	 * The sequence, and why each part exists:
	 *
	 *   1. everything is DECIDED before anything is written (`planMerge`);
	 *   2. uncommitted worktree work is committed first, so a merge never loses
	 *      an agent's last edit;
	 *   3. the base revision is captured immediately before the merge, so the
	 *      plan can be invalidated if the main tree moved while we read it;
	 *   4. on any failure the main tree is rolled back with `merge --abort` and
	 *      the worktree is KEPT — a conflict must cost a retry, not the work.
	 */
	async deliver(repoRoot, entry, { base, message, cleanup = true, autoCommit = true, commitIgnored = false } = {}) {
		const root = resolve(String(repoRoot));
		const path = typeof entry === 'string' ? entry : entry?.path;
		if (typeof path !== 'string' || path === '') throw new GitFailure('worktree-missing', '', { operation: 'deliver' });
		if (!(await pathExists(path))) throw new GitFailure('worktree-missing', path, { operation: 'deliver' });

		const meta = await this.#readMeta(path);
		const baseBranch = typeof base === 'string' && base !== '' ? base : meta?.base ?? null;

		const mainStatus = await this.status(root);
		const worktreeStatus = await this.status(path);
		const worktreeHead = await this.head(path);
		const mainHead = await this.head(root);
		const baseHead = baseBranch === null ? null : await this.head(root, baseBranch);

		const ahead = baseHead !== null && worktreeHead !== null
			? await this.count(root, `${baseHead}..${worktreeHead}`)
			: 0;
		const baseAhead = baseHead !== null && worktreeHead !== null
			? await this.count(root, `${worktreeHead}..${baseHead}`)
			: 0;

		const commitMessage = typeof message === 'string' && message.trim() !== ''
			? message.trim()
			: suggestCommitMessage(worktreeStatus, { prefix: 'wip: dsh worktree checkpoint' });

		const worktreeBranch = typeof entry === 'object' && entry !== null
			? entry.branch
			: ((await this.#currentBranch(path)) ?? meta?.branch ?? null);

		const plan = planMerge({
			sameRepo: await this.#sameRepository(root, path),
			mainBranch: mainStatus.branch,
			base: baseBranch,
			mainHead,
			mainStatus,
			worktreeBranch,
			worktreeHead,
			worktreeDirty: worktreeStatus.dirty,
			commitMessage,
			autoCommit,
			commitIgnored,
			hasIdentity: worktreeStatus.dirty ? await this.hasIdentity(root) : true
		});

		if (plan.ok !== true) {
			return {
				ok: false,
				reason: plan.reason,
				detail: plan.detail ?? '',
				kept: true,
				worktree: { path, branch: plan.worktreeBranch ?? worktreeBranch, ahead, baseAhead, dirty: worktreeStatus.dirty }
			};
		}

		// Dry-run the merge when the two sides have diverged. `--ff` cannot
		// conflict, so a fast-forward skips this; a diverged merge gets an answer
		// from `merge-tree --write-tree`, which touches nothing — so a conflict is
		// reported while the main tree is still untouched rather than rolled back.
		let conflictCheck = { known: true, conflict: false };
		if (baseAhead > 0 && typeof worktreeBranch === 'string' && worktreeBranch !== '') {
			conflictCheck = await this.conflictsWith(root, worktreeBranch);
		}
		if (conflictCheck.conflict === true) {
			return {
				ok: false,
				reason: 'merge-conflict',
				detail: '',
				detectedBy: 'merge-tree',
				conflictPaths: conflictCheck.paths ?? [],
				aborted: false,
				kept: true,
				worktree: { path, branch: worktreeBranch, ahead, baseAhead, dirty: worktreeStatus.dirty }
			};
		}

		const steps = mergeSteps(plan);
		const executed = [];
		for (const step of steps) {
			// WHERE each step runs is part of the step's meaning, and the two
			// differ: the checkpoint commit belongs in the worktree (that is where
			// the agent's work is), while the merge belongs in the MAIN tree (that
			// is the branch the commits are being delivered to). Running the merge
			// in the worktree merges the branch into itself, reports "Already up to
			// date" and silently delivers nothing.
			const inWorktree = step.id === 'stage' || step.id === 'commit';
			const cwd = inWorktree ? path : root;
			const result = await this.#run(cwd, gitArgs(step.args, { cwd }));
			executed.push({ id: step.id, exitCode: result.exitCode, cwd: inWorktree ? 'worktree' : 'main' });
			if (result.exitCode !== 0) {
				if (step.id === 'commit' && /nothing to commit|no changes added/i.test(`${result.stdout}${result.stderr}`)) {
					// A tree that is dirty only through ignored files has nothing to
					// commit; that is not a failure, and the merge can continue.
					continue;
				}
				if (step.abortOnFailure === true) await this.#abort(root);
				const reason = classifyGitFailure(result);
				return {
					ok: false,
					reason,
					detail: '',
					quoted: quotedFromGit(`${result.stderr}\n${result.stdout}`),
					aborted: step.abortOnFailure === true,
					kept: true,
					worktree: { path, branch: plan.worktreeBranch, ahead: 0, baseAhead, dirty: worktreeStatus.dirty }
				};
			}
		}

		// The merge reported success; confirm it actually landed before claiming it.
		const finalMainHead = await this.head(root);
		const landed = worktreeHead === null ? false : await this.isAncestor(root, worktreeHead, finalMainHead ?? 'HEAD');
		if (!landed) {
			await this.#abort(root);
			return { ok: false, reason: 'git-error', detail: 'the merge did not land', aborted: true, kept: true };
		}

		// Whether a checkpoint commit was really made is read from the EXECUTED steps,
		// not from the plan: a plan can carry a `preCommit` that staged nothing (a tree
		// dirty only through ignored paths), and reporting a commit that git never made
		// would put a number on the button's result that history does not contain.
		const checkpointed = executed.some((step) => step.id === 'commit' && step.exitCode === 0);
		// The shape is decided by whether the BASE had moved BEFORE the merge — that is
		// the question `describeMerge` answers. Measuring it after the fact from the
		// pre-merge worktree HEAD counts the checkpoint commit itself as "the base moved
		// on", so every delivery that checkpointed work was reported as a merge commit
		// even when git fast-forwarded it (verified: no merge commit in the history).
		const shape = describeMerge({ baseAhead });
		const summary = {
			ok: true,
			strategy: shape.strategy,
			strategyText: shape.text,
			base: baseBranch,
			branch: plan.worktreeBranch,
			// The checkpoint commit IS one of the commits this delivery brings to the
			// base branch, so leaving it out under-reported a successful merge as
			// "0 commit(s)" — the count the user reads after the click.
			commits: ahead + (checkpointed ? 1 : 0),
			mainHead: finalMainHead,
			worktreeHead,
			preCommitted: checkpointed,
			executed
		};

		if (cleanup === true) summary.cleanup = await this.cleanup(root, { path, branch: plan.worktreeBranch });
		return summary;
	}

	/**
	 * Commit whatever is uncommitted in one directory — the button's own verb.
	 *
	 * Deliberately the SAME steps the automatic checkpoint inside `deliver` runs
	 * (`stageArgs`, then `commit -m`), so pressing the button and letting a delivery
	 * checkpoint the work produce the identical commit. Nothing here is invented for
	 * the button: a repository's hooks run, no pathspec is narrowed, and the subject
	 * comes from {@link suggestCommitMessage} over the change list the caller
	 * already read.
	 *
	 * `commitIgnored` is passed through rather than defaulted here, so the default
	 * (and its reasoning) lives in exactly one place — {@link stageArgs}.
	 *
	 * The refusals come BEFORE the stage, because staging is a write: a clean tree
	 * would otherwise be turned into an empty commit attempt, and a missing
	 * identity into a `git add` the user never asked for.
	 */
	async commit(cwd, { message, commitIgnored = false } = {}) {
		const where = resolve(String(cwd));
		const status = await this.status(where);
		if (status.dirty !== true) {
			return { ok: false, reason: 'nothing-to-commit', path: where, changes: 0 };
		}

		const changes = Number(status.staged ?? 0) + Number(status.unstaged ?? 0) + Number(status.untracked ?? 0);
		const subject = typeof message === 'string' && message.trim() !== ''
			? message.trim()
			: suggestCommitMessage(status, { prefix: DEFAULT_COMMIT_MESSAGE });

		if ((await this.hasIdentity(where)) !== true) {
			return { ok: false, reason: 'identity-missing', path: where, changes, message: subject };
		}

		// The SAME argv the automatic checkpoint inside `deliver` uses, from the same
		// function, so pressing the button and letting a delivery checkpoint the work
		// can never commit different sets of files.
		const staged = await this.#run(where, gitArgs(stageArgs({ forceIgnored: commitIgnored === true }), { cwd: where }));
		if (staged.exitCode !== 0) {
			return { ok: false, reason: classifyGitFailure(staged), detail: '', quoted: quotedFromGit(staged.stderr), path: where, changes };
		}

		// No `--no-verify`: the repository's own `pre-commit` hook (a secret scanner,
		// a linter) exists to stop exactly this kind of commit, and skipping it would
		// be this plugin deciding that the user's guard does not apply.
		const committed = await this.#run(where, gitArgs(['commit', '-m', subject, '--'], { cwd: where }));
		if (committed.exitCode !== 0) {
			if (/nothing to commit|no changes added/i.test(`${committed.stdout}${committed.stderr}`)) {
				// A tree dirty only through ignored files stages nothing; that is not a
				// failure, and it is reported as the no-op it is.
				return { ok: false, reason: 'nothing-to-commit', path: where, changes: 0 };
			}
			return { ok: false, reason: classifyGitFailure(committed), detail: '', quoted: quotedFromGit(committed.stderr), path: where, changes };
		}

		return { ok: true, path: where, message: subject, changes, head: await this.head(where) };
	}

	/**
	 * Remove a finished worktree and its own branch.
	 *
	 * `-d` (never `-D`) for the branch: if the commits are not merged, git
	 * refuses and the branch survives. Silently forcing that delete is how a
	 * plugin loses somebody's only copy of a day's work.
	 *
	 * Removal is RETRIED, but only for one reason: `path-in-use`. That is the
	 * Windows case — a directory cannot be deleted while a live process holds it
	 * (its current directory, an open handle to a file inside, a scanner that just
	 * read the tree), and such a hold is usually gone a few hundred milliseconds
	 * later. A dirty worktree, a bad ref or a refusal is a decision, not a race,
	 * and retrying those would only make the button feel slow.
	 *
	 * When git still refuses, the worktree has ALREADY lost its contents:
	 * `git worktree remove` deletes every file first and removes the directory
	 * itself last. A refused last step therefore leaves an EMPTY shell, and — once
	 * the next `git worktree prune` drops its metadata — an orphan directory plus
	 * an orphan branch that nothing ever cleans up. That shell is reclaimed here,
	 * but only when it holds no file at all and no `.git` marker, which is exactly
	 * the state git left it in; anything else is the user's directory.
	 */
	async cleanup(repoRoot, { path, branch, force = false, attempts = REMOVE_ATTEMPTS } = {}) {
		const root = resolve(String(repoRoot));
		const target = typeof path === 'string' && path !== '' ? resolve(path) : String(path ?? '');
		const deleteBranch = typeof branch === 'string' && OWN_BRANCH.test(branch);
		const results = [];

		// The removal is not taken from `cleanupSteps`, because it is the one step
		// that is retried and whose empty-shell outcome is inspected. The argv still
		// comes from `#removeWorktree`, which builds it from the same place.
		const removal = await this.#removeWorktree(root, target, { force, attempts });
		results.push(removal.step);
		if (removal.ok !== true) {
			if ((await this.#reclaimShell(target)) !== true) {
				return { ok: false, removed: false, reason: removal.reason, detail: removal.detail, steps: results };
			}
			results.push({ id: 'reclaim', ok: true, reason: removal.reason });
		}

		// Branch and prune still come from `cleanupSteps`, so their argv lives in
		// git.js with everything else. A branch delete that git refuses (`-d`, an
		// unmerged branch) is data, not a failed cleanup.
		for (const step of cleanupSteps({ path: target, branch, force, deleteBranch }).filter((entry) => entry.id !== 'remove')) {
			const result = await this.#run(root, gitArgs(step.args, { cwd: root }));
			if (result.exitCode !== 0) {
				results.push({ id: step.id, ok: false, reason: classifyGitFailure(result) });
				continue;
			}
			results.push({ id: step.id, ok: true });
		}
		await this.#removeEmptyContainer(root, target);
		return { ok: true, removed: true, branchDeleted: results.some((entry) => entry.id === 'branch' && entry.ok), steps: results };
	}

	/** Discard a worktree without merging: the explicit "throw this away". */
	async discard(repoRoot, { path, branch } = {}) {
		const root = resolve(String(repoRoot));
		if (!(await pathExists(path))) {
			await this.#run(root, gitArgs(['worktree', 'prune'], { cwd: root }));
			await this.#removeEmptyContainer(root, path);
			return { ok: true, removed: true, branchDeleted: typeof branch === 'string' ? await this.deleteBranch(root, branch) : false };
		}
		const result = await this.cleanup(root, { path, branch, force: true });
		return { ok: result.ok, removed: result.removed, reason: result.reason ?? null, branchDeleted: result.branchDeleted === true };
	}

	/** Delete a branch, but only one of ours and only if fully merged. */
	async deleteBranch(repoRoot, branch) {
		if (typeof branch !== 'string' || !OWN_BRANCH.test(branch)) return false;
		const result = await this.#run(repoRoot, gitArgs(['branch', '-d', branch], { cwd: repoRoot }));
		return result.exitCode === 0;
	}

	/** A short human summary for a status payload. */
	async drift(repoRoot, entry, { base } = {}) {
		const state = await this.worktreeState(repoRoot, entry, { base });
		return { ...state, text: driftText(state) };
	}

	/* -------------------------------------------------------------- private -- */

	/**
	 * Keep the inside-layout container out of the repository's own git status.
	 *
	 * `.git/info/exclude` and not `.gitignore`: the line stays local to this
	 * clone, so the plugin never appears in a commit or in a collaborator's
	 * diff. `rev-parse --git-path` resolves the right file from any worktree of
	 * the repository (the index is shared), and `info/` is created when a fresh
	 * repository has none — `git init` does not always write one.
	 */
	async #ignoreContainer(root, container) {
		if (this.layout !== 'inside' || typeof container !== 'string' || container === '') return false;
		const pattern = containerExcludePattern();
		try {
			const reported = String((await this.#run(root, gitArgs(['rev-parse', '--git-path', 'info/exclude'], { cwd: root }))).stdout ?? '').trim();
			const file = reported === '' ? join(root, '.git', 'info', 'exclude') : resolve(root, reported);
			let current = '';
			try {
				current = await readFile(file, 'utf8');
			} catch {
				// Absent is the normal case for a repository that never excluded anything.
			}
			if (current.split(/\r?\n/).some((line) => line.trim() === pattern)) return true;
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, `${current === '' || current.endsWith('\n') ? current : `${current}\n`}${pattern}\n`, 'utf8');
			return true;
		} catch (error) {
			// The worktree is still correct; it is only visible to git, which the
			// next `git add -A` in the main tree would turn into a committed
			// parallel checkout. Worth a warning rather than a failed click.
			this.onWarn(`dsh-local-worktree: could not exclude ${container} from ${root}: ${error?.message ?? error}`);
			return false;
		}
	}

	/**
	 * Drop an inside-layout container once its last worktree is gone.
	 *
	 * `rmdir` succeeds only on an empty directory, which is exactly the
	 * condition to check: a container that still holds another worktree, or a
	 * file the user put there, survives untouched. The exclude line stays —
	 * removing it would rewrite repository state for no benefit, and it is
	 * inert while the directory is absent.
	 */
	async #removeEmptyContainer(root, removedPath) {
		if (this.layout !== 'inside' || typeof removedPath !== 'string' || removedPath === '') return false;
		const container = worktreeContainer(root, { layout: this.layout });
		if (!within(container, removedPath)) return false;
		try {
			await rmdir(container);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Run the removal step, retrying only a path that is momentarily in use.
	 *
	 * Returns git's own first error line as `detail` when it gives up, so a caller
	 * can say WHY a worktree survived instead of only that it did.
	 */
	async #removeWorktree(root, path, { force = false, attempts = REMOVE_ATTEMPTS } = {}) {
		if (typeof path !== 'string' || path === '') {
			return { ok: false, reason: 'invalid-path', detail: '', step: { id: 'remove', ok: false, reason: 'invalid-path', attempts: 0 } };
		}
		const args = gitArgs(['worktree', 'remove', ...(force === true ? ['--force'] : []), '--', path], { cwd: root });
		const total = Math.max(1, Number(attempts) || 1);
		let failure = null;
		let tried = 0;
		for (let attempt = 1; attempt <= total; attempt += 1) {
			tried = attempt;
			const result = await this.#run(root, args);
			if (result.exitCode === 0) {
				return { ok: true, step: { id: 'remove', ok: true, attempts: attempt } };
			}
			const current = { reason: classifyGitFailure(result), detail: firstLine(result.stderr) || firstLine(result.stdout) };
			// A first attempt that emptied the tree makes the NEXT attempt answer
			// `worktree-gone` (its `.git` pointer is gone), which describes the
			// consequence, not the cause. The cause — the busy path — is what the user
			// needs, so it is the one kept.
			if (failure === null || current.reason !== 'worktree-gone') failure = current;
			// Only a busy path can stop being busy on its own. Anything else — a dirty
			// worktree, a bad ref, an unregistered path — is an answer, and asking
			// again would produce the same answer more slowly.
			if (current.reason !== 'path-in-use') break;
			if (attempt < total) await this.sleep(REMOVE_BACKOFF_MS[Math.min(attempt - 1, REMOVE_BACKOFF_MS.length - 1)]);
		}
		const step = { id: 'remove', ok: false, reason: failure.reason, detail: failure.detail, attempts: tried };
		return { ok: false, reason: failure.reason, detail: failure.detail, step };
	}

	/**
	 * Delete the empty shell a refused removal leaves behind.
	 *
	 * Guarded twice, because deleting a directory is not undoable: the path must
	 * hold NO entry at all (git deleted every file already, so nothing can be lost)
	 * and must have no `.git` marker (so git still considers it a working tree only
	 * when it does). A path that is already gone counts as reclaimed.
	 */
	async #reclaimShell(path) {
		if (typeof path !== 'string' || path === '') return false;
		if ((await pathExists(path)) !== true) return true;
		if ((await gitMarker(path)) !== null) return false;
		let entries;
		try {
			entries = await readdir(path);
		} catch {
			return false;
		}
		if (entries.length !== 0) return false;
		try {
			await rmdir(path);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * The repository containing `start`, found by walking up.
	 *
	 * A linked worktree and a normal repository both have `.git`, but as a FILE (a
	 * `gitdir:` pointer) in the worktree's case. That is the trap this method
	 * exists to avoid: `git rev-parse --show-toplevel` inside a linked worktree
	 * answers with THE WORKTREE, not the main working tree — so a session running
	 * in a worktree would be told its repository root is the worktree, and every
	 * drift count computed against "HEAD" would be counted against itself (always
	 * zero). The main working tree is derived from the COMMON git dir instead.
	 */
	async #findRepositoryRoot(start) {
		for (const candidate of ancestors(start)) {
			const marker = await gitMarker(candidate);
			if (marker === null) continue;
			const paths = await this.#revParsePaths(candidate);
			if (paths === null) {
				return { root: candidate, localRoot: candidate, mainTop: candidate, gitDir: resolve(candidate, '.git'), commonDir: resolve(candidate, '.git'), reason: null };
			}
			const main = await this.#mainWorktreeRoot(candidate, paths.commonDir);
			return { ...paths, root: main.root, localRoot: main.localRoot, mainTop: main.mainTop, reason: main.reason };
		}
		return { root: null, localRoot: null, mainTop: null, gitDir: null, commonDir: null, reason: 'not-a-repository' };
	}

	/**
	 * The working tree that owns the repository, the working tree we are in, and
	 * the main working tree's own top level.
	 *
	 * All three are needed and they are not the same directory: the session may be
	 * inside a linked worktree (`localRoot`), the branch a delivery merges into
	 * belongs to the main working tree (`root`), and `mainTop` is how that main
	 * tree identifies its own `git worktree list` entry — the entry that must NOT
	 * be mistaken for a worktree of ours.
	 *
	 * A submodule is deliberately refused. Its git dir is NOT
	 * `<common>/worktrees/<name>`, so the "parent of the common dir" rule below
	 * would name the superproject and the plugin would offer to merge a
	 * submodule's branch into the wrong repository.
	 */
	async #mainWorktreeRoot(at, commonDir) {
		const top = (await this.#run(at, gitArgs(['rev-parse', '--show-toplevel'], { cwd: at }))).stdout.trim();
		const localRoot = top === '' ? resolve(at) : resolve(top);

		// A submodule has a git dir that is not `<common>/worktrees/<name>`, so
		// reading `core.worktree` is the reliable signal. It is set only there.
		const coreWorktree = await this.#run(localRoot, gitArgs(['config', '--get', 'core.worktree'], { cwd: localRoot }));
		if (coreWorktree.exitCode === 0 && coreWorktree.stdout.trim() !== '') {
			return { root: null, localRoot, mainTop: localRoot, reason: 'submodule-unsupported' };
		}

		// `<main>/.git` for a normal repository, `<main>/.git/worktrees/<name>` for a
		// linked worktree. Walking up past any `worktrees` component finds `<main>`.
		let current = resolve(commonDir);
		for (;;) {
			const parent = dirname(current);
			if (parent === current) break;
			if (basename(current) === 'worktrees' || basename(parent) === '.git') {
				return { root: parent, localRoot, mainTop: resolve(parent), reason: null };
			}
			current = parent;
		}
		const root = dirname(resolve(commonDir));
		return { root, localRoot, mainTop: root, reason: null };
	}

	async #revParsePaths(cwd) {
		const result = await this.#run(cwd, gitArgs(['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'], { cwd }));
		if (result.exitCode !== 0) return null;
		const [top, gitDir, commonDir] = String(result.stdout ?? '').split(/\r?\n/);
		if (top === undefined || top === '' || gitDir === undefined || commonDir === undefined) return null;
		return {
			root: resolve(top.trim()),
			gitDir: resolve(cwd, gitDir.trim()),
			commonDir: resolve(cwd, commonDir.trim()),
			reason: null
		};
	}

	async #commonDir(cwd) {
		const paths = await this.#revParsePaths(cwd);
		return paths?.commonDir ?? null;
	}

	async #currentBranch(cwd) {
		const result = await this.#run(cwd, gitArgs(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd }));
		if (result.exitCode !== 0) return null;
		const value = String(result.stdout ?? '').trim();
		return value === '' ? null : value;
	}

	/**
	 * Whether two paths are the same repository.
	 *
	 * Compared through the COMMON git dir, so a main tree and its own worktree
	 * pass (that is the intended pairing) while a worktree of a different clone
	 * fails even if the branch names happen to match.
	 */
	async #sameRepository(a, b) {
		const left = await this.#commonDir(a);
		const right = await this.#commonDir(b);
		if (left === null || right === null) return false;
		return samePath(left, right);
	}

	/** Roll the main tree back to its pre-merge state, warning if that fails. */
	async #abort(repoRoot) {
		const { args } = planAbort();
		const result = await this.#run(repoRoot, gitArgs(args, { cwd: repoRoot }));
		if (result.exitCode !== 0) {
			// The rollback failing is the one case a user MUST hear about, so it is
			// reported rather than swallowed: `merge --abort` failing can mean a
			// conflict was resolved by hand mid-merge.
			this.onWarn(`dsh-local-worktree: merge --abort failed in ${repoRoot}: ${String(result.stderr ?? '').trim()}`);
		}
		return result.exitCode === 0;
	}

	/**
	 * Where this worktree's own bookkeeping belongs.
	 *
	 * NOT in the working tree: a file inside the worktree shows up in `git
	 * status`, gets swept into the agent's next `git add -A`, and is then MERGED
	 * INTO THE USER'S BRANCH — which is how a plugin's scratch file ends up in
	 * somebody's history. A linked worktree has its own git directory
	 * (`<common>/worktrees/<name>`, named after the path's basename, NOT the
	 * branch), and that directory is invisible to every git command.
	 */
	async #metaDir(worktreePath) {
		const marker = resolve(worktreePath, '.git');
		try {
			const info = await stat(marker);
			if (info.isDirectory()) return marker;
			const text = await readFile(marker, 'utf8');
			const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
			if (match === null) return marker;
			return resolve(dirname(marker), match[1]);
		} catch {
			// No marker: fall back to the worktree itself, and expect the write to
			// fail loudly in the warning rather than silently landing in the tree.
			return marker;
		}
	}

	async #writeMeta(path, value) {
		try {
			const dir = await this.#metaDir(path);
			await writeFile(join(dir, META_FILE), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
			return true;
		} catch (error) {
			// Losing the metadata costs convenience, not correctness: the registry
			// and `git worktree list` both still know about the worktree.
			this.onWarn(`dsh-local-worktree: could not write worktree metadata for ${path}: ${error?.message ?? error}`);
			return false;
		}
	}

	async #readMeta(path) {
		for (const candidate of [join(await this.#metaDir(path), META_FILE), resolve(path, META_FILE)]) {
			try {
				const parsed = JSON.parse(await readFile(candidate, 'utf8'));
				if (parsed !== null && typeof parsed === 'object') return parsed;
			} catch {
				// Try the next location; an absent metadata file is normal.
			}
		}
		return null;
	}

	/**
	 * Run git IN a directory, tolerating a non-zero exit.
	 *
	 * The directory is the first argument on purpose. Every earlier revision of
	 * this file that passed `cwd` in an options object eventually ran a command in
	 * the wrong repository — a `git merge` that merges the worktree's own branch
	 * reports "Already up to date" and looks like a success. Naming the directory
	 * where each command belongs makes that class of mistake visible at the call
	 * site.
	 */
	async #run(cwd, args) {
		let result;
		try {
			result = await this.run(args, { cwd });
		} catch (error) {
			if (error?.code === 'ENOENT') throw new GitFailure('git-missing', String(error?.message ?? error), { args });
			throw error;
		}
		if (result === null || typeof result !== 'object') {
			return { exitCode: 1, stdout: '', stderr: 'the git runner returned nothing' };
		}
		return {
			exitCode: Number(result.exitCode) || 0,
			stdout: String(result.stdout ?? ''),
			stderr: String(result.stderr ?? '')
		};
	}

	/**
	 * Run git in a directory and require success, converting every failure into a
	 * GitFailure. Only OPERATIONS use this; reads go through {@link #run} and treat
	 * a non-zero exit as data, because a status poll must not throw when a
	 * repository is deleted out from under a live session.
	 */
	async #must(cwd, args, operation) {
		let result;
		try {
			result = await this.run(args, { cwd });
		} catch (error) {
			const reason = error?.code === 'ENOENT' ? 'git-missing' : (error?.killed === true ? 'git-timeout' : 'git-failed');
			throw new GitFailure(reason, String(error?.message ?? error), { operation, args });
		}
		if (result === null || typeof result !== 'object') {
			throw new GitFailure('git-failed', 'the git runner returned nothing', { operation, args });
		}
		if (result.exitCode !== 0) {
			const stdout = String(result.stdout ?? '');
			const stderr = String(result.stderr ?? '');
			throw new GitFailure(classifyGitFailure({ stdout, stderr, exitCode: result.exitCode }), '', {
				operation,
				args,
				exitCode: result.exitCode,
				stdout,
				stderr
			});
		}
		return result;
	}
}

/** Whether a path exists (any type). */
async function pathExists(path) {
	if (typeof path !== 'string' || path === '') return false;
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Non-empty lines of git output, CRLF-tolerant. */
function splitLines(text) {
	return String(text ?? '')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== '');
}

/**
 * git's first error line, as one short sentence.
 *
 * The reason code is what the UI branches on; this is what the user reads next to
 * it, so it is capped rather than allowed to paste a whole git diagnostic into a
 * menu.
 */
function firstLine(text) {
	const line = splitLines(text)[0] ?? '';
	return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1)}…` : line;
}

/** `.git` as a directory or a file, or null when this directory has neither. */
async function gitMarker(directory) {
	try {
		const info = await stat(resolve(directory, '.git'));
		return info.isDirectory() ? 'dir' : 'file';
	} catch {
		return null;
	}
}

export { pathExists, worktreePath };
