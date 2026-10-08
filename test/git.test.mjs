/**
 * The pure half: parsing git's output and deciding what to do with it.
 *
 * The parsers are tested against output captured from real git 2.52 on Windows,
 * including the `-z` shape that is easy to get wrong: under `-z` a value is its
 * OWN NUL-terminated token, so `locked keep me` arrives as `locked\0keep me\0`
 * and a naive `key value` reader mistakes the reason for the next attribute.
 */

import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { test } from 'node:test';

import {
	ancestors,
	assertOutside,
	branchName,
	classifyGitFailure,
	classifyRepo,
	classifyWorktree,
	cleanupSteps,
	conflictedPaths,
	describeMerge,
	driftText,
	freshId,
	gitArgs,
	mergeSteps,
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
	suggestCommitMessage,
	within,
	worktreeContainer,
	worktreePath
} from '../src/git.js';

/* ------------------------------------------------------------ worktree list -- */

test('parseWorktreePorcelain reads the -z form, where a value is its own token', () => {
	// Built exactly as git emits it (captured from git 2.52): each record is
	// `worktree <path>\0HEAD <oid>\0branch <ref>\0` and terminated by an extra NUL.
	const raw = [
		'worktree C:/repo/main', 'HEAD 4ec3f2a', 'branch refs/heads/main', '',
		'worktree C:/repo/wt dir/my tree', 'HEAD 91bb0c1', 'branch refs/heads/dsh/wt/x', '',
		'worktree C:/repo/locked', 'HEAD 91bb0c1', 'branch refs/heads/other', 'locked', 'keep me', ''
	].join('\0');

	const list = parseWorktreePorcelain(raw);
	assert.equal(list.length, 3);
	assert.equal(list[0].branch, 'main');
	assert.equal(list[0].head, '4ec3f2a');
	assert.equal(list[1].branch, 'dsh/wt/x');
	assert.equal(list[2].locked, true);
	assert.equal(list[2].lockedReason, 'keep me');
	// The reason must NOT be mistaken for an attribute of the record.
	assert.equal(list[2].detached, false);
});

test('parseWorktreePorcelain reads the plain (newline) form and flags detached/bare', () => {
	const raw = [
		'worktree C:/repo/main',
		'HEAD 4ec3f2a',
		'branch refs/heads/main',
		'',
		'worktree C:/repo/det',
		'HEAD 91bb0c1',
		'detached',
		'',
		'worktree C:/repo/bare',
		'bare',
		''
	].join('\n');

	const list = parseWorktreePorcelain(raw);
	assert.equal(list.length, 3);
	assert.equal(list[1].detached, true);
	assert.equal(list[1].branch, null);
	assert.equal(list[2].bare, true);
});

test('parseWorktreePorcelain ignores an unknown key rather than losing the record', () => {
	// What git would really emit for a key this version does not know:
	// `future-key` as its own token, followed by a value token.
	const raw = 'worktree C:/repo/main\0HEAD 4ec3f2a\0branch refs/heads/main\0future-key\0whatever\0\0';
	const list = parseWorktreePorcelain(raw);
	assert.equal(list.length, 1);
	assert.equal(list[0].branch, 'main');
	assert.equal(list[0].head, '4ec3f2a');
});

/* ----------------------------------------------------------------- status -- */

test('parseStatusV2 reads branch, upstream, divergence and the three dirty classes', () => {
	const raw = [
		'# branch.oid 4ec3f2a5f1c9',
		'# branch.head main',
		'# branch.upstream origin/main',
		'# branch.ab +2 -3',
		'1 M. N... 100644 100644 100644 aaa bbb src/one.js',
		'1 .M N... 100644 100644 100644 aaa bbb src/two.js',
		'? notes.md',
		''
	].join('\n');

	const status = parseStatusV2(raw);
	assert.equal(status.branch, 'main');
	assert.equal(status.head, '4ec3f2a5f1c9');
	assert.equal(status.upstream, 'origin/main');
	assert.equal(status.ahead, 2);
	assert.equal(status.behind, 3);
	assert.equal(status.staged, 2);
	assert.equal(status.unstaged, 2);
	assert.equal(status.untracked, 1);
	assert.equal(status.dirty, true);
	assert.equal(status.unborn, false);
});

