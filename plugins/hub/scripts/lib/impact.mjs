// `impact` (IMP-1..5): before a change, what the generated docs and skills say about the files it
// will touch, what to read first and what to run. It only reads; drift says what moved afterwards.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { generatorDir } from './catalog.mjs'
import { parseOptions, result, usage } from './cli.mjs'
import { covers, entryState } from './drift.mjs'
import { lsFiles, statusZ, topLevel } from './git.mjs'
import { codeOwnersPath, evidenceClass } from './inventory.mjs'
import { readLock, relatedLocks } from './lock.mjs'
import { classify, headings, splitFrontmatter } from './markdown.mjs'
import { isWorkspaceRoot, repoDirs } from './workspace.mjs'

const SIBLING = /^([A-Za-z0-9._-]+):(.+)$/
// The sections that say what to read or respect before a change, as the skeletons name them.
const READ_FIRST = ['Guardrails', 'Changes that cross repos', 'Before you change it', 'Before you begin', 'Rules', 'Safe path']
const VERIFY = 'Verify like CI'

// The read-first headings that some skeleton still has, so a renamed section fails a test.
export function readFirstHeadings() {
  const dir = join(generatorDir(), 'skeletons')
  const found = new Set()
  for (const name of readdirSync(dir).filter(n => n.endsWith('.md'))) {
    const text = readFileSync(join(dir, name), 'utf8')
    for (const h of headings(classify(splitFrontmatter(text).body))) if (h.level === 2) found.add(h.text.trim())
  }
  return READ_FIRST.filter(h => found.has(h))
}

// The level-2 headings of a generated file, and the lines of one section.
function sectionsOf(text) {
  const fm = splitFrontmatter(text)
  const lines = classify(fm.body, fm.offset)
  const all = text.split('\n')
  const heads = headings(lines).filter(h => h.level === 2)
  const body = name => {
    const at = heads.findIndex(h => h.text.trim() === name)
    if (at < 0) return null
    const end = heads[at + 1]?.n ?? all.length + 1
    return all.slice(heads[at].n, end - 1).filter(l => l.trim())
  }
  return { names: heads.map(h => h.text.trim()), body }
}

// Paths the working tree changed: modified, added, deleted, renamed (both names) and untracked.
function changedPaths(dir) {
  const parts = statusZ(dir).toString('utf8').split('\0')
  const out = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    out.push(entry.slice(3))
    if (/[RC]/.test(entry.slice(0, 2))) out.push(parts[++i])
  }
  return [...new Set(out.filter(Boolean))]
}

const stateOf = s => (s.missing ? 'missing' : s.edited || s.affected.length ? 'may be out of date' : s.unknown.length ? 'unknown' : 'up to date')

function fileItem(owner, dir, lock, path, entry, readable) {
  const item = { repo: owner, path, kind: entry.kind, state: stateOf(entryState(dir, path, entry)), read: [] }
  if (entry.type) item.type = entry.type
  if (entry.archetype) item.archetype = entry.archetype
  const file = join(dir, path)
  if (!existsSync(file)) return item
  if ((lock.settings?.language ?? 'en') !== 'en') item.read = [path]
  else {
    const { names } = sectionsOf(readFileSync(file, 'utf8'))
    item.read = readable.filter(h => names.includes(h)).map(h => `${path}#${h}`)
  }
  return item
}

