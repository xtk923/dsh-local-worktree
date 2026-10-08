/**
 * text.js — every string a user can read, in both of this plugin's languages.
 *
 * The reason codes come from `git.js` and are the contract: a code means the
 * same thing whether it was decided by `classifyRepo`, `planMerge` or
 * `classifyGitFailure`, so the text lives here once and the decisions stay
 * testable without asserting on prose.
 *
 * @module dsh-local-worktree/text
 */

/** Bilingual sentence. `zh` is shown first because that is the author's locale. */
const BOTH = (zh, en) => `${zh} / ${en}`;

/**
 * Why the button is not offering to create a worktree.
 *
 * Each entry answers "what should the user do", not "what did git say": a
 * disabled control with a raw git string is a dead end.
 */
export const REASONS = {
	'not-a-repository': BOTH('这里不是 git 仓库', 'not a git repository'),
	'submodule-unsupported': BOTH('这是一个 submodule，暂不支持 worktree 流程', 'this is a submodule, which the worktree flow does not support'),
	'status-unavailable': BOTH('读不到 git 状态', 'git status is unavailable'),
	'no-commits-yet': BOTH('仓库还没有任何提交，先在原工作区提交一次', 'the repository has no commit yet — commit once in the main tree first'),
	'merge-in-progress': BOTH('原工作区有一次没做完的合并，先解决它', 'the main tree has an unfinished merge — resolve it first'),
	'detached-head': BOTH('当前处于 detached HEAD，先切到一个分支', 'HEAD is detached — switch to a branch first'),
	'main-merge-in-progress': BOTH('原工作区有一次没做完的合并，先解决它', 'the main tree has an unfinished merge — resolve it first'),
	'main-unborn': BOTH('原分支还没有提交，无法合并', 'the main branch has no commit to merge into'),
	'main-on-other-branch': BOTH('原工作区已经切到别的分支了，请切回创建时的分支再合并', 'the main tree switched branches — return to the branch the worktree was cut from'),
	'main-detached': BOTH('原工作区处于 detached HEAD，无法确定合并目标', 'the main tree is on a detached HEAD, so there is no merge target'),
	'main-dirty': BOTH('原工作区有未提交改动，先提交或 stash，再合并', 'the main tree has uncommitted changes — commit or stash them, then merge'),
	'main-head-moved-refuse': BOTH('原分支已经被别人推进了，先同步再合并', 'the base branch moved — reconcile it before merging'),
	'worktree-missing': BOTH('worktree 目录不在了', 'the worktree directory is gone'),
	'worktree-dirty': BOTH('worktree 里有未提交改动', 'the worktree has uncommitted changes'),
	'nothing-to-commit': BOTH('没有需要提交的改动', 'nothing to commit'),
	'commit-failed': BOTH('提交失败', 'the commit failed'),
	'worktree-conflicted': BOTH('worktree 里有一次没做完的合并', 'the worktree has an unfinished merge'),
	'no-new-commits': BOTH('这个 worktree 还没有提交任何东西，没有可合并的内容', 'nothing has been committed in this worktree yet, so there is nothing to merge'),
	'uncommitted-changes': BOTH('只有未提交改动，会先自动提交一次', 'only uncommitted changes — they will be committed first'),
	'already-merged': BOTH('原分支已经包含 worktree 的全部提交', 'the base branch already contains every worktree commit'),
	'different-repository': BOTH('这个 worktree 不属于当前仓库', 'this worktree belongs to a different repository'),
	'merge-conflict': BOTH('两边改了同一处，合并已安全回滚；请在 worktree 里合并原分支后重试', 'both sides changed the same lines — the merge was rolled back; merge the base into the worktree and retry'),
	'branch-not-merged': BOTH('分支还有没合并的提交，已保留', 'the branch still has unmerged commits — it was kept'),
	'worktree-path-too-long': BOTH(
		'worktree 路径太长，git 会拒绝（上限约 200 字符）；把仓库放到更浅的目录，或改用更短的 worktree 根目录',
		'the worktree path is too long for git (about 200 characters max) — move the repository shallower or use a shorter worktree root'
	),
	'no-identity': BOTH('git 没有配置 user.email，无法生成提交', 'git has no user.email, so a commit cannot be made'),
	'worktree-exists': BOTH(
		'这个仓库已经有一个 worktree 了，先把它的提交合并回来或丢弃它',
		'this repository already has a worktree — deliver or discard it first'
	),
	'bad-reference': BOTH('起点提交不存在了', 'the start point no longer exists'),
	'path-in-use': BOTH('路径被占用或没有权限', 'the path is in use or not writable'),
	'invalid-path': BOTH('git 不接受这个路径', 'git rejected that path'),
	locked: BOTH('仓库被另一个 git 进程锁住了，稍后重试', 'another git process holds the lock — retry shortly'),
	'unrelated-histories': BOTH('两条历史没有共同祖先，需要人工处理', 'the two histories share no ancestor — this needs a human'),
	'local-changes-would-be-lost': BOTH('有改动会被覆盖，已中止', 'changes would be overwritten — aborted'),
	'hook-rejected': BOTH('仓库的 git hook 拒绝了这次提交', 'a repository hook rejected the commit'),
	'identity-missing': BOTH('git 没有配置 user.name / user.email', 'git has no user.name / user.email configured'),
	'not-fast-forwardable': BOTH('无法快进', 'not fast-forwardable'),
	'git-error': BOTH('git 报错了', 'git failed'),
	'git-failed': BOTH('git 命令失败', 'the git command failed'),
	'git-missing': BOTH('找不到 git 可执行文件', 'the git executable was not found'),
	'git-timeout': BOTH('git 命令超时', 'the git command timed out'),
	'unsupported-platform': BOTH('这个平台还没有实现', 'this platform is not implemented yet'),
	ok: BOTH('可以创建 worktree', 'ready to create a worktree'),
	ready: BOTH('可以合并回原分支', 'ready to merge back'),
	// The create gate, not a failure: a session standing in a worktree delivers the
	// one it is in. Creating another from there nests an isolation inside an
	// isolation and leaves the worktree that session was made for undelivered, so
	// the entry is refused with the two ways forward rather than hidden.
	'already-in-worktree': BOTH(
		'已经在一个 worktree 里了：先把它合并回去或丢弃它，或者回到原工作区再开新的',
		'already inside a worktree — deliver or discard it first, or create the next one from the main working tree'
	),
	'repo-root-only': BOTH('只有在仓库根目录才能创建 worktree', 'a worktree can only be created from the repository root')
};

