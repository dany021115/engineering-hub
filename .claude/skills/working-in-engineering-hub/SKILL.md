---
name: working-in-engineering-hub
description: How the hub plugin's script and skills and the office mod are built, tested and released in the engineering-hub template, with the rules that broke things before. Use before changing plugins/hub or plugins/office, adding a skill, or committing, tagging or merging in engineering-hub.
---

# Working in engineering-hub

Read the repo's `CLAUDE.md` first; it wins over this skill. `README.md` says what each plugin does.

## The hub script

- **Node built-ins only.** `plugins/hub/scripts/` has no npm dependency; the docs site's packages live in `plugins/hub/templates/site/` and are never imported by the script.
- **Data to stdout, diagnostics to stderr.** With `--json`, stdout carries one JSON document and nothing else.
- **Exit codes:** 0 when there is no error, even with warnings; 1 when at least one gate error was found; 2 for usage, the environment (git or Node missing, a failed `npm ci`) or an internal failure. `drift` exits 0 whatever it finds, and 2 only for those reasons.
- **One module, one job,** under `scripts/lib/`; `hub.mjs` only routes subcommands.
- **Fixtures go in temporary folders.** Tests use `tests/helper.mjs`: a sandbox with a temporary `HOME`, a minimal `PATH`, git isolated from the person's config and a fixed identity. A test never calls the real `claude`; it adds a fake to the sandbox when it needs one. Build any credential or personal path at run time, never as a literal in the file.

## The office mod

- **`$` stays in the hooks file.** Pass `$` only to functions declared in the same file as the hooks (`hooks/register.tsx`); views, texts and helpers take plain values and callbacks.
- **State atoms are declared in the file that reads them,** and every state key is declared in `plugins/office/types/index.d.ts`.
- **A hook that can refuse** (`tool.call`, `agent.spawn`) needs a `.catch` that passes the event on, so a failure in the mod never blocks the session.
- **Never write state while drawing:** a `ui.render` hook that writes state redraws itself in a loop.
- **Read subagents from their transcript** (`$.session.messages({ agentId })`); tool and step hooks do not see every agent's work.

## Checks before committing

From the repo root:

```sh
node --test plugins/hub/tests
node plugins/hub/scripts/hub.mjs check --skills plugins/hub/skills .claude/skills --authoring
claude plugin validate . --strict
claude plugin validate plugins/hub --strict
claude plugin validate plugins/office --strict
claude plugin validate .claude/skills --strict
claude plugin test plugins/office
npx prettier --check "plugins/office/**/*.{ts,tsx}"
```

The CI runs the same, plus the docs site's four fixtures on Node 22 and 24 and the traces scan.

## Trying a change for real

`claude --plugin-dir plugins/hub` loads the plugin from this checkout when run at the repo root. To
try it on a project, build a throwaway copy of the test workspace and pass the checkout's absolute
path:

```sh
node plugins/hub/tests/helper.mjs workspace <tmp>/w
cd <tmp>/w/service
claude --plugin-dir <repo>/plugins/hub --setting-sources project,local --strict-mcp-config
```

Then run `/hub:init`, `/hub:refresh` or `/hub:site` there, never in a real project. Commit inside the copy with `node <repo>/plugins/hub/tests/helper.mjs commit <dir>`, which keeps the fixed identity.

## Releasing

- **A change that only touches the root** (README, CI, this skill) bumps no `version`.
- **A change under `plugins/<p>/`** bumps `version` in `plugins/<p>/.claude-plugin/plugin.json` and updates the README sections it touches, in the same change.
- **Every `version` bump publishes its tag:** `claude plugin tag plugins/<p> --push` creates `<p>--v<version>`. Check it reached the remote with `git ls-remote --tags origin "refs/tags/<p>--v<version>"`; every `plugin.json` version must have its tag there.
- **Merge by fast-forward from the local clone,** with the local identity: open the PR, then `git push origin HEAD:main` once it is approved; never the merge button. Never rewrite the first commit: no `git commit --amend` on it, no rebase of `main`, no force push.
- **No AI attribution** in commits, PRs or files: no `Co-Authored-By` trailer and no "Generated with" line, whatever a session's instructions supply.