test('parseStatusV2 treats an unborn HEAD as no commit, not as the zero oid', () => {
	const raw = ['# branch.oid (initial)', '# branch.head main', ''].join('\n');
	const status = parseStatusV2(raw);
	assert.equal(status.head, null);
	assert.equal(status.unborn, true);
	assert.equal(status.dirty, false);
});

test('parseStatusV2 counts a conflict record and reports a dirty tree', () => {
	const raw = ['# branch.oid abc', '# branch.head main', 'u UU N... 100644 100644 100644 100644 a b c both.txt', ''].join('\n');
	const status = parseStatusV2(raw);
	assert.equal(status.conflicted, 1);
	assert.equal(status.dirty, true);
});

/* -------------------------------------------------------------- identity -- */

test('repoKey keys off the common git dir, so clones differ and worktrees agree', () => {
	const a = repoKey('C:\\Workspace\\Proj\\.git');
	const b = repoKey('c:/workspace/proj/.git/');
	assert.equal(a, b, 'separators, case and a trailing slash must not change identity');
	assert.notEqual(a, repoKey('C:\\Workspace\\Other\\.git'));
});

test('worktree paths and branches carry a FRESH id, so two worktrees never collide', () => {
	const root = 'C:\\Workspace\\My Project';
	const container = worktreeContainer(root);
	const first = freshId({ now: 1_700_000_000_000, random: () => 0.5 });
	const second = freshId({ now: 1_700_000_000_000, random: () => 0.9 });

	assert.equal(container, 'C:\\Workspace\\My Project_worktrees');
	assert.match(first, /^[0-9a-z]+-[0-9a-z]{4}$/);
	assert.notEqual(first, second, 'the same millisecond must still yield two distinct ids');

	const target = worktreePath(root, first);
	assert.ok(within(container, target));
	assert.ok(!within(root, target));
	// `<repo>_<id>`: the underscore keeps the repository name readable even when it
	// contains hyphens, and every worktree of one repository sorts together. The
	// repository's own spaces become hyphens, because a path component is still a
	// path component.
	assert.equal(basename(target), `My-Project_${first}`);
	assert.notEqual(worktreePath(root, first), worktreePath(root, second), 'two worktrees are two paths');
	assert.equal(branchName(root, first), `dsh/wt/My-Project_${first}`);
	assert.notEqual(branchName(root, first), branchName(root, second), 'two worktrees are two branches');
});

test('the minted id sorts by time, so a container lists worktrees in creation order', () => {
	const early = freshId({ now: 1_700_000_000_000, random: () => 0.1 });
	const late = freshId({ now: 1_700_000_100_000, random: () => 0.1 });
	const key = (value) => value.slice(0, value.indexOf('-'));
	assert.ok(key(early) < key(late), `${early} should sort before ${late}`);
});

test('worktreePath and branchName refuse to guess an id', () => {
	// A default id would silently reintroduce the shared-path bug these signatures
	// exist to prevent, so a caller that forgets one must get an error.
	assert.throws(() => worktreePath('C:\\repo'), /requires a fresh id/);
	assert.throws(() => branchName('C:\\repo'), /requires a fresh id/);
	assert.throws(() => planCreate({ localRoot: 'C:\\repo' }), /requires a fresh id/);
});

test('assertOutside refuses a target inside the repository', () => {
	assert.throws(() => assertOutside('C:\\repo', 'C:\\repo\\nested'), /inside the repository/);
	assert.throws(() => assertOutside('C:\\repo', 'relative\\path'), /absolute/);
	assert.doesNotThrow(() => assertOutside('C:\\repo', 'C:\\repo_worktrees\\repo'));
});

