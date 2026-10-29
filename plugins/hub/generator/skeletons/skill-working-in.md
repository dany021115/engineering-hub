---
name: working-in-<repo>
description: <Scope: changing, testing or handing back work in the <repo> repo. Then concrete triggers, in the third person, never the steps.>
---

# Working in <repo>

The repo's `<instructions-file>` is the authority and wins over this skill; this skill only adds what it does not say.

<!-- Writer notes, removed before handing back:
- Keep the sections below in this order. "Verify like CI" and "Hand-off" are required; drop any other section that has no supported fact.
- Each point is a bold rule followed by its reason, and cites only supported facts.
- "Guardrails" goes first only when the repo has a real restriction, so it survives compaction.
- "Changes that cross repos" exists only in a workspace and only with two-sided evidence.
- Replace <instructions-file> with `CLAUDE.md` or `AGENTS.md`, whichever the repo has. -->

## Guardrails

- **<Rule>.** <Why: the consequence of breaking it, and where the restriction is enforced.>

## Verify like CI

- **<Run the same command CI runs>.** <Which workflow runs it, so the agent can re-read it; any setup that command needs.>

## Gotchas

- **<Rule an agent would get wrong>.** <Why, pointing to the file that shows it.>

## Docs

- **<Where the pages live>.** <The docs folder, and that a page changes in the same change as the code it describes.>
- **The lock is the reverse index.** `.claude/hub.lock.json` lists, for each generated page and skill, the source files it was written from; a change to one of those sources means the page needs a look.

## Changes that cross repos

- **<Contract with another repo>.** <Both sides, by repo and path in `code`, and the order to land a change.>

## Hand-off

- **<What to check before handing back>.** <The commands to run, the docs to update, and what to report as not verified.>
