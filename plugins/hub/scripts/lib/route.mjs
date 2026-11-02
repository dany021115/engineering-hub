// `route` (RUT-1..6): the stops of a route through one repo, in an order the code fixes, each saying
// whether it still holds. It only reads; /hub:learn walks it with the person.
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { parseOptions, result, usage } from './cli.mjs'
import { entryState } from './drift.mjs'
import { lsFiles, topLevel } from './git.mjs'
import { looksLikeIdentifier } from './grounding.mjs'
import { sectionsOf } from './impact.mjs'
import { readLock, relatedLocks } from './lock.mjs'
import { classify, codeSpans, headings, isPathLike, isPlaceholder, splitFrontmatter } from './markdown.mjs'
import { runState } from './run.mjs'
import { isWorkspaceRoot, repoDirs } from './workspace.mjs'

const SIBLING = /^[A-Za-z0-9._-]+:/
const TYPE_ORDER = ['reference', 'overview', 'how-to', 'explanation']
const VERIFY = 'Verify like CI'
const START = 'Where to start'

// The repo `--repo` names, and its lock; a subfolder is that repo, a workspace root is not one.
export function lockedRepo(value) {
  const asked = resolve(value)
  const dir = existsSync(asked) ? topLevel(asked) : null
  if (!dir) {
    const repos = existsSync(asked) && isWorkspaceRoot(asked) ? Object.keys(repoDirs(asked)) : []
    throw usage(repos.length ? `this folder holds several repositories (${repos.join(', ')}): give one with --repo` : `${value} is not inside a git repository`)
  }
  const lock = readLock(dir)
  if (!lock) throw usage(`${value} has no .claude/hub.lock.json: run /hub:init first`)
  return { dir, lock, repo: basename(dir) }
}