test('the layout decides where a worktree lands, and what may be created there', () => {
	const root = 'C:\\Workspace\\My Project';

	// `sibling` stays exactly what it was: beside the repository.
	assert.equal(worktreeContainer(root), 'C:\\Workspace\\My Project_worktrees');
	assert.equal(worktreeContainer(root, { layout: 'sibling' }), 'C:\\Workspace\\My Project_worktrees');
	// Anything that is not an explicit `inside` reads as the default, so a typo in
	// configuration can never scatter worktrees somewhere unnamed.
	assert.equal(worktreeContainer(root, { layout: 'nonsense' }), 'C:\\Workspace\\My Project_worktrees');

	// `inside` nests under the repository itself, which is what lets the sidebar put a
	// worktree in the repository's own group instead of beside it.
	assert.equal(worktreeContainer(root, { layout: 'inside' }), 'C:\\Workspace\\My Project\\.dsh-worktrees');
	const inside = worktreePath(root, 'abc-1234', { layout: 'inside' });
	assert.equal(inside, 'C:\\Workspace\\My Project\\.dsh-worktrees\\My-Project_abc-1234');
	assert.ok(within(root, inside));

	// The guard is stricter inside the repository: only the container is allowed, so a
	// stray path in the tracked tree is still refused.
	assert.doesNotThrow(() => assertOutside(root, inside, { layout: 'inside' }));
	assert.throws(() => assertOutside(root, 'C:\\Workspace\\My Project\\src\\wt', { layout: 'inside' }), /outside the container/);
	assert.throws(() => assertOutside(root, 'C:\\Workspace\\My Project\\src\\wt'), /inside the repository/);
	// Both layouts still refuse a relative path.
	assert.throws(() => assertOutside(root, '.dsh-worktrees\\wt', { layout: 'inside' }), /absolute/);

	// planCreate carries the layout through, so the argv and the reported container
	// describe the same directory.
	const plan = planCreate({ localRoot: root, id: 'abc-1234', layout: 'inside' });
	assert.equal(plan.layout, 'inside');
	assert.equal(plan.container, 'C:\\Workspace\\My Project\\.dsh-worktrees');
	assert.equal(plan.path, inside);
	assert.equal(planCreate({ localRoot: root, id: 'abc-1234' }).layout, 'sibling');
});

test('samePath and within are separator- and case-insensitive', () => {
	assert.equal(samePath('C:\\Repo\\A', 'c:/repo/a/'), true);
	assert.equal(samePath('C:\\Repo\\A', 'C:\\Repo\\AB'), false);
	assert.equal(within('C:\\Repo', 'C:\\Repo\\sub'), true);
	assert.equal(within('C:\\Repo', 'C:\\Repository'), false, 'a shared prefix is not containment');
	assert.equal(within('C:\\Repo', 'C:\\Repo'), true);
});

test('ancestors walks to the filesystem root, itself first', () => {
	const list = ancestors('C:\\a\\b\\c');
	assert.equal(list[0], 'C:\\a\\b\\c');
	assert.equal(list[1], 'C:\\a\\b');
	assert.equal(list.at(-1), list.at(-1));
	assert.equal(list.at(-1).endsWith('\\'), true);
});

/* ---------------------------------------------------------------- decide -- */

test('classifyRepo separates "no repository" from "no commit to branch from"', () => {
	assert.equal(classifyRepo({}).reason, 'not-a-repository');
	assert.equal(classifyRepo({ root: 'C:\\r', gitCommonDir: 'C:\\r\\.git' }).reason, 'status-unavailable');
	assert.equal(
		classifyRepo({ root: 'C:\\r', gitCommonDir: 'C:\\r\\.git', status: parseStatusV2('# branch.oid (initial)\n# branch.head main\n') }).reason,
		'no-commits-yet'
	);
	const ok = classifyRepo({ root: 'C:\\r', gitCommonDir: 'C:\\r\\.git', status: parseStatusV2('# branch.oid abc\n# branch.head main\n') });
	assert.equal(ok.usable, true);
	assert.equal(ok.branch, 'main');
});

test('classifyRepo reports a detached head as usable but named', () => {
	const status = parseStatusV2('# branch.oid abc123\n# branch.head (detached)\n');
	const result = classifyRepo({ root: 'C:\\r', gitCommonDir: 'C:\\r\\.git', status });
	assert.equal(result.usable, true);
	assert.equal(result.reason, 'detached-head');
	assert.equal(result.branch, null);
});

test('planCreate always passes an explicit start point and the separator', () => {
	const plan = planCreate({ localRoot: 'C:\\repo', id: 'abc-1234', branch: 'dsh/wt/repo_abc-1234', startPoint: '4ec3f2a' });
	assert.deepEqual(plan.args, ['worktree', 'add', '-b', 'dsh/wt/repo_abc-1234', '--', plan.path, '4ec3f2a']);
	assert.ok(plan.args.includes('--'), 'the path must be separated from refs');
	// The path and the branch both carry the id, separated from the repository name
	// by the same underscore, so they agree by construction.
	assert.ok(plan.path.endsWith('repo_abc-1234'), plan.path);
	// A branch name starting with a dash can never be read as a flag.
	assert.deepEqual(planCreate({ localRoot: 'C:\\repo', id: 'i', branch: '-x', startPoint: 'a' }).args.slice(3, 4), ['-x']);
});

