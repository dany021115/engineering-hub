---
name: init
description: Generates verified skills and docs inside this repository or workspace. Explores the code, checks every fact against HEAD, writes in a staging folder, and asks for approval at three gates before anything lands in a repository. Never records anything in git.
argument-hint: "[repo ...]"
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs *)
---

# Generate skills and docs

You orchestrate. The script `hub.mjs` does everything deterministic (inventory, citations, plan
validation, gates, placing, locks); agents find facts and write prose; the person decides at three
gates. Nothing reaches a repository before the person approves the plan, and nothing is ever
committed or pushed: the person reviews the result and records it in git.

`$ARGUMENTS`, if given, names the repositories to start from (folder names in a workspace).

## Rules for every step

- **Each call to the script stands alone:** `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs <subcommand> … --json`,
  run from the session's folder, with no pipe, no redirection, no `cd` and no chaining of
  commands. Only that form
  is covered by this command's permission. Read its JSON from the output.
- **No other commands:** besides `hub.mjs`, run only P3's two `git` reads; the agents read the
  repositories. Any other command asks the person for permission.
- **To save data** (verdicts, findings, the plan) use Write or Edit on files inside `.hub-run/`.
  Never write anywhere else, and never edit a repository yourself. Build each absolute path by
  joining the `root` that `start` printed, copied exactly, and the relative path; never retype it.
  If a Write asks for permission, the path is wrong: deny it and fix the path.
- **Exit codes:** 0 no errors (warnings may be present), 1 gate errors to act on as the step says,
  2 usage or environment: show the message and stop.
- **Agents:** only `general-purpose` (explorer, integrator, writer) and `Explore` (verifier,
  reviewer). At most 4 agents at once (`caps.agentsAtOnce` in the catalog); launch in waves, a
  wave being several Agent calls in one message, each with `run_in_background: false`, so their
  results come back in the same turn. Never end your turn to wait for an agent. Each prompt names
  the brief in `.hub-run/generator/briefs/` and gives absolute paths built from the `root` that
  `start` returns. Never point an agent at the plugin's own folder.
- **Gates:** each gate (P1, P2, P3) is exactly one AskUserQuestion call: at most 3 content
  questions, each with its default marked "(default)" and listed first (also in a multi-select,
  where the default is the one that applies nothing), plus the gate decision as
  the last question; every question has 2 to 4 options. With more than 4 items to choose from,
  the question text lists every item with its id and its path, the options group them (all, none,
  or by kind), and any other selection is written in "Other" as ids. Never go on without an answer.
- **No question outside the gates.** AskUserQuestion is only for P1, P2 and P3. While agents run,
  wait for them without asking anything: the person has nothing to decide until the next gate.
- **Before each gate question,** write what the gate says to show as text in the same message,
  ahead of the AskUserQuestion call. The person sees only your text, never the tool results, so a
  question without that text asks them to decide blind.
- **Permission:** this command's grant for `hub.mjs` lasts the turn that started it, and the
  gates do not end it; while `.hub-run/` is open, the plugin's hook allows each lone `hub.mjs`
  call, and P3's two `git` reads, after that turn too, and lets the agents only read. Call it
  alone: no pipe, redirect, `cd` or chaining. If a call still asks for permission, tell the person
  that allowing it is safe: `hub.mjs` reads the repositories, writes in `.hub-run/`, touches a
  repository only in `place` and `finish` after their approval, and never commits or pushes.

## 0. Preflight

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs start --json`. Exit 2 means git or Node is
missing, or the session did not start at the top of the repository or workspace: show the message
(it names the folder to start Claude Code in) and stop. Otherwise read `mode`, `root`, `repos`,
`skipped`, `home`, `resume`, `discard`, `sitePlan` and `generator`, and show the warnings: skipped
repositories in one line each, and tracked files that differ from `HEAD` (facts are checked
against `HEAD`).

**An unfinished run** (`discard` is set) is decided before anything else, in one AskUserQuestion:

- `sitePlan` true: a `/hub:site` run is unfinished. Offer only to discard it or to stop.
- Otherwise offer "Resume from `<resume>` (default)", "Discard it" and "Stop".
- Discard: when `discard` is `start --discard`, run
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs start --discard --json`; when it is
  `finish --keep none` (files are already placed), run
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs finish .hub-run/plan.json --keep none --json`, which
  undoes what was placed. Then run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs start --json`
  again and go on as a new run.
