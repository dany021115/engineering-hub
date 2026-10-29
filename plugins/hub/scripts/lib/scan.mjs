import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { loadCatalog } from './catalog.mjs'
import { parseOptions, result, usage } from './cli.mjs'
import { findOnPath } from './env.mjs'
import { git, topLevel } from './git.mjs'
import { walkFiles } from './workspace.mjs'

// A path inside a personal folder: the users folder of macOS, Linux or Windows plus a name.
// The slashes stay escaped so this gate never finds the pattern in its own source (design 15.2.16).
export const HOME_PATH = /(?:\/(?:Users|home)\/|\b[A-Za-z]:[\\/]Users[\\/])[A-Za-z0-9._-]+/

const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g
const EXAMPLE_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i
const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g
const LOCAL_IPS = new Set(['127.0.0.1', '0.0.0.0'])

const normalize = s => s.replace(/\s+/g, ' ')
const escapeRe = s => s.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')

function lineAt(text, index) {
  let n = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

function allowedEmail(local, domain) {
  if (/no-?reply/i.test(local) || /(^|\.)users\.noreply\.github\.com$/i.test(domain)) return true
  if (local === 'git') return true
  return EXAMPLE_DOMAIN.test(domain)
}

// Design 15.8.131: a plain term ignores case and spacing; `re:` is a regex that ignores case,
// `cs:` a regex that keeps it. A term is named by its line number, never its text: in CI the
// file comes from a secret and the output lands in a log.
export function parseTerms(text) {
  const terms = []
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const label = `line ${i + 1} of the terms file`
    try {
      if (line.startsWith('re:')) terms.push({ label, re: new RegExp(line.slice(3), 'i') })
      else if (line.startsWith('cs:')) terms.push({ label, re: new RegExp(line.slice(3)) })
      else {
        const body = normalize(line.trim()).split(' ').map(escapeRe).join('\\s+')
        terms.push({ label, re: new RegExp(body, 'i') })
      }
    } catch {
      throw usage(`--terms: ${label} is not a valid regex`)
    }
  }
  return terms
}

export function loadTerms(file) {
  if (!file) return []
  const path = resolve(file)
  if (!existsSync(path)) throw usage(`--terms ${path} does not exist`)
  return parseTerms(readFileSync(path, 'utf8'))
}

// Author and committer names of a repo's history: several words are an error, one a warning.
export function historyNames(dir) {
  if (!topLevel(dir)) throw usage(`--authors ${dir} is not a git repository`)
  return logNames(git(dir, ['log', '--format=%an%x00%ae%x00%cn%x00%ce'], { allowFail: true }).stdout ?? '')
}

// Design 15.8.162: merges made on github.com carry `GitHub <noreply@github.com>` as committer,
// which names no person.
// ponytail: only GitHub's web identity; add another service's when a pilot meets it.
const WEB_COMMITTER = 'noreply@github.com'

export function logNames(out) {
  const names = new Set()
  for (const line of out.split('\n')) {
    const [an, ae, cn, ce] = line.split('\0')
    for (const [name, email] of [[an, ae], [cn, ce]]) {
      if (name?.trim() && email?.trim().toLowerCase() !== WEB_COMMITTER) names.add(normalize(name.trim()))
    }
  }
  return [...names]
}

