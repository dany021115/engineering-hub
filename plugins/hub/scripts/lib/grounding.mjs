import { basename } from 'node:path'
import { git } from './git.mjs'
import { classify, codeSpans, fences, isPathLike, isPlaceholder, splitFrontmatter } from './markdown.mjs'

const SHELL = new Set(['sh', 'bash', 'shell', 'zsh', 'console', 'shell-session'])
// `_` or an inner capital: CACHE_KEY, dbUrl, process.env.DB_URL; not plain words.
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/
const looksLikeIdentifier = s => IDENTIFIER.test(s) && (s.includes('_') || /[a-z0-9][A-Z]/.test(s))

function notDocs(docsDir) {
  const specs = [':(exclude,glob)**/*.md', ':(exclude,glob)**/*.mdx']
  if (docsDir && docsDir !== '.') specs.push(`:(exclude)${docsDir}/`)
  return specs
}

// `git grep` over tracked files outside the docs: true when the text appears there.
export function grepOutsideDocs(dir, needle, docsDir, { word = false } = {}) {
  const args = ['grep', '-q', '-F', ...(word ? ['-w'] : []), '-e', needle, '--', '.', ...notDocs(docsDir)]
  const r = git(dir, args, { allowFail: true })
  return r.status === 0
}

// Design 15.8.171: a dotted identifier (`Class.method`) is in the code when one tracked file outside
// the docs holds each of its parts as a word.
function partsTogether(dir, parts, docsDir) {
  const args = ['grep', '-q', '-F', '-w', '--all-match', ...parts.flatMap(p => ['-e', p]), '--', '.', ...notDocs(docsDir)]
  return git(dir, args, { allowFail: true }).status === 0
}

// The names of tracked files outside the docs, without extension: a command such as
// `check_index_health` often exists only as its file's name.
function fileStems(dir, docsDir) {
  const out = git(dir, ['ls-files', '--', '.', ...notDocs(docsDir)], { allowFail: true }).stdout ?? ''
  return new Set(out.split('\n').filter(Boolean).map(p => basename(p).replace(/\.[^.]+$/, '')))
}

// PUE-7: backticked paths exist, identifiers appear in the code, shell commands in tracked files.
//   paths      check backticked paths (pages; skills check them in their lint)
//   exists     path -> boolean over the repo with out/ overlaid, siblings included
//   repos      [{ dir, docsDir }] where an identifier may be found, own repo first
//   names      the names of those repos, which a page may give without grounding them
//   absent     related repos that are not checked out: what may live there is only a warning (DRI-5)
export function ground(text, { catalog, paths, exists, repos, names = [], absent = [], cache }) {
  const out = []
  const err = (message, n) => out.push({ gate: 'grounding', message: `line ${n}: ${message}` })
  const warn = (message, n) => out.push({ gate: 'grounding', severity: 'warning', message: `line ${n}: ${message}` })
  const mentions = (name, text) => new RegExp(`(^|[^A-Za-z0-9._-])${name.replace(/[.]/g, '\\.')}([^A-Za-z0-9_-]|$)`).test(text)
  const awayIn = span => {
    const [first, ...rest] = span.split('/')
    return rest.length && absent.includes(first) ? first : null
  }
  const fm = splitFrontmatter(text)
  const lines = classify(fm.body, fm.offset)
  const found = (needle, opts) => {
    const key = `${opts.word ? 'w' : 'f'}:${needle}`
    if (!cache.has(key)) cache.set(key, repos.some(r => grepOutsideDocs(r.dir, needle, r.docsDir, opts)))
    return cache.get(key)
  }
  const together = span => {
    const key = `t:${span}`
    if (!cache.has(key)) cache.set(key, span.includes('.') && repos.some(r => partsTogether(r.dir, span.split('.'), r.docsDir)))
    return cache.get(key)
  }
  const named = span => {
    if (span.includes('.')) return false
    return repos.some(r => {
      const key = `stems:${r.dir}`
      if (!cache.has(key)) cache.set(key, fileStems(r.dir, r.docsDir))
      return cache.get(key).has(span)
    })
  }
  for (const l of lines.filter(x => x.kind === 'prose')) {
    for (const span of codeSpans(l.text)) {
      if (isPlaceholder(span)) continue
      if (isPathLike(span)) {
        if (paths && !exists(span)) {
          const away = awayIn(span)
          if (away) warn(`the path ${span} is in ${away}, which is not next to this repository, so it was not checked`, l.n)
          else err(`the path ${span} does not exist`, l.n)
        }
      } else if (looksLikeIdentifier(span) && !catalog.groundingAllow.includes(span) && !names.includes(span)) {
        if (!found(span, { word: true }) && !together(span) && !named(span)) {
          // DRI-5: a warning only on a line about a repo that is not here; anywhere else an error.
          const about = absent.filter(name => mentions(name, l.text))
          if (about.length) {
            warn(`the identifier ${span} may live in ${about.join(', ')}, which ${about.length === 1 ? 'is' : 'are'} not next to this repository, so it was not checked`, l.n)
          } else err(`the identifier ${span} appears nowhere outside the docs`, l.n)
        }
      }
    }
  }
  for (const f of fences(lines).filter(f => SHELL.has(f.lang))) {
    for (const c of f.lines) {
      const cmd = c.text.trim().replace(/^\$\s+/, '')
      if (!cmd || cmd.startsWith('#') || isPlaceholder(cmd)) continue
      if (!found(cmd, { word: false })) {
        out.push({ gate: 'grounding', severity: 'warning', message: `line ${c.n}: the command "${cmd}" appears in no tracked file outside the docs` })
      }
    }
  }
  return out
}