- Resume: `verify` goes to step 3 for the repositories with a `facts/<repo>.jsonl` (no explorer
  runs again), `P2` goes to the P2 gate with the existing `.hub-run/plan.json`, and `P3` goes to
  the P3 gate. Take the language and docs home from `.hub-run/scope.json` or the plan.

## 1. Prepare the run

Choose the repositories: those of `$ARGUMENTS`, or every repository `start` listed. Run
`node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs start --repo <dir> --repo <dir> --json` with one
`--repo` per repository: `--repo .` in a single repository, `--repo <name>` in a workspace. It
writes `.hub-run/` (inventories, the git status snapshot, `env.json`, a copy of the generator) and
returns, per repository, `docsDir`, `docsSite`, `docsHasHtml`, `reinit` and `runs`, plus
`estimate` (`total`, `confirm`), `home` and `env`.

## P1. Scope

Show one short summary per repository from `.hub-run/inventory/<repo>.json` and the output above:
languages, docs and their tool, instruction files, skills, CI, size in tracked files, the detected
docs folder (when the docs folder holds HTML, the proposal is `documentation/`), whether a lock
exists (a re-init protects what was edited by hand) and the estimated agent runs.

Recommend accept-edits mode (shift+tab) for this run: the agents only write inside `.hub-run/`,
and the confinement gate checks that nothing else was written.

Then one AskUserQuestion:

1. **Repositories** (workspace only): default all with commits. With more than 4, list each one
   with its path in the question text and group the options: all (default), none, or by kind;
   other selections go in "Other" as names.
2. **Docs home** (workspace only): the repository whose docs folder holds the pages that span
   repositories; default the `home` from `start`.
3. **Language** of the generated text: English (default).
4. **Continue or cancel.** When `estimate.confirm` is true (more than 12 agent runs), put the cost
   in this question and in the continue option: "about `<total>` agent runs". Otherwise leave the
   cost out of both: the summary above already gives it.

In a single repository there is no repositories or home question: the home is that repository.

- Cancel: run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs start --discard --json` and stop.
- If the chosen repositories differ from those prepared, run the `start --repo` call of step 1
  again with only the chosen ones (a run without facts can be prepared again).
- Write `.hub-run/scope.json` with `repos`, `home` (null in a single repository) and `language`.

## 2. Explore

One `general-purpose` explorer per repository, never more than one per repository whatever its
size. Prompt: follow `.hub-run/generator/briefs/explore.md`; the repository root and name; the
paths of `inventory/<repo>.json`, `generator/catalog.json` and `generator/style.md` in the run
folder; the language; the paths it must not read (the inventory's `sensitive` and `excluded`).
It writes `facts/<repo>.jsonl` and returns at most 10 lines; keep those for P2.

## 3. Check citations

Per repository, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs facts --repo <name> --json`. Exit 1
only means some facts were rejected; keep `accepted`, `rejected`, `overCap` and `batches` for P2.

**Workspace only, after every repository:** one `general-purpose` integrator. Prompt: follow
`.hub-run/generator/briefs/integrate.md`; each repository's root, `facts/<repo>.checked.jsonl` and
`inventory/<repo>.json`; the docs home; catalog, style and language. It writes
`facts/_workspace.jsonl`; then run
`node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs facts --repo _workspace --json`.

## 4. Verify

One `Explore` verifier per batch file in `batches/`: that is ceil(high-impact facts / 25)
verifiers per repository. Prompt: follow `.hub-run/generator/briefs/verify.md`; the repository
root (for `_workspace`, the workspace root and the repository names); the path of its batch file.
Give it nothing else: no drafts, no other facts.

Write each answer, only its JSON lines, to `.hub-run/verdicts/<batch name>.jsonl`, then run
`node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs verdicts --repo <name> --in .hub-run/verdicts/<batch name>.jsonl --json`.
Exit 1 means a correction was rejected: keep `unsupported` and `corrected` for P2 and go on.

## 5. Plan

Write `.hub-run/plan.json` following `.hub-run/generator/catalog.json`:

