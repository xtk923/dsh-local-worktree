/**
 * git-runner.js — the one place this plugin spawns a process.
 *
 * Every git command the plugin runs goes through here, which is why this file
 * is small and paranoid:
 *
 *   * `execFile`, never a shell. Paths, branch names and commit messages with
 *     spaces, quotes, `&` or `;` are single argv elements and cannot become
 *     commands. On Windows this also avoids the `cmd.exe` quoting layer.
 *   * a hard timeout, because a git that waits for a credential prompt would
 *     otherwise hang the request that triggered it;
 *   * `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS` disabled, so git FAILS instead
 *     of waiting for input this process can never supply;
 *   * `GIT_CONFIG_NOSYSTEM` + a fixed `HOME`-independent environment are NOT
 *     used: a user's global git config (user.name, core.autocrlf) is exactly
 *     what a commit needs to behave like the user's own commit.
 *
 * @module dsh-local-worktree/git-runner
 */

import { execFile } from 'node:child_process';

/** Default wall-clock budget for one git command. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Buffers are bounded; a runaway `git log` must not exhaust the host. */
const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Environment for a machine-invoked git.
 *
 * `GIT_EDITOR`/`GIT_SEQUENCE_EDITOR` are pointed at a command that fails, so a
 * command that unexpectedly wants an editor returns an error rather than
 * blocking a headless host. Merge and commit messages are always passed with
 * `-m`, so this is a guard, not a policy.
 */
export function gitEnv(env = process.env) {
	return {
		...env,
		GIT_TERMINAL_PROMPT: '0',
		GIT_ASKPASS: 'echo',
		SSH_ASKPASS: 'echo',
		GIT_PAGER: 'cat',
		GIT_EDITOR: 'false',
		GIT_SEQUENCE_EDITOR: 'false',
		// Keep output stable for machine reading regardless of the user's locale.
		LC_ALL: 'C',
		LANG: 'C'
	};
}

/**
 * Create a runner bound to one `git` executable and one timeout.
 *
 * The returned function NEVER rejects on a non-zero exit: git's failure is data
 * (the plugin classifies it), while a spawn failure rejects so the caller can
 * tell "git says no" from "there is no git".
 */
export function createGitRunner({ gitPath = 'git', timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive number');
	const childEnv = gitEnv(env);

	return function run(args, { cwd } = {}) {
		return new Promise((resolve, reject) => {
			const options = {
				env: childEnv,
				timeout: timeoutMs,
				maxBuffer: MAX_BUFFER,
				windowsHide: true,
				encoding: 'utf8'
			};
			if (typeof cwd === 'string' && cwd !== '') options.cwd = cwd;
			execFile(gitPath, args, options, (error, stdout, stderr) => {
				if (error !== null && error !== undefined) {
					// `error.code` is the numeric exit code for a non-zero exit, and a
					// string errno (e.g. 'ENOENT') when the executable never started.
					if (typeof error.code === 'number' || error.killed === true || (error.signal !== undefined && error.signal !== null)) {
						resolve({
							exitCode: typeof error.code === 'number' ? error.code : 1,
							stdout: typeof stdout === 'string' ? stdout : '',
							stderr: typeof stderr === 'string' && stderr !== '' ? stderr : String(error.message ?? ''),
							killed: error.killed === true
						});
						return;
					}
					reject(error);
					return;
				}
				resolve({ exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
			});
		});
	};
}

/** Whether `git` can be spawned at all, and which version it is. */
export async function gitVersion(run) {
	try {
		const result = await run(['--version'], {});
		if (result.exitCode !== 0) return null;
		return String(result.stdout ?? '').trim();
	} catch {
		return null;
	}
}