export default function impact(argv) {
  const { values } = parseOptions(argv, { repo: { type: 'string' }, paths: { type: 'string', multiple: true } })
  if (!values.repo) throw usage('usage: hub.mjs impact --repo <dir> [--paths <path>...] [--json]')
  let given = (values.paths ?? []).map(p => p.replace(/^\.\//, ''))
  let dir = topLevel(resolve(values.repo))
  const asked = resolve(values.repo)
  // From a workspace root, `<repo>/<path>` names a repo of the workspace.
  if (!dir || (dir !== asked && isWorkspaceRoot(asked))) {
    if (!isWorkspaceRoot(asked)) throw usage(`${values.repo} is not inside a git repository`)
    const dirs = repoDirs(asked)
    const owners = [...new Set(given.map(p => p.split('/')[0]))]
    if (owners.length !== 1 || !dirs[owners[0]]) throw usage('from a workspace root, give paths as <repo>/<path>, all in one repository')
    dir = dirs[owners[0]]
    given = given.map(p => p.slice(owners[0].length + 1))
  }
  const lock = readLock(dir)
  if (!lock) throw usage(`${values.repo} has no .claude/hub.lock.json: run /hub:init first`)
  const repo = basename(dir)
  const res = result()
  const paths = given.length ? given : changedPaths(dir)
  const readable = readFirstHeadings()

  // The generated files that cite each path: this lock's own, and in a workspace the related
  // locks' entries whose `<repo>:<path>` keys name this repo (IMP-2, IMP-3).
  const related = relatedLocks(dir, lock)
  const absent = []
  for (const r of related) {
    if (r.problem) res.warnings.push({ repo, message: `${r.problem}, so it was skipped` })
    else if (!r.present) {
      const message = `${r.name} is not next to this repository, so its generated files were not checked`
      res.warnings.push({ repo, message })
      absent.push(message)
    }
  }
  const reports = paths.map(path => {
    const files = []
    for (const [p, entry] of Object.entries(lock.files ?? {})) {
      if (Object.keys(entry.sources ?? {}).some(k => !SIBLING.test(k) && covers(k, path))) files.push(fileItem(repo, dir, lock, p, entry, readable))
    }
    for (const r of related.filter(x => x.present && x.lock)) {
      for (const [p, entry] of Object.entries(r.lock.files ?? {})) {
        const cites = Object.keys(entry.sources ?? {}).some(k => k.startsWith(`${repo}:`) && covers(k.slice(repo.length + 1), path))
        if (cites) files.push(fileItem(r.name, r.dir, r.lock, p, entry, readable))
      }
    }
    return { path, covered: files.length > 0, generated: Boolean(lock.files?.[path]), files }
  })

  // What to run (IMP-4): the working-in skill's Verify like CI lines as written, else the CI files.
  const verify = []
  let verifyFrom = null
  const working = Object.entries(lock.files ?? {}).find(([, e]) => e.archetype === 'working-in')
  const workingFile = working && join(dir, working[0])
  if (working && existsSync(workingFile)) {
    verifyFrom = working[0]
    const edited = entryState(dir, working[0], working[1]).edited
    for (const line of sectionsOf(readFileSync(workingFile, 'utf8')).body(VERIFY) ?? []) {
      verify.push(edited ? `${line} (edited by hand since it was generated)` : line)
    }
  } else {
    verifyFrom = 'CI workflows'
    verify.push(...lsFiles(dir).filter(p => evidenceClass(p) === 'ci'))
  }
  if (reports.some(r => r.generated)) verify.push('hub.mjs check --lock .claude/hub.lock.json')
  const notCovered = working ? 'not covered: run the full Verify like CI set' : 'not covered: run every CI workflow'
  const owners = codeOwnersPath(lsFiles(dir))

  res.data = { repo, paths: reports, verify, verifyFrom, owners }
  const describe = f => `${f.path} (${[f.kind, f.type ?? f.archetype].filter(Boolean).join(', ')}): ${f.state}`
  for (const r of reports) {
    res.lines.push(r.path)
    for (const f of r.files) {
      res.lines.push(f.repo === repo ? `  ${describe(f)}` : `  a generated file of ${f.repo} cites this file: ${f.repo}/${describe(f)}`)
      if (f.read.length) res.lines.push(`    read: ${f.read.join(', ')}`)
    }
    if (!r.covered) res.lines.push(`  ${notCovered}`)
  }
  for (const message of absent) res.lines.push(`unknown: ${message}`)
  if (verify.length) {
    res.lines.push(`verify (from ${verifyFrom}):`)
    for (const line of verify) res.lines.push(`  ${line}`)
  }
  if (owners) res.lines.push(`owners: see ${owners}`)
  return res
}
