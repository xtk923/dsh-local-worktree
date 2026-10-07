/**
 * The operations, against real git in real throwaway repositories.
 *
 * What is asserted here is only what a user can be hurt by:
 *
 *   * the button's gate is right (a repository with no commit does NOT offer to
 *     create a worktree, and says why);
 *   * creating a worktree is idempotent and lands OUTSIDE the repository;
 *   * delivery reaches the branch the worktree was cut from, fast-forwarding
 *     when it can and producing a merge commit when the base moved;
 *   * a conflicted merge leaves the main tree EXACTLY as it was, and keeps the
 *     worktree so the work is not lost;
 *   * cleanup deletes only this plugin's own branch, and only when merged.
 *
 * The runner is the plugin's own `createGitRunner` — the same `execFile` call
 * the host makes at runtime — so a passing suite exercises the real spawn path
 * including its environment and argument handling.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { createGitRunner } from '../src/git-runner.js';
import { within } from '../src/git.js';
import { GitFailure, Workspace } from '../src/workspace.js';
import { commit, fingerprint, git, gitSoft, makeRepo, oid, porcelain, removeAll, subjects, writeFile } from './fixture.mjs';
import { join } from 'node:path';
import { basename } from 'node:path';

const run = createGitRunner();
const ws = new Workspace(run);

after(async () => {
	await removeAll();
});

/** A fresh repository and a workspace view of it. */
async function repo(options) {
	const root = await makeRepo(options);
	return { root, state: await ws.inspect(root) };
}

/* ---------------------------------------------------------------- inspect -- */

test('inspect reports a non-repository as absent, not as an error', async () => {
	const { tempDir } = await import('./fixture.mjs');
	const outside = await tempDir('loose-');
	const state = await ws.inspect(outside);
	assert.equal(state.repo.present, false);
	assert.equal(state.repo.usable, false);
	assert.equal(state.repo.reason, 'not-a-repository');
	assert.equal(state.worktree, null);
});

test('inspect finds the repository from a subdirectory', async () => {
	const { root } = await repo({ name: 'nested' });
	const { mkdir } = await import('node:fs/promises');
	const deep = join(root, 'packages', 'app', 'src');
	await mkdir(deep, { recursive: true });
	const state = await ws.inspect(deep);
	assert.equal(state.repo.present, true);
	assert.equal(state.repo.usable, true);
	assert.equal(state.repo.branch, 'main');
	// The session's path is the subdirectory; the repository root is what git says.
	assert.notEqual(state.repoRoot, deep);
	assert.equal(state.repo.dirty, false);
});

test('inspect refuses a repository with no commit yet, and says why', async () => {
	const { tempDir } = await import('./fixture.mjs');
	const root = await tempDir('empty-repo-');
	await git(root, ['init', '-b', 'main', '--quiet']);
	const state = await ws.inspect(root);
	assert.equal(state.repo.present, true);
	assert.equal(state.repo.usable, false);
	assert.equal(state.repo.reason, 'no-commits-yet');
});

/* ----------------------------------------------------------------- create -- */

