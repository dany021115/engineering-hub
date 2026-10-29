import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { absentInHead, showHead } from './git.mjs'
import { nameMatcher } from './glob.mjs'
import { buildInventory, isMarkdown, readInventory } from './inventory.mjs'
import { holdsQuote } from './markdown.mjs'
import { lockPath, runDir } from './paths.mjs'
import { repoDirs } from './workspace.mjs'

export const WORKSPACE = '_workspace'

export const normalize = s => s.replace(/\s+/g, ' ').trim()

function lockKeys(dir) {
  const file = lockPath(dir)
  if (!existsSync(file)) return new Set()
  try {
    return new Set(Object.keys(JSON.parse(readFileSync(file, 'utf8')).files ?? {}))
  } catch {
    return new Set()
  }
}

// What the evidence rules need to know about each repo of the run.
export function evidenceEnv(root, catalog) {
  const dirs = repoDirs(root)
  const cache = new Map()
  const isSensitive = nameMatcher(catalog.sensitiveFiles)
  const isConfig = nameMatcher(catalog.configFiles)
  const repo = name => {
    if (!dirs[name]) return null
    if (!cache.has(name)) {
      const dir = dirs[name]
      const inv = readInventory(runDir(root), name) ?? buildInventory(dir, catalog)
      const texts = new Map()
      cache.set(name, {
        name,
        dir,
        docsDir: inv.docsDir,
        sensitive: new Set(inv.sensitive),
        instructions: new Set(inv.instructions),
        generated: lockKeys(dir),
        head(path) {
          if (!texts.has(path)) {
            const t = showHead(dir, path)
            texts.set(path, t === null ? null : normalize(t))
          }
          return texts.get(path)
        },
      })
    }
    return cache.get(name)
  }
  return { root, catalog, dirs, repo, isSensitive, isConfig }
}

// `<repo>:<path>` names another repo; a plain path belongs to the fact's own repo.
export function splitRepoPath(env, value, own) {
  const m = /^([A-Za-z0-9._-]+):(.+)$/.exec(value)
  if (m && env.dirs[m[1]]) return { repo: m[1], path: m[2] }
  if (own === WORKSPACE) return { error: `"${value}" needs the form <repo>:<path> in workspace facts` }
  return { repo: own, path: value }
}

// Design 5.2: an old page or a secret never launders a claim.
function pathProblem(env, ctx, path, kind) {
  if (path === '.hub-run' || path.startsWith('.hub-run/')) return 'scratch files are not evidence'
  if (path === '.claude/hub.lock.json') return 'the lock is not evidence'
  if (env.isSensitive(path) || ctx.sensitive.has(path)) return 'sensitive files are never read'
  if (ctx.generated.has(path)) return 'generated files are not evidence'
  if (kind === 'location') return null
  if (ctx.docsDir && ctx.docsDir !== '.' && path.startsWith(ctx.docsDir + '/')) return 'the docs folder is not evidence'
  const instructions = ctx.instructions.has(path) || ['CLAUDE.md', 'AGENTS.md'].includes(basename(path))
  if (isMarkdown(path) && !instructions) return 'Markdown is not evidence, except instruction files'
  return null
}

function checkItem(env, item, kind, own) {
  const { limits } = env.catalog
  if (item && typeof item.quote === 'string' && typeof item.path === 'string') {
    const at = splitRepoPath(env, item.path, own)
    if (at.error) return at
    const ctx = env.repo(at.repo)
    if (!ctx) return { error: `unknown repository in ${item.path}` }
    const problem = pathProblem(env, ctx, at.path, kind)
    if (problem) return { error: `${item.path}: ${problem}` }
    const quote = normalize(item.quote)
    if (quote.length < limits.quoteMinChars || quote.length > limits.quoteMaxChars) {
      return {
        error: `${item.path}: a quote has ${limits.quoteMinChars}-${limits.quoteMaxChars} characters, this one ${quote.length}`,
      }
    }
    const text = ctx.head(at.path)
    if (text === null) return { error: `${item.path} is not in HEAD` }
    if (!holdsQuote(text, quote)) return { error: `quote not found in HEAD:${item.path}` }
    return { repo: at.repo, path: at.path }
  }
  if (item && typeof item.absence === 'string' && item.absence.trim()) {
    if (item.pathspec !== undefined && typeof item.pathspec !== 'string') return { error: 'pathspec must be a string' }
    const target = item.pathspec ? splitRepoPath(env, item.pathspec, own) : { repo: own }
    if (target.error) return target
    const ctx = env.repo(target.repo)
    if (!ctx) return { error: 'an absence needs a repository: use <repo>:<pathspec>' }
    if (!absentInHead(ctx.dir, item.absence, target.path)) {
      return { error: `"${item.absence}" is present in HEAD${item.pathspec ? ` under ${item.pathspec}` : ''}` }
    }
    return { repo: target.repo, absence: true }
  }
  return { error: 'each evidence item is {path, quote} or {absence, pathspec}' }
}

const ID = /^[A-Za-z][A-Za-z0-9_-]*$/

// Returns null when the fact holds, or the reason it is rejected.
export function checkFact(env, fact, own) {
  const kinds = env.catalog.factKinds.filter(k => k !== 'human')
  if (typeof fact.id !== 'string' || !ID.test(fact.id)) return 'invalid or missing id'
  if (!kinds.includes(fact.kind)) return `unknown kind ${JSON.stringify(fact.kind)}`
  if (typeof fact.claim !== 'string' || !fact.claim.trim()) return 'missing claim'
  if (!Array.isArray(fact.evidence) || !fact.evidence.length) return 'missing evidence'
  const quoted = []
  for (const item of fact.evidence) {
    const r = checkItem(env, item, fact.kind, own)
    if (r.error) return r.error
    if (!r.absence) quoted.push(r)
  }
  if (fact.kind === 'convention') {
    const files = new Set(quoted.map(q => `${q.repo}:${q.path}`))
    if (files.size < 3 && !quoted.some(q => env.isConfig(q.path))) {
      return 'a convention needs quotes in 3 different files, or one in a config file of catalog.configFiles'
    }
  }
  if (fact.kind === 'seam' && new Set(quoted.map(q => q.repo)).size < 2) {
    return 'a seam needs quotes in two repositories (<repo>:<path>)'
  }
  return null
}