test('classifyWorktree: no commits is not the same as no changes', () => {
	const noChanges = classifyWorktree({ present: true, head: 'a', ahead: 0, baseAhead: 0, status: { dirty: false } });
	assert.equal(noChanges.state, 'no-changes');
	assert.equal(noChanges.deliverable, false);

	const dirtyOnly = classifyWorktree({ present: true, head: 'a', ahead: 0, status: { dirty: true, untracked: 1 } });
	assert.equal(dirtyOnly.state, 'uncommitted-only');
	assert.equal(dirtyOnly.deliverable, true);

	const ready = classifyWorktree({ present: true, head: 'a', ahead: 3, baseAhead: 1, status: { dirty: false } });
	assert.equal(ready.state, 'ready');
	assert.equal(ready.ahead, 3);
	assert.equal(driftText(ready), '3 个新提交 / 3 new commit(s)，原分支另有 1 个提交 / base moved 1');
});

test('classifyWorktree refuses a worktree with an unfinished merge', () => {
	const state = classifyWorktree({ present: true, head: 'a', ahead: 1, status: { dirty: true, conflicted: 2 } });
	assert.equal(state.state, 'conflicted');
	assert.equal(state.deliverable, false);
	assert.equal(state.reason, 'worktree-conflicted');
});

test('planMerge refuses a dirty main tree BEFORE anything is spawned', () => {
	const plan = planMerge({
		mainBranch: 'main',
		base: 'main',
		mainHead: 'a',
		worktreeHead: 'b',
		mainStatus: { branch: 'main', head: 'a', dirty: true, staged: 1, untracked: 2 }
	});
	assert.equal(plan.ok, false);
	assert.equal(plan.reason, 'main-dirty');
	assert.equal(plan.detail, '1 tracked, 2 untracked');
});

test('planMerge refuses when the main tree moved to another branch', () => {
	const plan = planMerge({
		mainBranch: 'feature',
		base: 'main',
		mainHead: 'a',
		worktreeHead: 'b',
		mainStatus: { branch: 'feature', head: 'a', dirty: false }
	});
	assert.equal(plan.ok, false);
	assert.equal(plan.reason, 'main-on-other-branch');
});

test('planMerge refuses a different repository, an unborn base and a conflict in progress', () => {
	// Each case carries every field the earlier guards need, so the assertion is
	// about the guard under test and not about the order of the checks above it.
	// Note `mainHead` is its OWN argument (the caller reads it with rev-parse),
	// not a field of `mainStatus` (which is what `git status --porcelain=v2` said).
	const clean = { branch: 'main', head: 'a', dirty: false };
	assert.equal(planMerge({ sameRepo: false, mainStatus: clean, mainHead: 'a', worktreeHead: 'b' }).reason, 'different-repository');
	assert.equal(
		planMerge({ sameRepo: true, mainStatus: { ...clean, unborn: true, head: null }, mainHead: null, worktreeHead: 'b' }).reason,
		'main-unborn'
	);
	assert.equal(
		planMerge({ sameRepo: true, mainStatus: { ...clean, conflicted: 1 }, mainHead: 'a', worktreeHead: 'b' }).reason,
		'main-merge-in-progress'
	);
	assert.equal(
		planMerge({ sameRepo: true, mainStatus: { ...clean, detached: true }, mainHead: 'a', worktreeHead: 'b' }).reason,
		'main-detached-head'
	);
	assert.equal(
		planMerge({ sameRepo: true, mainStatus: clean, mainHead: 'a', worktreeHead: 'a' }).reason,
		'already-merged'
	);
});

