# engineering-hub

A Claude Code plugin marketplace with two plugins:

- **`hub`** generates a few verified skills and professional Markdown docs inside the project that installs it, and keeps them current as the code changes. An optional Docusaurus site renders those docs.
- **`office`** (optional) is an office of subagents that share a board, ask each other questions and delegate, briefed on the workspace's repos, docs and skills.

Nothing is generated here: the template carries no project content.

## Requirements

- Claude Code 2.1.312 or later.
- git, and Node 22 or later: the generator's checks run in `plugins/hub/scripts/hub.mjs`, which uses only Node's built-in modules.
- npm, only for the docs site of `/hub:site`.

## Install

```sh
claude plugin marketplace add <owner>/engineering-hub
claude plugin install hub@engineering-hub
claude plugin install office@engineering-hub   # optional
```

Or in one line: `claude plugin install hub --marketplace <owner>/engineering-hub`. Nothing is cloned into the project: the plugin lives in Claude Code's plugin cache.

## Use

Start Claude Code at the top of a repository, or in the folder that holds several repositories side by side, and run `/hub:init` (or `/hub:init <repo> …` to choose repositories in a workspace). It:

1. takes an inventory of each repository: languages, docs, instruction files, skills, CI, leaving out vendored or generated code (marked in `.gitattributes`, or in folders such as `vendor/` and `third_party/` that GitHub treats as vendored) and submodules;
2. sends one explorer per repository to collect facts, each citing a file and line;
3. checks every citation against `HEAD` and has independent verifiers confirm the facts that matter most;
4. proposes a plan, which you approve at the second of three gates;
5. writes the files in a staging folder, runs the gates (skill lint, docs structure, grounding, confinement, traces and secrets, `claude plugin validate`) and a clean reviewer, which also flags a procedure skill that repeats its how-to page; in the last round, a sentence the reviewer finds false is taken out rather than its whole file, unless it is a numbered step, a heading or part of a longer paragraph;
6. places the approved files, shows what was placed and what was dropped and why, and asks, at the third gate, what to keep. A dropped page takes with it whatever still links to it or names it, except an index, which only loses the list lines and sentences that link to it.

Above 12 agent runs it shows the estimate and asks first. While a run is open, the plugin's hook lets each lone call to its `hub.mjs` script, and the two read-only `git` commands of the result step, run without a prompt, and lets the run's agents only read: Read, Grep and Glob, or read-only shell commands such as `grep`, `find` and `git ls-files` where Grep and Glob are missing. An agent's Read, Grep or Glob outside the session's folder is refused at once, rather than raising a prompt that would stall the run. It never commits or pushes: review the diff (`git status`, `git diff`) and commit it yourself, on a branch of your choice.

