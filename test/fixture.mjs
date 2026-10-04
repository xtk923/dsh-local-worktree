/**
 * fixture.mjs — a real git repository in a temp directory, and a real git runner.
 *
 * These tests deliberately do NOT mock git. Every claim this plugin makes is a
 * claim about what git does (a merge rolls back, a worktree shares the object
 * database, the branch survives a refused delete), so the assertions run real
 * git in a throwaway repository and read the result. The runner is `git` with
 * `execFile`, which is also the contract `src/git-runner.js` implements for the
 * plugin, so a passing suite means the argv the plugin builds really works.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A git runner with the same shape the plugin injects: resolves for any exit
 * code, rejects only when git could not be started at all.
 */
export function runner({ timeoutMs = 30_000 } = {}) {
	return (args, { cwd } = {}) =>
		new Promise((resolve, reject) => {
			const options = {
				timeout: timeoutMs,
				maxBuffer: 8 * 1024 * 1024,
				encoding: 'utf8',
				windowsHide: true,
				env: {
					...process.env,
					GIT_TERMINAL_PROMPT: '0',
					LC_ALL: 'C',
					// A test machine's own global identity must not decide whether
					// these tests pass, and no test may write to it.
					GIT_CONFIG_GLOBAL: join(tempRoot(), 'global-gitconfig'),
					GIT_CONFIG_SYSTEM: join(tempRoot(), 'system-gitconfig')
				}
			};
			if (typeof cwd === 'string' && cwd !== '') options.cwd = cwd;
			execFile('git', args, options, (error, stdout, stderr) => {
				if (error !== null && error !== undefined && typeof error.code !== 'number' && error.killed !== true) {
					reject(error);
					return;
				}
				resolve({
					exitCode: error === null || error === undefined ? 0 : (typeof error.code === 'number' ? error.code : 1),
					stdout: String(stdout ?? ''),
					stderr: String(stderr ?? '')
				});
			});
		});
}

let cachedRoot = null;

/**
 * One temp root for the whole test process, cleaned up by `removeAll`.
 *
 * Created eagerly with `mkdirSync` because the runner points
 * `GIT_CONFIG_GLOBAL` inside it on the very first call, and git must be able to
 * find that directory already existing.
 */
export function tempRoot() {
	if (cachedRoot === null) {
		cachedRoot = join(tmpdir(), `dsh-local-worktree-tests-${process.pid}`);
		mkdirSync(cachedRoot, { recursive: true });
	}
	return cachedRoot;
}

/** A fresh temp directory (NOT inside a repository). */
export async function tempDir(prefix = 'case-') {
	const base = join(tempRoot(), 'cases');
	await mkdir(base, { recursive: true });
	return mkdtemp(join(base, prefix));
}

/**
 * Create a repository with one commit on `main`.
 *
 * `main` rather than `master` is pinned explicitly with `-b`, so the assertions
 * never depend on the machine's `init.defaultBranch`. Identity is set LOCALLY in
 * the repository, so the plugin's own commits (which pass no `-c user.*`) work
 * without this machine's global git config and without writing to it.
 */
export async function makeRepo({ name = 'repo', file = 'app.txt', content = 'one\n', branch = 'main' } = {}) {
	const root = await tempDir(`${name}-`);
	await git(root, ['init', '-b', branch, '--quiet']);
	await git(root, ['config', 'user.name', 'DSH Test']);
	await git(root, ['config', 'user.email', 'test@example.invalid']);
	await git(root, ['config', 'commit.gpgsign', 'false']);
	// Line-ending conversion is a per-machine setting; pinning it here keeps the
	// assertions about file CONTENT meaningful on any machine. (The plugin itself
	// never assumes either setting: it decides "dirty" from `git diff`, not from
	// stat data, so an autocrlf=true repository is not misread as changed.)
	await git(root, ['config', 'core.autocrlf', 'false']);
	await writeFile(join(root, file), content);
	await git(root, ['add', '-A']);
	await commit(root, 'init');
	return root;
}

/** Run git, throwing with git's own stderr when it fails (test ergonomics). */
export async function git(cwd, args) {
	const run = runner();
	const result = await run(args, { cwd });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed in ${cwd}\n${result.stdout}\n${result.stderr}`);
	}
	return result;
}

/** Run git, returning the result without throwing. */
export async function gitSoft(cwd, args) {
	return runner()(args, { cwd });
}

/** A commit with a fixed identity, so tests never need a global config. */
export async function commit(cwd, message) {
	return git(cwd, [
		'-c', 'user.name=DSH Test',
		'-c', 'user.email=test@example.invalid',
		'-c', 'commit.gpgsign=false',
		'commit', '--no-verify', '--quiet', '-m', message
	]);
}

/** `git log --format=%s`, newest first. */
export async function subjects(cwd, ref = 'HEAD') {
	const result = await git(cwd, ['log', '--format=%s', ref]);
	return result.stdout.split(/\r?\n/).filter((line) => line !== '');
}

/** `git rev-parse <ref>`, or null when the ref does not resolve. */
export async function oid(cwd, ref = 'HEAD') {
	const result = await gitSoft(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
	if (result.exitCode !== 0) return null;
	const value = result.stdout.trim();
	return value === '' ? null : value;
}

/** `git status --porcelain`, as a list of lines. */
export async function porcelain(cwd) {
	const result = await git(cwd, ['status', '--porcelain']);
	return result.stdout.split(/\r?\n/).filter((line) => line !== '');
}

/** A cheap content fingerprint of a whole working tree, for rollback checks. */
export async function fingerprint(cwd) {
	const result = await git(cwd, ['status', '--porcelain', '--untracked-files=all']);
	const tracked = await git(cwd, ['rev-parse', 'HEAD']);
	const { readFile } = await import('node:fs/promises');
	const files = await git(cwd, ['ls-files']);
	const bodies = [];
	for (const file of files.stdout.split(/\r?\n/).filter((line) => line !== '')) {
		try {
			bodies.push(`${file}:${await readFile(join(cwd, file), 'utf8')}`);
		} catch {
			bodies.push(`${file}:<unreadable>`);
		}
	}
	return JSON.stringify({ head: tracked.stdout.trim(), status: result.stdout, bodies });
}

export async function writeFile(path, content) {
	const { writeFile: write } = await import('node:fs/promises');
	await write(path, content, 'utf8');
}

export async function removeAll() {
	if (cachedRoot === null) return;
	await rm(cachedRoot, { recursive: true, force: true });
	cachedRoot = null;
}
