import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { loadCatalog } from './catalog.mjs'
import { parseOptions, result, usage } from './cli.mjs'
import { git, hashObject, headCommit, revParse, showHead, topLevel } from './git.mjs'
import { nameMatcher } from './glob.mjs'
import { envNames, evidenceClass, isMarkdown } from './inventory.mjs'
import { readLock, serializeLock } from './lock.mjs'
import { lockPath } from './paths.mjs'
import { generatorName } from './start.mjs'

const SIBLING = /^([A-Za-z0-9._-]+):(.+)$/

// The object a lock source names in HEAD today: its own repo's, or a sibling's when that is on
// disk next to it, or 'unknown' when it is not.
export function currentId(dir, key) {
  const m = SIBLING.exec(key)
  const [owner, rel] = m ? [m[1], m[2]] : [null, key]
  let at = dir
  if (owner) {
    at = join(dirname(dir), owner)
    if (!existsSync(at) || topLevel(at) !== at) return 'unknown'
  }
  return revParse(at, `HEAD:${rel.replace(/\/+$/, '')}`)
}

// Paths that a since..HEAD range changed, or null when the ref is not a commit here.
function changedSince(dir, ref) {
  if (!revParse(dir, `${ref}^{commit}`)) return null
  let r = git(dir, ['diff', '--name-only', '-z', `${ref}...HEAD`], { allowFail: true })
  if (r.status !== 0) r = git(dir, ['diff', '--name-only', '-z', `${ref}..HEAD`])
  return r.stdout.split('\0').filter(Boolean)
}

// Paths added since the documented commit that the inventory would classify, and environment
// variable names the documented commit never had.
function newEvidence(dir, since, settings, isSensitive) {
  const out = []
  const parts = git(dir, ['diff', '--name-status', '-M', '-z', `${since}..HEAD`]).stdout.split('\0').filter(Boolean)
  const touched = []
  for (let i = 0; i < parts.length; ) {
    const status = parts[i]
    const path = parts[i + (status.startsWith('R') || status.startsWith('C') ? 2 : 1)]
    i += status.startsWith('R') || status.startsWith('C') ? 3 : 2
    if (status === 'D') continue
    touched.push(path)
    const kind = /^[ARC]/.test(status) && evidenceClass(path)
    if (kind) out.push({ path, class: kind })
  }
  const docsDir = settings?.docsDir ?? 'docs'
  const seen = new Set()
  for (const path of touched) {
    if (isMarkdown(path) || isSensitive(path) || path.startsWith(docsDir + '/')) continue
    const text = showHead(dir, path)
    if (text === null) continue
    for (const name of envNames(path, text)) {
      if (seen.has(name)) continue
      seen.add(name)
      const before = git(dir, ['grep', '-q', '-F', '-w', '-e', name, since], { allowFail: true })
      if (before.status === 1) out.push({ path, env: name })
    }
  }
  return out
}

// Design 15.7.71: only `documentedCommit` changes, byte for byte the rest of the lock stays.
function advance(dir, lock, head) {
  const file = lockPath(dir)
  const text = readFileSync(file, 'utf8')
  const field = /("documentedCommit"\s*:\s*)"[^"]*"/
  writeFileSync(file, field.test(text) ? text.replace(field, `$1"${head}"`) : serializeLock({ ...lock, documentedCommit: head }))
}