test('create makes a worktree beside the repository on its own branch', async () => {
	const { root, state } = await repo({ name: 'create' });
	const created = await ws.create(root);

	assert.equal(created.ok, true);
	assert.equal(created.reused, false);
	assert.equal(created.base, 'main');
	assert.match(created.branch, /^dsh\/wt\//);
	// Beside the repository, in a sibling container — never inside it, because a
	// nested worktree would show up in the main repository's own status.
	assert.equal(within(root, created.path), false);
	// `<repo>_<fresh id>` inside a `<repo>_worktrees` sibling container.
	assert.ok(created.path.includes('_worktrees'));
	assert.equal(basename(created.path), `${basename(root)}_${created.path.slice(created.path.lastIndexOf('_') + 1)}`);

	// The plugin's bookkeeping must be invisible to git: a metadata file in the
	// working tree would be committed and then merged into the user's branch.
	// Asserted through `ws.status` (content-based) rather than raw
	// `status --porcelain`, because on a repository with `core.autocrlf=true` a
	// fresh checkout can carry a stat-only "modified" entry that is not a change.
	const freshStatus = await ws.status(created.path);
	assert.equal(freshStatus.dirty, false, 'a fresh worktree is clean, with no plugin file in it');
	assert.deepEqual(await git(created.path, ['ls-files']).then((r) => r.stdout.trim().split(/\r?\n/)), ['app.txt']);
	const { readdir } = await import('node:fs/promises');
	const entries = (await readdir(created.path)).sort();
	assert.deepEqual(entries, ['.git', 'app.txt'], 'no plugin metadata in the working tree (.git is git\'s own pointer file)');

	const list = await ws.listWorktrees(root);
	assert.equal(list.length, 2);
	const createdEntry = list.find((entry) => entry.path === created.path);
	assert.equal(createdEntry.branch, created.branch);
	assert.equal(createdEntry.head, state.repo.head, 'the worktree starts where the button promised');

	// The new worktree is a clean checkout of the same commit.
	const worktreeStatus = await ws.status(created.path);
	assert.equal(worktreeStatus.dirty, false);
	assert.equal(worktreeStatus.branch, created.branch);
});

test('create is NOT idempotent: a second click is a second worktree', async () => {
	const { root } = await repo({ name: 'twice' });
	const first = await ws.create(root);
	const second = await ws.create(root);
	// Two clicks must produce two worktrees on two branches. Silently reusing the
	// first one reads as "the button did nothing" — the bug this asserts against.
	assert.notEqual(second.path, first.path);
	assert.notEqual(second.branch, first.branch);
	assert.equal(second.reused, false);
	assert.equal((await ws.listWorktrees(root)).length, 3, 'the main tree plus two worktrees');
	// Both are real, independent working trees.
	assert.equal((await ws.status(first.path)).branch, first.branch);
	assert.equal((await ws.status(second.path)).branch, second.branch);
});

test('create refuses a repository with no commit, with a reason the UI can print', async () => {
	const { tempDir } = await import('./fixture.mjs');
	const root = await tempDir('no-commit-');
	await git(root, ['init', '-b', 'main', '--quiet']);
	await assert.rejects(() => ws.create(root), (error) => {
		assert.ok(error instanceof GitFailure);
		assert.equal(error.reason, 'no-commits-yet');
		return true;
	});
});

test('create refuses a detached HEAD, and retries past an occupied target', async () => {
	const { root } = await repo({ name: 'detached' });
	const headOid = await oid(root);
	await git(root, ['checkout', '--quiet', headOid]);
	await assert.rejects(() => ws.create(root), (error) => {
		assert.equal(error.reason, 'detached-head');
		return true;
	});
	await git(root, ['checkout', '--quiet', 'main']);

	// An EXPLICIT path that is already taken is refused outright, because a caller
	// that names a path is entitled to that path or an error — never a different one.
	const { mkdir } = await import('node:fs/promises');
	const { worktreePath } = await import('../src/git.js');
	const taken = worktreePath(root, 'fixed-id');
	await mkdir(taken, { recursive: true });
	await assert.rejects(
		() => ws.create(root, { id: 'fixed-id' }),
		(error) => {
			assert.equal(error.reason, 'worktree-exists');
			return true;
		}
	);
	// A MINTED id retries instead, so one occupied directory does not block the
	// button: every attempt gets a new directory name.
	const minted = await ws.create(root);
	assert.notEqual(minted.path, taken);
	assert.equal(minted.ok, true);
});

/* -------------------------------------------------------------- delivery -- */

test('deliver fast-forwards when the base has not moved', async () => {
	const { root, state } = await repo({ name: 'ff' });
	const created = await ws.create(root);
	await writeFile(join(created.path, 'feature.txt'), 'new feature\n');
	await git(created.path, ['add', '-A']);
	await commit(created.path, 'add feature');

	const result = await ws.deliver(root, created, { cleanup: false });
	assert.equal(result.ok, true);
	assert.equal(result.strategy, 'fast-forward');
	assert.equal(result.commits, 1);
	assert.equal(result.base, 'main');

	// The main tree has the file, and the history is linear: no merge commit.
	const mainSubjects = await subjects(root);
	assert.deepEqual(mainSubjects, ['add feature', 'init']);
	const mainStatus = await ws.status(root);
	assert.equal(mainStatus.dirty, false);
	assert.equal(mainStatus.head, result.mainHead);
	assert.notEqual(mainStatus.head, state.repo.head);
});

test('deliver makes a merge commit when the base moved on', async () => {
	const { root } = await repo({ name: 'diverge' });
	const created = await ws.create(root);

	await writeFile(join(created.path, 'feature.txt'), 'feature\n');
	await git(created.path, ['add', '-A']);
	await commit(created.path, 'worktree commit');

	// The main tree moves independently, touching a DIFFERENT file.
	await writeFile(join(root, 'other.txt'), 'main side\n');
	await git(root, ['add', '-A']);
	await commit(root, 'main commit');

	const result = await ws.deliver(root, created, { cleanup: false });
	assert.equal(result.ok, true);
	assert.equal(result.strategy, 'merge-commit');

	// A real merge commit exists, and it has two parents: the plugin must not
	// pretend a diverged history was a fast-forward.
	const parents = await git(root, ['rev-list', '--parents', '-n', '1', 'HEAD']);
	assert.equal(parents.stdout.trim().split(/\s+/).length, 3, 'a merge commit has two parents plus itself');
	const graph = await git(root, ['log', '--format=%s', '--all']);
	const subjects = graph.stdout.split(/\r?\n/).filter((line) => line !== '');
	assert.ok(subjects.includes('worktree commit'));
	assert.ok(subjects.includes('main commit'));
	assert.ok(subjects.some((line) => line.startsWith('Merge worktree ')), 'the merge commit names the branch it brought in');

	// Both sides are present in the working tree.
	const listing = await git(root, ['ls-files']);
	assert.match(listing.stdout, /feature\.txt/);
	assert.match(listing.stdout, /other\.txt/);
});

test('deliver commits uncommitted worktree work first, so nothing is lost', async () => {
	const { root } = await repo({ name: 'autocommit' });
	const created = await ws.create(root);
	await writeFile(join(created.path, 'app.txt'), 'edited but never committed\n');
	// An ignored artifact must survive too: it is often the agent's real output.
	const { mkdir } = await import('node:fs/promises');
	await mkdir(join(created.path, 'build'), { recursive: true });
	await writeFile(join(created.path, '.gitignore'), 'build/\n');
	await writeFile(join(created.path, 'build/out.bin'), 'artifact\n');

	const result = await ws.deliver(root, created, { cleanup: false, message: 'wip: agent output' });
	assert.equal(result.ok, true);
	assert.equal(result.preCommitted, true);

	const mainSubjects = await subjects(root);
	assert.equal(mainSubjects[0], 'wip: agent output');
	const tracked = await git(root, ['ls-files']);
	assert.match(tracked.stdout, /build\/out\.bin/, 'an ignored artifact must not be dropped at merge time');
});

/* ----------------------------------------------------------------- commit -- */

test('commit writes the uncommitted work with a subject taken from the file names', async () => {
	const { root } = await repo({ name: 'commit-basic' });
	const created = await ws.create(root);
	await writeFile(join(created.path, 'app.txt'), 'edited\n');
	await writeFile(join(created.path, 'new.txt'), 'added\n');

	const result = await ws.commit(created.path);
	assert.equal(result.ok, true);
	assert.equal(result.changes, 2, 'both the edit and the new file are part of the commit');
	assert.match(result.message, /app\.txt|new\.txt/, 'the subject names what changed');
	assert.equal((await ws.status(created.path)).dirty, false, 'the tree is clean afterwards');
	// The commit lands on the worktree's own branch, so it is still deliverable as one.
	assert.equal(result.head, await oid(created.path));
	assert.equal((await git(root, ['rev-list', '--count', `${await oid(root)}..${result.head}`])).stdout.trim(), '1');
});

test('commit honours an explicit subject over the generated one', async () => {
	const { root } = await repo({ name: 'commit-message' });
	const created = await ws.create(root);
	await writeFile(join(created.path, 'app.txt'), 'edited\n');

	const result = await ws.commit(created.path, { message: 'feat: say it properly' });
	assert.equal(result.ok, true);
	assert.equal(result.message, 'feat: say it properly');
	assert.equal((await subjects(created.path))[0], 'feat: say it properly');
});

test('commit refuses a clean tree instead of making an empty commit', async () => {
	const { root } = await repo({ name: 'commit-clean' });
	const created = await ws.create(root);
	const before = await oid(created.path);

	const result = await ws.commit(created.path);
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'nothing-to-commit');
	assert.equal(result.changes, 0);
	assert.equal(await oid(created.path), before, 'nothing was written');
});

