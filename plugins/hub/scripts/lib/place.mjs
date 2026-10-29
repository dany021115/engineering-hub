import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { loadCatalog } from './catalog.mjs'
import { HubError, parseOptions, result, usage } from './cli.mjs'
import { readEnv } from './env.mjs'
import { fileGates, overCap, planTargets, skillOwners, treeState } from './gates.mjs'
import { hashObject } from './git.mjs'
import { safeDecode } from './lint-docs.mjs'
import { SENTENCE, classify, links, splitFrontmatter } from './markdown.mjs'
import { lineTarget, offerProposal } from './offers.mjs'
import { proposalFile } from './paths.mjs'
import { loadPlanFile } from './plan.mjs'

export const placedFile = run => join(run, 'placed.json')

const json = value => JSON.stringify(value, null, 2) + '\n'

// Shared refusal of place and finish (design 15.7.68, 15.1.7): nothing is touched.
export function refuseUnless(run, plan, name) {
  if (existsSync(join(run, 'done.json'))) throw new HubError(`${name}: this run is finished (done.json); start a new one`)
  if (plan.approved !== true) throw new HubError(`${name}: the plan is not approved; run plan --approve after P2`)
}

function drop(f, reason, res, repo) {
  f.action = 'dropped'
  f.reason = reason
  res.data.dropped.push({ repo, id: f.id, path: f.path, reason })
}

// Design 15.8.109: a line that points at something dropped is dropped with it.
function dropOrphanLines(plan, res) {
  for (const [repo, r] of Object.entries(plan.repos)) {
    for (const f of (r.files ?? []).filter(f => f.offer === 'instructions-line' && f.action !== 'dropped')) {
      const cited = lineTarget(f, repo, r.docsDir ?? 'docs')
      const target = r.files.find(x => x.path === cited && ['create', 'update', 'dropped'].includes(x.action))
      if (target?.action === 'dropped') drop(f, 'target-dropped', res, repo)
    }
  }
}

