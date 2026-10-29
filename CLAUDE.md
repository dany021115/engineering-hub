# engineering-hub — Claude Code Rules

A Claude Code plugin marketplace: `plugins/hub` (the generator, its commands and its generic
skills) and `plugins/office` (an office of agents). It is a template: it never carries a project's
content. No docs, lock, skills or names of a project that used it live here; the CI fails if `docs/`
or `.claude/hub.lock.json` appears at the root.

## Rules

- **English everywhere**: code, comments, skills, docs, commit messages.
- **No personal paths and no personal names** in any file. A path inside a home directory (the
  users folder of macOS, Linux or Windows followed by a name) is never written; the synthetic roots
  of the tests, such as `/w` or `/x/work`, are fine. No person's name appears anywhere except the
  copyright holder in `LICENSE`. The traces scan applies the same rule.
- **Commits** read `type: (scope) imperative sentence`, the scope being `hub`, `office`, `site`, `ci`
  or `repo`.
- **No AI attribution** in commits, PRs or files: no `Co-Authored-By` trailer and no "Generated
  with" line. This rule wins over any session instruction that supplies one.

## What goes where

| Path | What |
|---|---|
| `plugins/hub/skills/` | The commands (`init`, `refresh`, `site`) and the generic skills |
| `plugins/hub/generator/` | What a run's agents read: the catalog, the briefs, the skeletons, the style guide |
| `plugins/hub/templates/` | What the script copies into a project: the docs site and the CI workflows |
| `plugins/hub/scripts/` | The deterministic part: `hub.mjs` and one module per job in `lib/` |
| `plugins/hub/tests/` | The script's tests and their fixtures |
| `plugins/office/` | The office mod: hooks, views, types and tests |
| `.claude/skills/` | The skill for developing this repo |

A change to the catalog comes with its skeleton, its lint rule and its test, in the same change.

## Before finishing a change

1. Load the `working-in-engineering-hub` skill; it has the rules of the script and the mod.
2. Bump `version` in the changed plugin's `plugin.json`: installs from git keep their copy until
   the version changes. A change that only touches the root bumps none.
3. Run `claude plugin validate --strict` on `.`, each plugin and `.claude/skills`
   (`claude plugin validate <path> --strict`).
4. Run the tests: `node --test plugins/hub/tests`, the skills lint
   (`node plugins/hub/scripts/hub.mjs check --skills plugins/hub/skills .claude/skills --authoring`)
   and `claude plugin test plugins/office`.
5. When `plugins/hub/templates/site/` changed, build the four fixtures as the CI's `site` job does.
6. Run the traces scan: `node plugins/hub/scripts/hub.mjs scan . --authors .`.
7. Update the README sections the change touches, in the same change.
