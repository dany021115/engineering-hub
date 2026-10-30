import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ground } from './grounding.mjs'
import { git, hashObject, lsFiles } from './git.mjs'
import { lintDoc } from './lint-docs.mjs'
import { lintSkill } from './lint-skills.mjs'
import { isRepoName, readLock, relatedRepos } from './lock.mjs'
import { proposalFile, stagingFile } from './paths.mjs'
import { countSupported, factIndex, matchPage } from './plan.mjs'
import { historyNames, makeScanner } from './scan.mjs'
import { isWorkspaceRoot, repoDirs } from './workspace.mjs'

// The per-file gates, shared by `check` and `place`; `<gate>` of a `gate:<gate>` drop.
export const GATES = ['skills', 'docs', 'scan', 'grounding', 'validate', 'facts']

const SKILL_PATH = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/
const DOC = /\.mdx?$/i

export const readText = file => readFileSync(file, 'utf8')

function diskSkills(dir) {
  const base = join(dir, '.claude', 'skills')
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(base, d.name, 'SKILL.md')))
    .map(d => d.name)
}

function makeExists(set) {
  return p => {
    const clean = p.replace(/^\.\//, '')
    if (clean.startsWith('/')) return false
    if (clean.endsWith('/')) {
      for (const x of set) if (x.startsWith(clean)) return true
      return false
    }
    return set.has(clean)
  }
}

// What every gate needs to know about the repos of a run: the tree each one sees (design 15.1.12,
// 15.7.75: tracked files, live plan paths and lock keys, never `sources`) and how to read it.
// Design 15.8.163: the repos whose code a file may cite are those named (the plan's and its
// workspace's, or the lock's repo), each with the workspace its lock or its home's lock lists.
// The other projects that share the folder never count.
function citable(dirs, names) {
  const out = new Set()
  for (const name of names.filter(n => dirs[n])) {
    out.add(name)
    const lock = readLock(dirs[name])
    const home = lock?.settings?.docsHome
    const homeLock = home && dirs[home] ? readLock(dirs[home]) : null
    for (const n of lock?.workspace?.repos ?? homeLock?.workspace?.repos ?? (home ? [home] : [])) if (dirs[n]) out.add(n)
  }
  return [...out]
}

export function treeState(root, { plan = null, catalog, language, mode, repo = null }) {
  const dirs = repoDirs(root)
  const named = plan ? [...Object.keys(plan.repos ?? {}), ...(plan.workspace?.repos ?? [])] : repo ? [repo] : Object.keys(dirs)
  const scope = citable(dirs, named)
  // DRI-5: the repos these locks relate to that are not checked out next to them, as in CI.
  const relatedOf = name => {
    try {
      return relatedRepos(readLock(dirs[name]), name)
    } catch {
      return []
    }
  }
  const absent = [...new Set(named.filter(n => dirs[n]).flatMap(relatedOf))].filter(n => isRepoName(n) && !dirs[n])
  const repos = {}
  const view = name => {
    if (repos[name]) return repos[name]
    const dir = dirs[name]
    if (!dir) return null
    const r = plan?.repos?.[name] ?? null
    const lock = readLock(dir)
    const entries = r?.files ?? []
    const live = entries.filter(f => f.action !== 'dropped')
    const existing = new Set(lsFiles(dir))
    for (const f of live) if (typeof f.path === 'string') existing[f.action === 'delete' ? 'delete' : 'add'](f.path)
    for (const key of Object.keys(lock?.files ?? {})) if (!live.some(f => f.action === 'delete' && f.path === key)) existing.add(key)
    // Design 15.8.167: the lock exists for the gates once there is one or the plan will write one.
    if (lock || r) existing.add('.claude/hub.lock.json')
    // Where each live planned file is read from: staging, or the proposal over a lock file.
    const overlay = new Map()
    for (const f of live) {
      if (['create', 'update'].includes(f.action)) overlay.set(f.path, stagingFile(root, name, f.path))
      else if (f.action === 'propose' && lock?.files?.[f.path]) overlay.set(f.path, proposalFile(root, name, f.id))
    }
    const docsDir = r?.docsDir ?? lock?.settings?.docsDir ?? 'docs'
    repos[name] = { name, dir, lock, docsDir, entries, live, existing, overlay, exists: makeExists(existing) }
    return repos[name]
  }
  const state = { root, dirs, scope, absent, plan, catalog, language, mode, view, grep: new Map(), scanners: new Map() }
  // The absent related repo a `<repo>/<path>` lives in, which no gate can check.
  state.unchecked = p => {
    const [first, ...rest] = p.split('/')
    return rest.length && absent.includes(first) ? first : null
  }
  // After the plan drops an entry, the next view of each repo reads it again; the caches stay.
  state.reset = () => {
    for (const name of Object.keys(repos)) delete repos[name]
  }
  state.exists = (repo, p) => {
    const own = view(repo)
    if (own.exists(p)) return true
    // A workspace page writes `<repo>/<path>`, its own repo's included.
    const [first, ...rest] = p.split('/')
    const named = rest.length && scope.includes(first) ? view(first) : null
    return Boolean(named && named.exists(rest.join('/')))
  }
  state.readDoc = (repo, p) => {
    const v = view(repo)
    const file = v.overlay.get(p) ?? join(v.dir, p)
    return existsSync(file) ? readText(file) : null
  }
  state.scanner = repo => {
    if (!state.scanners.has(repo)) {
      const v = view(repo)
      state.scanners.set(repo, makeScanner({ catalog, authors: historyNames(v.dir), allow: v.lock?.settings?.scanAllow ?? [] }))
    }
    return state.scanners.get(repo)
  }
  return state
}

// A lock's repo sits alone or in a workspace folder with its siblings.
export function lockRoot(dir) {
  const parent = dirname(dir)
  return isWorkspaceRoot(parent) && repoDirs(parent)[basename(dir)] === dir ? parent : dir
}

// The skill names a target may not take: another repo's skill on disk or in the plan.
export function skillOwners(state) {
  const owners = new Map()
  const add = (name, owner) => {
    if (!owners.has(name)) owners.set(name, [])
    owners.get(name).push(owner)
  }
  for (const [repo, dir] of Object.entries(state.dirs)) {
    for (const name of diskSkills(dir)) add(name, { repo, where: join(dir, '.claude', 'skills', name, 'SKILL.md') })
  }
  for (const repo of Object.keys(state.plan?.repos ?? {})) {
    for (const f of state.view(repo).live) {
      const m = SKILL_PATH.exec(f.path ?? '')
      if (m && ['create', 'update'].includes(f.action)) add(m[1], { repo, where: `${repo}:${f.path} (planned)` })
    }
  }
  return owners
}

// Targets past caps.skillsPerRepo, counting the plan's skills first and then the lock's others.
export function overCap(state, repo, targets) {
  const v = state.view(repo)
  const planned = v.live.filter(f => ['create', 'update', 'propose'].includes(f.action) && SKILL_PATH.test(f.path ?? ''))
  const paths = planned.map(f => f.path)
  for (const [key, e] of Object.entries(v.lock?.files ?? {})) {
    if (e.kind === 'skill' && !paths.includes(key) && !v.live.some(f => f.action === 'delete' && f.path === key)) paths.push(key)
  }
  const cap = state.catalog.caps.skillsPerRepo
  const over = new Set(paths.slice(cap))
  for (const t of targets) if (over.has(t.path)) t.overCap = paths.length
}

export function fileGates(target, state, extra = {}) {
  const { catalog, language, mode } = state
  const v = state.view(target.repo)
  const out = []
  if (!existsSync(target.file)) {
    out.push({ gate: target.kind === 'skill' ? 'skills' : 'docs', message: `nothing written for it at ${target.file}` })
    return out
  }
  const text = readText(target.file)
  const lintable = !target.edited && ['skill', 'page'].includes(target.kind)
  if (lintable && target.kind === 'skill') {
    const folder = SKILL_PATH.exec(target.path)?.[1] ?? basename(dirname(target.path))
    out.push(
      ...lintSkill(text, {
        folder,
        catalog,
        archetype: target.archetype ?? null,
        sections: language === 'en',
        exists: p => state.exists(target.repo, p),
        unchecked: p => state.unchecked(p),
      }),
    )
    const others = (extra.owners?.get(folder) ?? []).filter(o => o.repo !== target.repo)
    for (const o of others) out.push({ gate: 'skills', message: `skill name ${folder} is also used by ${o.where}` })
    if (target.overCap) {
      out.push({ gate: 'skills', message: `${target.overCap} skills in ${target.repo}, over caps.skillsPerRepo (${catalog.caps.skillsPerRepo})` })
    }
  }
  if (lintable && target.kind === 'page' && DOC.test(target.path)) {
    const prefix = v.docsDir === '.' ? '' : `${v.docsDir}/`
    const spec = target.path.startsWith(prefix) ? (matchPage(catalog, target.path.slice(prefix.length))?.spec ?? null) : null
    out.push(
      ...lintDoc(text, {
        path: target.path,
        docsDir: v.docsDir,
        spec,
        catalog,
        language,
        exists: p => state.exists(target.repo, p),
        readDoc: p => state.readDoc(target.repo, p),
      }),
    )
  }
  out.push(...state.scanner(target.repo)(text, target.path))
  if (lintable) {
    const repos = [v, ...state.scope.filter(n => n !== target.repo).map(state.view)]
    out.push(
      ...ground(text, {
        catalog,
        paths: target.kind === 'page',
        exists: p => state.exists(target.repo, p),
        repos: repos.map(r => ({ dir: r.dir, docsDir: r.docsDir })),
        names: state.scope,
        absent: state.absent,
        cache: state.grep,
      }),
    )
  }
  if (mode === 'plan') out.push(...factsGate(target, state))
  return out
}

// Design 15.8.112: the writer's fact ids are supported or human facts, and a skill keeps its minFacts.
function factsGate(target, state) {
  const f = target.entry
  if (!f || !Array.isArray(f.facts)) return []
  state.facts ??= new Map()
  if (!state.facts.has(target.repo)) state.facts.set(target.repo, factIndex(state.root, target.repo))
  const facts = state.facts.get(target.repo)
  const out = []
  for (const id of f.facts) {
    if (!facts.has(id)) out.push({ gate: 'facts', message: `fact ${id} is not a supported fact of facts/${target.repo}.checked.jsonl` })
  }
  const spec = target.kind === 'skill' && ['create', 'update'].includes(f.action) ? state.catalog.skills[f.archetype] : null
  if (spec) {
    const { count, ignored } = countSupported(state.catalog, spec, f.facts, facts)
    if (count < spec.minFacts) {
      const note = ignored.length ? `; ${ignored.join(', ')} only cite linter or formatter config` : ''
      out.push({ gate: 'facts', message: `${count} supported facts, below minFacts ${spec.minFacts} for ${f.archetype}${note}` })
    }
  }
  return out
}

// The files a plan's gates look at, in the repo with out/ overlaid (design 15.1.13, 15.8.106).
export function planTargets(state, repo) {
  const v = state.view(repo)
  const targets = []
  for (const f of v.live) {
    const file = v.overlay.get(f.path)
    if (!file || (f.action === 'propose' && !v.lock?.files?.[f.path])) continue
    const lockEntry = v.lock?.files?.[f.path]
    const kind = f.action === 'propose' ? lockEntry.kind : f.kind
    const archetype = f.action === 'propose' ? lockEntry.archetype : f.archetype
    targets.push({ repo, id: f.id, path: f.path, file, entry: f, kind, archetype, edited: false })
  }
  return targets
}

export function lockTargets(state, repo) {
  const v = state.view(repo)
  return Object.entries(v.lock?.files ?? {})
    .filter(([p]) => existsSync(join(v.dir, p)))
    .map(([p, entry]) => ({
      repo,
      path: p,
      file: join(v.dir, p),
      entry,
      kind: entry.kind,
      archetype: entry.archetype,
      edited: hashObject(v.dir, p) !== entry.hash,
    }))
}

