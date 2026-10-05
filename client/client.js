/**
 * The browser half: the git-worktree control, in ONE seat.
 *
 *   `conversation.input.left` — the composer toolbar. Ambient, so it exists BEFORE
 *   the first message, which is what lets a user start a session in a worktree
 *   instead of retrofitting one later; and present in every session, which the
 *   session header is not.
 *
 * One seat is a deliberate constraint, not an accident. A slot that hosts the same
 * component twice mounts it twice, with two independent copies of its state, so
 * every message the control shows appears twice on screen. This plugin did exactly
 * that: the same control in the composer toolbar and the session header produced
 * two identical banners. Asking the component which seat it is in was an attempt to
 * quiet one copy, but whether a slot projects registration options onto component
 * props is not something this plugin can verify, and the guess is what made the
 * layout messy. One registration removes the whole class of problem.
 *
 * Shipped as a `__ModuleLoader__` factory (the documented format for a plain-JS
 * client plugin — React comes from the browser module table, so a second React
 * is never installed and no JSX is needed).
 *
 * The state machine, which is the whole UX:
 *
 *   no session working directory → list the known git repositories and let the
 *                                  user pick one; picking creates a worktree,
 *                                  registers it as a Workspace, starts a session
 *                                  inside it, THEN SHOWS that session
 *   in a repository             → "创建 worktree · <branch>"
 *   in one of its worktrees     → "合并回 <branch> · N"
 *   not a repository            → render nothing at all
 *
 * Navigation is the two calls the sidebar makes for ITSELF, in this order:
 * `workspaces.create({ path })` registers the new worktree directory as a DSH
 * Workspace — which is what puts it in the sidebar at all, and what makes its
 * session group under it instead of landing in "Ungrouped" — and then
 * `uiWorkspace.openWorkspace(id)` starts a blank session whose working directory
 * is that workspace and selects it, which is exactly the sidebar's own "New
 * session" button.
 *
 * The order is not a shortcut around the Host; it is the only one that works. A
 * session started ON the Host is unknown to this client until a later list
 * refresh, and `sessions.retain()` — the call navigation makes — throws
 * `unknown session` for an id the browser has never seen, so a jump issued right
 * after creating one silently does nothing. A session the CLIENT creates is
 * addressable the moment that call resolves.
 *
 * What it deliberately does NOT do:
 *
 *   * import a Harness Client package (`@deepseek-ai/dsh-client-ui-primitives`
 *     and friends). The shipped guidance is explicit that a throwing component
 *     blanks the whole slot entry, and those modules change without notice. The
 *     controls below are plain markup styled with `--dsw-alias-*` theme tokens,
 *     so the only shared dependency is the token vocabulary itself.
 *   * read git state itself. The browser has no git access (`dsh-workspace-changes`
 *     ships no client half), so the host decides everything and this file renders
 *     the decision.
 */