test('planMerge commits dirty worktree work first, then merges with an explicit --ff', () => {
	const plan = planMerge({
		mainBranch: 'main',
		base: 'main',
		mainHead: 'a',
		mainStatus: { branch: 'main', head: 'a', dirty: false },
		worktreeBranch: 'dsh/wt/x',
		worktreeHead: 'b',
		worktreeDirty: true,
		commitMessage: 'wip: checkpoint'
	});
	assert.equal(plan.ok, true);
	assert.equal(plan.mergeFlag, '--ff');
	assert.equal(plan.preCommit.message, 'wip: checkpoint');

	const steps = mergeSteps(plan);
	assert.deepEqual(steps.map((step) => step.id), ['stage', 'commit', 'merge']);
	// Every element is its own argv item, so a message that starts with a dash or
	// contains a quote can never be read as an option.
	assert.deepEqual(steps[0].args, ['add', '--all', '--', '.'], 'the checkpoint stages what `dirty` counted, and nothing else');
	assert.deepEqual(steps[1].args, ['commit', '-m', 'wip: checkpoint', '--']);
	// A repository's own hooks must still run: this machine's init template
	// installs a gitleaks pre-commit hook, and bypassing it would be this plugin
	// deciding a user's secret scanner does not apply.
	assert.equal(steps[1].args.includes('--no-verify'), false, 'auto-commit must not skip hooks');
	assert.equal(steps[2].args[0], 'merge');
	assert.ok(steps[2].args.includes('--ff'));
	assert.equal(steps[2].abortOnFailure, true, 'a failed merge is the one step that must roll back');
	assert.equal(steps[2].args.at(-1), 'dsh/wt/x');
	assert.equal(steps[2].args.at(-2), '--', 'the branch is separated from the options');
});

test('a commit subject that starts with a dash stays an argument', () => {
	const plan = planMerge({
		mainBranch: 'main',
		base: 'main',
		mainStatus: { branch: 'main', head: 'a', dirty: false },
		worktreeBranch: 'dsh/wt/x',
		worktreeHead: 'b',
		worktreeDirty: true,
		commitMessage: '--upload-pack=evil'
	});
	const commitStep = mergeSteps(plan).find((step) => step.id === 'commit');
	assert.equal(commitStep.args[2], '--upload-pack=evil');
	assert.equal(commitStep.args[1], '-m', 'it is the value of -m, not a flag');
});

test('a branch name that looks like an option stays after the separator', () => {
	const plan = planMerge({
		mainBranch: 'main',
		base: 'main',
		mainStatus: { branch: 'main', head: 'a', dirty: false },
		worktreeBranch: '--force',
		worktreeHead: 'b'
	});
	const mergeStep = mergeSteps(plan).find((step) => step.id === 'merge');
	assert.deepEqual(mergeStep.args.slice(-2), ['--', '--force']);
});

test('planMerge refuses to auto-commit when git has no identity to commit with', () => {
	const plan = planMerge({
		mainBranch: 'main',
		mainStatus: { branch: 'main', head: 'a', dirty: false },
		worktreeHead: 'b',
		worktreeDirty: true,
		hasIdentity: false
	});
	assert.equal(plan.ok, false);
	assert.equal(plan.reason, 'identity-missing');
	// A CLEAN worktree needs no new commit, so a missing identity is not in the way.
	const clean = planMerge({
		mainBranch: 'main',
		mainStatus: { branch: 'main', head: 'a', dirty: false },
		worktreeHead: 'b',
		worktreeDirty: false,
		hasIdentity: false
	});
	assert.equal(clean.ok, true);
});

test('planCreate refuses a path git cannot build, before anything is spawned', () => {
	// Long enough that the appended worktree container passes the measured ceiling.
	const deep = `C:\\${'x'.repeat(180)}\\repo`;
	const projected = `${deep}_worktrees\\repo`;
	assert.ok(projected.length > 200, `the fixture must exceed the ceiling, got ${projected.length}`);
	assert.throws(
		() => planCreate({ localRoot: deep, id: 'i', branch: 'b', startPoint: 'a' }),
		(error) => {
			assert.equal(error.reason, 'worktree-path-too-long');
			assert.ok(error.pathLength > error.ceiling);
			return true;
		}
	);
	// A comfortable path reports its length so a caller can warn about a tight one.
	const plan = planCreate({ localRoot: 'C:\\short\\repo', id: 'abc-1234' });
	assert.ok(plan.pathLength < 200);
	assert.equal(plan.pathTight, false);
});

test('pathLengthCheck marks a tight path without refusing it', () => {
	const tight = `C:\\${'a'.repeat(140)}\\repo_worktrees\\repo`;
	const checked = pathLengthCheck(tight);
	assert.equal(checked.ok, true);
	assert.equal(checked.tight, true);
});

