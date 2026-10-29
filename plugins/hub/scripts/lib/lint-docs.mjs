import { posix } from 'node:path'
import { DATE, LINE_REF, VERSION } from './lint-skills.mjs'
import { HEADING, anchors, classify, fences, headings, links, splitFrontmatter, withoutCode } from './markdown.mjs'

const LIST_ITEM = /^ {0,3}(?:[-*+]|\d+[.)])\s/
const ORDERED = /^ {0,3}\d+[.)]\s/
const DOC = /\.mdx?$/i
const SHELL_PROMPT = /^\s*\$ /

export const safeDecode = s => {
  try {
    return decodeURI(s)
  } catch {
    return s
  }
}

const escapeRe = s => s.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')

// Intro: the first block after the H1 is prose, not a heading, fence, list or table.
function hasIntro(lines, h1) {
  for (const l of lines) {
    if (l.n <= h1.n || !l.text.trim()) continue
    if (l.kind !== 'prose') return false
    return !HEADING.test(l.text) && !LIST_ITEM.test(l.text) && !/^\s*\|/.test(l.text)
  }
  return false
}

function emptySections(lines, hs) {
  const out = []
  hs.forEach((h, i) => {
    const next = hs[i + 1]
    const end = next ? next.n : Infinity
    const content = lines.some(l => l.n > h.n && l.n < end && l.text.trim())
    if (!content && !(next && next.level > h.level)) out.push(h)
  })
  return out
}

function longestProcedure(lines) {
  let best = { steps: 0, n: 0 }
  let cur = { steps: 0, n: 0 }
  for (const l of lines) {
    if (l.kind === 'prose' && ORDERED.test(l.text)) {
      if (!cur.steps) cur.n = l.n
      cur.steps++
    } else if (l.kind === 'prose' && l.text.trim() && !/^\s/.test(l.text)) {
      if (cur.steps > best.steps) best = cur
      cur = { steps: 0, n: 0 }
    }
  }
  return cur.steps > best.steps ? cur : best
}

// Mermaid (design 15.7.77): the header and the node count; labelled edges are the agent's job.
export function mermaidNodes(code) {
  const body = code.filter(l => l.trim() && !l.trim().startsWith('%%'))
  const header = (body[0] ?? '').trim()
  const nodes = new Set()
  if (/^sequenceDiagram\b/.test(header)) {
    for (const l of body.slice(1)) {
      const t = l.trim()
      const decl = /^(?:participant|actor)\s+(\S+)/.exec(t)
      if (decl) nodes.add(decl[1])
      const msg = /^([^\s:+-][^:]*?)\s*(?:-->>|->>|-->|->|--x|-x|--\)|-\))[+-]?\s*([^:]+?)\s*:/.exec(t)
      if (msg) {
        nodes.add(msg[1].trim())
        nodes.add(msg[2].trim())
      }
    }
    return { kind: 'sequenceDiagram', nodes: nodes.size }
  }
  if (/^flowchart\b/.test(header)) {
    const skip = /^(subgraph|end|classDef|class|style|linkStyle|click|direction)\b/
    for (const l of body.slice(1)) {
      const t = l.trim().replace(/\|[^|]*\|/g, ' ')
      if (skip.test(t)) continue
      for (const part of t.split(/\s*(?:-->|---|-\.->|==>|--[xo]|<-->|-- [^-]+? -->|-\.-|===)\s*/)) {
        const id = /^([A-Za-z0-9_]+)/.exec(part.trim())
        if (id) nodes.add(id[1])
      }
    }
    return { kind: 'flowchart', nodes: nodes.size }
  }
  return { kind: header.split(/\s/)[0] || '(empty)', nodes: 0 }
}