- Top level: `schema` 1, `mode` `"init"`, `generator` (the `generator` that `start` returned,
  `hub@<version>`), `settings.language` (a code such as `en` or `es`, never the language's name),
  `workspace` (null with one repository, otherwise `home` and `repos`), `estimate.agentRuns`
  (writers, reviewers and corrections still to come), `approved` false.
- Per repository: `head` from its inventory of this run (`plan` refuses any other), `docsDir`,
  `files`, `rejected` and `questions`.
- `files` come only from candidates that were not rejected and whose facts are still supported in
  `facts/<repo>.checked.jsonl` (a corrected fact `<id>c` replaces `<id>`). Each entry has `id`,
  `path`, `action`, `kind`, `archetype` (skills) or `type` and `trigger` (pages), `why` and
  `facts`. Skills live at `.claude/skills/<name>/SKILL.md` with the catalog's names and caps, where
  `{repo}` is the repository's name in lowercase with every run of other characters as `-`
  (`dlujo_store` gives `working-in-dlujo-store`);
  pages under the docs folder at a catalog path; workspace pages only in the docs home.
- `rejected`: each candidate with `rejected`, as `idea` and `reason` from the closed list.
- `questions`: at most 3 in the whole plan, only for what a person decides (whether an area needs
  a guardrail, whether a merge deploys). Each has `id`, `text`, `decides` (entry ids), `default`
  `"no"`, `answer` null and `role` null. Entries decided by a question you drop are left out.
- A guardrail skill always comes with one `guardrail-deny` entry (`.claude/settings.json`,
  `deny` as `Tool(pattern)` rules), and the same question decides both.
- Offers are `propose` entries with `offer`. `instructions-line`: one line in `text`, citing
  `working-in-<repo>` when the plan writes it, otherwise `<docs>/index.md`, and none if the plan
  writes neither; it goes to `CLAUDE.md` if it exists, else to `AGENTS.md`. `team-settings`
  (`.claude/settings.json`) and `hub-check` (`.github/workflows/hub-check.yml`) only when
  `env.json` has `gitSource` true; without it, plan neither.

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs plan .hub-run/plan.json --json` and fix the plan
until it exits 0: each error names the entry and the rule (paths, triggers, `minFacts`, caps,
offers, entries a re-init must `update` or `propose`).

## P2. Plan

Show, per repository, a table of the entries (action, path, kind or type, why, number of facts),
the rejected ideas with their reason, the facts that fell (rejected citations, over the cap, not
supported by a verifier) and `estimate.agentRuns`. Then one AskUserQuestion: each plan question
(at most 3), options "Leave it out (default)" and "Yes"; and the decision: "Approve", "Change" or
"Cancel".

- Cancel: run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs start --discard --json`; every repository
  stays as in `status/<repo>.txt`. Stop.
- Change: ask what to change, edit the plan, run the `plan` call of step 5 again and repeat P2.
- Approve: write each answer in `plan.json` (`"yes"`, `"no"` for "Leave it out", or the text) with
  `role`, the role of who answered (`maintainer` unless they say otherwise; never a name). For each
  question answered "no", remove from `files` the entries it `decides`. Then run
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs plan .hub-run/plan.json --approve --json`; on exit 1,
  fix what it names and run it again.

## 6. Write in staging

One `general-purpose` writer per repository, plus one for the workspace pages in the docs home.
Prompt: follow `.hub-run/generator/briefs/write.md`; the repository root and name; its entries
with `action` `create` or `update`, and `propose` without `offer` (id, path, action, kind,
archetype or type, trigger, why, fact ids); the path of `facts/<repo>.checked.jsonl` (and
`facts/_workspace.checked.jsonl` for workspace pages) with the ids to use; the paths of
`generator/skeletons/`, `generator/style.md`, `generator/catalog.json` and `inventory/<repo>.json`;
the language. The workspace writer also gets each repository's `remote` from its inventory, or that
it has none.

Writers write only `out/<repo>/<path>`, with `_claude` for every `.claude` segment, and
`proposals/<repo>/<id>.proposed`. Each returns one JSON line per file with its entry id and the
fact ids it used: write those ids into that entry's `facts` in `plan.json`.

## 7. Gates and review: two rounds at most

**Round 1.**

1. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs check .hub-run/plan.json --round 1 --json`.
2. One clean `Explore` reviewer per repository with entries to write. Prompt: follow
   `.hub-run/generator/briefs/review.md`; the repository root (and the siblings' roots in a
   workspace); a table with one row per `create` or `update` entry: its plan path and its staging
   path `out/<repo>/<path with _claude>`; `generator/style.md`; the language. Never the facts.
3. Write its answer, only the JSON lines, to `.hub-run/review/<repo>-1.in.jsonl` and run
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs review --repo <name> --in .hub-run/review/<repo>-1.in.jsonl --round 1 --json`.
   Exit 2 naming a `file` that is not a plan path: correct that `file` to the plan path from the
   table (or remove the finding), and run `review` again.
4. One correction prompt per writer: the check errors of its entries and only the findings
   `review` kept, in `.hub-run/review/<repo>-1.jsonl`, passed as they are. Add no advice of your
   own: a fix the writer cannot back with a supported fact fails round 2, where nothing is
   corrected. Use a new `general-purpose` with the same inputs if the first writer cannot be
   continued. Update `facts` in the plan from its answer.

**Round 2.**

1. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs check .hub-run/plan.json --round 2 --json`.
2. A new reviewer as in round 1; its findings go to `.hub-run/review/<repo>-2.in.jsonl`.
3. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs review --repo <name> --in .hub-run/review/<repo>-2.in.jsonl --round 2 --json`.

`check` marks `dropped` in the plan, with a `reason`, every entry that still fails a gate.
`review` takes out of its staged file the sentence or line that a `false`, `unsupported` or
`wrong-command` finding quotes, and lists it in `trimmed`; an entry it cannot trim that way, or with
another finding, it marks `dropped` with `reason` `review`. Keep `trimmed` for P3. Nobody corrects
anything after round 2.

**Confinement.** If `check` reports a `confinement` error in either round, a file changed outside
`.hub-run/` during the run. Stop before `place`: list the unexpected paths, say that nothing was
deleted, and let the person decide. Run the round's `check` again only when they say so; to
abandon the run, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs start --discard --json`.

## 8. Place

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs place .hub-run/plan.json --json`. It checks every
file again, copies what passes into the repositories, marks `dropped` (with a `reason`) what fails
or what an offer pointed at, writes the offers' proposals and records `placed.json`. Exit 1 only
means something was dropped. From here, `git diff` shows the real result.

**A repository with a hub docs site.** Per repository, run
`node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs site --repo <dir> --json`; it only reads. When `hubSite`
is true, build the site with the placed pages:
`node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs site --repo <dir> --build docs-site --json`. Exit 1 lists
each broken link or diagram by file and line and each broken anchor by its page; exit 2 means
`npm ci` failed. Without a hub site, never run `--build`: nothing here calls npm.

## P3. Result

For each repository run `git -C <repo> status --short` and `git -C <repo> diff --stat`, each alone
(they only read). Show, per repository: that status and diff stat; the site build's result when
there was one, every error by file and line or page; every `dropped` entry of
`plan.json` with its `reason` (`gate:<gate>`, `review` or `target-dropped`, including what
`place` skipped); what round 2's `review` took out (`trimmed`), the findings it left to the person
on lines they wrote by hand, and what `place` took out of an index (their warnings); the facts that
fell; the open questions; and each proposal and offer from
`place`'s `proposals` by its id and its destination path (`CLAUDE.md`, not `x1.proposed`).

About the offers, say:

- Team settings (`.claude/settings.json`): the team gets `hub` without installing it, with three
  limits: it loads only when a session opens at the repository's root directory, only once the
  person trusts the folder, and not in cloud sessions.
- Without `gitSource` in `env.json` (no `claude` CLI, or `engineering-hub` not added from a git
  source), say in one line that there is no team settings or `hub-check.yml` offer.
- Without a hub site, the Keep question's text ends with one line: `/hub:site` can build a docs
  site from these docs.

Then one AskUserQuestion:

1. **Proposals and offers to apply** (multiple choice), default none. Up to 4, one option each,
   labelled with id and destination. With more than 4, list them all in the question text with id
   and destination, and offer all, none, or groups by kind; other selections go in "Other" as ids.
   What is not chosen changes nothing.
2. **Keep:** "Keep all (default)", "Keep without some" (write in "Other" the ids to leave out) or
   "Discard all". If they pick "Keep without some" without ids, ask which. When the site build
   failed, leave out "Keep all": offer "Keep without some (default)" and "Discard all", and say
   which pages break the build; `finish` itself does not check it.

## 9. Finish

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs finish .hub-run/plan.json --keep <keep> --apply <ids> --json`,
where `<keep>` is `all`, `none`, or for "Keep without some" the kept entry ids separated by
commas, and `<ids>` the chosen proposals and offers, separated by commas. Pass `--apply` only when a
proposal or offer was chosen. It removes or restores what was discarded, never touches a file
changed since `place`, applies the chosen proposals after scanning them, writes the locks and
checks confinement. Exit 1 still finishes the run.

Report from its output: what was written and what was not, files left as they are because they
changed after `place`, proposals not applied with the reason, unexpected paths, the locks written,
and the suggested commit message in the repository's style. Say that the new skills are active
already, before anything is recorded in git, and that reviewing and committing is up to the person
(on a working branch of their choice). Do not commit or push.
