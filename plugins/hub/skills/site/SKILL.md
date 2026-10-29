---
name: site
description: Installs an opt-in Docusaurus docs site in docs-site/ of one repository, built from its existing Markdown docs. Checks the repository first, stages the site, builds it with broken links and diagrams named by file and line, and asks for approval at three gates. Deploying stays off until the person turns it on. Never records anything in git.
argument-hint: "[repo]"
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs *)
---

# Install a docs site

You orchestrate; the script `hub.mjs` does the work and the person decides at three gates. The site
always goes in `docs-site/` of one repository and builds only that repository's docs folder. Nothing
reaches the repository before the person approves, and nothing is ever committed or pushed.

`$ARGUMENTS`, if given, names the repository (a folder name in a workspace).

## Rules for every step

- **Each call to the script stands alone:** `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs <subcommand> … --json`,
  run from the session's folder, with no pipe, no redirection, no `cd` and no chaining of commands.
  Only that form is covered by this command's permission. Read its JSON from the output.
- **Exit codes:** 0 no errors (warnings may be present), 1 errors to show as the step says, 2 usage
  or environment: show the message and stop.
- **Gates:** each gate (P1, P2, P3) is exactly one AskUserQuestion call: at most 3 content
  questions, each with its default marked "(default)" and listed first, plus the gate decision as
  the last question; every question has 2 to 4 options. Never go on without an answer.
- **No question outside the gates.** AskUserQuestion is only for P1, P2 and P3.
- **Before each gate question,** write what the gate says to show as text in the same message,
  ahead of the AskUserQuestion call. The person sees only your text, never the tool results.
- **Permission:** this command's grant for `hub.mjs` lasts the turn that started it. If the first
  call to `hub.mjs` after a gate asks for permission, tell the person that allowing it in this
  session is safe: `hub.mjs` reads the repository, writes in `.hub-run/`, touches the repository only
  in `place` and `finish` after their approval, and never commits or pushes.

## 0. Report

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs site --json`, adding `--repo <dir>` when
`$ARGUMENTS` names a repository. It writes nothing. Read `mode`, `root`, `repo`, `home`, `lock`,
`hubSite`, `github`, `docsDir`, `node` and `npm`. The site goes in `repo`: in a workspace without an
argument that is the docs home (the one whose lock lists the workspace, else the default home).

- `hubSite` true: the lock already has a hub site. Say that updating an installed site is out of
  scope, and stop.
- `npm` null, or Node below 22.12: say that the site needs Node 22.12 or later and npm, and stop.

## P1. Scope

Show: the repository and its path, the site folder `docs-site/`, the docs folder it will build
(`docsDir`), whether a lock exists, and, in a workspace, that only this repository's docs are built.

Then one AskUserQuestion:

1. **Title** of the site: the repository's name (default), or another title written in "Other".
2. **Workflow** (only when `github` is true): add `.github/workflows/docs-site.yml`, which builds the
   site on pull requests and pushes to the default branch: "Yes (default)" or "No". Say that it only
   builds: deploying needs the repository variable `DOCS_DEPLOY`.
3. **Docs folder** (only without a lock): the report's `docsDir` (default), or another folder in
   "Other".
4. **Continue or cancel.**

Never ask about the site folder (always `docs-site/`) nor about deploying. Cancel: nothing was
written; stop.

## 1. Stage the site

In every call below, `--repo` is `.` in a single repository and the repository's name in a
workspace.

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs site --repo <dir> --into docs-site --title <title> --json`,
with the title in double quotes when it has spaces, adding `--docs <folder>` when P1 chose another
docs folder and `--workflow` when P1 said yes. It
checks the repository and, if everything passes, prepares `.hub-run/`, stages the site and writes an
unapproved plan; the repository does not change.

Exit 2 names every check that failed: a missing or doubled docs index, another site, Node or npm.
Show them and stop. When it names an unfinished run in `.hub-run/`, do not touch it: say that
`/hub:init` offers to resume or discard it (an unfinished site run can only be discarded), and stop.

## P2. Plan

One AskUserQuestion, "Approve (default)" or "Cancel", whose question text itself carries
what the person must see, because they may read nothing else: every file the plan writes, one line
each with its destination path (`docs-site/package.json`, `docs-site/site.json`, …, and
`.github/workflows/docs-site.yml` when the workflow was asked for, which only P3 applies), never a
count instead of the list; then that `npm ci` downloads about 300 MB and that
`docs-site/node_modules` takes about 500 MB, hidden from git by the site's `.gitignore`.

- Approve: run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs plan .hub-run/plan.json --approve --json`.
- Cancel: run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs start --discard --json`, which removes
  `.hub-run/`; nothing was placed. Stop.

## 2. Place and build

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs place .hub-run/plan.json --json`. Exit 1 means a file
was not placed: one that already existed stays as it is, and one that failed the scan is dropped;
keep both for P3.

Then run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs site --repo <dir> --build docs-site --json`. It
installs with `npm ci --ignore-scripts`, checks the diagrams and builds. Exit 1 lists each broken
link or diagram by file and line and each broken anchor by its page. Exit 2 means `npm ci` failed
(network or registry); nothing was checked or built.

## P3. Result

Run `git -C <dir> status --short` and `git -C <dir> diff --stat`, each alone (they only read).
Show: that status; the build result, with every error by file and line or page; what `place` did
not place and why; and, when the workflow was asked for, the proposal from `place`'s `proposals`
with its destination `.github/workflows/docs-site.yml` and the branch in its `note`.

The Keep question's text below ends with these three lines, as they are, every time:

- Preview: `npm --prefix docs-site start`.
- Deploy is off. To turn it on: in the repository's settings, Pages → Source "GitHub Actions",
  then `gh variable set DOCS_DEPLOY --body pages`.
- A GitHub Pages site is public unless the organization has private Pages, which needs GitHub
  Enterprise Cloud.

Then one AskUserQuestion:

1. **Workflow** (only when it was asked for in P1): "Leave it out (default)" or "Add
   .github/workflows/docs-site.yml".
2. **Keep:** "Keep the site (default)" or "Discard it". When the build failed, say so in the
   question and list "Discard it (default)" first.

## 3. Finish

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs finish .hub-run/plan.json --keep <all|none> --json`,
adding `--apply <id>` with the workflow's id when it was chosen. Keeping registers the site's files
in `.claude/hub.lock.json` as `kind: "site"`; discarding removes what was placed and the build
folders, and writes no lock when there was none.

Report what was written and what was not, whether the workflow was added, the lock, and the
suggested commit message. Reviewing and committing is up to the person, on a working branch of
their choice. Do not commit or push.