When the code changes, run `/hub:refresh` (or `/hub:refresh <repo> …`). It runs `drift`, says "up to date" when nothing is affected, and otherwise refreshes the affected files through the same facts, gates and three approvals. A file you edited by hand is never overwritten: its refresh comes as a proposal you can accept or leave, which keeps every line you wrote (a reviewer's finding on one of them is shown to you, never acted on), and a file you deleted is never recreated.

For a docs site, run `/hub:site` (or `/hub:site <repo>` in a workspace). It installs a Docusaurus site in `docs-site/` of one repository, built from that repository's docs folder: it checks first that the docs folder has an index and that no other site is there, stages the site, asks before placing it, warns about the download (`npm ci` fetches about 300 MB, and `node_modules` takes about 500 MB), builds it with every broken link or diagram named by file and line, and registers its files in the lock. Preview it with `npm --prefix docs-site start`. With a GitHub remote it can add `.github/workflows/docs-site.yml`, which builds the site on pull requests; deploying to GitHub Pages stays off until you set Pages to "GitHub Actions" and run `gh variable set DOCS_DEPLOY --body pages`. A Pages site is public unless your organization has private Pages (GitHub Enterprise Cloud). Once the site exists, `/hub:init` and `/hub:refresh` rebuild it after placing their pages.

### Adding values to the site by hand

`/hub:site` writes `docs-site/site.json` with only `title`, `noIndex` and, when the docs are not in `docs/`, `docsDir`. Three more keys are yours to add, by hand:

```json
{
  "title": "Service docs",
  "noIndex": true,
  "editUrl": "https://github.com/<owner>/<repo>/edit/main/docs/",
  "prism": ["toml", "ini"],
  "labels": { "how-to": "Guides" }
}
```

- **`editUrl`** is the URL of the docs folder in your forge's editor; each page adds its own path to it and gets an "Edit this page" link.
- **`prism`** adds syntax highlighting for languages beyond the default ones (`bash` and `diff` are always on).
- **`labels`** names a top-level docs folder that has no `index.md` or `README.md`; without a label, the folder's name is used (`how-to` reads "How to").

The site's config, helper and lockfile stay identical to the template, so these values live in `site.json` only.

## What it writes and where

In each chosen repository, and only what the approved plan lists:

| Path | What |
|---|---|
| `.claude/skills/<name>/SKILL.md` | At most 3 skills per repository, each backed by verified facts: `working-in-<repo>`, guardrails for a risky area, a procedure, or a language style |
| `docs/` | Markdown pages: an index, and architecture and how-to pages when the code calls for them. An existing docs folder is used; when it holds HTML, pages go to `documentation/` |
| `.claude/hub.lock.json` | What was generated and from which commit, so a later run can tell what is out of date and what was edited by hand |
| `docs-site/` | The docs site, only after `/hub:site` |
| `.hub-run/` | The run's scratch folder, which ignores itself; a finished run is cleared by the next one |

Pages that span repositories go to the docs home you choose. Changes to files a person wrote, such as a line in `CLAUDE.md` or `AGENTS.md`, team settings in `.claude/settings.json` or a `hub-check.yml` workflow, are only offered, and applied only if you pick them at the third gate.

To see what is out of date without changing anything, run `node <hub plugin>/scripts/hub.mjs drift --repo .` in a repository with a lock. It lists the generated files edited by hand, deleted, or whose sources changed since they were written, new CI, manifest, contract, data or deploy files and new environment variables, and whether the installed generator is newer. It always exits 0; `--since <ref>` limits it to what that range changed, and `--annotate` prints GitHub warnings. With `--advance` it moves the lock's `documentedCommit` to `HEAD`, changing nothing else, but only when no generated file is affected. A generated file you delete is never recreated: once you confirm the deletion it leaves the lock. A refresh moves `documentedCommit` only when every affected file was updated, accepted or let go.

## Generic skills

The plugin brings four skills that work in any repository, single or in a workspace:

- **`how-we-work`**: find and follow the repository's commit, branch and pull-request conventions.
- **`docs-with-code`**: keep documentation in step with the code.
- **`cross-repo-seams`**: recognise a contract another repository relies on, and land both sides in a safe order.
- **`reviewing-changes`**: what a bug-focused review misses: docs, seams and conventions.

## Workspaces

A workspace is a folder that holds several git repositories side by side. Start Claude Code in that folder and run `/hub:init`: the first gate lists the repositories and lets you leave some out.

- **The docs home** holds the pages that span repositories, in `<home>/docs/workspace/`. By default it is the repository with the most Markdown in its docs folder; the first gate lets you choose another. The other repositories' locks point at it.
- **Links between repositories** use the root URL of each one's `origin`, without credentials; a path in another repository is always written in `code` as `<repo>/<path>`, and a repository without a remote gets only that path.
- **Skills of one repository** load when a session starts in it. From the workspace folder, start Claude Code with `claude --add-dir <repo>` to see that repository's skills from the first prompt.

## Teammates

Teammates install nothing to use what was generated: the skills are files under `.claude/skills/`, the docs are Markdown, and both reach them with the repository.

To let them run `/hub:refresh` too, the third gate can offer team settings: `extraKnownMarketplaces` and `enabledPlugins` entries in `.claude/settings.json` that make Claude Code offer `hub` to anyone who opens the repository. The offer appears only when the `claude` CLI is on the PATH and `engineering-hub` was added as a marketplace from GitHub (`claude plugin marketplace add <owner>/engineering-hub`) or from a git URL, never from a local folder; then it works even if your own session loads `hub` with `--plugin-dir`. When either is missing, the third gate says so in one line. It has three limits: it applies only to sessions started at the repository's root, only once the person trusts the folder, and not in cloud sessions.

The `hub-check.yml` offer, made under the same condition, checks every pull request: `check --lock` blocks it when a generated file breaks a gate or cites a path that is gone, and `drift` only warns. It clones this template at the `hub--v<version>` tag of the version in the lock. If the template repository is private, create a fine-grained token with read-only access to the contents of that repository alone and save it as the `HUB_TEMPLATE_TOKEN` secret of the repository that runs the workflow.

## Update and uninstall

```sh
claude plugin marketplace update engineering-hub
claude plugin update hub@engineering-hub
```

Auto-update is off by default for a marketplace you add, so a plugin stays at its version until you update it. `claude plugin uninstall hub@engineering-hub` removes the plugin; what it generated stays in your repositories, because it is yours. Delete `.claude/hub.lock.json` too if you no longer want `/hub:refresh` to track those files.

## Office

The `office` plugin is optional. Install it with `claude plugin install office@engineering-hub`, then open it with `/office`, or hire an agent with `/office [--worktree] <task>`. Agents share a board, ask each other questions and delegate them, and each one is briefed on the workspace. The office allows its own board and message tools, so a hired agent never waits on a prompt for them; hiring still asks.

**How it finds the workspace.** Once per session:

1. If the `workspaceRoot` option names a folder, that folder is the root and its repos are the child folders with a `.git` (dot folders are skipped, and at most 30 are kept; a toast says how many were skipped).
2. Otherwise, a session outside git takes its own folder as the root, the same way.
3. A session inside a repo reads that repo's `.claude/hub.lock.json`: a `workspace` entry makes the parent folder the root, with the repos it lists; a `settings.docsHome` entry points at the repo whose lock lists them. Without either, the repo alone is the workspace. The office never assumes that the parent of a repo is a workspace.

Each value read from a lock is checked on its own; an invalid one is dropped, and a lock that cannot be read gets a toast at the start of the session.

**The briefing.** The main thread, every agent that starts inside the root, and every agent the office hires get a short `# Workspace` section with absolute paths: each repo with the first sentence of its docs index, its `CLAUDE.md` or `AGENTS.md`, its docs index and its skills, and the folder of the pages that span repos. Only files that exist are listed. Resumed runs, forks and workflow agents are left untouched.

**Options** (`claude plugin configure office`, the plugin's `userConfig`), both optional:

- `workspaceRoot`: the folder that holds the repos side by side; leave it empty to find it from the session.
- `neverIsolate`: repo folders where hired agents always work in the real checkout, never in a worktree.

**Worktrees.** A hire with `worktree: "yes"` (or `/office --worktree`) runs in its own git worktree, created in `.office-worktrees/` beside the repo; the first one writes a `.gitignore` there so git ignores the folder. In the agent's Changes tab, **Apply** runs `git apply --check` and then `git apply` on the repo's working tree: nothing is staged, and if the check fails nothing changes and the worktree stays. **Discard** removes the worktree.

**Limits.** The office is a mod, built on an API in early access. Under the managed setting `allowManagedHooksOnly` it loads no hooks, so it does nothing. Where an organization manages Claude Code, the `prompt.compose` hook is skipped: the main thread then gets no rules or briefing, while spawned and hired agents still get them.

`plugins/office/tests/smoke-cwd.sh` runs one `claude -p` session with haiku in a temporary workspace and checks that a hired agent works in its repo and that its post reaches the board; it runs outside `claude plugin test`.

## Working with superpowers

`hub` writes what is specific to your project; it brings no general engineering workflow. For brainstorming, planning, test-driven development and debugging skills, install the upstream `superpowers` plugin from its own marketplace, as its README describes. The two do not overlap.

## Measuring a skill

To see whether a generated skill earns its place, measure it in a throwaway copy of the repository, never in the repository itself:

1. **Load:** from the copy's root, `claude -p "ok" --output-format stream-json --verbose` lists in its first line, under `skills`, every skill that loads.
2. **Trigger:** write ten prompts that should use the skill and ten close ones that should not, run each with `claude -p`, and count the `Skill` tool calls with its name in the stream.
3. **Effect:** wrap the skill in a temporary plugin with a few behaviour cases and compare with and without it: `claude plugin eval <wrapper> --no-publish`. Read `aggregates.delta` in the JSON (`--json`); a delta of zero with the skill firing means its body adds nothing.

Always pass `--no-publish`: without it, eval publishes its report when your account supports it.

## Development

See `CLAUDE.md` for the rules and the `working-in-engineering-hub` skill for how the script and the mod are built. From the repository root:

```sh
node --test plugins/hub/tests
node plugins/hub/scripts/hub.mjs check --skills plugins/hub/skills .claude/skills --authoring
claude plugin validate . --strict
claude plugin validate plugins/hub --strict
claude plugin validate plugins/office --strict
claude plugin validate .claude/skills --strict
claude plugin test plugins/office
node plugins/hub/scripts/hub.mjs scan . --authors .
```

The CI runs these, and builds the docs site template against its four fixtures on Node 22 and 24. A change under `plugins/<p>/` bumps that plugin's `version` and publishes its tag with `claude plugin tag plugins/<p> --push`.

## License

MIT, © engineering-hub contributors. See `LICENSE`.
