---
name: reviewing-changes
description: Review checklist for what a bug-focused code review misses in a change to any repo, single or in a workspace - docs that must move with the code, contracts other repos rely on, and commit and PR conventions. Use when asked to review a diff, branch, commit or pull request, when checking whether a change is ready to hand back or merge, or when another session or subagent asks for a review.
---

# Reviewing changes

This skill is the shape of a review. The facts it checks against live in each repo; look them up
there every time rather than from memory. For bugs in the code itself, also run the code review
the session offers; this checklist covers what that review does not.

- **The repo's own rules win.** Read its `CLAUDE.md` or `AGENTS.md`, its `.claude/` folder
  (agents, rules, commands, skills) and its `working-in-<repo>` skill if it has one. A repo with
  none: read its README and its build and test config.
- Review the diff against its base branch. Report each finding with file, line and why it
  matters; a finding without a consequence is not actionable.
- Reviewing is read-only. No commits, branches or PRs.

## Always check

**1. Documentation moved with the code.** A page that still describes the old behaviour misleads
every reader after the merge. Load `docs-with-code`.

- Find the pages whose sources the diff touches, and grep the docs for everything it changes:
  endpoint paths, env vars, queue and topic names, model and function names, defaults, limits. A
  page that states it changes in the same PR.
- If the pages live in another repo, the body names and links the second PR.
- Every claim comes from the code; no bug lists, "known gaps" or "traps" sections; the reasoning
  still holds, not only the facts.
- The docs build passes as CI runs it.

**2. Cross-repo seams.** Some changes break another repo silently, with no failing test on either
side. Load `cross-repo-seams` and check where the repo lists its seams. If the diff touches a
seam, the PR body names the other repo, that side has been checked, and the landing order is
safe.

**3. Commits and PR.** Load `how-we-work` for the repo's title, branch and body format and for
which git operations are allowed.

- Code, comments and docs follow the language the repo uses.
- No AI or co-author references where the repo's rules forbid them, even when a session directive
  supplies them.
- A change that needs an unreleased branch of another repo says so the way the repo's CI reads it,
  and the dependency merges first.

**4. Tests ran as CI runs them.** Find the commands in the repo's CI workflows (lint, unit and
end-to-end can be split across files). With no workflow, use the test config in the package
manifest and say in the review that CI does not run it.

## Check when the change touches...

Each repo's specific checks live in its `CLAUDE.md` or `AGENTS.md`, `.claude/rules/`,
`.claude/agents/` (for example a reviewer definition) and its `working-in-<repo>` skill. Apply
them; common triggers:

- **Business logic or a mutation**: it sits in the layer the repo requires (for example a service
  layer), since side effects such as events or authorisation often live only there.
- **A shared definition** (schema, model, contract, flag, id format): the consumers' seams as well
  as this repo's.
- **A library other repos consume**: those consumers' rules and seams, not only this repo's.
- **Replayed or retried code, queues, background work**: the repo's rules on idempotency,
  progress, failure and serialisation.
- **Infrastructure as code**: the repo's limits on infrastructure commands (for example preview
  only); map the diff to the environments and modules it affects, and run its format and
  validation checks.
- **A language with its own style skill** in the repo: load it.