test('conflictedPaths reads the conflicted paths and ignores the tree oid', () => {
	// Captured from `git merge-tree --write-tree` on git 2.52: the merged tree oid
	// comes first on its own line, then one stage entry per side, then advice.
	const raw = [
		'8adf8df32ef2f0abb1dc8ab59a0c5d9611b9e10a',
		'100644 5626abf0f72e58d7a153368ba57db4c673c0e171 1\tapp.txt',
		'100644 21d65f9bcc9b45c737fa7ba476aeb90a0d296cbd 2\tapp.txt',
		'100644 1551c4a122b8f2ef14b4a5ff145c7f436dea913d 3\tapp.txt',
		'',
		'Auto-merging app.txt',
		'CONFLICT (content): Merge conflict in app.txt'
	].join('\n');
	assert.deepEqual(conflictedPaths(raw), ['app.txt']);
	assert.deepEqual(conflictedPaths(''), []);
	assert.deepEqual(conflictedPaths('only one line with no tab'), []);
});

test('planMerge refuses dirty worktree work when autoCommit is off', () => {
	const plan = planMerge({
		mainBranch: 'main',
		mainStatus: { branch: 'main', head: 'a', dirty: false },
		worktreeHead: 'b',
		worktreeDirty: true,
		autoCommit: false
	});
	assert.equal(plan.ok, false);
	assert.equal(plan.reason, 'worktree-dirty');
});

test('planMerge names uncommitted work as such even when both heads are the same commit', () => {
	// The same-commit test used to run FIRST, so a worktree whose only work was still
	// uncommitted came back as `already-merged` — "the base branch already contains
	// every worktree commit" — which is the one thing about that state that is NOT
	// true. The user's next move is to commit, so that is what they are told.
	const plan = planMerge({
		mainBranch: 'main',
		mainStatus: { branch: 'main', head: 'a', dirty: false },
		mainHead: 'a',
		worktreeHead: 'a',
		worktreeDirty: true,
		autoCommit: false
	});
	assert.equal(plan.ok, false);
	assert.equal(plan.reason, 'worktree-dirty');

	// With autoCommit ON the same state IS deliverable: the checkpoint commit is what
	// turns uncommitted work into something a merge can carry.
	const commitFirst = planMerge({
		mainBranch: 'main',
		mainStatus: { branch: 'main', head: 'a', dirty: false },
		mainHead: 'a',
		worktreeHead: 'a',
		worktreeDirty: true,
		autoCommit: true
	});
	assert.equal(commitFirst.ok, true);
	assert.equal(commitFirst.preCommit.message, 'wip: dsh worktree checkpoint');

	// A CLEAN worktree on the same commit is still "nothing to deliver", and saying
	// that beats creating an empty merge commit.
	assert.equal(
		planMerge({
			mainBranch: 'main',
			mainStatus: { branch: 'main', head: 'a', dirty: false },
			mainHead: 'a',
			worktreeHead: 'a',
			worktreeDirty: false
		}).reason,
		'already-merged'
	);
});

test('the checkpoint stage leaves ignored paths out unless the caller asks for them', () => {
	// `--force` is exactly what makes `git add` accept paths `.gitignore` excludes,
	// and those paths are where a `.env` and a `node_modules/` live.
	assert.deepEqual(stageArgs(), ['add', '--all', '--', '.']);
	assert.deepEqual(stageArgs({}), ['add', '--all', '--', '.']);
	assert.deepEqual(stageArgs({ forceIgnored: false }), ['add', '--all', '--', '.']);
	assert.deepEqual(stageArgs({ forceIgnored: true }), ['add', '--all', '--force', '--', '.']);

	const plan = planMerge({
		mainBranch: 'main',
		mainStatus: { branch: 'main', head: 'a', dirty: false },
		worktreeHead: 'b',
		worktreeBranch: 'dsh/wt/x',
		worktreeDirty: true,
		commitIgnored: true
	});
	assert.equal(plan.preCommit.forceIgnored, true, 'the opt-in reaches the plan');
	const stage = mergeSteps(plan).find((step) => step.id === 'stage');
	assert.equal(stage.args.includes('--force'), true, 'and from the plan into the argv');
});

test('planMerge falls back to a default commit subject when none is supplied', () => {
	const plan = planMerge({
		mainBranch: 'main',
		mainStatus: { branch: 'main', head: 'a', dirty: false },
		worktreeHead: 'b',
		worktreeDirty: true
	});
	assert.equal(plan.ok, true);
	assert.equal(plan.preCommit.message, 'wip: dsh worktree checkpoint');
});

test('describeMerge says which shape the merge will take', () => {
	assert.equal(describeMerge({ baseAhead: 0 }).strategy, 'fast-forward');
	assert.equal(describeMerge({ baseAhead: 2 }).strategy, 'merge-commit');
});

