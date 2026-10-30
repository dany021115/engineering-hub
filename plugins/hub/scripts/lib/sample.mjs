// `sample` (EVI-4): a stable sample of the sentences a run placed, for the person to check against
// the code at P3. It reads the staged copy of each placed file, which is what was placed.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generatorDir, loadCatalog } from './catalog.mjs'
import { HubError, parseOptions, result, usage } from './cli.mjs'
import { git, lsFiles } from './git.mjs'
import { classify, codeSpans, HEADING, isPathLike, SENTENCE, splitFrontmatter } from './markdown.mjs'
import { stagingFile } from './paths.mjs'
import { factIndex, loadPlanFile } from './plan.mjs'
import { repoDirs } from './workspace.mjs'

const TABLE = /^\s*\|/
const MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/
const PLACEHOLDER = /<[^<>]*>/
const sha1 = text => createHash('sha1').update(text).digest('hex')
const flat = text => text.replace(/\s+/g, ' ').trim()

// The checkable sentences of a Markdown text: prose outside frontmatter, headings, fences and
// tables, with list and step markers taken off; `only` keeps the given line numbers. A sentence
// that ends in a colon only leads into a list and states nothing.
export function sentences(text, only = null) {
  const fm = splitFrontmatter(text)
  const out = []
  for (const l of classify(fm.body, fm.offset)) {
    if (l.kind !== 'prose' || (only && !only.has(l.n))) continue
    if (!l.text.trim() || HEADING.test(l.text) || TABLE.test(l.text)) continue
    for (const s of l.text.replace(MARKER, '').trim().split(SENTENCE)) {
      const t = s.trim()
      if (t.split(/\s+/).length >= 4 && !/:[*_]*$/.test(t)) out.push({ line: l.n, text: t })
    }
  }
  return out
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Whether a sentence is one every skeleton writes: as it is, or with its one blank filled when at
// least six words around it are fixed (the authority line). Nothing to check in them.
export function fixedSentences() {
  const dir = join(generatorDir(), 'skeletons')
  const exact = new Set()
  const patterns = []
  for (const name of readdirSync(dir).filter(n => n.endsWith('.md'))) {
    for (const s of sentences(readFileSync(join(dir, name), 'utf8'))) {
      const text = flat(s.text)
      const blanks = text.match(/<[^<>]*>/g) ?? []
      if (!blanks.length) exact.add(text)
      else if (blanks.length === 1 && text.replace(PLACEHOLDER, ' ').split(/\s+/).filter(w => /[A-Za-z]/.test(w)).length >= 6) {
        const [before, after] = text.split(PLACEHOLDER)
        patterns.push(new RegExp(`^${escapeRe(before)}.+?${escapeRe(after)}$`))
      }
    }
  }
  return sentence => {
    const text = flat(sentence)
    return exact.has(text) || patterns.some(p => p.test(text))
  }
}

export default function sample(argv) {
  const { values, positionals } = parseOptions(argv, { n: { type: 'string' } }, { positionals: true })
  if (positionals.length !== 1) throw usage('usage: hub.mjs sample <plan.json> [--n <n>] [--json]')
  const { plan, run, root } = loadPlanFile(positionals[0])
  if (existsSync(join(run, 'done.json'))) throw new HubError('sample: this run is finished (done.json); start a new one')
  const placedPath = join(run, 'placed.json')
  if (!existsSync(placedPath)) throw usage('sample: nothing is placed yet; run place first')
  const n = values.n === undefined ? loadCatalog().limits.spotSentences : Number(values.n)
  if (!Number.isInteger(n) || n < 1) throw usage('--n takes a whole number of sentences, 1 or more')
  const seed = sha1(Object.entries(plan.repos ?? {}).map(([name, r]) => `${name}:${r.head ?? ''}`).sort().join('\n'))

  const file = join(run, 'sample.json')
  const res = result()
  if (existsSync(file)) {
    const kept = JSON.parse(readFileSync(file, 'utf8'))
    if (kept.n === n && kept.seed === seed) return report(res, kept.items)
  }

  const placed = JSON.parse(readFileSync(placedPath, 'utf8'))
  const dirs = repoDirs(root)
  const isFixed = fixedSentences()
  const units = []
  for (const [repo, r] of Object.entries(placed.repos ?? {})) {
    const dir = dirs[repo]
    const entries = new Map((plan.repos?.[repo]?.files ?? []).map(f => [f.path, f]))
    const index = factIndex(root, repo)
    const tracked = dir ? new Set(lsFiles(dir)) : new Set()
    for (const [path, p] of Object.entries(r.files ?? {})) {
      if (!['create', 'update'].includes(p.action) || !p.placed || !/\.md$/i.test(path)) continue
      const staged = stagingFile(root, repo, path)
      const source = existsSync(staged) ? staged : dir && join(dir, path)
      if (!source || !existsSync(source)) continue
      const text = readFileSync(source, 'utf8')
      // In a refresh, only what this run changed: the lines the previous blob did not have.
      let only = null
      if (p.previous && dir) {
        const before = new Set(git(dir, ['cat-file', 'blob', p.previous]).stdout.split('\n'))
        only = new Set(text.split('\n').flatMap((line, i) => (before.has(line) ? [] : [i + 1])))
      }
      const factPaths = [
        ...new Set(
          (entries.get(path)?.facts ?? [])
            .map(id => index.get(id))
            .filter(f => f && f.kind !== 'human')
            .flatMap(f => (f.evidence ?? []).map(e => e.path ?? e.pathspec).filter(x => typeof x === 'string' && x)),
        ),
      ]
      sentences(text, only).forEach((s, i) => {
        if (isFixed(s.text)) return
        const named = codeSpans(s.text).filter(span => isPathLike(span) && (tracked.has(span) || [...tracked].some(t => t.startsWith(span.endsWith('/') ? span : `${span}/`))))
        units.push({ repo, path, line: s.line, text: s.text, open: named.length ? [...new Set(named)] : factPaths, key: sha1(`${seed}\n${repo}\n${path}\n${s.line}\n${i}`) })
      })
    }
  }
  const chosen = units
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, n)
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path) || a.line - b.line)
    .map(({ key: _key, ...u }, i) => ({ n: i + 1, ...u }))
  writeFileSync(file, JSON.stringify({ schema: 1, n, seed, items: chosen }, null, 2) + '\n')
  return report(res, chosen)
}

function report(res, items) {
  res.data = { items }
  for (const s of items) res.lines.push(`${s.n}. ${s.repo} ${s.path}:${s.line}: ${s.text}${s.open.length ? ` (open: ${s.open.join(', ')})` : ''}`)
  if (!items.length) res.lines.push('no placed sentence to check')
  return res
}