// `drift --repo <dir>... [--since <ref>] [--annotate] [--advance]` (design 8): reports and exits 0
// whatever it finds; 2 only for usage or environment. It writes only with --advance, and then only
// `documentedCommit`, when no file is affected.
export default function drift(argv) {
  const { values } = parseOptions(argv, {
    repo: { type: 'string', multiple: true },
    since: { type: 'string' },
    annotate: { type: 'boolean' },
    advance: { type: 'boolean' },
  })
  if (!values.repo?.length) throw usage('usage: hub.mjs drift --repo <dir>... [--since <ref>] [--annotate] [--advance] [--json]')
  const isSensitive = nameMatcher(loadCatalog().sensitiveFiles)
  const installed = generatorName()
  const res = result()
  res.data.repos = []
  for (const arg of values.repo) {
    const dir = topLevel(resolve(arg))
    if (!dir) throw usage(`${arg} is not inside a git repository`)
    const lock = readLock(dir)
    if (!lock) throw usage(`${arg} has no .claude/hub.lock.json: run /hub:init first`)
    const repo = basename(dir)
    const report = { repo, dir, generator: lock.generator ?? null, installed, files: [], newEvidence: [], since: null }

    for (const [path, entry] of Object.entries(lock.files ?? {})) {
      const missing = !existsSync(join(dir, path))
      const edited = !missing && hashObject(dir, path) !== entry.hash
      const affected = []
      const unknown = []
      for (const [key, id] of Object.entries(entry.sources ?? {})) {
        const now = currentId(dir, key)
        if (now === 'unknown') unknown.push(key)
        else if (now !== id) affected.push(key)
      }
      if (missing || edited || affected.length || unknown.length) report.files.push({ path, kind: entry.kind, edited, missing, affected, unknown })
    }

    const documented = lock.documentedCommit
    if (documented && revParse(dir, `${documented}^{commit}`)) {
      report.newEvidence = newEvidence(dir, documented, lock.settings, isSensitive)
    } else {
      res.warnings.push({ repo, message: `documentedCommit ${documented ?? '(none)'} is not in this clone, so new evidence is skipped (fetch the full history to see it)` })
    }

    if (report.generator !== installed) {
      res.warnings.push({ repo, message: `generated by ${report.generator ?? 'an unknown version'}, installed ${installed}: run /hub:init to regenerate` })
    }

    if (values.since) {
      const changed = changedSince(dir, values.since)
      if (!changed) res.warnings.push({ repo, message: `--since ${values.since} is not a commit in this clone; nothing to compare` })
      else {
        const hits = key => !SIBLING.test(key) && changed.some(p => p === key || (key.endsWith('/') && p.startsWith(key)))
        report.since = Object.entries(lock.files ?? {})
          .filter(([, e]) => Object.keys(e.sources ?? {}).some(hits))
          .map(([path, e]) => ({ path, sources: Object.keys(e.sources).filter(hits) }))
      }
    }
    if (values.advance) {
      const affected = report.files.filter(f => f.affected.length).length
      const head = headCommit(dir)
      report.advanced = !affected && lock.documentedCommit !== head
      if (affected) res.warnings.push({ repo, message: `${affected} generated files are affected, so documentedCommit stays; run /hub:refresh` })
      else if (report.advanced) {
        advance(dir, lock, head)
        res.lines.push(`${repo}: documentedCommit moved to ${head}`)
      }
    }
    res.data.repos.push(report)

    const counts = ['edited', 'missing'].map(k => `${report.files.filter(f => f[k]).length} ${k}`)
    counts.push(`${report.files.filter(f => f.affected.length).length} affected`, `${report.files.filter(f => f.unknown.length).length} unknown`)
    res.lines.push(report.files.length || report.newEvidence.length ? `${repo}: ${counts.join(', ')}` : `${repo}: up to date`)
    for (const f of report.files) {
      const states = ['edited', 'missing'].filter(k => f[k])
      if (f.affected.length) states.push(`affected by ${f.affected.join(', ')}`)
      if (f.unknown.length) states.push(`unknown for ${f.unknown.join(', ')}`)
      res.lines.push(`  ${f.path}: ${states.join('; ')}`)
    }
    for (const e of report.newEvidence) res.lines.push(`  new evidence: ${e.env ? `variable ${e.env} in ${e.path}` : `${e.class} ${e.path}`}`)
    if (values.annotate) {
      const marked = report.since ?? (values.since ? [] : report.files.filter(f => f.affected.length).map(f => ({ path: f.path, sources: f.affected })))
      for (const m of marked) res.lines.push(`::warning file=${m.path}::hub: its sources changed (${m.sources.join(', ')}); run /hub:refresh to update it`)
    }
  }
  return res
}
