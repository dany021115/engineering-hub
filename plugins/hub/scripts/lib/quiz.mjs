// `quiz` (QUI-1..7): a recall check the person takes without Claude, from the sentences and tables
// of generated pages that still hold. It only reads, and nothing it shows is kept anywhere.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCatalog } from './catalog.mjs'
import { parseOptions, result, usage } from './cli.mjs'
import { lsFiles } from './git.mjs'
import { classify, codeSpans, headings, isPathLike, splitFrontmatter } from './markdown.mjs'
import { checkedSpan, freshnessOf, lockedRepo, underArea } from './route.mjs'
import { fixedSentences, sentences } from './sample.mjs'

const REASONS = { 'edited by hand': 'edited', missing: 'missing', 'sources changed': 'sources changed', 'sources not checked': 'sources not checked' }
const MIN_WORDS = 5
const CELL = /^`([^`]+)`$/
const plain = text => text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*/g, '')

// A sentence with one checked span, blanked; null when it would make a poor question.
function clozeOf(sentence, allowed) {
  const text = plain(sentence)
  const spans = codeSpans(text)
  if (spans.length !== 1 || !checkedSpan(spans[0]) || allowed.includes(spans[0])) return null
  const written = `\`${spans[0]}\``
  const rest = text.replace(written, ' ')
  if (text.startsWith(`${written},`) || rest.includes(spans[0]) || rest.trim().split(/\s+/).length < MIN_WORDS) return null
  return { kind: 'cloze', text: text.replace(written, '____'), answer: spans[0] }
}

// The rows of tables whose second column says where a name is read, as the reference skeleton writes
// it. The name is one the grounding gate checks: a plain key such as `service` may be set, not read.
function whereOf(lines, known) {
  const out = []
  let inTable = false
  for (const l of lines) {
    const cells = l.text.trim().startsWith('|') ? l.text.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()) : null
    if (!cells) inTable = false
    else if (cells[1] === 'Where it is read') inTable = true
    else if (inTable) {
      const name = CELL.exec(cells[0] ?? '')?.[1]
      const file = CELL.exec(cells[1] ?? '')?.[1]
      if (name && file && checkedSpan(name) && (isPathLike(file) || known.has(file))) {
        out.push({ line: l.n, kind: 'where', text: `Which file reads \`${name}\`?`, answer: file })
      }
    }
  }
  return out
}

export default function quiz(argv) {
  const { values } = parseOptions(argv, { repo: { type: 'string' }, n: { type: 'string' }, seed: { type: 'string' }, area: { type: 'string' }, answers: { type: 'boolean' } })
  if (!values.repo) throw usage('usage: hub.mjs quiz --repo <dir> [--n <n>] [--seed <s>] [--area <path>] [--answers] [--json]')
  const catalog = loadCatalog()
  const n = values.n === undefined ? catalog.limits.quizQuestions : Number(values.n)
  if (!Number.isInteger(n) || n < 1) throw usage('--n takes a whole number of questions, 1 or more')
  const seed = values.seed ?? '1'
  const { dir, lock, repo } = lockedRepo(values.repo)
  const known = new Set(lsFiles(dir))
  const isFixed = fixedSentences()
  const skipped = []
  const found = new Map()

  for (const [path, entry] of Object.entries(lock.files ?? {})) {
    if (entry.kind !== 'page') continue
    if (values.area !== undefined && !underArea(Object.keys(entry.sources ?? {}), values.area)) continue
    const { freshness } = freshnessOf(dir, path, entry)
    if (freshness !== 'unchanged') {
      skipped.push({ path, reason: REASONS[freshness] })
      continue
    }
    const text = readFileSync(join(dir, path), 'utf8')
    const fm = splitFrontmatter(text)
    const lines = classify(fm.body, fm.offset).filter(l => l.kind === 'prose')
    const heads = headings(lines).filter(h => h.level === 2)
    const sectionAt = line => heads.filter(h => h.n < line).at(-1)?.text.trim() ?? null
    const questions = sentences(text).filter(s => !isFixed(s.text)).flatMap(s => {
      const q = clozeOf(s.text, catalog.groundingAllow)
      return q ? [{ line: s.line, ...q }] : []
    })
    if (entry.type === 'reference') questions.push(...whereOf(lines, known))
    for (const q of questions) {
      if (!found.has(q.text)) found.set(q.text, { kind: q.kind, text: q.text, answer: q.answer, page: path, section: sectionAt(q.line), key: createHash('sha1').update(`${seed}\n${path}\n${q.line}\n${q.text}`).digest('hex') })
    }
  }

  const chosen = [...found.values()].sort((a, b) => a.key.localeCompare(b.key)).slice(0, n)
  const questions = chosen.map(({ key: _key, answer, page, section, ...q }, i) => ({ n: i + 1, ...q, ...(values.answers ? { answer, page, section } : {}) }))
  const res = result()
  res.data = { repo, seed, questions, skipped }
  if (questions.length < n) res.warnings.push({ repo, message: `only ${questions.length} questions from these pages` })
  for (const q of questions) {
    res.lines.push(`${q.n}. ${q.text}`)
    if (values.answers) res.lines.push(`   answer: ${q.answer} (${q.page}${q.section ? `, ${q.section}` : ''})`)
  }
  for (const s of skipped) res.lines.push(`left out: ${s.path} (${s.reason})`)
  return res
}