/**
 * Look up a reason, never throwing.
 *
 * An unknown code is reported as itself rather than swallowed: a missing string
 * is a bug, and seeing the code in the UI is how it gets noticed.
 */
export function reasonText(code, { lang = 'zh' } = {}) {
	if (typeof code !== 'string' || code === '') return '';
	const entry = REASONS[code];
	if (entry === undefined) return code;
	if (lang === 'both') return entry;
	const [zh, en] = entry.split(' / ');
	return lang === 'en' ? (en ?? zh ?? '') : (zh ?? '');
}

/** Bilingual, always, for a place with room for one line. */
export function bothText(code) {
	return reasonText(code, { lang: 'both' });
}

/** Where a created worktree lives, as a sentence. */
export function createdText({ path, branch }) {
	return BOTH(`已创建 worktree：${path}（分支 ${branch}）`, `worktree created: ${path} (branch ${branch})`);
}

/**
 * The outcome of one explicit commit, as a sentence.
 *
 * The subject is quoted because it was generated from the file names rather than
 * typed by the user: seeing it after the fact is how they learn what the button
 * wrote into their history.
 */
export function committedText({ message, changes }) {
	const count = Number(changes) || 0;
	return BOTH(
		`已提交 ${count} 处改动：${message}`,
		`committed ${count} change(s): ${message}`
	);
}

/**
 * The outcome of one merge, as a sentence.
 *
 * The strategy picks a WORD inside each language rather than a bilingual fragment
 * inside a bilingual sentence: `BOTH` is a `zh / en` join, so interpolating one
 * `BOTH` result into another produced `已把 2 个提交快进 / fast-forwarded到 main`
 * — two half-sentences fighting in both languages at once.
 */
export function deliveredText({ strategy, branch, base, commits }) {
	const fastForward = strategy === 'fast-forward';
	return BOTH(
		`已把 ${commits} 个提交${fastForward ? '快进' : '用一个 merge commit 合并'}到 ${base}（来自 ${branch}）`,
		`${commits} commit(s) ${fastForward ? 'fast-forwarded' : 'merged with a commit'} into ${base} from ${branch}`
	);
}

/** What a conflict rollback promises the user. */
export function abortedText({ detail }) {
	const tail = detail ? `（${detail}）` : '';
	return BOTH(`合并冲突，已用 merge --abort 完整回滚原工作区${tail}`, `merge conflict — the main tree was restored with merge --abort${detail ? ` (${detail})` : ''}`);
}