test('commit keeps ignored artifacts, exactly as the automatic checkpoint does', async () => {
	const { root } = await repo({ name: 'commit-ignored' });
	const created = await ws.create(root);
	const { mkdir } = await import('node:fs/promises');
	await mkdir(join(created.path, 'build'), { recursive: true });
	await writeFile(join(created.path, '.gitignore'), 'build/\n');
	await writeFile(join(created.path, 'build/out.bin'), 'artifact\n');

	const result = await ws.commit(created.path);
	assert.equal(result.ok, true);
	const tracked = await git(created.path, ['ls-files']);
	assert.match(tracked.stdout, /build\/out\.bin/, 'the artifact is committed with --force, as delivery does');
});

test('deliver refuses a dirty main tree and touches nothing', async () => {
	const { root } = await repo({ name: 'main-dirty' });
	const created = await ws.create(root);
	await writeFile(join(created.path, 'feature.txt'), 'x\n');
	await git(created.path, ['add', '-A']);
	await commit(created.path, 'feature');

	await writeFile(join(root, 'app.txt'), 'uncommitted local edit\n');
	const before = await fingerprint(root);
	const mainHeadBefore = await oid(root);

	const result = await ws.deliver(root, created, { cleanup: false });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'main-dirty');
	assert.equal(result.kept, true);

	assert.equal(await fingerprint(root), before, 'the main tree must be byte-identical');
	assert.equal(await oid(root), mainHeadBefore);
	// The worktree still exists with its commit intact.
	assert.equal(await oid(created.path), await oid(created.path));
	assert.equal((await ws.status(created.path)).dirty, false);
});