window.__ModuleLoader__.load({
	id: 'dsh-local-worktree',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		const API = 'api/dsh-local-worktree';

		/**
		 * The client services this control needs, captured in `apply`.
		 *
		 * `workspaces` registers the new directory as a DSH Workspace — which is
		 * what puts it in the sidebar at all, and what makes its session group
		 * under it instead of landing in "Ungrouped" — `sessions` is not used
		 * directly here (it is what `uiWorkspace.openWorkspace` calls), and
		 * `uiWorkspace` is the navigation surface.
		 */
		const services = { uiWorkspace: null, workspaces: null };

		/**
		 * Show a Session in the Conversation panel.
		 *
		 * `uiWorkspace.openSession(id)` is the shipped navigation action — the same
		 * call the sidebar's own session-row click makes. It is best-effort here on
		 * purpose: a composition without the service must lose the automatic jump,
		 * not the control that created the worktree, and the result is returned so
		 * the caller can say which of the two happened.
		 *
		 * Note what it CANNOT do: `sessions.retain()` — the call this navigation
		 * makes — throws `unknown session` for an id the client has never seen, so a
		 * Session started on the host is not navigable until a later list refresh
		 * teaches the client about it. That is why the main path below creates the
		 * Session from here instead.
		 */
		function openInUi(sessionId) {
			if (typeof sessionId !== 'string' || sessionId === '') return 'no-session';
			const workspace = services.uiWorkspace;
			if (workspace === null) return 'unavailable';
			try {
				// No "already navigated" guard: this is only ever called from a click, and
				// revisiting the same session later is a legitimate thing to ask for.
				workspace.openSession(sessionId);
				return 'opened';
			} catch {
				return 'failed';
			}
		}

		/** Two directory paths that name the same place, sparing case and separators. */
		function sameDir(left, right) {
			const norm = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
			return norm(left) !== '' && norm(left) === norm(right);
		}

		/**
		 * Put the user INTO a worktree that was just created.
		 *
		 * Two calls, both owned by the browser, and together they are the whole fix
		 * for "the worktree is created but nothing happens":
		 *
		 *   `workspaces.create({ path })`  registers the directory on the Host
		 *     (idempotent — it resolves by canonical path first) and echoes the row
		 *     into the CLIENT projection immediately, so the sidebar has it before
		 *     anything tries to navigate to it.
		 *   `uiWorkspace.openWorkspace(id)` is exactly what the sidebar's own "New
		 *     session" button does: it starts a blank Session whose working
		 *     directory is the workspace path AND selects it, so the jump cannot
		 *     race the session catalog the way a host-created Session does.
		 *
		 * The stage is reported rather than a bare boolean, because the caller's
		 * recovery differs: nothing was created for `no-services`/`create-failed`,
		 * while `navigate-failed` may already have a Session the user can open by
		 * hand.
		 */
		async function enterWorktree(path) {
			if (typeof path !== 'string' || path === '') return { ok: false, stage: 'create-failed' };
			const workspaces = services.workspaces;
			const navigation = services.uiWorkspace;
			if (workspaces === null || typeof workspaces.create !== 'function') return { ok: false, stage: 'no-services' };
			if (navigation === null || typeof navigation.openWorkspace !== 'function') return { ok: false, stage: 'no-services' };
			let workspace;
			try {
				workspace = await workspaces.create({ path });
			} catch (error) {
				console.warn('dsh-local-worktree: the worktree directory was not registered as a workspace:', error);
				return { ok: false, stage: 'create-failed' };
			}
			const workspaceId = workspace && typeof workspace.workspaceId === 'string' ? workspace.workspaceId : '';
			if (workspaceId === '') return { ok: false, stage: 'create-failed' };
			try {
				await navigation.openWorkspace(workspaceId);
			} catch (error) {
				console.warn('dsh-local-worktree: the workspace is registered but its session was not opened:', error);
				return { ok: false, stage: 'navigate-failed', workspaceId };
			}
			return { ok: true, stage: 'done', workspaceId };
		}

		/**
		 * The control's own stylesheet, rendered as an element so unmounting the
		 * component removes it.
		 *
		 * Every colour comes from a token this build actually defines — the theme
		 * contract is `--dsw-alias-bg-overlay` (popovers), `--dsw-alias-bg-layer-1/2`
		 * (raised surfaces), `--dsw-alias-border-l1/l2`, `--dsw-alias-label-*` and
		 * `--dsw-alias-state-*`. Inventing names like `--dsw-alias-bg-elevated` does
		 * NOT degrade gracefully: an undefined custom property resolves to nothing,
		 * so a menu ends up with a TRANSPARENT background and its text fights the
		 * conversation behind it. The `light-dark()` fallback keeps a popover opaque
		 * even if a future theme stops defining the token.
		 *
		 * Layering is stated explicitly rather than assumed: the component is
		 * `position:relative`, so it creates no stacking context that would trap the
		 * menu, and the menu sits at a high z-index because it is opened from the
		 * composer toolbar, over whatever the page draws there.
		 */
		const CSS = `
.dshwt-wrap{position:relative;display:inline-flex;align-items:center;gap:2px;min-width:0;font-size:12px}
.dshwt-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;max-width:240px;height:26px;padding:0 8px;
  border:1px solid transparent;border-radius:6px;cursor:pointer;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-secondary);background:transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshwt-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshwt-btn:disabled{cursor:not-allowed;opacity:.5}
.dshwt-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshwt-btn--deliver{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);
  border-color:var(--dsw-alias-border-l1)}
.dshwt-btn--deliver:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}
.dshwt-btn--start{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dshwt-more{box-sizing:border-box;width:18px;height:26px;padding:0;border:none;border-radius:6px;
  cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent;font-size:12px;line-height:1}
.dshwt-more:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshwt-menu{position:absolute;z-index:1000;bottom:calc(100% + 6px);left:0;min-width:260px;max-width:400px;max-height:52vh;overflow:auto;
  padding:4px;display:flex;flex-direction:column;
  border:1px solid var(--dsw-alias-border-l2);border-radius:8px;
  background:var(--dsw-alias-bg-overlay,light-dark(#ffffff,#232323));color:var(--dsw-alias-label-primary);
  box-shadow:0 8px 28px rgba(0,0,0,.28)}
.dshwt-item{display:block;width:100%;text-align:left;padding:5px 8px;border:none;border-radius:6px;
  background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshwt-item:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dshwt-item:disabled{opacity:.5;cursor:not-allowed}
.dshwt-item--danger{color:var(--dsw-alias-state-error-primary)}
.dshwt-head{padding:5px 8px 3px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);white-space:normal}
.dshwt-sub{display:block;font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshwt-note{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);padding:4px 8px 6px;max-width:320px;white-space:normal}
.dshwt-sep{height:1px;margin:4px 2px;background:var(--dsw-alias-border-l1)}
`;

		/** One JSON call, with the contract the host routes implement. */
		async function call(path, { method = 'GET', body, signal } = {}) {
			try {
				const response = await fetch(`${API}/${path}`, {
					method,
					headers: body === undefined
						? { accept: 'application/json' }
						: { 'content-type': 'application/json', accept: 'application/json' },
					body: body === undefined ? undefined : JSON.stringify(body),
					signal
				});
				if (!response.ok) return { ok: false, reason: 'http-error', detail: String(response.status) };
				return await response.json();
			} catch (error) {
				if (error && error.name === 'AbortError') return null;
				return { ok: false, reason: 'network', detail: String((error && error.message) || error) };
			}
		}

		/** The last two path segments: enough to recognise a repository in a menu. */
		function shortPath(value) {
			const parts = String(value ?? '').split(/[\\/]/).filter((part) => part !== '');
			return parts.slice(-2).join('/');
		}

		/** A short label for the current state, in both languages. */
		function labelFor(status, phase, hasCwd) {
			if (phase === 'busy') return '处理中… / working…';
			if (!hasCwd) return '用 worktree 开工';
			if (status === null) return 'worktree';
			const kind = status.action ? status.action.kind : 'none';
			if (kind === 'deliver') {
				const worktree = status.worktree ?? {};
				const ahead = worktree.ahead ? worktree.ahead : 0;
				// The label is the ONLY explanation a disabled button gets, so each case
				// names the state rather than the branch: "worktree · master" told the
				// user nothing about why there was nothing to click.
				if (ahead > 0) return `合并回 ${status.repo.branch || '?'} · ${ahead}`;
				if (worktree.dirty) return 'worktree 有未提交改动';
				return 'worktree 还没有新提交';
			}
			return status.repo.branch ? `创建 worktree · ${status.repo.branch}` : '创建 worktree';
		}

		/** The tooltip: what this click will do, or why it will not. */
		function titleFor(status, phase, hasCwd) {
			if (phase === 'busy') return '正在执行 git 操作… / running a git operation…';
			if (!hasCwd) {
				return [
					'还没选择工作目录：点这里选一个 git 仓库，直接用 worktree 开工',
					'No working directory yet — pick a git repository to start in a worktree',
					'会先建 worktree，再开一个落在里面的新会话 / creates the worktree, then a session inside it'
				].join('\n');
			}
			if (status === null) return '正在读取 git 状态… / reading git state…';
			if (!status.repo || status.repo.present !== true) return '这不是一个 git 仓库 / not a git repository';
			if (status.action && status.action.kind === 'deliver') {
				const worktree = status.worktree ?? {};
				const ahead = worktree.ahead ? worktree.ahead : 0;
				const parts = [
					`worktree: ${worktree.path || ''}`,
					`分支 / branch: ${worktree.branch ? worktree.branch : '?'}`,
					`目标 / into: ${status.repo.branch || '?'}`
				];
				if (ahead > 0 && status.merge && status.merge.text) parts.push(status.merge.text);
				if (status.action.enabled !== true) {
					// The refusal is the whole tooltip here, and the common one needs an
					// instruction rather than a status: nothing was committed in the
					// worktree yet, so there is nothing to merge.
					parts.push('');
					parts.push(worktree.dirty
						? 'worktree 里有未提交的改动：先提交，按钮才会亮 / uncommitted changes — commit them and this button turns on'
						: '这个 worktree 还没有提交任何东西，没有可合并的内容',
						'');
					parts.push('在这个 worktree 里：git add -A && git commit -m "..."',
						'然后回到这里点按钮即可合并回原分支',
						'In the worktree: git add -A && git commit -m "..."',
						'then press this button to merge into the base branch');
				}
				// The worktree being BEHIND its base is not a refusal — it is the reason a
				// clean worktree can still have nothing to deliver, and on its own the
				// message above would read as "you did nothing" when the work actually
				// landed in the main repository. Say where it went.
				if (worktree.baseAhead > 0) {
					parts.push('',
						`注意：主分支已经领先这个 worktree ${worktree.baseAhead} 个提交`,
						'如果你刚才是在主仓库里改的，那个提交就在主分支上，这个 worktree 里没有东西可交',
						'note: the base branch is ' + worktree.baseAhead + ' commit(s) ahead of this worktree',
						'if you worked in the main repository, the commit is already on the base branch');
				}
				return parts.join('\n');
			}
			if (!status.action || status.action.enabled !== true) {
				return (status.action && (status.action.reasonText || status.action.reason)) || '';
			}
			const lines = [
				`仓库 / repository: ${status.repo.root || ''}`,
				`worktree 建在 / worktrees land in: ${status.worktreeContainer || ''}`,
				'目录名 <repo>_<时间戳+随机>，每次点击新建一个 / path is <repo>_<timestamp+random>, a new one per click',
				'本地 git，不使用 remote / local git only, no remote'
			];
			const mine = Array.isArray(status.myWorktrees) ? status.myWorktrees : [];
			if (mine.length > 0) {
				lines.push('');
				lines.push(`本插件已建 ${mine.length} 个 / this plugin already made ${mine.length}:`);
				for (const record of mine.slice(0, 4)) lines.push(`  ${record.path}`);
			}
			return lines.join('\n');
		}

		/** The branch glyph, so the control reads as git at a glance. */
		function Glyph() {
			return h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', 'aria-hidden': true, style: { flex: '0 0 auto' } },
				h('path', {
					fill: 'currentColor',
					d: 'M5 2.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0 1a.5.5 0 1 1 0 1 .5.5 0 0 1 0-1Zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0 1a.5.5 0 1 1 0 1 .5.5 0 0 1 0-1ZM4.5 5.6v3.9a2.5 2.5 0 0 0 2.5 2.5h2a2.5 2.5 0 0 0 2.5-2.5V5.6a2 2 0 0 1-1-.4v4.3a1.5 1.5 0 0 1-1.5 1.5h-2A1.5 1.5 0 0 1 5.5 9.5V5.2a2 2 0 0 1-1 .4Zm5.4.9a2.5 2.5 0 0 0 2.6-2.5V3.5a.5.5 0 0 0-1 0V4a1.5 1.5 0 0 1-1.6 1.5.5.5 0 0 0 0 1Z'
				})
			);
		}

		/**
		 * The whole control.
		 *
		 * Mounted in ONE seat only, and that is the design decision that matters
		 * here: registering the same component in two slots makes the browser render
		 * it twice, with two independent copies of its state, so every message it
		 * shows appears in two places at once. A `seat` prop was tried as a way to
		 * keep the second copy quiet, but whether a slot projects registration
		 * options onto component props is not something this plugin can verify — and
		 * a guess about that is exactly what produced two banners on screen.
		 *
		 * So the control lives in `conversation.input.left`, the composer toolbar:
		 * it is ambient, so it exists before the first message (the Hero case), and
		 * it is present in every session, which the session header is not.
		 */
		function GitWorktreeControl(props) {
			const sessionId = props && props.sessionId;
			const useSessions = props && props.useSessions;
			// The documented way for a client plugin to learn a session's working
			// directory: the session store, subscribed to the smallest slice.
			const cwd = useSessions
				? useSessions((state) => (sessionId && state.byId[sessionId] ? state.byId[sessionId].cwd : undefined))
				: undefined;

			const [status, setStatus] = React.useState(null);
			const [repos, setRepos] = React.useState(null);
			const [phase, setPhase] = React.useState('idle');
			const [notice, setNotice] = React.useState(null);
			// false = closed, 'main' = this directory's actions, 'repos' = the picker.
			const [menu, setMenu] = React.useState(false);
			const mounted = React.useRef(true);
			const generation = React.useRef(0);

			React.useEffect(() => () => { mounted.current = false; }, []);

			/** Re-read this directory's state. Only the newest answer may win. */
			const refresh = React.useCallback(async () => {
				if (!cwd) { setStatus(null); return undefined; }
				const mine = ++generation.current;
				const controller = new AbortController();
				const value = await call(`status?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });
				if (mounted.current && mine === generation.current) setStatus(value);
				return () => controller.abort();
			}, [cwd]);

			React.useEffect(() => {
				let cancel;
				refresh().then((dispose) => { cancel = dispose; });
				return () => { if (typeof cancel === 'function') cancel(); };
			}, [cwd, refresh]);

			const loadRepos = React.useCallback(async () => {
				const value = await call('workspaces');
				if (mounted.current) setRepos(value === null ? { ok: false, items: [] } : value);
				return value;
			}, []);

			// The repository list is loaded whenever the picker is open, and re-read
			// each time it opens so a workspace added meanwhile shows up.
			React.useEffect(() => {
				if (menu !== 'repos') return;
				void loadRepos();
			}, [menu, loadRepos]);

			// Close the menu on Escape, the behaviour a user expects from a menu.
			React.useEffect(() => {
				if (menu === false) return undefined;
				const onKey = (event) => { if (event.key === 'Escape') setMenu(false); };
				document.addEventListener('keydown', onKey);
				return () => document.removeEventListener('keydown', onKey);
			}, [menu]);

			/** Run one action, then re-read state so the label tells the truth. */
			const run = React.useCallback(async (path, body, done) => {
				setPhase('busy');
				setNotice(null);
				const answer = await call(path, { method: 'POST', body: { ...body, ...(cwd ? { cwd } : {}) } });
				if (!mounted.current) return;
				if (answer === null) { setPhase('idle'); return; }
				if (answer.ok === true) {
					// `done` may be async: entering the new worktree is a navigation, and
					// its outcome decides what the user is told.
					const text = await done(answer);
					if (mounted.current) setNotice(text);
				} else {
					setNotice(`${answer.reasonText || answer.reason || 'failed'}${answer.detail ? `（${answer.detail}）` : ''}`);
				}
				setPhase('idle');
				await refresh();
			}, [cwd, refresh]);

			/**
			 * The worktree exists — get the user into it, and report what happened.
			 *
			 * The main path is entirely client-side: register the directory as a
			 * Workspace, then let `openWorkspace` start a Session in it and select it.
			 * Only when this composition has no service to do that does the host get
			 * asked to start the session, exactly as it used to.
			 */
			const afterCreate = React.useCallback(async (answer) => {
				const where = answer.created && answer.created.path ? answer.created.path : '';
				const placed = where === '' ? { ok: false, stage: 'create-failed' } : await enterWorktree(where);
				if (placed.ok === true) {
					return `${where}\n已进入该 worktree 的新会话 / now in the worktree's new session`;
				}
				if (placed.stage === 'navigate-failed') {
					return `${where}\nworktree 与工作区已就绪，请到左侧列表打开它的会话 / the worktree and its workspace are ready — open its session from the sidebar`;
				}
				// Degradation path: no `workspaces`/`sessions` on this client, so the
				// host starts the session the way it always did. The jump may still be
				// too early for this client to know the id — say so instead of pretending.
				const asked = where === ''
					? null
					: await call('session', { method: 'POST', body: { cwd: where, sessionId: sessionId ?? null } });
				const hostSession = asked !== null && asked.ok === true && asked.session ? asked.session.sessionId : null;
				if (hostSession === null) return `${where}\nworktree 已就绪 / the worktree is ready`;
				return openInUi(hostSession) === 'opened'
					? `${where}\n已切换到该 worktree 的新会话 / switched to the new session in the worktree`
					: `${where}\nworktree 已就绪，请到左侧会话列表打开它 / the worktree is ready — open its session from the sidebar (${hostSession})`;
			}, [sessionId]);

			/**
			 * This plugin's other live worktrees for the repository.
			 *
			 * The host reports only records THIS plugin wrote whose directory still
			 * exists, so a worktree from another tool (DSH's own managed checkout) is
			 * absent by construction and can never be offered or blocked here.
			 */
			const mineWorktrees = React.useCallback(() => {
				const records = status && Array.isArray(status.myWorktrees) ? status.myWorktrees : [];
				const current = status && status.worktree && status.worktree.path ? status.worktree.path : null;
				return records.filter((record) => record && record.path && record.path !== current);
			}, [status]);

			/**
			 * The session working in one of this plugin's other worktrees.
			 *
			 * The CLIENT's Workspace projection answers first, by path: a session the
			 * browser started is registered there at once, while the host's remembered
			 * id (the fallback) only exists once the host has been told about it. The
			 * projection is also the authority the sidebar groups by, so its answer is
			 * the one that is certain to be a row the user can actually see.
			 */
			const sessionOfWorktree = React.useCallback((record) => {
				const workspaces = services.workspaces;
				const items = workspaces !== null && workspaces.list && typeof workspaces.list.getSnapshot === 'function'
					? workspaces.list.getSnapshot().items
					: null;
				if (Array.isArray(items)) {
					const match = items.find((item) => item && sameDir(item.path, record.path));
					const first = match !== undefined && Array.isArray(match.sessionIds) ? match.sessionIds[0] : undefined;
					if (typeof first === 'string' && first !== '') return first;
				}
				return typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : null;
			}, []);

			/**
			 * Start a worktree session in a chosen repository, then GO there.
			 *
			 * The jump is the point: without it the new session is only a row in the
			 * sidebar, and the user has to find it and open it by hand — which is what
			 * made this flow feel broken.
			 */
			const startIn = React.useCallback(async (path) => {
				setMenu(false);
				setPhase('busy');
				setNotice(null);
				const answer = await call('create', { method: 'POST', body: { cwd: path, sessionId: sessionId ?? null } });
				if (!mounted.current) return;
				if (answer !== null && answer.ok === true) setNotice(await afterCreate(answer));
				else if (answer !== null) setNotice(`${answer.reasonText || answer.reason || 'failed'}${answer.detail ? `（${answer.detail}）` : ''}`);
				setPhase('idle');
			}, [sessionId, afterCreate]);

			if (cwd && status !== null && status.repo && status.repo.present !== true) return null;

			const hasCwd = Boolean(cwd);
			const action = status && status.action ? status.action : null;
			const kind = action ? action.kind : 'none';
			const enabled = action ? action.enabled === true : false;
			const isDeliver = kind === 'deliver';
			const busy = phase === 'busy';

			/**
			 * Whether THIS directory may cut another worktree, and why not.
			 *
			 * The host decides it (`status.create`) because the rule is about the
			 * repository rather than about markup: once a session is standing in a
			 * worktree, what it has to finish is THAT worktree — deliver it or discard
			 * it — and a second one cut from inside the first nests an isolation inside
			 * an isolation.
			 *
			 * The fallback is not decoration. This bundle hot-reloads into a running
			 * page while the host half only changes on a restart, so between the two
			 * this must reach the same verdict from what the status payload has always
			 * carried: the worktree the session is in.
			 */
			const gate = status && status.create && typeof status.create === 'object'
				? status.create
				: {
					enabled: Boolean(status && status.repo && status.repo.usable === true)
						&& !(status && status.worktree && status.worktree.present === true),
					reason: status && status.worktree && status.worktree.present === true ? 'already-in-worktree' : 'ok',
					reasonText: ''
				};
			const canCreate = gate.enabled === true;
			// The entry is never HIDDEN, only disabled: a menu that silently drops the
			// thing the user came for reads as a bug, and there is room here to say why.
			const createHint = canCreate
				? null
				: gate.reasonText
					|| (gate.reason === 'already-in-worktree'
						? '已经在一个 worktree 里了：先把它合并回去或丢弃它，或者回到原工作区再开新的 / already inside a worktree — deliver or discard it first, or create the next one from the main working tree'
						: '');
			// The sub line stays short (it is one clipped row); the tooltip carries the
			// whole sentence.
			const createSub = !canCreate && gate.reason === 'already-in-worktree'
				? '已经在一个 worktree 里 / already in a worktree'
				: (status && status.repo && status.repo.root ? shortPath(status.repo.root) : null);

			const onPrimary = () => {
				if (busy) return;
				// Before a working directory exists, the primary click opens the picker:
				// there is no repository to act on yet. When a worktree already exists
				// the primary click opens the menu, whose first entry reaches it.
				if (!hasCwd || !enabled) { setMenu(menu === false ? (hasCwd ? 'main' : 'repos') : false); return; }
				if (isDeliver) {
					void run('deliver', {}, (answer) => {
						const clean = answer.cleanup && answer.cleanup.removed ? '，worktree 已清理 / cleaned up' : '';
						return `${answer.text || '已合并 / merged'}${clean}`;
					});
					return;
				}
				void run('create', { sessionId }, afterCreate);
			};

			const option = (key, label, sub, onClick, opt) => h('button', {
				key,
				type: 'button',
				className: `dshwt-item${opt && opt.danger ? ' dshwt-item--danger' : ''}`,
				disabled: busy || (opt && opt.disabled === true),
				// A disabled entry's tooltip is its explanation, so a caller may supply
				// one that says more than the sub line does.
				title: (opt && opt.title) || sub || label,
				// The menu must not steal focus from the composer behind it.
				onMouseDown: (event) => event.preventDefault(),
				onClick
			}, label, sub ? h('span', { className: 'dshwt-sub' }, sub) : null);

			const repoOptions = () => {
				const items = repos && Array.isArray(repos.items) ? repos.items : null;
				if (items === null) {
					return [h('div', { key: 'loading', className: 'dshwt-note' }, '正在读取工作区列表… / loading workspaces…')];
				}
				const git = items.filter((item) => item.git === true);
				const other = items.filter((item) => item.git !== true);
				return [
					h('div', { key: 'head', className: 'dshwt-head' }, '选一个 git 仓库，直接用 worktree 开工 / pick a repository to start in a worktree'),
					...git.map((item) => option(
						`repo:${item.path}`,
						item.title,
						shortPath(item.path),
						() => { void startIn(item.path); },
						{}
					)),
					git.length === 0
						? h('div', { key: 'none', className: 'dshwt-note' }, '已知工作区里没有 git 仓库。先在左侧添加一个仓库目录。/ None of the known workspaces is a git repository — add one from the sidebar first.')
						: null,
					other.length > 0 ? h('div', { key: 'sep', className: 'dshwt-sep' }) : null,
					...other.map((item) => option(
						`norepo:${item.path}`,
						item.title,
						`${shortPath(item.path)} · 不是 git 仓库 / not a git repository`,
						() => {},
						{ disabled: true }
					))
				];
			};

			const mainOptions = () => [
				h('div', { key: 'head', className: 'dshwt-head' }, '当前目录 / this directory'),
				// Disabled once this session is already in a worktree: the verb that
				// matters there is deliver, below. The host's `create` decision carries
				// the reason, so the same rule is not re-derived here.
				option('create', '创建 worktree / create worktree',
					createSub,
					() => { setMenu(false); void run('create', { sessionId }, afterCreate); },
					{ disabled: !canCreate, title: createHint }),
				option('deliver', '合并回原分支 / deliver to the base branch',
					status && status.repo ? status.repo.branch : null,
					() => { setMenu(false); void run('deliver', {}, (answer) => answer.text || '已合并 / merged'); },
					{ disabled: !isDeliver || !enabled }),
				option('open', '在文件管理器中打开 / open in file manager',
					status ? shortPath(status.worktree && status.worktree.path ? status.worktree.path : status.repoRoot) : null,
					() => { setMenu(false); void run('open', {}, () => '已打开 / opened'); },
					{ disabled: !status || !status.repoRoot }),
				// The plugin's OWN other worktrees for this repository. Deliberately
				// narrow: worktrees this plugin did not create (DSH's own managed
				// checkouts, a hand-made one) are none of this control's business and
				// must never disable anything here.
				mineWorktrees().length > 0 ? h('div', { key: 'mine-head', className: 'dshwt-head' },
					`本插件已建 ${mineWorktrees().length} 个 worktree，点下面可以跳过去。在这个会话里改动会直接落到 ${status && status.repo ? status.repo.branch || '当前分支' : '当前分支'}`,
					h('span', { className: 'dshwt-sub' }, `${mineWorktrees().length} worktree(s) waiting — edits made HERE land on the base branch`)) : null,
				...mineWorktrees().map((record) => option(
					`mine:${record.path}`,
					'跳回已有 worktree / go to existing worktree',
					shortPath(record.path),
					() => {
						setMenu(false);
						const target = sessionOfWorktree(record);
						if (target === null) {
							setNotice(`worktree: ${record.path}\n没有记录到它的会话，请到左侧会话列表打开 / no session is on record — open it from the sidebar`);
							return;
						}
						const move = openInUi(target);
						setNotice(move === 'opened'
							? '已切换到该 worktree 的会话 / switched to that worktree\'s session'
							: '无法自动切换，请到左侧会话列表打开它 / could not switch automatically — open it from the sidebar');
					},
					{}
				)),
				h('div', { key: 'sep1', className: 'dshwt-sep' }),
				option('switch', '在别的仓库里开工 / start in another repository', null,
					() => setMenu('repos'), {}),
				h('div', { key: 'sep2', className: 'dshwt-sep' }),
				option('discard', '丢弃 worktree（不合并）/ discard worktree', null,
					() => { setMenu(false); void run('discard', {}, () => '已丢弃 / discarded'); },
					{ disabled: !isDeliver, danger: true }),
				isDeliver ? h('div', { key: 'note', className: 'dshwt-note' },
					'丢弃会强制删除 worktree 目录和它自己的分支，未提交的改动会丢失。/ Discarding force-removes the worktree directory and its own branch; uncommitted changes are lost.') : null
			];

			return h(React.Fragment, null,
				h('style', { 'data-plugin': 'dsh-local-worktree' }, CSS),
				h('div', { className: 'dshwt-wrap' },
					h('button', {
						type: 'button',
						className: `dshwt-btn${isDeliver ? ' dshwt-btn--deliver' : ''}${!hasCwd ? ' dshwt-btn--start' : ''}`,
						disabled: busy,
						title: titleFor(status, phase, hasCwd),
						'aria-label': titleFor(status, phase, hasCwd),
						'aria-haspopup': menu === false ? undefined : 'menu',
						'aria-expanded': menu === false ? 'false' : 'true',
						onClick: onPrimary
					},
						h(Glyph),
						h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, labelFor(status, phase, hasCwd))
					),
					h('button', {
						type: 'button',
						className: 'dshwt-more',
						'aria-haspopup': 'menu',
						'aria-expanded': menu === false ? 'false' : 'true',
						'aria-label': 'worktree 更多操作 / more worktree actions',
						title: '更多操作 / more actions',
						onClick: () => setMenu(menu === false ? (hasCwd ? 'main' : 'repos') : false)
					}, '⋯'),
					menu === false ? null : h('div', { className: 'dshwt-menu', role: 'menu' },
						menu === 'repos' ? repoOptions() : mainOptions()
					)
				),
				// One line, clipped to the row it lives in. The full story — paths, the
				// recovery command, the drift counts — belongs in the tooltip, which does
				// not move anything; a multi-line banner in the composer toolbar pushes
				// the input the user is typing into.
				notice ? h('div', { className: 'dshwt-note' }, notice) : null
			);
		}

		return {
			name: 'dsh-local-worktree',
			// `uiWorkspace` is what makes the created session VISIBLE, `workspaces` is
			// what puts the new worktree directory in the sidebar at all, and
			// `sessions` is what `openWorkspace` starts the session through. All three
			// are declared so this plugin waits for them instead of racing them, and
			// every shipped Web composition provides them
			// (`@deepseek-ai/dsh-client-ui-workspace`); the code above still degrades
			// to host-side session creation if one is ever missing.
			inject: ['slots', 'uiWorkspace', 'workspaces', 'sessions'],
			apply(ctx) {
				// Captured once, guarded at the call site: a missing service must cost
				// the navigation, never the control.
				services.uiWorkspace = ctx.uiWorkspace ?? ctx.get?.('uiWorkspace') ?? null;
				services.workspaces = ctx.workspaces ?? ctx.get?.('workspaces') ?? null;
				// ONE seat, deliberately. `conversation.input.left` is the composer
				// toolbar: ambient, so it exists before the first message, and present in
				// every session. Registering a second seat is what put two copies of this
				// control — and of every message it shows — on screen at once, because the
				// component is then genuinely mounted twice with two copies of its state.
				ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
					name: 'conversation.input.left',
					id: 'dsh-local-worktree',
					order: 20,
					label: 'Git worktree'
				}, GitWorktreeControl));
			}
		};
	}
});