const BULLET = /^ {0,3}[-*+]\s/
const WHOLE = /^ {0,3}[#|>]/
const plural = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`

// Design 15.8.161: an index keeps the rest when a page it links to is dropped. A one-line bullet
// that links to it goes, and so does such a sentence of a one-line paragraph; a list left with no
// item takes the sentence ending in ':' that introduces it. A link elsewhere (a longer item or
// paragraph, a table, a heading) still fails the docs gate. Nothing is added.
function pruneIndexes(plan, state, res) {
  for (const [repo, r] of Object.entries(plan.repos)) {
    const gone = new Set((r.files ?? []).filter(f => f.action === 'dropped').map(f => f.path))
    if (!gone.size) continue
    for (const f of r.files) {
      if (f.kind !== 'page' || !['create', 'update'].includes(f.action) || posix.basename(f.path) !== 'index.md') continue
      const file = state.view(repo).overlay.get(f.path)
      if (!file || !existsSync(file)) continue
      const dead = s =>
        links(s).some(k => {
          const [target] = k.target.split('#')
          if (!target || target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return false
          return gone.has(posix.normalize(posix.join(posix.dirname(f.path), safeDecode(target))))
        })
      const text = readFileSync(file, 'utf8')
      const fm = splitFrontmatter(text)
      const prose = new Set(classify(fm.body, fm.offset).filter(l => l.kind === 'prose').map(l => l.n))
      const lines = text.split('\n').map((t, i) => ({ t, prose: prose.has(i + 1), gone: false }))
      const blank = l => !l || (l.prose && !l.t.trim())
      const bullet = l => Boolean(l?.prose && BULLET.test(l.t))
      const cut = { bullets: 0, sentences: 0 }
      for (const [i, l] of lines.entries()) {
        if (!l.prose || WHOLE.test(l.t) || !dead(l.t)) continue
        if (bullet(l)) {
          // An indented next line makes the bullet part of a larger item: it stays whole.
          if (/^\s+\S/.test(lines[i + 1]?.t ?? '')) continue
          l.gone = true
          cut.bullets++
        } else if (blank(lines[i - 1]) && blank(lines[i + 1])) {
          const sentences = l.t.split(SENTENCE)
          const live = sentences.filter(s => !dead(s))
          cut.sentences += sentences.length - live.length
          if (live.length) l.t = live.join(' ')
          else l.gone = true
        }
      }
      // A list between blank lines whose items all went, below a one-line paragraph ending in ':'.
      for (const [i, l] of lines.entries()) {
        if (!bullet(l) || !blank(lines[i - 1])) continue
        let j = i
        while (bullet(lines[j])) j++
        const intro = lines[i - 2]
        if (!blank(lines[j]) || !lines.slice(i, j).every(x => x.gone)) continue
        if (!intro?.prose || intro.gone || !/:\s*$/.test(intro.t) || !blank(lines[i - 3])) continue
        const sentences = intro.t.split(SENTENCE)
        sentences.pop()
        if (sentences.length) intro.t = sentences.join(' ')
        else intro.gone = true
        cut.sentences++
      }
      if (!cut.bullets && !cut.sentences) continue
      // The blank lines that the removals leave side by side become one.
      const kept = lines.filter(l => !l.gone).filter((l, k, a) => !(k > 0 && blank(l) && blank(a[k - 1])))
      writeFileSync(file, kept.map(l => l.t).join('\n'))
      const what = [cut.bullets && plural(cut.bullets, 'list line'), cut.sentences && plural(cut.sentences, 'sentence')].filter(Boolean)
      res.warnings.push({ repo, id: f.id, path: f.path, message: `removed ${what.join(' and ')} that linked to dropped pages` })
    }
  }
}

// `place <plan.json>` (design 15.1.9, 15.7.55-57, 15.8.105, 15.8.109-110): gates again, copy what
// passes from staging to its plan path, run deletes, write the offers' proposals, keep placed.json.
export default function place(argv) {
  const { positionals } = parseOptions(argv, {}, { positionals: true })
  if (positionals.length !== 1) throw usage('usage: hub.mjs place <plan.json> [--json]')
  const { path, plan, root, run } = loadPlanFile(positionals[0])
  refuseUnless(run, plan, 'place')
  if (existsSync(placedFile(run))) throw new HubError('place already ran for this plan: go on with finish')
  const catalog = loadCatalog()
  const env = readEnv(root)
  const res = result()
  res.data = { placed: [], deleted: [], proposals: [], dropped: [], skipped: [] }
  const state = treeState(root, { plan, catalog, language: plan.settings?.language ?? 'en', mode: 'plan' })
  const repos = Object.keys(plan.repos ?? {})
  for (const repo of repos) if (!state.dirs[repo]) throw usage(`no repository named ${repo} in ${root}`)

  // Every file to copy passes the deterministic gates again; the scan covers all of it. A drop can
  // break a file that already passed, by a link or a path to it, so the indexes are pruned and the
  // gates run again on a fresh view of the tree until nothing more drops (design 15.8.161).
  let count
  do {
    count = res.data.dropped.length
    pruneIndexes(plan, state, res)
    state.reset()
    const owners = skillOwners(state)
    for (const repo of repos) {
      const targets = planTargets(state, repo).filter(t => ['create', 'update'].includes(t.entry.action))
      overCap(state, repo, targets)
      for (const t of targets) {
        const errors = fileGates(t, state, { owners }).filter(f => f.severity !== 'warning')
        if (!errors.length) continue
        drop(t.entry, `gate:${errors[0].gate}`, res, repo)
        for (const e of errors) res.errors.push({ repo, id: t.id, path: t.path, gate: e.gate, message: `not placed: ${e.message}` })
      }
    }
  } while (res.data.dropped.length > count)
  dropOrphanLines(plan, res)

  const placed = { schema: 1, repos: {} }
  for (const repo of repos) {
    const dir = state.dirs[repo]
    const v = state.view(repo)
    const record = (placed.repos[repo] = { files: {}, proposals: {} })
    for (const f of plan.repos[repo].files ?? []) {
      const where = { repo, id: f.id, path: f.path }
      const abs = join(dir, f.path)
      if (f.action === 'create' || f.action === 'update' || f.action === 'delete') {
        const lockEntry = v.lock?.files?.[f.path]
        if (f.action === 'create' && existsSync(abs)) {
          res.errors.push({ ...where, message: 'not placed: the path was taken after P2; the file there stays as it is' })
          res.data.skipped.push(where)
          continue
        }
        if (f.action === 'delete' && lockEntry && !existsSync(abs)) {
          // A confirmed disappearance: nothing to delete, and nothing to restore.
          record.files[f.path] = { id: f.id, action: f.action, placed: null, previous: null }
          res.data.deleted.push(where)
          continue
        }
        if (f.action !== 'create' && (!lockEntry || !existsSync(abs) || hashObject(dir, f.path) !== lockEntry.hash)) {
          res.errors.push({ ...where, message: `not placed: ${f.path} is not the file the lock generated; it stays as it is` })
          res.data.skipped.push(where)
          continue
        }
        const previous = f.action === 'create' ? null : hashObject(dir, f.path, { write: true })
        if (f.action === 'delete') {
          rmSync(abs)
          record.files[f.path] = { id: f.id, action: f.action, placed: null, previous }
          res.data.deleted.push(where)
          continue
        }
        mkdirSync(dirname(abs), { recursive: true })
        copyFileSync(v.overlay.get(f.path), abs)
        record.files[f.path] = { id: f.id, action: f.action, placed: hashObject(dir, f.path), previous }
        res.data.placed.push(where)
      } else if (f.action === 'propose') {
        record.proposals[f.id] = { path: f.path, target: existsSync(abs) ? hashObject(dir, f.path) : null }
        if (!f.offer) {
          // The writer's own proposal: P3 lists it with the offers.
          const out = proposalFile(root, repo, f.id)
          if (existsSync(out)) res.data.proposals.push({ ...where, file: out })
          else res.warnings.push({ ...where, message: 'the writer left no proposal for it' })
          continue
        }
        const proposal = offerProposal(f, { dir, env, docsDir: plan.repos[repo].docsDir ?? v.docsDir })
        if (proposal.error) {
          res.warnings.push({ ...where, message: `no proposal written: ${proposal.error}` })
          continue
        }
        const out = proposalFile(root, repo, f.id)
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, proposal.text)
        res.data.proposals.push({ ...where, file: out, ...(proposal.note ? { note: proposal.note } : {}) })
      }
    }
  }
  writeFileSync(placedFile(run), json(placed))
  if (res.data.dropped.length) writeFileSync(path, json(plan))
  res.lines.push(`placed ${res.data.placed.length} files, deleted ${res.data.deleted.length}, wrote ${res.data.proposals.length} proposals`)
  for (const d of res.data.dropped) res.lines.push(`dropped ${d.repo} ${d.id} ${d.path}: ${d.reason}`)
  return res
}