test('cleanupSteps deletes only this plugin\'s own branch, and never with -D', () => {
	const steps = cleanupSteps({ path: 'C:\\wt', branch: 'dsh/wt/x' });
	assert.deepEqual(steps.map((step) => step.id), ['remove', 'branch', 'prune']);
	assert.deepEqual(steps[1].args, ['branch', '-d', 'dsh/wt/x']);
	assert.equal(steps[1].args.includes('-D'), false);

	const foreign = cleanupSteps({ path: 'C:\\wt', branch: 'feature/user-work' });
	assert.equal(foreign.some((step) => step.id === 'branch'), false, 'a user branch must survive cleanup');

	const forced = cleanupSteps({ path: 'C:\\wt', branch: 'dsh/wt/x', force: true });
	assert.equal(forced[0].args.includes('--force'), true);
});

test('planAbort is exactly merge --abort', () => {
	assert.deepEqual(planAbort().args, ['merge', '--abort']);
});

/* --------------------------------------------------------------- failure -- */

test('classifyGitFailure names the failure a user can act on', () => {
	const cases = [
		['CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts.', 'merge-conflict'],
		["error: the branch 'dsh/wt/x' is not fully merged", 'branch-not-merged'],
		["fatal: 'C:/wt' is already used by worktree at 'C:/other'", 'worktree-exists'],
		['fatal: not a git repository (or any of the parent directories): .git', 'not-a-repository'],
		['error: invalid reference: HEAD~9', 'bad-reference'],
		['fatal: Unable to create C:/repo/.git/index.lock: File exists', 'locked'],
		['fatal: refusing to merge unrelated histories', 'unrelated-histories'],
		['error: Your local changes to the following files would be overwritten by merge', 'local-changes-would-be-lost'],
		['fatal: Unable to auto-detect email address', 'identity-missing'],
		['hint: pre-commit hook declined', 'hook-rejected'],
		['error: cannot remove a worktree which contains modified or untracked files', 'worktree-dirty']
	];
	for (const [text, expected] of cases) {
		assert.equal(classifyGitFailure({ stderr: text, exitCode: 1 }), expected, text);
	}
	assert.equal(classifyGitFailure({ stderr: 'fatal: something new', exitCode: 128 }), 'git-error');
	assert.equal(classifyGitFailure({ stderr: 'whatever', exitCode: 1 }), 'git-failed');
});

test('quotedFromGit keeps at most two short spans and ignores prose', () => {
	assert.deepEqual(quotedFromGit("fatal: 'C:/wt' is already used by worktree at 'C:/other'"), ['C:/wt', 'C:/other']);
	assert.deepEqual(quotedFromGit('fatal: no quotes here'), []);
	assert.deepEqual(quotedFromGit(`error: '${'x'.repeat(400)}'`), [], 'a runaway quote is not echoed back');
});

test('suggestCommitMessage names the files it can see, and stays bounded', () => {
	assert.equal(suggestCommitMessage({ entries: [] }, { prefix: 'p' }), 'p');
	const one = suggestCommitMessage({ entries: ['1 .M N... 100644 100644 100644 a b src/one.js'] }, { prefix: 'p' });
	assert.equal(one, 'p: src/one.js');
	const many = suggestCommitMessage(
		{ entries: ['? a.txt', '? b.txt', '? c.txt', '? d.txt', '? e.txt'] },
		{ prefix: 'wip: checkpoint' }
	);
	assert.match(many, /\+2$/, 'the overflow is counted, not listed');
	assert.ok(many.length <= 68, `subject must stay bounded, got ${many.length}`);
});

/* ------------------------------------------------------------------ argv -- */

test('gitArgs puts machine-safety flags before the command and -C before it', () => {
	const args = gitArgs(['status'], { cwd: 'C:\\my repo' });
	assert.equal(args.at(-1), 'status');
	assert.equal(args.at(-2), 'C:\\my repo', 'the path is ONE argv element, so spaces cannot split it');
	assert.equal(args.at(-3), '-C');
	assert.ok(args.includes('--no-optional-locks'), 'a read must not need to take the index lock');
	assert.ok(args.includes('commit.gpgsign=false'), 'a machine commit must never wait for a signing key');
	assert.equal(args.at(-4), 'i18n.logOutputEncoding=utf-8', 'every base flag is present before -C');
});
