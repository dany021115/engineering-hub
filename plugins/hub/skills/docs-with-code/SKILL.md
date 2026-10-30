---
name: docs-with-code
description: Keeps documentation in step with the code in a single repo or any repo of a workspace. Use when a change alters behaviour, an endpoint, an env var, a queue or topic, a data model, a default or a limit; when writing or editing a documentation page; or before opening a PR that changes behaviour.
---

# Docs change with the code

**When behaviour changes, the page changes in the same change.** Not afterwards, not in a
follow-up. A page describing the old behaviour is worse than no page: a reader cannot tell which
half is stale, so one wrong sentence discredits the ones around it.

## Find the pages a change touches

- **Map the change before writing it.** If the repo has `.claude/hub.lock.json`, run
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs impact --repo <repo> --paths <the files you will touch>`.
  It only reads, and lists the pages and skills that cite those files, the ones in other repos
  included, the sections to read before changing them, and the checks to run.
- **Start from the lock.** If the repo has `.claude/hub.lock.json`, find every entry under
  `files` whose `sources` include a file you change (a folder source ending in `/` covers the
  files inside it; a source written `<repo>:<path>` is a file of that sibling repo). Each such
  page or skill was written from that file: update it in the same change.
- **Then grep the docs** for what you touched: endpoint paths, env var names, queue and topic
  names, model and function names, defaults and limits. If a page states it, the page changes
  with the code. Pages filed under one repo can describe behaviour another owns.
- **Where the pages live:** the repo's `CLAUDE.md` or `AGENTS.md` and its `working-in-<repo>`
  skill say which docs folder describes it. In a workspace, pages that span repos live in the
  docs home, the repo whose lock has a `workspace` block, under its docs folder's `workspace/`.
- **Pages about one repo can live in another.** Then a change here needs a second PR there; say
  so in both bodies and link them.
- **Keep one copy of a page.** A second copy in another repo diverges; keep at most a link.
- **A docs site has its own rules** for which tree is editable; read its README or config.

## Before opening the PR

1. **Update every page you found** above, in the same change.
2. **Check the seams the change touches**, if the repo lists them (see `cross-repo-seams`).
3. **Run the docs build and checks as CI does:** the repo's CI workflows give the commands. Dead
   links and anchors usually fail them.
4. **Ask whether the reasoning still holds.** Pages explain *why* things are shaped the way they
   are. A change can leave every fact correct and the explanation wrong; that is the harder
   failure to spot.

## How pages are written

**Every claim comes from the code.** Not from a README, a docstring, a diagram or a PR title; each
can be wrong, and a PR title can describe work a later commit reverted. Read the source and verify;
if you cannot verify it, leave it out. A page about another repo is verified against that repo's
code, not its README.

**The pages say what the system is.** No bug lists, no "known gaps", no "traps" sections.
Deliberate behaviour, however surprising, is the system and belongs on the page. Something that
looks like a defect is recorded separately and raised, not written into a page.

**New pages follow their siblings:** the same shape, and frontmatter only if the sibling pages use
it. The site config decides ordering and which Markdown features render; check the result with
the build.
