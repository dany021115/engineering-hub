import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCatalog } from './catalog.mjs'
import { parseOptions, result, usage } from './cli.mjs'
import { WORKSPACE, checkFact, evidenceEnv } from './evidence.mjs'
import { readJsonl, writeJsonl } from './jsonl.mjs'
import { runDir } from './paths.mjs'
import { resolveRoot } from './workspace.mjs'

export const checkedFile = (root, name) => join(runDir(root), 'facts', `${name}.checked.jsonl`)

// What a verifier sees: never drafts, only the claim and its evidence.
const forVerifier = f => ({ id: f.id, kind: f.kind, claim: f.claim, evidence: f.evidence })

function writeBatches(root, name, facts, catalog) {
  const dir = join(runDir(root), 'batches')
  mkdirSync(dir, { recursive: true })
  for (const f of readdirSync(dir)) if (f.startsWith(`${name}-`)) rmSync(join(dir, f))
  const verified = facts.filter(f => catalog.verifiedKinds.includes(f.kind))
  const size = catalog.limits.verifierBatchSize
  const files = []
  for (let i = 0; i * size < verified.length; i++) {
    const file = join(dir, `${name}-${i + 1}.jsonl`)
    writeJsonl(file, verified.slice(i * size, (i + 1) * size).map(forVerifier))
    files.push(file)
  }
  return files
}

export function commandEnv(argv, extra = {}) {
  const { values } = parseOptions(argv, { repo: { type: 'string' }, ...extra })
  if (!values.repo) throw usage('--repo <name> is required')
  const catalog = loadCatalog()
  const root = resolveRoot(process.cwd())
  const env = evidenceEnv(root, catalog)
  if (values.repo !== WORKSPACE && !env.dirs[values.repo]) throw usage(`no repository named ${values.repo} in ${root}`)
  return { values, catalog, root, env, name: values.repo }
}

export default function facts(argv) {
  const { catalog, root, env, name } = commandEnv(argv)
  const file = join(runDir(root), 'facts', `${name}.jsonl`)
  if (!existsSync(file)) throw usage(`${file} does not exist`)
  const { items, bad } = readJsonl(file)
  const res = result()
  for (const b of bad) res.errors.push({ repo: name, message: `line ${b.line}: ${b.message}` })
  const accepted = []
  const others = []
  const seen = new Set()
  for (const item of items) {
    if (item.type === 'candidate' || item.type === 'question') {
      others.push(item)
      continue
    }
    if (item.type !== 'fact') {
      res.errors.push({ repo: name, id: item.id, message: `unknown line type ${JSON.stringify(item.type)}` })
      continue
    }
    const reason = seen.has(item.id) ? 'duplicate id' : checkFact(env, item, name)
    if (reason) res.errors.push({ repo: name, id: String(item.id ?? '?'), message: reason })
    else {
      seen.add(item.id)
      accepted.push(item)
    }
  }
  // Design 15.7.64: the cap applies after invalid quotes are rejected, keeping the file's order.
  const kept = accepted.slice(0, catalog.caps.factsPerRepo)
  const overCap = accepted.length - kept.length
  writeJsonl(checkedFile(root, name), [...kept, ...others])
  const batches = writeBatches(root, name, kept, catalog)
  const rejected = res.errors.map(e => ({ id: e.id ?? null, reason: e.message }))
  const report = { accepted: kept.length, rejected, overCap }
  writeFileSync(join(runDir(root), 'facts', `${name}.report.json`), JSON.stringify(report, null, 2) + '\n')
  if (overCap) {
    res.warnings.push({
      repo: name,
      message: `${overCap} facts dropped by caps.factsPerRepo (${catalog.caps.factsPerRepo})`,
    })
  }
  res.data = { repo: name, ...report, batches }
  res.lines.push(`${name}: ${kept.length} facts accepted, ${rejected.length} rejected, ${overCap} over the cap`)
  res.lines.push(`${batches.length} verifier batches`)
  return res
}
