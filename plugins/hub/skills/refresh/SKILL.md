---
name: refresh
description: Updates the skills and docs that /hub:init generated after the code they describe changed. Finds what is out of date with the lock, re-checks the facts against HEAD, keeps hand edits as proposals, and asks for approval at three gates before anything lands in a repository. Never records anything in git.
argument-hint: "[repo ...]"
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs *)
---

# Refresh generated skills and docs

You orchestrate. The script `hub.mjs` does everything deterministic (drift, citations, plan
validation, gates, placing, locks); agents find facts and write prose; the person decides at three
gates. Only files the lock tracks are refreshed; a file edited by hand is never overwritten, only
offered as a proposal. Nothing is ever committed or pushed.

`$ARGUMENTS`, if given, names the repositories to refresh (folder names in a workspace).

## Rules for every step

- **Each call to the script stands alone:** `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs <subcommand> … --json`,
  run from the session's folder, with no pipe, no redirection, no `cd` and no chaining of
  commands. Only that form is covered by this command's permission. Read its JSON from the output.
- **No other commands:** besides `hub.mjs`, run only P3's two `git` reads. `drift` already names
  the sources that changed; the explorer reads their diffs. Any other command asks the person for
  permission.
- **To save data** (verdicts, findings, the plan) use Write or Edit on files inside `.hub-run/`.
  Never write anywhere else, and never edit a repository yourself. Build each absolute path by
  joining the `root` that `start` printed, copied exactly, and the relative path; never retype it.
  If a Write asks for permission, the path is wrong: deny it and fix the path.
- **Exit codes:** 0 no errors (warnings may be present), 1 gate errors to act on as the step says,
  2 usage or environment: show the message and stop.
- **Agents:** only `general-purpose` (explorer, writer) and `Explore` (verifier, reviewer). At most
  4 agents at once (`caps.agentsAtOnce` in the catalog); launch in waves, a wave being several Agent
  calls in one message, each with `run_in_background: false`, so their results come back in the
  same turn. Never end your turn to wait for an agent. Each prompt names the brief in
  `.hub-run/generator/briefs/` and gives absolute paths built from the `root` that `start` returns.
  Never point an agent at the plugin's own folder.
- **Gates:** each gate (P1, P2, P3) is exactly one AskUserQuestion call: at most 3 content
  questions, each with its default marked "(default)" and listed first (also in a multi-select,
  where the default is the one that applies nothing), plus the gate decision as the last question;
  every question has 2 to 4 options. With more than 4 items to choose from, the question text lists
  every item with its id and its path, the options group them (all, none, or by kind), and any
  other selection is written in "Other" as ids. Never go on without an answer.
- **No question outside the gates.** AskUserQuestion is only for P1, P2 and P3. While agents run,
  wait for them without asking anything: the person has nothing to decide until the next gate.
- **Before each gate question,** write what the gate says to show as text in the same message,
  ahead of the AskUserQuestion call. The person sees only your text, never the tool results, so a
  question without that text asks them to decide blind.
- **Permission:** this command's grant for `hub.mjs` lasts the turn that started it, and the
  gates do not end it; while `.hub-run/` is open, the plugin's hook allows each lone `hub.mjs`
  call, and P3's two `git` reads, after that turn too, and lets the agents only read. If a call
  still asks for permission, tell the person that allowing it is safe: `hub.mjs` reads the
  repositories, writes in `.hub-run/`, touches a repository only in `place`, `finish` and
  `drift --advance` after their approval, and never commits or pushes.