// Whether a source key falls under an area: the key is the area, is inside it, or is a folder
// that holds it. Keys of other repos never do.
export function underArea(keys, area) {
  const a = area.replace(/^\.\//, '').replace(/\/+$/, '')
  return keys.some(k => !SIBLING.test(k) && (k === a || k.startsWith(`${a}/`) || (k.endsWith('/') && a.startsWith(k))))
}

// What a lock entry's state means for someone about to rely on it.
export function freshnessOf(dir, path, entry) {
  const s = entryState(dir, path, entry)
  if (s.missing) return { freshness: 'missing' }
  if (s.edited) return { freshness: 'edited by hand' }
  if (s.affected.length) return { freshness: 'sources changed', changed: s.affected }
  if (s.unknown.length) return { freshness: 'sources not checked' }
  return { freshness: 'unchanged' }
}

// The spans of a page's prose that the grounding gate checks: paths and identifiers.
export const checkedSpan = span => !isPlaceholder(span) && (isPathLike(span) || looksLikeIdentifier(span))

function citesOf(text) {
  const fm = splitFrontmatter(text)
  const prose = classify(fm.body, fm.offset).filter(l => l.kind === 'prose')
  return { prose, cites: [...new Set(prose.flatMap(l => codeSpans(l.text)).filter(checkedSpan))] }
}

function pageStop(owner, dir, stage, path, entry) {
  const stop = { stage, kind: 'page', repo: owner, path, type: entry.type ?? null, headings: [], cites: [], ...freshnessOf(dir, path, entry) }
  if (stop.freshness === 'missing') return stop
  const { prose, cites } = citesOf(readFileSync(join(dir, path), 'utf8'))
  stop.headings = headings(prose).filter(h => h.level === 2).map(h => h.text.trim())
  stop.cites = cites
  return stop
}

// The pages and files a "Where to start" section names, links and backticked paths, as they appear.
function startItems(lines, index, isPage, inRepo) {
  const out = []
  for (const line of lines) {
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)[^)]*\)|`([^`]+)`/g)) {
      if (m[1]) {
        if (/^[a-z][a-z0-9+.-]*:|^\/|^#/i.test(m[1])) continue
        const path = posix.normalize(posix.join(posix.dirname(index), m[1].split('#')[0]))
        if (isPage(path)) out.push({ kind: 'page', path })
      } else if (isPage(m[2])) out.push({ kind: 'page', path: m[2] })
      else if (inRepo(m[2])) out.push({ kind: 'file', path: m[2] })
    }
  }
  return out
}

export default function route(argv) {
  const { values } = parseOptions(argv, { repo: { type: 'string' }, area: { type: 'string' } })
  if (!values.repo) throw usage('usage: hub.mjs route --repo <dir> [--area <path>] [--json]')
  const { dir, lock, repo } = lockedRepo(values.repo)
  const res = result()
  const files = lock.files ?? {}
  const docs = lock.settings?.docsDir ?? 'docs'
  const inDocs = rel => posix.join(docs, rel)
  const isPage = path => Object.hasOwn(files, path) && files[path].kind === 'page'
  const tracked = lsFiles(dir)
  const inRepo = span => {
    const p = span.replace(/\/$/, '')
    return tracked.includes(p) || tracked.some(t => t.startsWith(`${p}/`))
  }

  const stops = []
  const used = new Set()
  const addPage = (stage, path) => {
    if (used.has(path) || !isPage(path)) return
    used.add(path)
    stops.push(pageStop(repo, dir, stage, path, files[path]))
  }

  // run: how to run it comes first; without those pages, what the working-in skill says.
  const RUN = ['how-to/run-locally.md', 'how-to/run-tests.md'].map(inDocs)
  for (const path of RUN) addPage('run', path)
  if (!stops.length) {
    const working = Object.entries(files).find(([, e]) => e.archetype === 'working-in')
    const state = working && freshnessOf(dir, working[0], working[1])
    const verify = state && state.freshness !== 'missing' ? (sectionsOf(readFileSync(join(dir, working[0]), 'utf8')).body(VERIFY) ?? []) : []
    if (verify.length) stops.push({ stage: 'run', kind: 'skill', repo, path: working[0], verify, ...state })
    else res.warnings.push({ repo, message: 'no page or skill says how to run this repository' })
  }

  // start: the index, then what its list names.
  const index = inDocs('index.md')
  addPage('start', index)
  const named = isPage(index) && existsSync(join(dir, index)) && stops.at(-1)?.freshness !== 'missing' ? sectionsOf(readFileSync(join(dir, index), 'utf8')).body(START) : null
  if (!named) res.warnings.push({ repo, message: `no "${START}" section, so the pages are ordered by type` })
  for (const item of startItems(named ?? [], index, isPage, inRepo)) {
    if (item.kind === 'page') addPage('start', item.path)
    else if (!used.has(item.path)) {
      used.add(item.path)
      stops.push({ stage: 'start', kind: 'file', repo, path: item.path })
    }
  }

  // first-change, concepts, then what is left, by type.
  const pages = Object.keys(files).filter(isPage).sort()
  const typeOf = path => files[path].type
  const release = inDocs('how-to/release.md')
  const first = pages.find(p => typeOf(p) === 'how-to' && !used.has(p) && p !== release)
  if (first) addPage('first-change', first)
  for (const p of pages.filter(x => typeOf(x) === 'explanation')) addPage('concepts', p)
  const rank = p => (TYPE_ORDER.indexOf(typeOf(p)) + 1 || TYPE_ORDER.length + 1)
  for (const p of pages.slice().sort((a, b) => rank(a) - rank(b))) addPage('more', p)

  // across: the related repos' pages that cite this one.
  const keysOf = new Map()
  for (const r of relatedLocks(dir, lock)) {
    if (r.problem) res.warnings.push({ repo, message: `${r.problem}, so it was skipped` })
    else if (!r.present) res.warnings.push({ repo, message: `${r.name} is not next to this repository, so its pages were not listed` })
    for (const [path, entry] of Object.entries(r.lock?.files ?? {})) {
      const own = Object.keys(entry.sources ?? {}).filter(k => k.startsWith(`${repo}:`)).map(k => k.slice(repo.length + 1))
      if (entry.kind !== 'page' || !own.length) continue
      const stop = pageStop(r.name, r.dir, 'across', path, entry)
      keysOf.set(stop, own)
      stops.push(stop)
    }
  }

  // RUT-6: pages an open run may still change.
  if ([dir, dirname(dir)].some(d => { const s = runState(d); return s.exists && !s.done })) {
    res.warnings.push({ repo, message: 'a run is not finished here, so the pages may change' })
  }

  let kept = stops
  if (values.area !== undefined) {
    const area = values.area.replace(/^\.\//, '').replace(/\/+$/, '')
    kept = stops.filter(s => {
      if (s.kind === 'file') return s.path.replace(/\/$/, '') === area || s.path.startsWith(`${area}/`) || area.startsWith(s.path)
      return underArea(keysOf.get(s) ?? Object.keys(files[s.path]?.sources ?? {}), area)
    })
    if (!kept.length) res.warnings.push({ repo, message: `no stop under ${values.area}` })
  }

  const numbered = kept.map((s, i) => ({ n: i + 1, ...s }))
  res.data = { repo, stops: numbered }
  for (const s of numbered) {
    const where = s.repo === repo ? s.path : `${s.repo}/${s.path}`
    const state = s.freshness ? `: ${s.freshness}${s.changed ? ` (${s.changed.join(', ')})` : ''}` : ''
    res.lines.push(`${s.n}. ${s.stage}: ${where}${s.type ? ` (${s.type})` : ''}${state}`)
    for (const line of s.verify ?? []) res.lines.push(`   ${line}`)
  }
  return res
}
