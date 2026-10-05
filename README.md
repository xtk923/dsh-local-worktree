# dsh-local-worktree

A one-click git worktree inside DeepSeek Harness. In a git workspace a button
appears in the composer toolbar: press it to cut an isolated worktree under the
repository, do the work there, then press it again to merge that work back into
the branch it came from.

**Everything is local git.** No remote, no bundle, no GitHub, no network. A
linked worktree shares the repository's object database, so commits made in it
are already reachable from the main tree — "deliver" is a plain local branch
merge, nothing more.

```
 ┌────────────────────────┐   create    ┌────────────────────────────────────────────┐
 │  C:\proj\app           │ ──────────► │  C:\proj\app\.dsh-worktrees\app_a4f9m3k8   │
 │  branch: main          │             │  branch: dsh/wt/app_a4f9m3k8               │
 │  (your working copy)   │ ◄────────── │  (the session works here)                  │
 └────────────────────────┘   deliver   └────────────────────────────────────────────┘
```

The worktree lands **under the repository** by default (`worktreeLayout: inside`),
which is what lets the DSH sidebar nest it inside the repository's own workspace
group — the sidebar nests a workspace under its nearest *registered* ancestor
directory, so a sibling directory could never appear there. The container is
`.dsh-worktrees/`, and the plugin adds that one line to the repository's own
`.git/info/exclude` before creating it, so the main tree's `git status` never sees
it and a `git add -A` there cannot commit a parallel checkout. Set
`worktreeLayout: sibling` for the older `<parent>\<repo>_worktrees\` layout.

Every click mints a **new** `app_<timestamp+random>` directory, so two clicks are
two worktrees rather than one reused one.

## What the button does

The control lives in **one** seat — `conversation.input.left`, the composer
toolbar — and the state it renders is decided by the session's working directory:

* that slot is **ambient**, so it exists *before the first message*, which is what
  makes it possible to **start** a session in a worktree rather than retrofit one
  afterwards;
* it is present in **every** session, which the session header is not.

One seat is a deliberate constraint. A slot that hosts the same component twice
mounts it twice with two independent copies of its state, so every message the
control shows appears twice on screen — this plugin did exactly that, in the
composer toolbar and the session header at once.

| Where the session is | What the control offers |
|---|---|
| **no working directory yet** (blank-session Hero) | **用 worktree 开工** — opens a picker of your known git repositories; picking one cuts a worktree, registers it as a workspace, opens a session rooted in it, and **switches the browser to that session** |
| not a git repository | nothing at all — the control does not render |
| a repository with no commit yet | a disabled button explaining that you must commit once first |
| a repository on a branch | **创建 worktree** — cut a new worktree and start a session in it |
| inside a worktree it created | **合并回 &lt;branch&gt; · N** — merge the N new commits back |

Creating is available in a usable repository **until the session is inside a
worktree**. Once it is, the `⋯` menu's **创建 worktree** entry is disabled, with
the reason on it: what that session has to finish is the worktree it is standing
in — deliver it or discard it — and a second worktree cut from inside the first
nests one isolation inside another. The entry is disabled rather than hidden, so
the menu still answers "why can't I?"; **在别的仓库里开工** stays enabled, because
that one starts fresh work in a repository you pick. In the main working tree
creation is unconditional: each worktree gets its own `<repo>_<id>` path and its
own branch, so a second click is a second worktree rather than a collision.
Worktrees this plugin made are listed in the `⋯` menu so you can jump back to
their session; worktrees it did **not** make — including DSH's own managed
checkouts under `~/.dsh/worktrees/`, and any you created by hand — are
deliberately not reported and never disable anything here.

The rule is decided by the Host (`create` in the `status` payload, alongside
`action`) and only *rendered* by the button, because it is a statement about the
repository. It is deliberately advisory: the `create` route itself stays open,
since its other callers are not this directory's session — the Hero picker cuts a
worktree in a repository you chose, which may itself be a worktree this plugin
registered, and `/worktree create` and the `git_worktree` tool are surfaces a
caller drives on purpose.

The picker lists non-git workspaces too, greyed with the reason: a menu that
silently omits the directory you just picked is worse than one that says why.

Joining a new worktree is **two client calls, in this order**, and both are the
calls the sidebar makes for itself:

1. `workspaces.create({ path })` — registers the new directory as a DSH
   Workspace. This is what puts it in the sidebar at all, and it is what makes the
   session group *under* the worktree instead of landing in **Ungrouped**; the
   call is idempotent (the Host resolves by canonical path first) and its answer is
   merged into the client's own projection immediately, so the row exists before
   anything tries to navigate to it.
2. `uiWorkspace.openWorkspace(id)` — the sidebar's **New session** button, exactly:
   it starts a blank session whose working directory is that workspace and selects
   it.

The order is not an implementation detail; it is the reason the jump used to do
nothing. A session started on the **Host** is unknown to the browser until a later
list refresh, and `sessions.retain()` — the call navigation makes — throws
`unknown session` for an id the client has never seen, so navigating to one
immediately after creating it silently fails. A session the **client** creates is
addressable the moment that call resolves.

If a composition has no `workspaces`/`sessions` service, the control degrades
instead of breaking: it asks the Host (`POST /session`) to start the session the
old way, tries the jump anyway, and otherwise tells you where to find it. The
`git_worktree` tool and `/worktree create` have no browser at all, so they keep
starting the session on the Host and still register the directory as a workspace.

A `⋯` menu beside it carries the secondary actions: create (disabled, with the
reason, once the session is already inside a worktree), deliver, open that
worktree's session, open the folder in the file manager, start in *another*
repository, and discard the worktree.

## What "deliver" guarantees

1. **Nothing is decided after something is written.** Every refusal — a dirty
   main tree, the main tree having moved to another branch, a different
   repository, an unfinished merge — is decided by reading state first.
2. **A conflict is detected before it happens.** When the base branch has moved,
   `git merge-tree --write-tree` computes the merge *without touching the working
   tree, the index or HEAD*. A conflict is reported with the file names, and
   nothing was ever started.
3. **If a conflict does land anyway** (an older git without `merge-tree
   --write-tree`), the only recovery this plugin performs is `git merge --abort`,
   which restores the pre-merge index and working tree exactly. The worktree is
   always kept, so a conflict costs a retry — never the work.
4. **The worktree's own branch is deleted with `git branch -d`, never `-D`.** If
   its commits are not merged, git refuses and the branch survives.

## What it will not do

* **Never touches a remote.** No `fetch`, no `push`, no `remote add`. There is a
  test that asserts `git remote -v` is empty and no `remote.*` config exists
  after a full create → work → deliver cycle.
* **Never skips your hooks.** The automatic checkpoint commit runs *with*
  `pre-commit` hooks enabled. If a repository's hook (a secret scanner, a
  linter) refuses the commit, that is reported as a failure — the plugin does not
  decide that your gitleaks hook does not apply.
* **Never commits on your behalf without being asked.** A commit happens only at
  delivery time, only if the worktree still has uncommitted work, and only
  because `autoCommit` is on (it is; set it false to be refused instead).
* **Never deletes a worktree with uncommitted changes** during cleanup. Forced
  removal happens only through the explicit **discard** action, whose menu entry
  says what it will cost.

## Install

```
dsh plugin add C:\Workspace\dsh-local-worktree
```

or, from inside DSH, `plugin_manager` with `action: "install_bundle"` and this
directory as the target. The bundle patch inserts one host row; the browser half
is discovered automatically from the package's `dsh.client` section.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Keep the surfaces but refuse every action with a reason. |
| `autoCommit` | `true` | Commit leftover worktree work before merging (a commit subject is generated from the changed file names). |
| `autoCleanup` | `true` | After a successful merge, remove the worktree and delete its own branch if fully merged. |
| `commitMessage` | `wip: dsh worktree checkpoint` | Subject for the automatic commit. |
| `registerTool` | `true` | Expose the `git_worktree` tool to the agent. |
| `worktreeLayout` | `inside` | Where a worktree lands: `inside` = `<repo>\.dsh-worktrees\<repo>_<id>` (nests under the repository in the sidebar's Workspace Tree grouping, and the container is added to `.git/info/exclude`); `sibling` = `<parent>\<repo>_worktrees\<repo>_<id>`. |
| `gitTimeoutMs` | `60000` | Wall-clock budget for one git command. |
| `registryPath` | `$DSH_HOME/plugins/dsh-local-worktree/worktrees.json` | Where created worktrees are remembered. |

## Three surfaces, one implementation

* **The button** — `GET /api/dsh-local-worktree/{status,workspaces,health}` and
  `POST /api/dsh-local-worktree/{create,deliver,discard,open,session}`. Every
  answer is JSON with `ok` and, on refusal, a stable `reason` code and a bilingual
  `reasonText`, so the UI never prints raw git output at you. `POST /create` takes
  `session: "client" | "host" | "none"` (default `client`: the browser registers the
  workspace and starts the session; `host` starts it here, for the tool and the
  command; `none` creates the directory only), and `POST /session` starts a session
  in an existing worktree for a caller that cannot.
* **The tool** — `git_worktree` with `action: status | create | deliver | discard`.
  The agent can isolate its own work instead of being told to.
* **The command** — `/worktree`, `/worktree create`, `/worktree deliver`.

## Reloading after an update

The client half is served through `dsh-client-modules`, and `dsh-client-hmr`
swaps a rebuilt bundle into the running page — so a change to `client/client.js`
reaches an open page without a refresh. A change to the **host** half (a new
route, a new tool, a new response field) is a replaced package: DSH loads fresh
host JavaScript only on restart. Restart the app (or the Host) after changing
`src/`.

## Styling rule (learned the hard way)

Use **only** the theme tokens the running build defines. On this build that is
fourteen: `--dsw-alias-bg-base`, `-bg-layer-1`, `-bg-layer-2`, `-bg-overlay`,
`--dsw-alias-border-l1`, `-border-l2`, `--dsw-alias-brand-primary`,
`--dsw-alias-label-primary`, `-label-secondary`, four `--dsw-alias-state-*`
colours, and `--dsw-specific-sidebar-fill`. Ask the page for the live list with
`cordis_inspect_query` (`platform: "client"`, provider `Theme`, method
`listTokens`) instead of guessing a name.

A token that does not exist is **not** a soft miss: an undefined CSS custom
property resolves to nothing at all, so
`background: var(--dsw-alias-bg-elevated)` produces a **transparent** popover
whose text fights the conversation behind it. That is exactly what happened here,
which is why `test/client.test.mjs` now fails on any `--dsw-*` reference outside
the real list and asserts the popover keeps an opaque fallback.

## Layout notes, and why

Two layouts, one decision — `worktreeLayout`:

* **`inside` (default)** — `<repo>\.dsh-worktrees\<repo>_<id>`. The worktree sits
  under the repository, which is the only way it can appear inside the
  repository's own group in the sidebar: the sidebar nests a workspace under its
  nearest *registered ancestor directory*, so a sibling directory is always a
  parallel group however it is registered (and in the flat/WorkSpace grouping
  modes the two are always siblings — that view mode is a browser-local setting
  this plugin cannot and should not change).
  Because the container is inside the working tree, the plugin adds
  `.dsh-worktrees/` to the repository's `.git/info/exclude` **before** creating
  it. `info/exclude` and not `.gitignore`: the line stays local to your clone, so
  nothing about this plugin ever appears in a commit or a collaborator's diff. An
  emptied container is removed again on cleanup/discard, which `rmdir` only allows
  when nothing else is in it.
* **`sibling`** — `<parent>\<repo>_worktrees\<repo>_<id>`, the original layout,
  kept for anyone who prefers worktrees outside the repository. Nothing extra is
  written to git for it.

In both layouts the worktree's directory is `<repo>_<id>` and its branch is
`dsh/wt/<repo>_<id>`, where `<id>` is a fresh `<timestamp>-<random>` pair per
worktree. The underscore separator is deliberate: it keeps the repository name
readable when that name itself contains hyphens, so `my-app_a4f9m3k8` names its
parent unambiguously while `my-app-a4f9m3k8` could be a repository called that.
The branch it was cut from is recorded — in the worktree's own git directory
(`.git/worktrees/<name>/`), **not** in the working tree, because a file in the
working tree would be committed and then merged into your branch. The plugin's
scratch data must never be part of your history.

git refuses a worktree whose absolute path exceeds roughly 210 characters
(`fatal: '$GIT_DIR' too big`), and `core.longpaths` does not raise that ceiling.
The plugin measures the path before spawning anything and refuses with a message
that names the limit, instead of letting you read git's.

## Worktree paths and the path ceiling

If your repository lives deep in the filesystem, the computed path may be too long
for git. Keep repositories under a short root (for example `C:\w\`), or move the
repository shallower — the plugin cannot shorten a path that your own directory
layout made long, and it will tell you the measured length rather than fail with
git's `'$GIT_DIR' too big`.

## Requirements

* `git` on `PATH`, version 2.38 or newer for conflict pre-detection
  (`merge-tree --write-tree`). Older versions work; a conflict is then detected
  by merging and rolling back with `merge --abort`, which is exercised by a test.
* Node 22+ (the DSH runtime).

## Tests

```
node --test test/
```

111 tests. The repository and operation suites run **real git** in throwaway
repositories under the OS temp directory — no mocked child process — and the
implementation suite drives the actual HTTP route handlers with synthetic
requests. The assertions are about the promises above: a fast-forward stays
linear, a diverged base gets a real merge commit with two parents, a conflicted
delivery restores the main tree byte-for-byte, a refused cleanup loses nothing,
and the inside layout leaves `git status` clean. The client suite mounts the
browser half against a React stand-in and asserts the two calls that join a new
worktree — register the workspace, then open its session — in that order, plus the
degradation path when the composition has no `workspaces` service.
