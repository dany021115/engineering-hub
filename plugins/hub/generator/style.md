# Style

These are the rules for every page and skill the generator writes. Each rule carries a mark: [lint] means `hub.mjs check` enforces it, and [agent] means the writer follows it and the reviewer watches for it. Some rules carry both, split by what the lint can see. Limits, word lists and required sections live in `catalog.json`; this file names them and never copies them.

## Docs

1. **One page, one job.** A page is an overview, a how-to, a reference or an explanation. A reference has no steps, and a how-to has no lists of options. [agent]
2. **Title and intro.** One H1, the title, followed by one to three sentences on what the page covers and who it is for. [lint]
3. **Headings.** Sentence case; task headings start with a verb; no skipped levels and no empty sections. [lint: levels and empty sections]
4. **Voice.** Second person, present tense, active voice; "we" only for the organization. [agent]
5. **Timeless prose.** No words that date the text (the list is `timelessWords` in `catalog.json`), no dates, versions or counts: point to the file that holds them. [lint: the word list, in `en`; dates and versions as warnings]
6. **Nothing provisional.** No roadmaps, TODO, TBD, known gaps or bug lists. A possible defect goes in the report, never on the page. [lint]
7. **Procedures.** Numbered, one action per step, within the page type's `maxSteps`, and a section to verify the result. [lint: step count; agent: one action per step]
8. **Lead-ins.** Every list, table, code block and diagram follows a sentence that introduces it. [agent]
9. **Code.** Paths, commands, variables and identifiers go in `code`; fences name their language; commands have no `$ ` prompt. [lint: fence language and `$ `; agent: paths, commands, variables and identifiers in `code`]
10. **Placeholders.** Write them as `<kebab-case>` and explain each one right after its block, so grounding can tell them from real identifiers. [agent; grounding exempts them]
11. **Links.** Between pages, relative `.md` paths inside the docs folder, with link text that describes the target and never "here". Cite code by path and symbol in backticks, never with a relative link to a file that is not a doc (it breaks a strict build), never by line number and never with a link to lines on the default branch. [lint]
12. **Diagrams.** Mermaid `flowchart` or `sequenceDiagram`, at most 15 nodes, with labelled edges and a sentence that states the diagram's scope. [lint: header and node count; agent: labelled edges and the scope sentence]
13. **No identifying data.** No secrets, names of people, emails, absolute local paths or internal hosts; name roles, not people. [lint: scan]
14. **Budgets.** Each page stays within its type's `maxWords`. [lint: warning]
15. **Point, do not copy.** Link specs, manifests and CI files instead of repeating them; reference tables follow the order of their source. [agent]

## Skills

16. **Frontmatter.** `name` equals the folder name, is kebab-case, within `limits.skillNameMaxChars`, never contains "claude" or "anthropic", and is unique in the workspace; `description` stays within `limits.descriptionMaxChars` (warning above `limits.descriptionWarnChars`) and has no `<` or `>`; only allowed keys, each with its type. [lint]
17. **Description.** Scope first, then concrete triggers, in the third person; never a summary of the steps. [agent]
18. **The instructions file wins.** Point to the repo's `CLAUDE.md` or `AGENTS.md`; never repeat it. [agent]
19. **Order.** Most important first; each point is a rule in bold followed by its reason. [agent]
20. **Content.** Only what an agent would get wrong without it: no overviews, file trees, dependency lists, generic advice or rules a linter already enforces. [agent]
21. **Pointers.** Facts that change are pointers with a command to re-check them: no versions, counts, dates, line numbers or deep paths. [lint, in part]
22. **Standing instructions.** Rules, not one-off steps. [agent]
23. **Size and keys.** The body stays within its archetype's `maxLines` and never above `limits.skillBodyMaxLines`; no `allowed-tools`, `hooks`, `context`, `agent` or `model`. [lint]

## Another language

When the run's language is not English, headings and prose are in that language; skill names and paths stay in English kebab-case. The timeless word list (rule 5) and the required sections are checked only in `en`; TODO and TBD (rule 6) are checked in every language.
