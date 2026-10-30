import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { generatorVersion, loadCatalog } from './catalog.mjs'
import { HubError, parseOptions, result, usage } from './cli.mjs'
import { confinement } from './confine.mjs'
import { git, hashObject } from './git.mjs'
import { currentId } from './drift.mjs'
import { readLock, sourcesFromFacts, writeLock } from './lock.mjs'
import { isSettingsPatch, mergePatch, settingsText } from './offers.mjs'
import { proposalFile } from './paths.mjs'
import { factIndex, loadPlanFile } from './plan.mjs'
import { placedFile, refuseUnless } from './place.mjs'
import { readJson } from './run.mjs'
import { historyNames, makeScanner } from './scan.mjs'
import { isWorkspaceRoot, repoDirs } from './workspace.mjs'

const ids = value => (value ?? '').split(/[\s,]+/).filter(Boolean)
const BUILT = /^([A-Za-z0-9_-][A-Za-z0-9._-]*)\/(node_modules|build|\.docusaurus)$/

function removeEmptyParents(dir, file) {
  let d = dirname(file)
  while (d.startsWith(dir + '/') && existsSync(d) && !readdirSync(d).length) {
    rmdirSync(d)
    d = dirname(d)
  }
}

function restore(dir, path, blob) {
  const abs = join(dir, path)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, git(dir, ['cat-file', 'blob', blob], { raw: true }).stdout)
}

// Design 15.8.172: a refresh updates what an init added.
function commitMessage(dir, what, verb) {
  const subjects = git(dir, ['log', '-n', '20', '--format=%s'], { allowFail: true }).stdout?.split('\n').filter(Boolean) ?? []
  const styled = re => subjects.length && subjects.filter(s => re.test(s)).length * 2 >= subjects.length
  if (styled(/^\w+: \(/)) return `docs: (hub) ${verb} ${what}`
  if (styled(/^\w+(\([^)]*\))?!?: /)) return `docs: ${verb} ${what}`
  return `${verb[0].toUpperCase()}${verb.slice(1)} ${what}`
}

// EVI-6: what the person said about the sampled sentences, with the ones that did not match, and
// nothing about who said it. Checked before anything is written.
function spotCheck(run, value) {
  const file = join(run, 'sample.json')
  const items = existsSync(file) ? readJson(file).items ?? [] : []
  if (['none', 'all', 'some'].includes(value)) return { sampled: items.length, answer: value, mismatched: [] }
  const numbers = [...new Set(value.split(',').map(s => s.trim()))]
  if (numbers.some(s => !/^\d+$/.test(s))) throw usage(`--spot takes none, all, some or sentence numbers, not ${JSON.stringify(value)}`)
  const mismatched = numbers.map(s => {
    const item = items.find(i => i.n === Number(s))
    if (!item) throw usage(`--spot: there is no sentence ${s} in the sample`)
    return { repo: item.repo, path: item.path, line: item.line, text: item.text }
  })
  return { sampled: items.length, answer: 'some', mismatched }
}

function spotLine(spot) {
  if (spot.answer === 'none') return 'spot check: not checked'
  if (spot.answer === 'all') return `spot check: ${spot.sampled} sampled, all matched`
  if (!spot.mismatched.length) return `spot check: ${spot.sampled} sampled, some did not match`
  return `spot check: ${spot.sampled} sampled, ${spot.mismatched.length} did not match: ${spot.mismatched.map(m => `${m.repo} ${m.path}:${m.line}`).join(', ')}`
}