export function makeScanner({ catalog = loadCatalog(), terms = [], authors = [], allow = [] } = {}) {
  const secrets = catalog.secretPatterns.map(p => ({ name: p.name, re: new RegExp(p.regex, `g${p.flags ?? ''}`) }))
  const allowed = new Set(allow.map(a => normalize(String(a)).toLowerCase()))
  const people = authors
    .filter(n => !allowed.has(n.toLowerCase()))
    .map(n => {
      const words = n.split(' ')
      const body = words.map(escapeRe).join('\\s+')
      return { name: n, several: words.length > 1, re: new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu') }
    })

  return function scanText(text, path) {
    const findings = []
    const add = (message, index, severity) =>
      findings.push({ gate: 'scan', message: index === null ? message : `line ${lineAt(text, index)}: ${message}`, severity })

    const home = new RegExp(HOME_PATH.source, 'g')
    for (const m of text.matchAll(home)) add(`a path inside a personal folder: ${m[0]}`, m.index)
    for (const m of text.matchAll(EMAIL)) {
      const local = m[0].slice(0, m[0].indexOf('@'))
      if (!allowedEmail(local, m[1])) add(`an email address: ${m[0]}`, m.index)
    }
    for (const s of secrets) {
      s.re.lastIndex = 0
      for (const m of text.matchAll(s.re)) add(`a ${s.name}`, m.index)
    }
    const flat = normalize(text)
    for (const p of people) {
      if (!p.re.test(flat)) continue
      if (p.several) add(`the name of a git author or committer: ${p.name}`, null)
      else add(`a one-word git author or committer name: ${p.name}`, null, 'warning')
    }
    for (const t of terms) {
      if (t.re.test(flat)) add(`a traced term: ${t.label}`, null)
      if (path && t.re.test(path)) add(`a traced term in the file name: ${t.label}`, null)
    }
    for (const m of text.matchAll(GUID)) add(`a GUID: ${m[0]}`, m.index, 'warning')
    for (const m of text.matchAll(IPV4)) if (!LOCAL_IPS.has(m[0])) add(`an IPv4 address: ${m[0]}`, m.index, 'warning')
    return findings
  }
}

export function readTextFile(file) {
  const buf = readFileSync(file)
  if (buf.subarray(0, 8000).includes(0)) return null
  return buf.toString('utf8')
}

// Optional: `gitleaks dir` when it is installed.
export function gitleaks(path) {
  const bin = findOnPath('gitleaks')
  if (!bin) return []
  const tmp = mkdtempSync(join(tmpdir(), 'hub-gitleaks-'))
  try {
    const report = join(tmp, 'report.json')
    const r = spawnSync(bin, ['dir', path, '--no-banner', '--redact', '--report-format', 'json', '--report-path', report, '--exit-code', '0'], {
      encoding: 'utf8',
    })
    if (r.error || !existsSync(report)) return []
    const items = JSON.parse(readFileSync(report, 'utf8') || '[]')
    return items.map(i => ({ file: i.File, message: `line ${i.StartLine}: gitleaks ${i.RuleID}: ${i.Description}` }))
  } catch {
    return []
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const skipDir = (p, d) => d.isDirectory() && (d.name === '.git' || d.name === 'node_modules')

function ignored(dir) {
  return git(dir, ['check-ignore', '-q', '.'], { allowFail: true }).status === 0
}

// Design 15.7.79: inside a repo, what git lists (tracked and untracked, not ignored); outside a repo,
// or for a folder git ignores, the whole tree without .git and node_modules.
export function filesToScan(arg) {
  const path = resolve(arg)
  if (!existsSync(path)) throw usage(`${arg} does not exist`)
  if (!statSync(path).isDirectory()) return [path]
  if (topLevel(path) && !ignored(path)) {
    const out = git(path, ['ls-files', '-z', '-co', '--exclude-standard']).stdout
    return out
      .split('\0')
      .filter(Boolean)
      .map(p => join(path, p))
      .filter(p => existsSync(p) && statSync(p).isFile())
  }
  return walkFiles(path, skipDir).map(p => join(path, p))
}

export default function scan(argv) {
  const { values, positionals } = parseOptions(argv, { terms: { type: 'string' }, authors: { type: 'string' } }, { positionals: true })
  if (!positionals.length) throw usage('usage: hub.mjs scan <path>... [--terms <file>] [--authors <repo>] [--json]')
  const scanText = makeScanner({
    terms: loadTerms(values.terms),
    authors: values.authors ? historyNames(resolve(values.authors)) : [],
  })
  const res = result()
  const files = [...new Set(positionals.flatMap(filesToScan))].sort()
  for (const file of files) {
    const shown = relative(process.cwd(), file) || file
    const text = readTextFile(file)
    const found = text === null ? [] : scanText(text, shown)
    for (const f of found) (f.severity === 'warning' ? res.warnings : res.errors).push({ path: shown, message: f.message })
  }
  for (const arg of positionals) {
    for (const g of gitleaks(resolve(arg))) res.errors.push({ path: relative(process.cwd(), resolve(arg, g.file)), message: g.message })
  }
  res.data = { files: files.length }
  res.lines.push(`scanned ${files.length} files: ${res.errors.length} errors, ${res.warnings.length} warnings`)
  return res
}