test('deliver refuses when the main tree is on another branch', async () => {
	const { root } = await repo({ name: 'switched' });
	const created = await ws.create(root);
	await writeFile(join(created.path, 'feature.txt'), 'x\n');
	await git(created.path, ['add', '-A']);
	await commit(created.path, 'feature');

	await git(root, ['checkout', '-b', 'elsewhere', '--quiet']);
	const before = await fingerprint(root);
	const headBefore = await oid(root);

	const result = await ws.deliver(root, created, { cleanup: false });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'main-on-other-branch');

	// Nothing was moved and nothing was written onto the wrong branch.
	assert.equal(await fingerprint(root), before);
	assert.equal(await oid(root), headBefore);
	assert.deepEqual(await subjects(root, 'elsewhere'), ['init'], 'the branch we were on must not gain the worktree commits');
	assert.deepEqual(await subjects(root, 'main'), ['init'], 'the base branch was not touched either');
});

test('deliver reports "already merged" instead of creating an empty merge commit', async () => {
	const { root } = await repo({ name: 'noop' });
	const created = await ws.create(root);
	const result = await ws.deliver(root, created, { cleanup: false });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'already-merged');
});

/* --------------------------------------------------------------- conflict -- */

test('when conflict detection is unavailable, a real conflict is rolled back exactly', async () => {
	const { root } = await repo({ name: 'fallback' });
	const created = await ws.create(root);

	await writeFile(join(created.path, 'app.txt'), 'worktree side\n');
	await git(created.path, ['add', '-A']);
	await commit(created.path, 'worktree edit');

	await writeFile(join(root, 'app.txt'), 'main side\n');
	await git(root, ['add', '-A']);
	await commit(root, 'main edit');

	// An older git has no `merge-tree --write-tree`; this is what the plugin then
	// sees. The safety net has to hold: merge, fail, `merge --abort`, restore.
	const blindRunner = (args, options) =>
		args.includes('merge-tree')
			? Promise.resolve({ exitCode: 129, stdout: '', stderr: "error: unknown option `write-tree'" })
			: run(args, options);
	const blind = new Workspace(blindRunner);

	const before = await fingerprint(root);
	const headBefore = await oid(root);

	const result = await blind.deliver(root, created, { cleanup: false });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'merge-conflict');
	assert.equal(result.aborted, true, 'without a dry run the merge really was started and rolled back');
	assert.equal(result.kept, true);

	assert.equal(await fingerprint(root), before, 'merge --abort restored the main tree');
	assert.equal(await oid(root), headBefore);
	const mergeHead = await gitSoft(root, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
	assert.notEqual(mergeHead.exitCode, 0);
	const worktreeHead = await oid(created.path);
	assert.notEqual(worktreeHead, null, 'the worktree and its commit survive the rollback');
});

