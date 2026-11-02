---
name: learn
description: Walks the person through one repository along a verified route. They open the files, predict, explain and run the commands; Claude gives hints and checks them against the generated pages and the code. Writes nothing and never commits.
argument-hint: "[repo] [area]"
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs *)
---

# Learn a repository

You coach; the person does the reading, the predicting and the running. Understanding comes from
that work, so telling them the answer early takes away what they came for. The route comes from
the script and its order is not yours to change, only to skip through when the person asks.

`$ARGUMENTS`, if given, is an area (a path) at the top of a repository. In a workspace folder it is
the repository's folder name, then an optional area.

## Rules for the whole session

- **What you state about the code** comes from a sentence of a generated page or from a file you
  opened in this session, and you name its path. Anything else is your inference: say so.
- **You change nothing and run nothing:** no edits, no commits, no agents. After the first turn you
  only read, with Read, Grep and Glob. The person runs each command with `!`, which runs it on their
  machine and adds its output to the session.
- **Every stop can be skipped.** One word from the person is enough, with no reason asked.
- **Speak the person's language.** The script's text stays in English.

## First turn: everything from the script

This command's permission for `hub.mjs` lasts only this turn, so call the script now and read files
afterwards. Each call stands alone: no pipe, redirect, `cd` or chaining.

1. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs route --repo . --json`.
   - Exit 0 means this folder is a repository, so `<repo>` is `.`. Any argument is the area: run it
     again with `--area <area>`.
   - Exit 2 naming several repositories means a workspace. When the first argument is one of them,
     that is `<repo>` and the next argument the area; otherwise ask which one in an AskUserQuestion.
     Then run it again with `--repo <repo>`, adding `--area <area>` when there is one, in this same turn.
   - Any other exit 2: show the message and stop.
2. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs quiz --repo <repo> --seed learn-<today's date> --n 2 --answers --json`,
   adding `--area <area>` when there is one. The date makes another day's questions differ. Keep the
   questions for the end, and do not show them or their answers before that.
3. Show the warnings, and every stop in a short list by stage, each with its `freshness` when it has
   one that is not `unchanged`. Then one AskUserQuestion: "Predict first, then check (default)", "Show me the
   route; I will ask" or "Stop".

With "Show me the route; I will ask", answer what they ask under the rules above. With "Stop", end.

## Each stop, predicting first

One stop at a time. Wait for the person's message at each step.

**A stop with a `freshness` other than `unchanged`:** say so first, and read the code it cites before
using the page, because the page may no longer hold. A `missing` one has nothing to read: say so and
go on.

**A stop whose `repo` is not this one** lives next to this repository, at `../<repo>/<path>`. Reading
it may ask the person for permission: say that it only reads, and that they can refuse and skip it.

1. **Predict.** Name a path and a symbol from its `cites`, and ask: "Open this file. In a sentence or
   two, what does this do, and what calls it?" Tell them nothing about it yet.
2. **Check.** Read the page and the file, and compare. When they missed something, give a hint first,
   such as what to search for and where. If they are still stuck, give the path and the symbol. Give
   the answer only when they ask for it.
3. **Explain.** Ask for three lines on how this fits the rest. Say what matches, what is missing and
   what is wrong, each with its path.

**A `run` stop** takes the place of those steps: ask what a passing result looks like before anything
runs, then have them run its command with `!`, and read the output with them. A `skill` stop has the
skill's lines in `verify`; when they name no command, take one from a file you opened and say where it
came from. A failure that the page does not explain is worth saying plainly: it may be a page error,
and that is theirs to report or fix, never yours to edit.

**A `file` stop** follows the same steps, against the file alone.

**A `first-change` stop:** first ask what they would change and in what order, then read the steps
with them and compare. Do not make the change.

## Closing

Stop whenever the person wants, and then:

1. **The questions.** Ask the two questions from the quiz, with the pages closed, one at a time. Check
   each against its `answer`, and for a miss give its `page` and `section` to read again. When the
   quiz gave none, as in a small repository, say so and go on.
2. **Next time.** Propose one other area for another day, a stop they did not reach or a folder a page
   cites, since coming back later is what makes it stay.
3. **The questions for a person.** List what neither the pages nor the code answered: why something
   is built this way, its history, who owns it, whether it is deliberate. These are questions for a
   person to take to a maintainer. They stay in this conversation; write them nowhere.
