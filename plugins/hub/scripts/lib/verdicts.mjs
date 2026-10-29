import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { result, usage } from './cli.mjs'
import { checkFact } from './evidence.mjs'
import { checkedFile, commandEnv } from './facts.mjs'
import { readJsonl, writeJsonl } from './jsonl.mjs'

// Design 15.1.6: a not-found or contradicted fact stops being supported; a correction becomes
// `<id>c` only when its own quote is in HEAD.
export default function verdicts(argv) {
  const { values, root, env, name } = commandEnv(argv, { in: { type: 'string' } })
  if (!values.in) throw usage('--in <file> is required')
  const input = resolve(values.in)
  if (!existsSync(input)) throw usage(`${input} does not exist`)
  const file = checkedFile(root, name)
  if (!existsSync(file)) throw usage(`${file} does not exist: run facts --repo ${name} first`)

  const res = result()
  const { items } = readJsonl(file)
  const { items: verdictList, bad } = readJsonl(input)
  for (const b of bad) res.errors.push({ repo: name, message: `${input} line ${b.line}: ${b.message}` })
  const facts = new Map(items.filter(i => i.type === 'fact').map(f => [f.id, f]))
  const replaced = new Map()
  const summary = { supported: [], unsupported: [], corrected: [] }

  for (const v of verdictList) {
    const fact = facts.get(v.id)
    if (!fact || replaced.has(v.id)) {
      res.errors.push({ repo: name, id: String(v.id), message: 'verdict for a fact that is not supported' })
      continue
    }
    if (v.verdict === 'supported') {
      summary.supported.push(v.id)
    } else if (v.verdict === 'not-found') {
      replaced.set(v.id, [])
      summary.unsupported.push(v.id)
    } else if (v.verdict === 'contradicted') {
      const correction = { type: 'fact', id: `${v.id}c`, kind: fact.kind, claim: v.claim, evidence: v.evidence }
      const reason = facts.has(correction.id) ? 'duplicate id' : checkFact(env, correction, name)
      summary.unsupported.push(v.id)
      if (reason) {
        replaced.set(v.id, [])
        res.errors.push({ repo: name, id: correction.id, message: `correction rejected: ${reason}` })
      } else {
        replaced.set(v.id, [{ ...correction, corrects: v.id }])
        summary.corrected.push(correction.id)
      }
    } else {
      res.errors.push({ repo: name, id: String(v.id), message: `unknown verdict ${JSON.stringify(v.verdict)}` })
    }
  }
  const merged = items.flatMap(i => (i.type === 'fact' && replaced.has(i.id) ? replaced.get(i.id) : [i]))
  writeJsonl(file, merged)
  res.data = { repo: name, ...summary }
  res.lines.push(
    `${name}: ${summary.supported.length} supported, ${summary.unsupported.length} no longer supported, ${summary.corrected.length} corrections kept`,
  )
  return res
}