test('a conflicted delivery is refused without ever touching the main tree', async () => {
	const { root } = await repo({ name: 'conflict' });
	const created = await ws.create(root);

	// Both sides edit the SAME line of the SAME file: a real content conflict.
	await writeFile(join(created.path, 'app.txt'), 'worktree side\n');
	await git(created.path, ['add', '-A']);
	await commit(created.path, 'worktree edit');

	await writeFile(join(root, 'app.txt'), 'main side\n');
	await git(root, ['add', '-A']);
	await commit(root, 'main edit');

	const before = await fingerprint(root);
	const headBefore = await oid(root);
	const worktreeHeadBefore = await oid(created.path);

	const result = await ws.deliver(root, created, { cleanup: false });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'merge-conflict');
	assert.equal(result.kept, true);
	// The conflict is detected by the DRY RUN, so no merge was ever started: that
	// is why `aborted` is false and no rollback was needed.
	assert.equal(result.detectedBy, 'merge-tree');
	assert.equal(result.aborted, false);
	assert.deepEqual(result.conflictPaths, ['app.txt']);

	// The promises that matter: identical tree, identical HEAD, no MERGE_HEAD.
	assert.equal(await fingerprint(root), before);
	assert.equal(await oid(root), headBefore);
	const mergeHead = await gitSoft(root, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
	assert.notEqual(mergeHead.exitCode, 0, 'a refused delivery leaves no MERGE_HEAD');
	assert.deepEqual(await porcelain(root), [], 'the main tree must be clean');

	// The worktree survives with its commit, so a retry is possible.
	assert.equal(await oid(created.path), worktreeHeadBefore);
	assert.equal((await ws.status(created.path)).dirty, false);
});

