/**
 * registry.js — the small amount of state this plugin remembers between runs.
 *
 * One JSON file per DSH home, keyed by repository. It exists so that opening a
 * session days later can still answer two questions the repository alone cannot:
 * WHICH worktree was created for this session, and WHICH branch it was cut from
 * (the base is what makes "deliver the commits" a decision rather than a guess).
 *
 * Everything here is best-effort. A registry that cannot be read is not an
 * error worth failing a click over — the worktree on disk and the git branch
 * that owns it are the source of truth, and the registry only saves the user
 * from re-selecting them.
 *
 * Writes are atomic (tmp file + rename) because the DSH host can be restarted
 * at any moment and a truncated registry would read as "no worktrees", which is
 * the one failure that would strand a user's work.
 *
 * @module dsh-local-worktree/registry
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** On-disk schema version. A bump means the reader must migrate, not guess. */
export const REGISTRY_VERSION = 1;

/** Bounded growth: the newest N worktrees per repository are kept. */
const MAX_PER_REPO = 32;

/** Default location inside the DSH home. */
export function defaultRegistryPath(dshHome) {
	const home = typeof dshHome === 'string' && dshHome !== '' ? dshHome : process.env.DSH_HOME ?? '';
	return join(home, 'plugins', 'dsh-local-worktree', 'worktrees.json');
}

/** An empty registry, in the current schema. */
export function emptyRegistry() {
	return { version: REGISTRY_VERSION, revision: 0, repositories: {} };
}

/**
 * Read a registry, tolerating every way it can be wrong.
 *
 * A corrupt file is reported through `onWarn` and replaced by an empty one in
 * memory; it is NOT deleted, so a user who cares can still look at it.
 */
export async function loadRegistry(path, { onWarn } = {}) {
	try {
		const text = await readFile(path, 'utf8');
		const parsed = JSON.parse(text);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			onWarn?.(`registry at ${path} is not an object; starting empty`);
			return emptyRegistry();
		}
		if (parsed.version !== REGISTRY_VERSION) {
			// A future version is not something to reinterpret: keep the data but
			// stop trusting its shape, and let the next write upgrade it.
			onWarn?.(`registry at ${path} has version ${String(parsed.version)}; expected ${REGISTRY_VERSION}`);
			return { ...emptyRegistry(), ...parsed, version: REGISTRY_VERSION };
		}
		return {
			version: REGISTRY_VERSION,
			revision: Number(parsed.revision) || 0,
			repositories: typeof parsed.repositories === 'object' && parsed.repositories !== null ? parsed.repositories : {}
		};
	} catch (error) {
		if (error?.code !== 'ENOENT') onWarn?.(`registry at ${path} could not be read: ${error?.message ?? error}`);
		return emptyRegistry();
	}
}

/**
 * Write a registry atomically.
 *
 * `rename` over an existing file is atomic on both NTFS and POSIX, so a reader
 * never observes a half-written registry — which matters because the reader may
 * be a second click racing this one.
 */
export async function saveRegistry(path, registry, { onWarn } = {}) {
	const value = { ...registry, version: REGISTRY_VERSION };
	try {
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
		await rename(tmp, path);
		return { ok: true };
	} catch (error) {
		onWarn?.(`registry at ${path} could not be written: ${error?.message ?? error}`);
		return { ok: false, error: String(error?.message ?? error) };
	}
}

/* ------------------------------------------------------------ pure updates -- */

/** The record for one repository, or an empty shape that is safe to spread. */
export function repoRecord(registry, key) {
	const found = registry?.repositories?.[key];
	if (found === undefined || found === null || typeof found !== 'object') {
		return { id: key, localRoot: null, worktrees: [] };
	}
	return { ...found, worktrees: Array.isArray(found.worktrees) ? found.worktrees : [] };
}

/**
 * Insert or replace one worktree record, newest first, capped.
 *
 * Returns a NEW registry: the caller decides when to persist, so a pure update
 * can be asserted in a test without touching a filesystem.
 */
export function putWorktree(registry, key, record) {
	const base = registry ?? emptyRegistry();
	const repo = repoRecord(base, key);
	const rest = repo.worktrees.filter((entry) => entry?.branch !== record?.branch);
	const worktrees = [record, ...rest].slice(0, MAX_PER_REPO);
	return {
		...base,
		revision: (Number(base.revision) || 0) + 1,
		repositories: {
			...base.repositories,
			[key]: { ...repo, worktrees, updatedAt: new Date().toISOString() }
		}
	};
}

/** Update one worktree record in place, leaving the order alone. */
export function patchWorktree(registry, key, branch, patch) {
	const base = registry ?? emptyRegistry();
	const repo = repoRecord(base, key);
	let touched = false;
	const worktrees = repo.worktrees.map((entry) => {
		if (entry?.branch !== branch) return entry;
		touched = true;
		return { ...entry, ...patch, updatedAt: new Date().toISOString() };
	});
	if (!touched) return base;
	return {
		...base,
		revision: (Number(base.revision) || 0) + 1,
		repositories: { ...base.repositories, [key]: { ...repo, worktrees } }
	};
}

/** Drop one worktree record; the branch is the identity, not the path. */
export function dropWorktree(registry, key, branch) {
	const base = registry ?? emptyRegistry();
	const repo = repoRecord(base, key);
	const worktrees = repo.worktrees.filter((entry) => entry?.branch !== branch);
	if (worktrees.length === repo.worktrees.length) return base;
	return {
		...base,
		revision: (Number(base.revision) || 0) + 1,
		repositories: { ...base.repositories, [key]: { ...repo, worktrees } }
	};
}

/**
 * The worktree a directory IS, or that CONTAINS it.
 *
 * Both are needed: the button must be active while the session sits at the
 * repository root, and the delivery button must be active while it sits anywhere
 * inside the worktree the agent has been editing.
 */
export function findByPath(registry, key, path) {
	if (typeof path !== 'string' || path === '') return null;
	const repo = repoRecord(registry, key);
	const normalise = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	const target = normalise(path);
	let best = null;
	for (const entry of repo.worktrees) {
		const candidate = normalise(entry?.path);
		if (candidate === '') continue;
		if (candidate === target || target.startsWith(`${candidate}/`)) {
			if (best === null || candidate.length > normalise(best.path).length) best = entry;
		}
	}
	return best;
}

/** Every worktree recorded for a repository, newest first. */
export function listWorktrees(registry, key) {
	return repoRecord(registry, key).worktrees.slice();
}