## 0. Preflight

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs start --json`. Exit 2: show the message (it names
the folder to start Claude Code in) and stop. Otherwise read `mode`, `root`, `repos`, `skipped`,
`resume`, `discard`, `sitePlan` and `generator`, and show the warnings.

- **No lock:** the repositories to refresh are those of `$ARGUMENTS`, or all, keeping only those
  whose `reinit` is true (they have `.claude/hub.lock.json`). If none is left, say that nothing was
  generated here yet and that `/hub:init` does it, and stop: no agent runs.
- **An unfinished run** (`discard` is set) is decided first, in one AskUserQuestion. `sitePlan`
  true: offer only to discard it or to stop. Otherwise offer "Resume from `<resume>` (default)",
  "Discard it" and "Stop". Discard: when `discard` is `start --discard`, run
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs start --discard --json`; when it is
  `finish --keep none`, run
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs finish .hub-run/plan.json --keep none --json`. Then
  run `start --json` again and go on as a new run. Resume: `verify` goes to step 3, `P2` runs the
  `plan` call on the existing plan for its `evidence` and goes to the P2 gate, and `P3` runs the
  `sample` call of step 8, which gives the same sentences again, and goes to the P3 gate, with the
  scope from `.hub-run/scope.json` or the plan.

## 1. Prepare the run and find the drift

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs start --repo <dir> --repo <dir> --json` with one
`--repo` per repository to refresh (`--repo .` in a single repository). A finished earlier run
(its `done.json`) is cleared and this one starts from zero. Then run
`node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs drift --repo <dir> --repo <dir> --json` with the same
repositories. Per repository it gives `files` (each `edited`, `missing`, `affected` and `unknown`
sources), `newEvidence`, `generator` and `installed`; its warnings say when `documentedCommit` is
not in this clone and when the installed generator is newer.