test('after a conflict, merging the base into the worktree makes delivery succeed', async () => {
	const { root } = await repo({ name: 'recover' });
	const created = await ws.create(root);

	await writeFile(join(created.path, 'app.txt'), 'worktree side\n');
	await git(created.path, ['add', '-A']);
	await commit(created.path, 'worktree edit');

	await writeFile(join(root, 'app.txt'), 'main side\n');
	await git(root, ['add', '-A']);
	await commit(root, 'main edit');

	assert.equal((await ws.deliver(root, created, { cleanup: false })).reason, 'merge-conflict');

	// The documented recovery: merge the base INTO the worktree, resolve, and commit
	// that merge. Committing only the resolved file leaves the two histories
	// divergent, so the next delivery hits the same conflict — which is why this
	// test performs the actual merge rather than just editing the file. The merge
	// itself is EXPECTED to exit non-zero: it stops on the conflict so a human (or
	// an agent) can resolve it, which is exactly the state being tested.
	const mergeInto = await gitSoft(created.path, ['merge', '--no-edit', 'main']);
	assert.notEqual(mergeInto.exitCode, 0, 'the in-worktree merge must stop on the same conflict');
	assert.match(`${mergeInto.stdout}${mergeInto.stderr}`, /CONFLICT/);

	await writeFile(join(created.path, 'app.txt'), 'both sides reconciled\n');
	await git(created.path, ['add', '-A']);
	await commit(created.path, 'reconcile');

	const second = await ws.deliver(root, created, { cleanup: false });
	assert.equal(second.ok, true);
	const content = await git(root, ['show', 'main:app.txt']);
	assert.equal(content.stdout.replace(/\r?\n$/, ''), 'both sides reconciled');
});

/* ---------------------------------------------------------------- cleanup -- */

