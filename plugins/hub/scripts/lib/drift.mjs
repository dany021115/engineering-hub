import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { loadCatalog } from './catalog.mjs'
import { parseOptions, result, usage } from './cli.mjs'
import { git, hashObject, headCommit, revParse, showHead, topLevel } from './git.mjs'
import { nameMatcher } from './glob.mjs'
import { envNames, evidenceClass, isMarkdown } from './inventory.mjs'
import { readLock, relatedLocks, serializeLock } from './lock.mjs'
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

// Paths that a since..HEAD range changed, or null when the ref is not a commit here. A rename
// counts as its old path and its new one (DRI-4).
function changedSince(dir, ref) {
  if (!revParse(dir, `${ref}^{commit}`)) return null
  let r = git(dir, ['diff', '--name-only', '--no-renames', '-z', `${ref}...HEAD`], { allowFail: true })
  if (r.status !== 0) r = git(dir, ['diff', '--name-only', '--no-renames', '-z', `${ref}..HEAD`])
  return r.stdout.split('\0').filter(Boolean)
}

// A lock source key covers a path when it names it, or names a folder that holds it.
export const covers = (key, path) => key === path || (key.endsWith('/') && path.startsWith(key))

// What drift knows of one lock entry: gone, edited by hand, or citing sources that moved or that
// it cannot see. Shared with impact.
export function entryState(dir, path, entry) {
  const missing = !existsSync(join(dir, path))
  const edited = !missing && hashObject(dir, path) !== entry.hash
  const affected = []
  const unknown = []
  for (const [key, id] of Object.entries(entry.sources ?? {})) {
    const now = currentId(dir, key)
    if (now === 'unknown') unknown.push(key)
    else if (now !== id) affected.push(key)
  }
  return { missing, edited, affected, unknown }
}

// The related repos of a lock that are not on disk, each with what that leaves unchecked (DRI-3),
// and a warning for each related repo that could not be read.
function relatedReport(dir, lock, repo, related, warnings) {
  const absent = []
  for (const r of related) {
    if (r.problem) warnings.push({ repo, message: `${r.problem}, so it was skipped` })
    else if (!r.present) {
      const owned = Object.values(lock.files ?? {}).flatMap(e => Object.keys(e.sources ?? {})).filter(k => k.startsWith(`${r.name}:`)).length
      const what =
        r.name === lock.settings?.docsHome
          ? 'its pages that cite this repository were'
          : owned
            ? `${owned} source${owned === 1 ? '' : 's'} of this repository's generated files ${owned === 1 ? 'was' : 'were'}`
            : null
      if (!what) continue
      warnings.push({ repo, message: `${r.name} is not next to this repository, so ${what} not checked` })
      absent.push(`${r.name} is not checked out next to this repository; ${what} not checked`)
    }
  }
  return absent
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
    const report = { repo, dir, generator: lock.generator ?? null, installed, files: [], home: null, newEvidence: [], since: null }

    for (const [path, entry] of Object.entries(lock.files ?? {})) {
      const { missing, edited, affected, unknown } = entryState(dir, path, entry)
      if (missing || edited || affected.length || unknown.length) report.files.push({ path, kind: entry.kind, edited, missing, affected, unknown })
    }

    // DRI-1: a member also answers for the pages of its docs home that cite its files.
    const related = relatedLocks(dir, lock)
    const absent = relatedReport(dir, lock, repo, related, res.warnings)
    const home = related.find(r => r.name === lock.settings?.docsHome && r.present && !r.problem)
    const own = `${repo}:`
    const homeEntries = home?.lock
      ? Object.entries(home.lock.files ?? {}).filter(([, e]) => Object.keys(e.sources ?? {}).some(k => k.startsWith(own)))
      : []
    if (home && !home.lock) res.warnings.push({ repo, message: `the docs home ${home.name} has no .claude/hub.lock.json, so its pages were not checked` })
    if (home?.lock) {
      report.home = { repo: home.name, files: [] }
      for (const [path, entry] of homeEntries) {
        const keys = Object.keys(entry.sources).filter(k => k.startsWith(own))
        const { affected, unknown } = entryState(home.dir, path, { sources: Object.fromEntries(keys.map(k => [k, entry.sources[k]])) })
        if (affected.length || unknown.length) report.home.files.push({ path, affected, unknown })
      }
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
        const hits = key => !SIBLING.test(key) && changed.some(p => covers(key, p))
        // DRI-2: a page the range itself changes is updated, not left behind.
        report.since = Object.entries(lock.files ?? {})
          .filter(([, e]) => Object.keys(e.sources ?? {}).some(hits))
          .map(([path, e]) => ({ path, sources: Object.keys(e.sources).filter(hits), updated: changed.includes(path) }))
        const homeHits = key => key.startsWith(own) && changed.some(p => covers(key.slice(own.length), p))
        for (const [path, e] of homeEntries) {
          const keys = Object.keys(e.sources).filter(homeHits)
          if (keys.length) report.since.push({ repo: home.name, path, sources: keys })
        }
        report.changed = changed
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

    const homeFiles = report.home?.files ?? []
    const counts = ['edited', 'missing'].map(k => `${report.files.filter(f => f[k]).length} ${k}`)
    counts.push(`${report.files.filter(f => f.affected.length).length} affected`, `${report.files.filter(f => f.unknown.length).length} unknown`)
    if (homeFiles.length) counts.push(`${homeFiles.length} in ${report.home.repo}`)
    res.lines.push(report.files.length || homeFiles.length || report.newEvidence.length ? `${repo}: ${counts.join(', ')}` : `${repo}: up to date`)
    const stateOf = f => {
      const states = ['edited', 'missing'].filter(k => f[k])
      if (f.affected.length) states.push(`affected by ${f.affected.join(', ')}`)
      if (f.unknown.length) states.push(`unknown for ${f.unknown.join(', ')}`)
      return states.join('; ')
    }
    for (const f of report.files) res.lines.push(`  ${f.path}: ${stateOf(f)}`)
    for (const f of homeFiles) res.lines.push(`  ${report.home.repo}/${f.path}: ${stateOf(f)}`)
    for (const e of report.newEvidence) res.lines.push(`  new evidence: ${e.env ? `variable ${e.env} in ${e.path}` : `${e.class} ${e.path}`}`)
    if (values.annotate) {
      const marked =
        report.since ??
        (values.since
          ? []
          : [
              ...report.files.filter(f => f.affected.length).map(f => ({ path: f.path, sources: f.affected })),
              ...homeFiles.filter(f => f.affected.length).map(f => ({ repo: report.home.repo, path: f.path, sources: f.affected })),
            ])
      for (const m of marked) {
        if (m.repo) {
          // An annotation names a file of this repo: the changed file the home's page cites.
          const files = m.sources.map(k => k.slice(own.length)).flatMap(rel => (report.changed ? report.changed.filter(p => covers(rel, p)) : [rel]))
          for (const file of [...new Set(files)]) {
            res.lines.push(`::warning file=${file}::hub: ${m.repo}/${m.path} cites this file; run /hub:refresh from the workspace to update it`)
          }
        } else if (m.updated) {
          res.lines.push(`::notice file=${m.path}::hub: this range changes its sources (${m.sources.join(', ')}) and the page too; check that it still matches them`)
        } else res.lines.push(`::warning file=${m.path}::hub: its sources changed (${m.sources.join(', ')}); run /hub:refresh to update it`)
      }
      for (const note of absent) res.lines.push(`::notice::hub: ${note}`)
    }
    delete report.changed
  }
  return res
}