**Up to date** (no file affected or missing, and no new evidence, in any repository): say "up to
date", with how many files are edited by hand (protected: never overwritten). If the installed
generator is newer, say that `/hub:init` regenerates with it. If `HEAD` is past `documentedCommit`,
ask in one AskUserQuestion whether to move `documentedCommit` to `HEAD`: "Leave it (default)" or
"Move it". Move it: run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs drift --repo <dir> --advance --json`
per repository; it changes only the lock. Then run
`node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs start --discard --json` and stop.

## P1. Scope

Show per repository: the affected files with the sources that changed, the files edited by hand
(an affected one gets a proposal, never an overwrite), the files that disappeared (never
recreated), sources whose sibling repository is not on disk (`unknown`), the new evidence (new CI,
manifest, contract, data or deploy files and new variables: `/hub:init` writes pages or skills for
them), and a newer generator if any.

Recommend accept-edits mode (shift+tab) for this run: the agents only write inside `.hub-run/`.

Then one AskUserQuestion:

1. **Affected files to refresh** (multiple choice): all of them (default), none, or groups by kind;
   other selections go in "Other" as paths. Here the default is every affected file, because
   refreshing them is what the command is for.
2. **Disappeared files** (only when there are some, multiple choice): "Keep them in the lock
   (default)" or "Confirm they are gone" (they leave the lock).
3. **Continue or cancel.** When `estimate.confirm` from `start --repo` is true, put "about
   `<total>` agent runs" in this question and its continue option.

- Cancel: run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs start --discard --json` and stop.
- Write `.hub-run/scope.json` with `repos`, `home` (from the lock: the repository whose lock has
  `workspace`, or null), `language` (the lock's `settings.language`), and per repository the chosen
  affected paths and the confirmed disappearances.

## 2. Explore

One `general-purpose` explorer per repository with chosen files. Prompt: follow
`.hub-run/generator/briefs/explore.md`, its section "In a refresh"; the repository root and name;
the paths of `inventory/<repo>.json`, `generator/catalog.json` and `generator/style.md`; the
language; the paths it must not read; and per chosen file its path, its `sources` from the lock,
and `documentedCommit` when `drift` did not warn that it is missing from the clone. It writes
`facts/<repo>.jsonl` and returns at most 10 lines.

## 3. Check citations

Per repository, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs facts --repo <name> --json`. Exit 1
only means some facts were rejected; keep `accepted`, `rejected`, `overCap` and `batches` for P2.

## 4. Verify

One `Explore` verifier per batch file in `batches/`. Prompt: follow
`.hub-run/generator/briefs/verify.md`; the repository root; the path of its batch file; nothing
else. Write each answer, only its JSON lines, to `.hub-run/verdicts/<batch name>.jsonl`, then run
`node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs verdicts --repo <name> --in .hub-run/verdicts/<batch name>.jsonl --json`.

## 5. Plan

Write `.hub-run/plan.json` following `.hub-run/generator/catalog.json`: `schema` 1, `mode`
`"refresh"`, `generator` from `start`, `settings.language` from the lock, `workspace` with the
`home` and `repos` that the docs home's lock records, also when only one of those repositories is
refreshed (null outside a workspace), `estimate.agentRuns`, `approved` false; per repository `head`,
`docsDir` (the lock's), `files`, `rejected` and `questions`. One entry per chosen file, with the
lock's `kind` and `archetype` or `type`, a `trigger` for pages, `why` and the supported `facts`:

- `update` for a file not edited by hand;
- `propose` (no `offer`) for a file edited by hand: the writer rewrites it from its current text;
- `delete` for each confirmed disappearance (nothing is deleted: it only leaves the lock).

A chosen file whose claims no supported fact backs any more stays an `update`: the writer removes
what is no longer true. `questions` only for what a person decides, at most 3.

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs plan .hub-run/plan.json --json` and fix the plan
until it exits 0.

## P2. Plan

Show, per repository, a table of the entries (action, path, kind or type, why, number of facts),
and under it the evidence of each entry: the `text` of its row in the `evidence` the `plan` call
returned, one line per entry exactly as given. Then the facts that fell and
`estimate.agentRuns`. Then one AskUserQuestion: each plan question,
options "Leave it out (default)" and "Yes"; and the decision: "Approve", "Change" or "Cancel".

- Cancel: run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs start --discard --json` and stop.
- Change: ask what to change, edit the plan, run the `plan` call again and repeat P2.
- Approve: write each answer with `role` (`maintainer` unless they say otherwise; never a name),
  remove the entries a "no" decides, and run
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs plan .hub-run/plan.json --approve --json`.

## 6. Write in staging

One `general-purpose` writer per repository. Prompt: follow `.hub-run/generator/briefs/write.md`,
its section "In a refresh"; the repository root and name; its `update` and `propose` entries; the
path of `facts/<repo>.checked.jsonl` with the ids to use; the paths of `generator/skeletons/`,
`generator/style.md`, `generator/catalog.json` and `inventory/<repo>.json`; the language. Writers
write `update` entries to `out/<repo>/<path>` (with `_claude` for every `.claude` segment) and
`propose` entries to `proposals/<repo>/<id>.proposed`, and return one JSON line per file with its
entry id and the fact ids it used: write those into the entry's `facts`.

## 7. Gates and review: two rounds at most

**Round 1.** Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs check .hub-run/plan.json --round 1 --json`.
The proposals over lock files go through the gates at their plan path, like staged files. Then one
clean `Explore` reviewer per repository. Prompt: follow `.hub-run/generator/briefs/review.md`; the
repository root; a table with one row per `update` entry (plan path, staging path
`out/<repo>/<path with _claude>`) and per `propose` entry (plan path, staging path
`proposals/<repo>/<id>.proposed`); `generator/style.md`; the language. Never the facts. Write its
answer to `.hub-run/review/<repo>-1.in.jsonl` and run
`node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs review --repo <name> --in .hub-run/review/<repo>-1.in.jsonl --round 1 --json`
(exit 2 naming a `file` that is not a plan path: correct that `file` and run it again). Then one
correction prompt per writer with the check errors of its entries and the findings in
`.hub-run/review/<repo>-1.jsonl`, passed as they are, with no advice of your own: a fix the writer
cannot back with a supported fact fails round 2, where nothing is corrected.

**Round 2.** Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs check .hub-run/plan.json --round 2 --json`,
a new reviewer as in round 1 writing `.hub-run/review/<repo>-2.in.jsonl`, and
`node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs review --repo <name> --in .hub-run/review/<repo>-2.in.jsonl --round 2 --json`.
`check` marks `dropped`, with a `reason`, what still fails a gate. `review` takes out of a staged
file the sentence or line that a `false`, `unsupported` or `wrong-command` finding quotes, listing it
in `trimmed`, and marks `dropped` with `reason` `review` what it cannot trim that way; keep `trimmed`
for P3. Nobody corrects anything after round 2. A dropped proposal leaves the edited file and its
lock entry as they are.

**Confinement.** A `confinement` error means a file changed outside `.hub-run/` during the run.
Stop before `place`: list the paths, say that nothing was deleted, and let the person decide.

## 8. Place

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs place .hub-run/plan.json --json`. Exit 1 only means
something was dropped.

**A repository with a hub docs site.** Per repository, run
`node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs site --repo <dir> --json`; it only reads. When `hubSite`
is true, build the site with the refreshed pages:
`node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs site --repo <dir> --build docs-site --json`. Exit 1 lists
each broken link or diagram by file and line and each broken anchor by its page; exit 2 means
`npm ci` failed. Without a hub site, never run `--build`: nothing here calls npm.

**A sample to check.** Last, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs sample .hub-run/plan.json --json`.
It only reads, gives the same sentences each time in this run, and takes them only from the lines
this run changed. Its `items` each have a number `n`, a `repo`, `path` and `line`, a `text` and the
`open` paths to read it against.

## P3. Result

For each repository run `git -C <repo> status --short` and `git -C <repo> diff --stat`, each alone.
Show per repository: that status and diff stat; the site build's result when there was one, every
error by file and line or page; every `dropped` entry with its `reason`; what round 2's `review`
took out (`trimmed`), the findings it left to the person on lines they wrote by hand, and what
`place` took out of an index (their warnings); the facts
that fell; and each proposal from `place`'s `proposals` by its id and its destination path, saying
that accepting one replaces the file edited by hand and tracks it again, and leaving it makes the
file the person's (it leaves the lock). If no site exists yet, say in one line that `/hub:site`
builds one from these docs.

**The sampled sentences,** when `sample` gave any: list them numbered, each with its repository,
`path:line`, the sentence and its `open` paths, in the text before the call and again in the text
of their question. Say that a sentence that does not match is left out with "Keep without some" and
its file's id, or fixed by hand afterwards, and that editing it protects that file at the next
refresh. With no sentence there is no such question.

Then one AskUserQuestion:

1. **Proposals to apply** (multiple choice), default none. Up to 4, one option each, labelled with
   id and destination; with more, list them in the question text and group the options.
2. **Did these sentences match the code?** (only with sampled sentences): "Not checked (default)",
   "All matched" or "Some did not (numbers in Other)". "Some did not" without numbers is an answer
   too: do not ask again.
3. **Keep:** "Keep all (default)", "Keep without some" (ids in "Other") or "Discard all". When the
   site build failed, leave out "Keep all": offer "Keep without some (default)" and "Discard all",
   and say which pages break the build; `finish` itself does not check it.

## 9. Finish

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs finish .hub-run/plan.json --keep <keep> --apply <ids> --spot <spot> --json`
(`--apply` only when a proposal was chosen; `--spot` only when the sentences were asked about:
`none` for "Not checked", `all` for "All matched", `some` for "Some did not" without numbers, or the
numbers written in "Other", separated by commas). It applies the chosen proposals unless their file
changed since `place`, takes the rejected ones and the confirmed disappearances out of the lock,
and moves `documentedCommit` to `HEAD` only when every affected file was refreshed, accepted or let
go; its warnings name the ones that hold it back. Exit 1 still finishes the run.

Report from its output what was written and what was not, files left as they are, proposals not
applied with the reason, the spot check, whether `documentedCommit` moved, and the suggested commit
message.
Reviewing and committing is up to the person, on a working branch of their choice. Do not commit
or push.