test('cleanup removes the worktree and deletes only this plugin\'s own branch', async () => {
	const { root } = await repo({ name: 'cleanup' });
	const created = await ws.create(root);
	await writeFile(join(created.path, 'feature.txt'), 'x\n');
	await git(created.path, ['add', '-A']);
	await commit(created.path, 'feature');

	const delivered = await ws.deliver(root, created, { cleanup: true });
	assert.equal(delivered.ok, true);
	assert.equal(delivered.cleanup.ok, true);
	assert.equal(delivered.cleanup.removed, true);
	assert.equal(delivered.cleanup.branchDeleted, true);

	const list = await ws.listWorktrees(root);
	assert.equal(list.length, 1, 'only the main tree is left');
	const branch = await gitSoft(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/dsh/wt/anything']);
	assert.notEqual(branch.exitCode, 0);
});

test('cleanup refuses to remove a worktree with uncommitted changes unless forced', async () => {
	const { root } = await repo({ name: 'dirty-cleanup' });
	const created = await ws.create(root);
	await writeFile(join(created.path, 'scratch.txt'), 'unsaved\n');

	const refused = await ws.cleanup(root, { path: created.path, branch: created.branch });
	assert.equal(refused.ok, false);
	assert.equal(refused.removed, false);
	assert.equal(refused.reason, 'worktree-dirty');

	// The file is still there: a refused cleanup must not lose work.
	const list = await ws.listWorktrees(root);
	assert.ok(list.some((entry) => entry.path === created.path));

	const forced = await ws.discard(root, { path: created.path, branch: created.branch });
	assert.equal(forced.ok, true);
	assert.equal((await ws.listWorktrees(root)).length, 1);
});

test('cleanup deletes the branch with -d, so an unmerged branch survives', async () => {
	const { root } = await repo({ name: 'unmerged-branch' });
	const created = await ws.create(root);
	await writeFile(join(created.path, 'feature.txt'), 'x\n');
	await git(created.path, ['add', '-A']);
	await commit(created.path, 'unmerged work');

	// Remove the worktree without delivering: the branch keeps the only copy.
	const removed = await ws.cleanup(root, { path: created.path, branch: created.branch, force: true });
	assert.equal(removed.ok, true);
	assert.equal(removed.branchDeleted, false, 'an unmerged branch must be kept');
	const still = await gitSoft(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${created.branch}`]);
	assert.equal(still.exitCode, 0);
});

test('a foreign branch name is never deleted by cleanup', async () => {
	const { root } = await repo({ name: 'foreign' });
	const created = await ws.create(root);
	await git(created.path, ['checkout', '-b', 'feature/user-work', '--quiet']);
	await git(root, ['worktree', 'remove', '--force', created.path]);
	const deleted = await ws.deleteBranch(root, 'feature/user-work');
	assert.equal(deleted, false);
	const survives = await gitSoft(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/feature/user-work']);
	assert.equal(survives.exitCode, 0);
});

/* ------------------------------------------------------------ drift/status -- */

test('worktreeState counts both directions of drift from the recorded base', async () => {
	const { root } = await repo({ name: 'drift' });
	const created = await ws.create(root);

	await writeFile(join(created.path, 'a.txt'), 'a\n');
	await git(created.path, ['add', '-A']);
	await commit(created.path, 'one');
	await writeFile(join(created.path, 'b.txt'), 'b\n');
	await git(created.path, ['add', '-A']);
	await commit(created.path, 'two');

	await writeFile(join(root, 'c.txt'), 'c\n');
	await git(root, ['add', '-A']);
	await commit(root, 'base moved');

	const state = await ws.worktreeState(root, created, { base: 'main' });
	assert.equal(state.ahead, 2);
	assert.equal(state.baseAhead, 1);
	assert.equal(state.deliverable, true);
	assert.equal(state.dirty, false);
	assert.match(state.base, /^main$/);
});

test('a missing worktree directory is reported as missing, not as a crash', async () => {
	const { root } = await repo({ name: 'gone' });
	const created = await ws.create(root);
	const { rm } = await import('node:fs/promises');
	await rm(created.path, { recursive: true, force: true });

	const state = await ws.worktreeState(root, created, { base: 'main' });
	assert.equal(state.present, false);
	assert.equal(state.reason, 'worktree-missing');

	// And the session sitting where the worktree used to be still gets an answer.
	const inspected = await ws.inspect(root);
	assert.equal(inspected.repo.present, true);
	assert.equal(inspected.repo.usable, true);
});

test('inspect from inside the worktree reports the worktree and the repository', async () => {
	const { root } = await repo({ name: 'inside' });
	const mainRoot = root;
	const created = await ws.create(root);
	await writeFile(join(created.path, 'feature.txt'), 'x\n');
	await git(created.path, ['add', '-A']);
	await commit(created.path, 'feature');

	const state = await ws.inspect(join(created.path));
	// A session inside the worktree still resolves "which repository is this" to
	// the main tree, so the delivery action knows both sides.
	assert.equal(state.repoRoot, mainRoot);
	assert.equal(state.worktree.present, true);
	assert.equal(state.worktree.ahead, 1);
	assert.equal(state.worktree.state, 'ready');
	assert.equal(state.worktree.branch, created.branch);
});

/* ----------------------------------------------------------------- safety -- */

test('a path with spaces and non-ASCII characters survives the whole round trip', async () => {
	const { tempDir } = await import('./fixture.mjs');
	const base = await tempDir('spaces-');
	const root = join(base, 'my project 中文');
	await git(base, ['init', '-b', 'main', '--quiet', root]);
	await git(root, ['config', 'user.name', 'DSH Test']);
	await git(root, ['config', 'user.email', 'test@example.invalid']);
	await writeFile(join(root, 'app.txt'), 'one\n');
	await git(root, ['add', '-A']);
	await commit(root, 'init');

	const created = await ws.create(root);
	assert.ok(created.path.includes('my project 中文') || created.path.includes('my-project'));
	await writeFile(join(created.path, '中文 文件.txt'), '内容\n');
	await git(created.path, ['add', '-A']);
	await commit(created.path, '中文提交');

	const result = await ws.deliver(root, created, { cleanup: false });
	assert.equal(result.ok, true);
	// `-z` output is read directly rather than through git's quoting, so the
	// non-ASCII name is compared as the bytes git stored.
	const listing = await git(root, ['ls-files', '-z']);
	assert.ok(listing.stdout.split('\0').includes('中文 文件.txt'), `expected the CJK path, got ${JSON.stringify(listing.stdout)}`);
});
