import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { findOnPath } from './env.mjs'

const real = p => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// `claude plugin validate --strict <out/<repo>/_claude/skills> --json` (PUE-9): it only sees
// what is planned. Without claude on the PATH it does not run and `check` says so.
export function validateSkills(dir, targets) {
  const claude = findOnPath('claude')
  if (!claude) return { ran: false, findings: [], warning: 'claude is not on the PATH: plugin validate did not run; the own lint covers it' }
  if (!existsSync(dir)) return { ran: false, findings: [] }
  const r = spawnSync(claude, ['plugin', 'validate', '--strict', dir, '--json'], { encoding: 'utf8', timeout: 180000 })
  let report
  try {
    report = JSON.parse(r.stdout)
  } catch {
    const why = (r.error?.message ?? r.stderr ?? '').trim().split('\n')[0]
    return { ran: false, findings: [], warning: `plugin validate gave no report${why ? `: ${why}` : ''}` }
  }
  const byFile = new Map(targets.map(t => [real(t.file), t]))
  const findings = []
  const items = [report.manifest, ...(report.contents ?? [])].filter(Boolean)
  for (const item of items) {
    const target = item.file ? byFile.get(real(item.file)) : null
    for (const e of [...(item.errors ?? []), ...(item.warnings ?? [])]) {
      const at = item.file ? `${item.file}: ` : ''
      findings.push({ target, message: `plugin validate: ${at}${e.path ? `${e.path}: ` : ''}${e.message}` })
    }
  }
  if (!findings.length && report.success === false) findings.push({ target: null, message: 'plugin validate failed' })
  return { ran: true, findings }
}

const VALE = ['.vale.ini', '_vale.ini', 'vale.ini']
const MARKDOWNLINT = [
  '.markdownlint.json',
  '.markdownlint.jsonc',
  '.markdownlint.yaml',
  '.markdownlint.yml',
  '.markdownlint-cli2.jsonc',
  '.markdownlint-cli2.yaml',
]

function runLinter(name, bins, argsFor, dir, targets) {
  const bin = bins.map(findOnPath).find(Boolean)
  if (!bin) return { findings: [], warning: `${name} is configured in ${dir} but not installed: skipped` }
  const r = spawnSync(bin, argsFor(bin, targets.map(t => t.file)), { cwd: dir, encoding: 'utf8', timeout: 180000 })
  if (r.error) return { findings: [], warning: `${name} did not run: ${r.error.message}` }
  if (r.status === 0) return { findings: [] }
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  const findings = []
  for (const t of targets) {
    const lines = output.split('\n').filter(l => l.includes(t.file))
    if (lines.length) findings.push({ target: t, message: `${name}: ${lines.join(' | ')}` })
  }
  if (!findings.length) for (const t of targets) findings.push({ target: t, message: `${name}: ${output.split('\n').slice(0, 5).join(' | ')}` })
  return { findings }
}

// Vale and markdownlint only run where the project configures them (PUE-12); their errors block.
export function optionalLinters(dir, targets) {
  const out = { findings: [], warnings: [] }
  if (!targets.length) return out
  const vale = VALE.find(f => existsSync(join(dir, f)))
  if (vale) {
    const r = runLinter('Vale', ['vale'], (_, files) => [`--config=${join(dir, vale)}`, '--output=line', ...files], dir, targets)
    out.findings.push(...r.findings)
    if (r.warning) out.warnings.push(r.warning)
  }
  const md = MARKDOWNLINT.find(f => existsSync(join(dir, f)))
  if (md) {
    const r = runLinter(
      'markdownlint',
      ['markdownlint-cli2', 'markdownlint'],
      (bin, files) => (bin.endsWith('cli2') ? ['--config', join(dir, md), ...files] : ['-c', join(dir, md), ...files]),
      dir,
      targets,
    )
    out.findings.push(...r.findings)
    if (r.warning) out.warnings.push(r.warning)
  }
  return out
}
