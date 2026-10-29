import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadCatalog } from './catalog.mjs'
import { HubError, parseOptions, result, usage } from './cli.mjs'
import { evidenceEnv, normalize, splitRepoPath } from './evidence.mjs'
import { absentInHead, git } from './git.mjs'
import { readJsonl, writeJsonl } from './jsonl.mjs'
import { readLock } from './lock.mjs'
import { removeText } from './markdown.mjs'
import { RUN_DIR, runDir, stagingFile, toStagingPath } from './paths.mjs'
import { loadPlanFile } from './plan.mjs'
import { resolveRoot } from './workspace.mjs'

const PROBLEMS = ['false', 'unsupported', 'restates-instructions', 'wrong-command', 'duplicates-page']
const NEED_QUOTE = ['false', 'wrong-command']
// The problems a finding states about one sentence, which round 2 can take out on its own.
const ONE_SENTENCE = ['false', 'unsupported', 'wrong-command']

// A reviewer's evidence holds when a quote is in HEAD or an absence is absent from it.
function citationHolds(env, repo, evidence) {
  if (!Array.isArray(evidence) || !evidence.length) return false
  const { limits } = env.catalog
  return evidence.every(item => {
    if (item && typeof item.quote === 'string' && typeof item.path === 'string') {
      const at = splitRepoPath(env, item.path, repo)
      const ctx = !at.error && env.repo(at.repo)
      const quote = normalize(item.quote)
      if (!ctx || quote.length < limits.quoteMinChars || quote.length > limits.quoteMaxChars) return false
      const text = ctx.head(at.path)
      return text !== null && text.includes(quote)
    }
    if (item && typeof item.absence === 'string' && item.absence.trim()) {
      const at = item.pathspec ? splitRepoPath(env, item.pathspec, repo) : { repo }
      const ctx = !at.error && env.repo(at.repo)
      return Boolean(ctx) && absentInHead(ctx.dir, item.absence, at.path)
    }
    return false
  })
}

// Design 15.8.170: the lines a person wrote into a file the lock generated are the ones in the file
// and not in the blob the lock recorded; they are theirs to keep.
function personLines(dir, path) {
  const hash = readLock(dir)?.files?.[path]?.hash
  const file = join(dir, path)
  if (!hash || !existsSync(file)) return []
  const generated = git(dir, ['cat-file', '-p', hash], { allowFail: true })
  if (generated.status !== 0) return []
  const before = new Set(generated.stdout.split('\n').map(l => l.trim()))
  return readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !before.has(l))
}

