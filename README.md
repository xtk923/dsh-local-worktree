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
and its sessions are shown **in the repository's own group** in the DSH sidebar —
a worktree is a second place to work on the same project, not a second project.
The container is `.dsh-worktrees/`, and the plugin adds that one line to the
repository's own `.git/info/exclude` before creating it, so the main tree's `git
status` never sees it and a `git add -A` there cannot commit a parallel checkout.
Set `worktreeLayout: sibling` for the older `<parent>\<repo>_worktrees\` layout —
the sessions are still shown in the repository's group.

## Sidebar: the worktree's session belongs to the repository

Where the sidebar puts a session is the Host's decision and it is not configurable:
`Workspace.sessionIds` is filtered by `cwd === workspace.path`, and `attachSession`
refuses a session whose `cwd` differs from the workspace path. A session running in
a worktree can therefore only ever belong to the worktree's own Workspace, and the
Workspace Tree nests that Workspace under the repository's — which is how every new
worktree used to add a workspace row under the main one, with its session inside.

No sidebar setting changes that membership, so the merge is done in the one seam a
plugin *can* own: the Workspace projection every Workspace surface renders from
(`ctx.workspaces.list`). Its `getSnapshot` is wrapped, and the projection the
sidebar draws is derived from the Host's own:

* a registered worktree Workspace stops being a group of its own, and its sessions
  join the group of the repository they were cut from;
* a Session that RUNS in a worktree but belongs to no Workspace at all — the
  `git_worktree` tool's, `/worktree`'s, or the Host fallback's, all of which the
  Host leaves under **Ungrouped** — is adopted by that same group, found by its
  live `cwd`;
* a worktree of a worktree resolves to the outermost group, and anything that is
  not this plugin's worktree is left exactly as it was: DSH's own managed checkouts
  under `$DSH_HOME/worktrees/`, a directory that merely *looks* like a container,
  and every ordinary Workspace.

The rule is a name rule, applied positionally: the first segment below the
repository must be `.dsh-worktrees` (this plugin's inside layout) or a
`*_worktrees` directory (its sibling layout). Membership is never guessed from a
substring, because a merge that swallowed too much would hide a real Workspace.

**Nothing on the Host moves.** Working directories, session logs, Workspace
attachments and the plugin's own registry are untouched; only what the sidebar
draws is derived differently. That is what makes the browser-local switch a real
one — `localStorage['dsh.dsh-local-worktree.sidebar-merge'] = 'off'` restores the
per-worktree groups exactly as they were, with no restart and no Host change.

Because the sidebar's picker and its **New session** button read the same merged
projection, a worktree no longer appears there as a place to start a session:
worktree sessions are started from this plugin's own control. The group's **New
session** button creates a session in the repository, which is what its group
means.

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
| inside a worktree it created | **提交 · N** — commit the N changed files in the worktree (subject generated from their names); and **合并 · N** — merge the N new commits back, which asks whether to **remove the worktree** afterwards, removal being the default answer |

Commit and merge are **two buttons side by side**, in the order the work happens,
and both read a decision the Host made (`status.commit`, `status.action`) rather
than deriving one from what the payload happens to contain. The one that is the
user's next step carries the accent: **提交 · N** while the worktree is dirty,
**合并 · N** once it is not. A button that cannot act is disabled rather than
hidden, and its tooltip is the reason — "nothing to commit (0 staged, 0 unstaged,
0 untracked)" — so nothing moves under the cursor when the tree becomes clean.

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
   Workspace. This is what attaches its session to that directory instead of
   leaving it in **Ungrouped**, and it is what the Host's own registry records;
   the call is idempotent (the Host resolves by canonical path first) and its
   answer is merged into the client's own projection immediately.
2. `sessions.create({ workspaceId })` — creates the blank Session rooted in that
   worktree and attached to its Workspace, which the client can address at once —
   and then `uiWorkspace.openSession(id)` selects it.

The second call is deliberately **not** `uiWorkspace.openWorkspace(id)`. That
shipped call resolves its Workspace out of the very projection the sidebar merge
rewrites, and the worktree's own row is absent from it by then, so it would fail
with `unknown workspace` *after* the directory was created. `sessions.create` has
the property the old order existed to guarantee — the Session is catalogued
before the call resolves, so navigating to it cannot race the session list the way
a Host-created one does.

The order is not an implementation detail; it is the reason the jump used to do
nothing. A session started on the **Host** is unknown to the browser until a later
list refresh, and `sessions.retain()` — the call navigation makes — throws
`unknown session` for an id the client has never seen, so navigating to one
immediately after creating it silently fails. A session the **client** creates is
addressable the moment that call resolves.

Without the merge (a browser that switched it off, or a composition with no
Session projection) the shipped `openWorkspace` call is still the one used, so an
older page keeps working unchanged.

If a composition has no `workspaces`/`sessions` service, the control degrades
instead of breaking: it asks the Host (`POST /session`) to start the session the
old way, tries the jump anyway, and otherwise tells you where to find it. The
`git_worktree` tool and `/worktree create` have no browser at all, so they keep
starting the session on the Host and still register the directory as a workspace.

A `⋯` menu beside the buttons carries the same two verbs — **提交** and
**合并到原分支** — plus the secondary actions: create (disabled, with the reason,
once the session is already inside a worktree), jump to one of this plugin's other
worktrees, open the folder in the file manager, start in *another* repository, and
discard the worktree. Every way into a merge — the button and the menu entry —
opens the **same question** described below, so the two can never disagree about
what a merge does.

### When the control re-reads git state

The row renders a decision about a **directory**, and the agent changes that
directory while the session runs — so a read taken once, at mount, is a snapshot
that goes stale exactly when it starts to matter. The control therefore re-reads
whenever **the session moves**, read off the session store the composer slot is
handed (never a timer, and never its own clicks alone):

| Signal | What moved |
|---|---|
| `cwd` | the session was pointed at another directory |
| `running` (Host event `api-session/status`) | a turn started — and, the one that matters, **ended**, so what the agent wrote and committed is on disk now |
| `updatedAt` (Host event `api-session/activity`) | a durable user message was recorded, the other moment a session moves |

Nothing polls, and a re-render that carries no movement reads nothing: the clock is
a dependency of the read, not an unconditional effect. A read that a newer one
supersedes is aborted, so two answers cannot race into the row. Before this, the
counts were read at mount and after the control's own clicks only — which is why a
button could sit on `提交 · 0` over a dirty worktree until you switched to another
conversation and back (that remount happened to re-read).

## Committing is its own button

An agent's work sits uncommitted between turns, and a merge of uncommitted work is
a merge of nothing. The plugin used to paper over that: a delivery would silently
checkpoint the worktree first (`autoCommit`). That is still the fallback for
callers that cannot press anything — the `git_worktree` tool and `/worktree
deliver` — but the UI now offers the decision instead of taking it.

**提交 · N** commits everything uncommitted in the directory the session is
standing in: the worktree when there is one, the repository root otherwise (a
branch in the main tree has the same problem with fewer steps). The subject is
generated from the changed file names (`wip: dsh worktree checkpoint: app.txt,
feature.txt +1`), and the commit is an ordinary one:

* `git add --all -- .` — the same staging a delivery checkpoint does, from the
  same function, so the two can never commit different sets of files. Ignored
  paths are **left out by default**: the ignore rules that keep `node_modules/`
  out of a repository are the ones that keep a `.env` out of it, and a commit
  cannot be taken back with another click. `commitIgnoredArtifacts: true` stages
  them as well, for a build whose ignored output is the deliverable;
* `git commit -m <subject> --` — **without `--no-verify`**. A repository's own
  `pre-commit` hook (this machine's init template installs a gitleaks scanner
  into every new repository) exists to stop exactly this kind of commit, and
  skipping it would be this plugin deciding that your guard does not apply. A
  hook refusal is reported as `hook-rejected`, and nothing is committed;
* nothing is staged before the decision: a clean tree is refused with
  `nothing-to-commit` rather than turned into an empty commit, and a missing
  `user.email` is diagnosed *before* `git add` rather than after (`identity-missing`).

The counts on the button come from the Host (`status.commit`: `changes`, `staged`,
`unstaged`, `untracked`), which is also what decides whether the button is live.
Nothing is committed without a click, and the click reports the subject it wrote,
because the subject was generated rather than typed.

## Merging asks about the worktree, and the default is to remove it

A merge used to decide the worktree's fate on its own, through the `autoCleanup`
flag: the directory and its `dsh/wt/*` branch disappeared the moment the commits
landed. The worktree is where the session lives, so that is now the user's call.
Pressing **合并 · N** opens a one-step question:

| Entry | What it does |
|---|---|
| **合并并删除（默认）** | merges, then removes the directory and its own branch (with `git branch -d`: a branch whose commits are not merged survives) |
| **合并但保留** | merges, and leaves both the directory and the branch alone |
| **取消** | closes the question; nothing was merged, so nothing was lost |

Removal is what happens if you simply confirm: it is the **first** entry, it is
marked *默认 / default*, and it is **focused**, so `Enter` on the open question
takes it. `Escape` cancels. The answer is reported back — *worktree 已删除*, *已保留*
— and a removal you asked for that git then **refused** (a dirty worktree, a
locked repository) is reported as exactly that, never as a choice to keep.

Keeping a worktree is a first-class outcome, not a leftover: the directory, its
branch and this plugin's record of it all survive, so the menu can still jump to
that session, and a later delivery from there still knows which branch it came
from. Keeping is not a way to deliver the same commits twice — once they are in
the base branch, a second delivery is refused with `already-merged`.

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
5. **The worktree is removed only because that is what you chose.** Removal is the
   default answer to the merge question, not a side effect of merging: say *keep*
   and the directory, the branch and the record that lets you jump back to its
   session all stay.

## What it will not do

* **Never touches a remote.** No `fetch`, no `push`, no `remote add`. There is a
  test that asserts `git remote -v` is empty and no `remote.*` config exists
  after a full create → work → deliver cycle.
* **Never skips your hooks.** Both the **提交** button and the automatic
  checkpoint commit run *with* `pre-commit` hooks enabled. If a repository's hook
  (a secret scanner, a linter) refuses the commit, that is reported as a failure —
  the plugin does not decide that your gitleaks hook does not apply.
* **Never commits on your behalf without being asked.** The button is the only
  way to commit from the UI, and it is a click. The one automatic commit happens
  at delivery time, only if the worktree still has uncommitted work, and only
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
| `autoCommit` | `true` | Commit leftover worktree work before merging (a commit subject is generated from the changed file names). The **提交** button makes this fallback rarely needed; it still covers the `git_worktree` tool and `/worktree deliver`. |
| `autoCleanup` | `true` | The answer the **surfaces that cannot ask** use — the `git_worktree` tool and `/worktree deliver` — and the fallback for a `POST /deliver` that sends no `cleanup`. The button always asks and sends the answer explicitly; removal stays the default either way. |
| `commitMessage` | `wip: dsh worktree checkpoint` | Prefix of the generated subject, used by both the button and the automatic checkpoint. |
| `commitIgnoredArtifacts` | `false` | Stage paths `.gitignore` excludes in a checkpoint commit, so an ignored build artifact survives the worktree being removed. Off by default: those same paths are where secrets live, and a commit cannot be taken back. It can only ever widen a commit that was happening anyway — an ignored path on its own never counts as dirty. |
| `registerTool` | `true` | Expose the `git_worktree` tool to the agent. |
| `worktreeLayout` | `inside` | Where a worktree lands: `inside` = `<repo>\.dsh-worktrees\<repo>_<id>` (the container is added to `.git/info/exclude`); `sibling` = `<parent>\<repo>_worktrees\<repo>_<id>`. Both are recognised by the sidebar merge, so the layout is a filesystem choice only. |
| `gitTimeoutMs` | `60000` | Wall-clock budget for one git command. |
| `registryPath` | `$DSH_HOME/plugins/dsh-local-worktree/worktrees.json` | Where created worktrees are remembered. |

## Three surfaces, one implementation

* **The buttons** — `GET /api/dsh-local-worktree/{status,workspaces,health}` and
  `POST /api/dsh-local-worktree/{create,commit,deliver,discard,open,session}`.
  Every answer is JSON with `ok` and, on refusal, a stable `reason` code and a
  bilingual `reasonText`, so the UI never prints raw git output at you.
  `POST /create` takes `session: "client" | "host" | "none"` (default `client`:
  the browser registers the workspace and starts the session; `host` starts it
  here, for the tool and the command; `none` creates the directory only), and
  `POST /session` starts a session in an existing worktree for a caller that
  cannot. `POST /commit` takes an optional `message` and answers the subject it
  actually wrote; it refuses a clean tree with `nothing-to-commit` and a missing
  identity with `identity-missing`. `POST /deliver` takes `cleanup: boolean` — the
  answer to the merge question — and defaults to `autoCleanup` (remove) when it is
  absent.
  The `status` payload carries both decisions: `action` (the primary verb) and
  `commit` (`enabled`, `reason`, `reasonText`, `changes`, `staged`, `unstaged`,
  `untracked`, `path`), so the buttons render a decision instead of deriving one.
* **The tool** — `git_worktree` with
  `action: status | commit | create | deliver | discard`. The agent can isolate its
  own work *and* commit it instead of being told to reach for a shell; `commit`
  takes an optional `message`, and `deliver` takes the same `cleanup: false` to
  keep the worktree.
* **The command** — `/worktree`, `/worktree create`, `/worktree commit [subject]`,
  `/worktree deliver [keep]`. The rest of a `commit` line is the subject, kept as
  typed; a typed command has no popover to ask in, so keeping is an argument.

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
  under the repository, which keeps a repository's worktrees together on disk and
  inside the repository's own folder — and it is the layout the sidebar merge
  recognises ([above](#sidebar-the-worktrees-session-belongs-to-the-repository)).
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
node --test "test/**/*.test.mjs"
```

(That is `npm test`. On Node 24 a **directory** argument is treated as a *file* —
`node --test test/` and `node --test test` both die with `MODULE_NOT_FOUND` — so
the suite is named by glob; it also keeps `test/fixture.mjs`, a helper rather than
a suite, out of the run.)

151 tests. The repository and operation suites run **real git** in throwaway
repositories under the OS temp directory — no mocked child process — and the
implementation suite drives the actual HTTP route handlers with synthetic
requests. The assertions are about the promises above: a fast-forward stays
linear, a diverged base gets a real merge commit with two parents, a conflicted
delivery restores the main tree byte-for-byte, a refused cleanup loses nothing,
`cleanup: false` keeps the directory, the branch and the plugin's own record of
it, and the inside layout leaves `git status` clean. A delivery that checkpointed
uncommitted work reports the commit it made and still calls a fast-forward a
fast-forward, while leaving both an ignored artifact and an ignored secret out of
the branch. An explicit commit lands on the worktree's branch (so it is still
deliverable as one), honours a given subject, refuses a clean tree instead of
writing an empty commit, and takes ignored paths only when
`commitIgnoredArtifacts` asks for them. The client suite mounts the browser half
against a React stand-in and asserts the two calls that join a new worktree —
register the workspace, then open its session — in that order, the degradation
path when the composition has no `workspaces` service, that **commit and merge
are two buttons** whose states come from the host's own decisions, that
uncommitted work is disclosed *before* the click (the question counts the
checkpoint commit it is about to make), the merge question: that a merge click
asks *before* it merges, that the default answer is the one that removes the
worktree (first, marked, focused), and that choosing to keep sends
`cleanup: false` — and the clock the row reads: moving the session's own store (a
turn ending, a recorded prompt) re-reads git state, while a re-render that
carries no movement reads nothing. The sidebar merge is asserted as a projection:
a worktree's sessions join the repository's group and its own group is gone, a
worktree of a worktree lands in the outermost group, a Session the Host left
ungrouped is adopted by its `cwd`, a directory that merely looks like a container
is left alone, the merged snapshot stays one stable object per change (React's
`useSyncExternalStore` contract), the browser switch and a missing Session
projection each leave the Host's own projection untouched, the create flow starts
its Session through the Session Controller rather than `openWorkspace`, and a
worktree whose group was merged away is still reached by where its session runs.
