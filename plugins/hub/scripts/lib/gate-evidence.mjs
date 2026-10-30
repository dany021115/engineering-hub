// EVI-1, EVI-2: the checked fact that backs each plan entry, shown at P2 so the person sees what
// an entry rests on. A quote that the scanner flags never reaches the gate.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { normalize } from './evidence.mjs'
import { showHead } from './git.mjs'
import { readJsonl } from './jsonl.mjs'
import { readLock } from './lock.mjs'
import { runDir } from './paths.mjs'
import { factIndex } from './plan.mjs'
import { historyNames, makeScanner } from './scan.mjs'
import { repoDirs } from './workspace.mjs'

const SIBLING = /^([A-Za-z0-9._-]+):(.+)$/

// Each fact id the verifiers ruled on, with the verdict the orchestrator recorded.
function readVerdicts(root) {
  const dir = join(runDir(root), 'verdicts')
  const out = new Map()
  const warnings = []
  if (!existsSync(dir)) return { verdicts: out, warnings }
  for (const name of readdirSync(dir).filter(n => n.endsWith('.jsonl'))) {
    const { items, bad } = readJsonl(join(dir, name))
    if (bad.length) warnings.push({ message: `verdicts/${name} line ${bad[0].line} could not be read, so its facts show as quoted only` })
    for (const v of items) if (v && typeof v.id === 'string') out.set(v.id, v.verdict)
  }
  return { verdicts: out, warnings }
}

// A quote cut to `max` code points, spaces normalized, with an ellipsis when cut.
export function cutQuote(quote, max) {
  const points = [...normalize(quote)]
  return points.length > max ? points.slice(0, max - 1).join('') + '…' : points.join('')
}

// The one line where a quote appears as it is, or null when it is absent or appears twice.
function lineOf(text, quote) {
  if (text === null) return null
  const at = text.indexOf(quote)
  if (at < 0 || text.indexOf(quote, at + 1) >= 0) return null
  return text.slice(0, at).split('\n').length
}

// What a finding is, without the text it matched.
const findingKind = message => message.replace(/^line \d+: /, '').split(':')[0]

export function entryEvidence(root, plan, catalog) {
  const dirs = repoDirs(root)
  const { verdicts, warnings } = readVerdicts(root)
  const scanners = new Map()
  const scannerOf = repo => {
    if (!scanners.has(repo)) {
      const dir = dirs[repo]
      scanners.set(repo, makeScanner({ catalog, authors: dir ? historyNames(dir) : [], allow: (dir && readLock(dir)?.settings?.scanAllow) || [] }))
    }
    return scanners.get(repo)
  }
  const ownerOf = (value, repo) => {
    const m = SIBLING.exec(value)
    return m && dirs[m[1]] ? { repo: m[1], path: m[2] } : { repo, path: value }
  }
  const labelOf = fact =>
    fact.corrects ? 'corrected' : catalog.verifiedKinds.includes(fact.kind) && verdicts.get(fact.id) === 'supported' ? 'verified' : 'quote'

  const rows = []
  for (const [repo, r] of Object.entries(plan.repos ?? {})) {
    const index = factIndex(root, repo)
    const order = [...index.keys()]
    for (const entry of (r.files ?? []).filter(f => f.action !== 'dropped' && typeof f.id === 'string')) {
      const facts = [...new Set(entry.facts ?? [])]
        .filter(id => index.has(id))
        .sort((a, b) => order.indexOf(a) - order.indexOf(b))
        .map(id => index.get(id))
        .filter(f => f.kind !== 'human' && (f.evidence ?? []).some(e => typeof e.quote === 'string' || typeof e.absence === 'string'))
      const head = { id: entry.id, repo, entry: entry.path }
      const quoted = f => (f.evidence ?? []).find(e => typeof e.path === 'string' && typeof e.quote === 'string')
      let withheld = null
      let row = null
      for (const tier of [f => catalog.verifiedKinds.includes(f.kind) && quoted(f), quoted]) {
        for (const f of facts) {
          const ev = tier(f)
          if (!ev || row) continue
          const at = ownerOf(ev.path, repo)
          const flagged = scannerOf(at.repo)(ev.quote, at.path).filter(x => x.severity !== 'warning')
          if (flagged.length) {
            withheld ??= { f, at, reason: [...new Set(flagged.map(x => findingKind(x.message)))].join(', ') }
            continue
          }
          const line = lineOf(dirs[at.repo] ? showHead(dirs[at.repo], at.path) : null, ev.quote)
          const quote = cutQuote(ev.quote, catalog.limits.gateQuoteChars)
          row = { ...head, fact: f.id, label: labelOf(f), claim: f.claim, path: ev.path, quote, more: facts.length - 1 }
          if (line) row.line = line
        }
        if (row) break
      }
      if (!row) {
        const f = facts.find(x => (x.evidence ?? []).some(e => typeof e.absence === 'string'))
        const ev = f?.evidence.find(e => typeof e.absence === 'string')
        if (ev) row = { ...head, fact: f.id, label: labelOf(f), claim: f.claim, absence: ev.absence, pathspec: ev.pathspec ?? '', more: facts.length - 1 }
      }
      if (!row && withheld) {
        row = { ...head, fact: withheld.f.id, label: labelOf(withheld.f), claim: withheld.f.claim, path: withheld.at.path, withheld: withheld.reason, more: facts.length - 1 }
      }
      if (!row) row = { ...head, evidence: null }
      row.text = gateLine(row)
      rows.push(row)
    }
  }
  return { rows, warnings }
}

// The line the P2 text shows for an entry, as the person reads it.
export function gateLine(row) {
  const lead = `${row.id} ${row.entry}`
  if (row.evidence === null) return `${lead}: no evidence`
  const more = row.more ? ` (+${row.more} more)` : ''
  if (row.absence !== undefined) return `${lead}: ${row.label} · no "${row.absence}" in ${row.pathspec || 'the repository'}${more}`
  const where = row.line ? `${row.path}:${row.line}` : row.path
  if (row.withheld) return `${lead}: ${row.label} · ${where} · quote withheld (${row.withheld})${more}`
  return `${lead}: ${row.label} · ${where} · "${row.quote}"${more}`
}