// `review --repo <r> --in <file> --round <n>` (design 15.7.66, 15.8.110, 15.8.113, 15.8.166): the
// reviewer cites plan paths; a false or wrong-command finding without a valid citation is discarded.
export default function review(argv) {
  const { values } = parseOptions(argv, { repo: { type: 'string' }, in: { type: 'string' }, round: { type: 'string' } })
  if (!values.repo || !values.in) throw usage('usage: hub.mjs review --repo <name> --in <file> --round <n> [--json]')
  const round = Number(values.round)
  if (![1, 2].includes(round)) throw usage('--round must be 1 or 2')
  const root = resolveRoot(process.cwd())
  const planFile = join(runDir(root), 'plan.json')
  const { plan, path } = loadPlanFile(planFile)
  const repo = values.repo
  const r = plan.repos?.[repo]
  if (!r) throw usage(`the plan has no repository named ${repo}`)
  const input = resolve(values.in)
  if (!existsSync(input)) throw usage(`${input} does not exist`)
  const { items, bad } = readJsonl(input)
  if (bad.length) throw usage(`${input} line ${bad[0].line}: ${bad[0].message}`)

  const planPaths = new Set((r.files ?? []).map(f => f.path))
  // The reviewer's table maps each plan path to its staging path; name the plan path it meant.
  const staged = new Map([...planPaths].map(p => [`out/${repo}/${toStagingPath(p)}`, p]))
  const strays = items.filter(f => !planPaths.has(f.file))
  if (strays.length) {
    const names = strays
      .map(f => JSON.stringify(f.file) + (staged.has(String(f.file).replace(/^\.hub-run\//, '')) ? ` (the staging path of ${staged.get(String(f.file).replace(/^\.hub-run\//, ''))})` : ''))
      .join(', ')
    throw new HubError(`findings must cite a plan path of ${repo} in file, not ${names}; fix ${input} and run review again`)
  }
  for (const f of items) {
    if (!PROBLEMS.includes(f.problem)) throw usage(`finding on ${f.file}: problem must be one of ${PROBLEMS.join(', ')}`)
  }

  const env = evidenceEnv(root, loadCatalog())
  const kept = []
  const discarded = []
  const left = []
  // A finding on a line the person wrote in a file they edited by hand is left to them: the writer
  // never gets it, and round 2 never takes the line out.
  const own = new Map()
  const theirs = f => {
    const edited = (r.files ?? []).some(x => x.path === f.file && x.action === 'propose' && !x.offer)
    const text = typeof f.text === 'string' ? f.text.trim() : ''
    if (!edited || !text || !env.repo(repo)) return false
    if (!own.has(f.file)) own.set(f.file, personLines(env.repo(repo).dir, f.file))
    return own.get(f.file).some(l => l.includes(text))
  }
  for (const f of items) {
    if (NEED_QUOTE.includes(f.problem) && !citationHolds(env, repo, f.evidence)) discarded.push(f)
    else if (theirs(f)) left.push(f)
    else kept.push(f)
  }
  writeJsonl(join(runDir(root), 'review', `${repo}-${round}.jsonl`), kept)

  const res = result()
  const dropped = []
  const trimmed = []
  if (round === 2) {
    for (const f of r.files ?? []) {
      const found = kept.filter(k => k.file === f.path)
      if (f.action === 'dropped' || !found.length) continue
      // Design 15.8.166: in the last round a finding about one sentence takes only that sentence out
      // of the staged file; any other finding, or one it cannot take out cleanly, drops the entry.
      const file = ['create', 'update'].includes(f.action) ? stagingFile(root, repo, f.path) : null
      let text = file && existsSync(file) ? readFileSync(file, 'utf8') : null
      for (const k of found) text = text !== null && ONE_SENTENCE.includes(k.problem) ? removeText(text, k.text) : null
      if (text !== null) {
        writeFileSync(file, text)
        trimmed.push({ id: f.id, path: f.path, texts: found.map(k => k.text) })
        continue
      }
      f.action = 'dropped'
      f.reason = 'review'
      dropped.push({ id: f.id, path: f.path })
    }
    if (dropped.length) writeFileSync(path, JSON.stringify(plan, null, 2) + '\n')
  }
  for (const f of kept) {
    const id = r.files.find(x => x.path === f.file)?.id
    res.errors.push({ repo, id, path: f.file, gate: 'review', message: `${f.problem}: ${f.text ?? ''}`.trim() })
  }
  for (const f of discarded) {
    res.warnings.push({ repo, path: f.file, message: `discarded a ${f.problem} finding without a valid citation` })
  }
  for (const f of left) {
    res.warnings.push({ repo, path: f.file, message: `left to the person, on a line they wrote by hand: ${f.problem}: ${f.text}` })
  }
  res.data = { repo, round, kept: kept.length, discarded: discarded.length, left: left.length, dropped, trimmed, file: join(RUN_DIR, 'review', `${repo}-${round}.jsonl`) }
  res.lines.push(`${repo}: ${kept.length} findings kept, ${discarded.length} discarded`)
  for (const d of dropped) res.lines.push(`dropped ${d.id} ${d.path}: review`)
  for (const t of trimmed) for (const x of t.texts) res.lines.push(`trimmed ${t.id} ${t.path}: ${x}`)
  return res
}