// Structure of a page (PUE-5 part 1) and its links and diagrams (part 2).
//   path       the page's plan path; docsDir its repo's docs folder
//   spec       its catalog entry, or null outside the catalog
//   language   settings.language: the timeless words and required sections are English rules
//   exists     path -> boolean over the repo with out/ overlaid
//   readDoc    path -> text of that page over the same tree, or null
export function lintDoc(text, { path, docsDir, spec, catalog, language, exists, readDoc }) {
  const out = []
  const err = (message, n) => out.push({ gate: 'docs', message: n ? `line ${n}: ${message}` : message })
  const warn = (message, n) => out.push({ gate: 'docs', severity: 'warning', message: n ? `line ${n}: ${message}` : message })
  const fm = splitFrontmatter(text)
  const lines = classify(fm.body, fm.offset)
  const prose = lines.filter(l => l.kind === 'prose')
  const hs = headings(lines)

  const first = lines.find(l => l.text.trim())
  const h1 = first && hs.find(h => h.n === first.n && h.level === 1)
  if (!h1) err(fm.present ? 'the page must open with an H1 right after its frontmatter' : 'the page must open with an H1')
  else if (!hasIntro(lines, h1)) err('the H1 needs an intro of one to three sentences', h1.n)
  for (let i = 1; i < hs.length; i++) {
    if (hs[i].level > hs[i - 1].level + 1) err(`the heading skips a level: ${'#'.repeat(hs[i].level)} after ${'#'.repeat(hs[i - 1].level)}`, hs[i].n)
  }
  for (const h of emptySections(lines, hs)) err(`the section "${h.text}" is empty`, h.n)

  for (const f of fences(lines)) {
    if (!f.lang) err('a code block needs a language', f.start)
    for (const c of f.lines) if (SHELL_PROMPT.test(c.text)) err('a command carries a $ prompt', c.n)
  }
  for (const l of prose) {
    for (const m of l.text.matchAll(/(`+)\$ /g)) if (m) err('a command carries a $ prompt', l.n)
  }

  const procedure = longestProcedure(lines)
  const maxSteps = spec?.maxSteps ?? 10
  if (procedure.steps > maxSteps) err(`a procedure has ${procedure.steps} steps, over ${maxSteps}`, procedure.n)

  const english = language === 'en'
  const timeless = new RegExp(`(?<![\\p{L}\\p{N}])(${catalog.timelessWords.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'iu')
  const placeholder = new RegExp(`\\b(${catalog.placeholderWords.map(escapeRe).join('|')})\\b`)
  for (const l of lines) {
    const ref = LINE_REF.exec(l.text)
    if (ref && !/^https?:/.test(ref[0])) err(`code is cited by line number: ${ref[0]}`, l.n)
    const ph = placeholder.exec(l.text)
    if (ph) err(`the page carries ${ph[1]}`, l.n)
    if (l.kind !== 'prose') continue
    const plain = withoutCode(l.text).replace(/\]\([^)]*\)/g, ']')
    const t = english && timeless.exec(plain)
    if (t) err(`the word "${t[1]}" dates the page`, l.n)
    const date = DATE.exec(plain)
    if (date) warn(`a date: ${date[0]}`, l.n)
    const version = VERSION.exec(plain)
    if (version) warn(`a version: ${version[0]}`, l.n)
  }

  if (english && spec) {
    const present = new Set(hs.map(h => `${'#'.repeat(h.level)} ${h.text.trim()}`))
    for (const s of spec.required) if (!present.has(s)) err(`a ${spec.type} page needs the section ${s}`)
  }
  if (spec?.maxWords) {
    const words = prose.map(l => withoutCode(l.text)).join(' ').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length
    if (words > spec.maxWords) warn(`the page has ${words} words, over ${spec.maxWords} for a ${spec.type} page`)
  }

  lintLinks(prose, { path, docsDir, exists, readDoc, ownText: text, err })
  for (const f of fences(lines).filter(f => f.lang === 'mermaid')) {
    const m = mermaidNodes(f.lines.map(c => c.text))
    if (!['flowchart', 'sequenceDiagram'].includes(m.kind)) err(`a Mermaid ${m.kind} diagram: use flowchart or sequenceDiagram`, f.start)
    else if (m.nodes > 15) err(`a Mermaid diagram has ${m.nodes} nodes, over 15`, f.start)
  }
  return out
}

function lintLinks(prose, { path, docsDir, exists, readDoc, ownText, err }) {
  const docsPrefix = docsDir === '.' ? '' : `${docsDir}/`
  for (const l of prose) {
    for (const link of links(l.text)) {
      const label = link.text.trim().toLowerCase()
      if (!link.image && /^(click )?here$/.test(label)) err('a link whose text is "here": say where it goes', l.n)
      const target = link.target
      if (!target || /^(mailto|tel):/i.test(target)) continue
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        const blob = /\/blob\/([^/]+)\/[^#]*#L\d+/.exec(target)
        if (blob && !/^[0-9a-f]{40}$/.test(blob[1])) err(`a link to lines of a branch: ${target}`, l.n)
        continue
      }
      const [file, rawAnchor] = target.split('#')
      let anchor = rawAnchor
      try {
        anchor = rawAnchor && decodeURIComponent(rawAnchor)
      } catch {}
      let resolved = path
      if (file) {
        if (file.startsWith('/')) {
          err(`a link must be relative, not ${target}`, l.n)
          continue
        }
        resolved = posix.normalize(posix.join(posix.dirname(path), safeDecode(file)))
        const outsideRepo = resolved.startsWith('../') || resolved === '..'
        if (!outsideRepo && !exists(resolved)) {
          err(`a link to a ${DOC.test(resolved) ? 'page' : 'path'} that does not exist: ${target}`, l.n)
          continue
        }
        if (outsideRepo || !resolved.startsWith(docsPrefix)) {
          err(`a relative link leaves the docs folder: ${target}`, l.n)
          continue
        }
        if (!DOC.test(resolved)) {
          err(`a relative link to a file that is not a doc: ${target}; cite code by its path in backticks`, l.n)
          continue
        }
      }
      if (anchor) {
        const text = file ? readDoc(resolved) : ownText
        if (text !== null && !anchors(text).has(anchor)) err(`an anchor that does not resolve: ${target}`, l.n)
      }
    }
  }
}
