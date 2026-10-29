---
name: cross-repo-seams
description: How to recognise a contract one repo relies on from another (a seam), find where the workspace lists its seams, and land both sides in a safe order. Use before changing an identifier format another repo parses, a message or payload, a function signature another repo calls, a shared contract or schema snapshot, a table or model name, a feature flag, an event on a shared topic, or anything another service reads from a shared database.
---

# Cross-repo seams

A seam is any contract another repo relies on: an id format, a payload, a contract file, a table
name, a flag. Nothing at build time catches a mismatch, so changing one side alone breaks the
other silently, or breaks work already in flight.

## Where the current list lives

- **The `## Changes that cross repos` section** of each repo's `working-in-<repo>` skill names
  the seams of that repo, with the files on both sides. Read the one for the repo you change, then
  the ones on the other side. A repo without that section can still appear in others'.
- **`workspace/interfaces.md`** in the docs folder of the docs home (the repo whose
  `.claude/hub.lock.json` has a `workspace` block) lists the seams between repos, when it exists.
- **Without either,** read each repo's docs and its instructions file, `CLAUDE.md` or `AGENTS.md`,
  on both sides, and any contract skill under its `.claude/skills/`. Then confirm the seam in the
  code of both repos.
- Repos often refer to each other by package or clone name; resolve one through its package
  manifest or the heading of its instructions file.

## Kinds of seam

Use these to recognise one no list names yet.

| Kind | Why it breaks silently |
|---|---|
| An identifier another repo parses | The consumer derives meaning from the format; a new format routes nowhere |
| Behaviour that lives in one layer only (for example events emitted by a service layer) | Code that bypasses the layer skips it, with no error |
| Table and model names shared through a database | The other side hardcodes the name; a rename leaves it pointing at nothing |
| Hand-written mirrors (flag lists, enum values) | Nothing verifies them; a value added on one side is inert on the other |
| Contract snapshots copied across repos | Pinned by tests that skip without a sibling checkout |
| Payloads mapped to function arguments | An unexpected key is an error on every call |
| Code baked into another service's build artifact | A change reaches it only after that artifact is rebuilt and redeployed |
| Fire-and-forget events | Additive is safe; a rename is silently ignored |

## Landing order

- **Additive first.** The shared definition and any schema change land before anything uses them.
- **Consumers next.** A consumer tolerates a missing or new key before the producer sends it.
  Queued messages carry the old shape, so never make a new key required in the release that
  introduces it.
- **Producers after.** Each hop that forwards a new key does so only when present, so an older
  consumer downstream keeps working.
- **Removal last**, in reverse: stop producing, then stop consuming, then drop the definition.
- **Merging is not always deploying.** Check whether a merge deploys, whether a rebuild or
  redeploy is a separate step, and which ref the build takes its dependencies from. Nothing in a
  PR body reaches a deploy.

## Before changing a seam

1. Find the seam where the list above says it lives.
2. Read the consumer's code in its sibling checkout, not its README or docstring.
3. Run the pinning tests on both sides; the repos' CI workflows show which sibling checkouts they
   need, and without one they may skip instead of failing.
4. Make the consumer accept old and new shapes; drop the tolerance only after both deploy.
5. Open the PRs together: each names the others, states the deploy order, and points CI at the
   unmerged branches the way each repo's workflows read it (see `how-we-work`).
6. Update the pages the change touches in the same PRs (see `docs-with-code`).