// `finish <plan.json> [--keep all|none|<ids>] [--apply <ids>] [--spot …]` (design 15.1.9, 15.7.67-70,
// 15.8.103, 15.8.105, 15.8.135, 15.8.137-138): keep or undo what place did, apply the accepted
// proposals, write the locks, check confinement and leave done.json. It never records a change in git.
export default function finish(argv) {
  const { values, positionals } = parseOptions(argv, { keep: { type: 'string' }, apply: { type: 'string' }, spot: { type: 'string' } }, { positionals: true })
  if (positionals.length !== 1) throw usage('usage: hub.mjs finish <plan.json> [--keep all|none|<ids>] [--apply <ids>] [--spot none|all|some|<n,...>] [--json]')
  const { path, plan, root, run } = loadPlanFile(positionals[0])
  refuseUnless(run, plan, 'finish')
  if (!existsSync(placedFile(run))) throw new HubError('finish: nothing is placed yet; run place first')
  const placed = readJson(placedFile(run))
  const dirs = repoDirs(root)
  const repos = Object.keys(plan.repos ?? {})
  for (const repo of repos) if (!dirs[repo]) throw usage(`no repository named ${repo} in ${root}`)

  const entries = new Map()
  for (const repo of repos) for (const f of plan.repos[repo].files ?? []) entries.set(f.id, { repo, f })
  const keepArg = values.keep ?? 'all'
  const keep = ['all', 'none'].includes(keepArg) ? keepArg : new Set(ids(keepArg))
  const apply = ids(values.apply)
  for (const id of keep instanceof Set ? keep : []) if (!entries.has(id)) throw usage(`--keep: no entry ${id} in the plan`)
  for (const id of apply) {
    const e = entries.get(id)
    if (!e || e.f.action !== 'propose') throw usage(`--apply: ${id} is not a proposal of the plan`)
  }
  const kept = id => keep === 'all' || (keep instanceof Set && keep.has(id))
  const spot = values.spot === undefined ? null : spotCheck(run, values.spot)

  const res = result()
  const report = { kept: [], discarded: [], changed: [], applied: [], notApplied: [], unexpected: [], removed: [], locks: [] }
  if (spot) report.spot = spot
  const allowed = Object.fromEntries(repos.map(r => [r, new Set()]))
  const catalog = loadCatalog()

  for (const repo of repos) {
    const dir = dirs[repo]
    const r = plan.repos[repo]
    const rec = placed.repos?.[repo] ?? { files: {}, proposals: {} }
    const previous = readLock(dir)
    const files = { ...(previous?.files ?? {}) }
    const facts = factIndex(root, repo)
    const sourcesOf = f => sourcesFromFacts(dirs, repo, (f.facts ?? []).map(id => facts.get(id)).filter(Boolean))
    const generatedEntry = (f, hash) => {
      const entry = { kind: f.kind, hash, sources: sourcesOf(f) }
      if (f.archetype) entry.archetype = f.archetype
      if (f.type) entry.type = f.type
      return entry
    }

    // What place did, kept or undone; a file changed since place is left as it is (15.7.69).
    for (const [p, info] of Object.entries(rec.files ?? {})) {
      const f = entries.get(info.id)?.f ?? { id: info.id, path: p }
      const abs = join(dir, p)
      const now = existsSync(abs) ? hashObject(dir, p) : null
      const changed = info.action === 'delete' ? now !== null : now !== info.placed
      const keepIt = kept(info.id)
      const where = { repo, id: info.id, path: p }
      if (changed) {
        allowed[repo].add(p)
        report.changed.push(where)
        res.warnings.push({ ...where, message: 'changed since place: left as it is' })
        if (keepIt && info.action !== 'delete') files[p] = generatedEntry(f, info.placed)
        if (keepIt && info.action === 'delete') delete files[p]
        ;(keepIt ? report.kept : report.discarded).push(where)
        continue
      }
      if (keepIt) {
        allowed[repo].add(p)
        if (info.action === 'delete') delete files[p]
        else files[p] = generatedEntry(f, info.placed)
        report.kept.push(where)
      } else {
        if (info.action === 'create') {
          rmSync(abs)
          removeEmptyParents(dir, abs)
        } else if (info.previous) restore(dir, p, info.previous)
        report.discarded.push(where)
      }
    }

    // Design 15.8.107: the folders `site --build` recorded. A site plan that keeps none of the site's
    // files removes them all; otherwise a folder stays only where git ignores it, as the site's
    // .gitignore does, so that confinement never meets build output. placed.json sits in .hub-run/,
    // where the run's agents can write: only a build folder of a site, really inside the repository,
    // is ever removed.
    const inside = realpathSync(dir) + sep
    for (const built of rec.build ?? []) {
      const m = BUILT.exec(String(built))
      const abs = m && join(dir, built)
      if (!abs || !existsSync(abs) || !realpathSync(abs).startsWith(inside)) continue
      const siteKept = Object.entries(rec.files ?? {}).some(([p, info]) => p.startsWith(`${m[1]}/`) && kept(info.id))
      const ignored = git(dir, ['check-ignore', '-q', '--', built], { allowFail: true }).status === 0
      if (ignored && !(plan.mode === 'site' && !siteKept)) continue
      rmSync(abs, { recursive: true, force: true })
      removeEmptyParents(dir, abs)
      report.removed.push({ repo, path: built })
    }

    // Accepted proposals: scanned, applied only where their target is still what place saw.
    const scanText = makeScanner({ catalog, authors: historyNames(dir), allow: previous?.settings?.scanAllow ?? [] })
    const attempted = new Set()
    for (const id of apply.filter(id => entries.get(id).repo === repo)) {
      const f = entries.get(id).f
      const where = { repo, id, path: f.path }
      attempted.add(id)
      const notApplied = why => {
        report.notApplied.push({ ...where, reason: why })
        res.errors.push({ ...where, message: `not applied: ${why}` })
      }
      if (f.action === 'dropped') {
        notApplied(`dropped (${f.reason})`)
        continue
      }
      const file = proposalFile(root, repo, id)
      if (!existsSync(file)) {
        notApplied(`${file} does not exist`)
        continue
      }
      const text = readFileSync(file, 'utf8')
      const found = scanText(text, f.path).filter(x => x.severity !== 'warning')
      if (found.length) {
        notApplied(`the scan found ${found.map(x => x.message).join('; ')}`)
        continue
      }
      const abs = join(dir, f.path)
      if (isSettingsPatch(f)) {
        let current = {}
        if (existsSync(abs)) {
          try {
            current = JSON.parse(readFileSync(abs, 'utf8'))
          } catch {
            notApplied(`${f.path} is not valid JSON`)
            continue
          }
        }
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, settingsText(mergePatch(current, JSON.parse(text))))
      } else {
        const now = existsSync(abs) ? hashObject(dir, f.path) : null
        if (now !== (rec.proposals?.[id]?.target ?? null)) {
          allowed[repo].add(f.path)
          notApplied(`${f.path} changed since place; the proposal stays in ${file}`)
          continue
        }
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, text)
        if (f.offer === 'hub-check' || f.offer === 'docs-site') files[f.path] = { kind: 'ci', hash: hashObject(dir, f.path), sources: {} }
        else if (files[f.path]) {
          const old = files[f.path]
          // Reviewed against HEAD in the rounds, so its sources are HEAD's too.
          const now = Object.fromEntries(Object.entries(old.sources ?? {}).map(([k, id]) => [k, [null, 'unknown'].includes(currentId(dir, k)) ? id : currentId(dir, k)]))
          files[f.path] = { ...old, hash: hashObject(dir, f.path), sources: f.facts ? sourcesOf(f) : now }
        }
      }
      allowed[repo].add(f.path)
      report.applied.push(where)
    }
    // A proposal over a lock file that P3 did not take leaves the lock: the file is the person's.
    // One dropped in the rounds keeps its old entry (15.8.138).
    for (const f of r.files ?? []) {
      if (f.action === 'propose' && !f.offer && files[f.path] && !attempted.has(f.id)) delete files[f.path]
    }

    if (!previous && !Object.keys(files).length) continue
    if (plan.mode === 'site') {
      // Design 15.7.92 (SIT-18): a first lock holds the site alone; an existing one only gains its files.
      const lock = previous ? { ...previous, files } : { schema: 1, generator: generatorVersion(), documentedCommit: r.head, settings: { docsDir: r.docsDir ?? 'docs' }, files }
      writeLock(dir, lock, previous, { bare: !previous })
      allowed[repo].add('.claude/hub.lock.json')
      report.locks.push(repo)
      continue
    }
    // documentedCommit moves only when every affected file was updated, accepted or let go (GEN-26):
    // an entry left as the previous lock had it, with a source that changed, holds it back.
    const untreated = Object.entries(previous?.files ?? {})
      .filter(([p, e]) => files[p] === e && Object.entries(e.sources ?? {}).some(([k, id]) => ![id, 'unknown'].includes(currentId(dir, k))))
      .map(([p]) => p)
    for (const p of untreated) res.warnings.push({ repo, path: p, message: 'affected and not updated: documentedCommit stays where it was' })
    const settings = { ...(previous?.settings ?? {}), language: plan.settings?.language ?? 'en', docsDir: r.docsDir ?? 'docs' }
    const lock = {
      ...(previous ?? {}),
      schema: 1,
      generator: generatorVersion(),
      documentedCommit: untreated.length ? previous.documentedCommit : r.head,
      settings,
      files,
    }
    const ws = plan.workspace
    if (ws?.home) {
      if (repo === ws.home) {
        lock.workspace = { repos: ws.repos }
        delete settings.docsHome
      } else {
        delete lock.workspace
        settings.docsHome = ws.home
      }
    }
    writeLock(dir, lock, previous)
    allowed[repo].add('.claude/hub.lock.json')
    report.locks.push(repo)
  }

  for (const f of confinement(root, dirs, repos, isWorkspaceRoot(root), allowed)) {
    report.unexpected.push(...f.paths.map(p => (f.repo ? `${f.repo}:${p}` : p)))
    res.errors.push({ repo: f.repo, path: f.path, gate: f.gate, message: `${f.message}; nothing was deleted: decide what to keep` })
  }

  writeFileSync(join(run, 'done.json'), JSON.stringify({ schema: 1, plan: path, ...report }, null, 2) + '\n')
  const verb = plan.mode === 'refresh' ? 'update' : 'add'
  res.data = { ...report, message: commitMessage(dirs[repos[0]], plan.mode === 'site' ? 'the docs site' : 'the generated skills and docs', verb) }
  res.lines.push(`kept ${report.kept.length}, discarded ${report.discarded.length}, applied ${report.applied.length} proposals`)
  for (const k of report.kept) res.lines.push(`written: ${k.repo} ${k.path}`)
  for (const a of report.applied) res.lines.push(`applied: ${a.repo} ${a.id} ${a.path}`)
  for (const d of report.discarded) res.lines.push(`not written: ${d.repo} ${d.path}`)
  for (const b of report.removed) res.lines.push(`removed build output: ${b.repo} ${b.path}`)
  for (const c of report.changed) res.lines.push(`left as it is (changed since place): ${c.repo} ${c.path}`)
  for (const n of report.notApplied) res.lines.push(`not applied: ${n.repo} ${n.id} ${n.path}: ${n.reason}`)
  for (const u of report.unexpected) res.lines.push(`unexpected: ${u}`)
  if (spot) res.lines.push(spotLine(spot))
  res.lines.push(`locks written: ${report.locks.join(', ') || 'none'}`)
  res.lines.push(`suggested message: ${res.data.message}`)
  if (plan.mode !== 'site') res.lines.push('the new skills are active already, before anything is recorded in git')
  return res
}
