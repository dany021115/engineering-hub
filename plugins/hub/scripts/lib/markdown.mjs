// A line-level view of a Markdown file that the lints, the grounding and the slugger share.
export function splitFrontmatter(text) {
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''))
  if (lines[0] !== '---') return { present: false, closed: false, raw: null, body: lines, offset: 0 }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') {
      return { present: true, closed: true, raw: lines.slice(1, i).join('\n'), body: lines.slice(i + 1), offset: i + 1 }
    }
  }
  return { present: true, closed: false, raw: lines.slice(1).join('\n'), body: [], offset: lines.length }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)?.*$/

// Each body line with its 1-based number in the file and whether it is prose, a fence line or code.
export function classify(body, offset = 0) {
  const out = []
  let open = null
  body.forEach((text, i) => {
    const n = offset + i + 1
    const m = FENCE.exec(text)
    if (open) {
      if (m && m[1][0] === open.marker[0] && m[1].length >= open.marker.length && !m[2]) {
        out.push({ n, text, kind: 'fence-close', fence: open })
        open = null
      } else {
        open.lines.push({ n, text })
        out.push({ n, text, kind: 'code', fence: open })
      }
    } else if (m) {
      open = { marker: m[1], lang: (m[2] ?? '').toLowerCase(), start: n, lines: [] }
      out.push({ n, text, kind: 'fence-open', fence: open })
    } else out.push({ n, text, kind: 'prose' })
  })
  return out
}

export const fences = lines => [...new Set(lines.filter(l => l.fence).map(l => l.fence))]

export const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/

export function headings(lines) {
  return lines
    .filter(l => l.kind === 'prose')
    .map(l => ({ l, m: HEADING.exec(l.text) }))
    .filter(x => x.m)
    .map(({ l, m }) => ({ n: l.n, level: m[1].length, text: m[2], line: l }))
}

export function codeSpans(text) {
  const out = []
  const re = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g
  let m
  while ((m = re.exec(text))) out.push(m[2].trim())
  return out
}

export const withoutCode = text => text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, ' ')

export function links(text) {
  const out = []
  const re = /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+["'][^"']*["'])?\s*\)/g
  let m
  while ((m = re.exec(withoutCode(text)))) out.push({ image: m[1] === '!', text: m[2], target: m[3] })
  return out
}

// Rendered heading text, as Docusaurus slugs it: no inline markup, links reduced to their text.
function headingText(raw) {
  return raw
    .replace(/\s*\{#[^}]+\}\s*$/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*]/g, '')
}

// github-slugger: lower case, drop every character that is not a letter, mark, number,
// connector, space or hyphen, spaces become hyphens; repeats get -1, -2.
export function slugger() {
  const seen = new Map()
  return raw => {
    const base = headingText(raw)
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-')
    let slug = base
    if (seen.has(base)) {
      let n = seen.get(base)
      do slug = `${base}-${++n}`
      while (seen.has(slug))
      seen.set(base, n)
    }
    seen.set(slug, 0)
    return slug
  }
}

export function anchors(text) {
  const { body, offset } = splitFrontmatter(text)
  const lines = classify(body, offset)
  const slug = slugger()
  const set = new Set()
  for (const h of headings(lines)) {
    const explicit = /\{#([^}]+)\}\s*$/.exec(h.text)
    set.add(explicit ? explicit[1] : slug(h.text))
  }
  for (const l of lines.filter(x => x.kind === 'prose')) {
    for (const m of l.text.matchAll(/<a\s[^>]*(?:id|name)=["']([^"']+)["']/g)) set.add(m[1])
  }
  return set
}

export const isPlaceholder = s => /<[^<>]*>/.test(s) || /\$\{[^}]*\}/.test(s)

// Design 15.8.175: an agent may quote `<url>` as `&lt;url&gt;`; decoded, it names the same text.
export const unescapeHtml = s =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&amp;/g, '&')
export const holdsQuote = (text, quote) => text.includes(quote) || text.includes(unescapeHtml(quote))

// A code span that names a file or folder rather than a command, a package or a git ref:
// it has a slash and is absolute, a folder (`deploy/`) or ends in a file name with an extension.
export function isPathLike(s) {
  if (!s || !s.includes('/') || /\s/.test(s) || !/^[\w.<>${}~/-]+$/.test(s)) return false
  if (s === '/' || s.startsWith('//')) return false
  const last = s.split('/').filter(Boolean).pop() ?? ''
  return s.startsWith('/') || s.endsWith('/') || /^\.?[\w-]+(\.[\w-]+)*\.[A-Za-z0-9]+$/.test(last) || /^\.[\w-]+$/.test(last)
}

// Where a prose line splits into sentences: after `.`, `!` or `?`, before a capital or inline markup.
export const SENTENCE = /(?<=[.!?])\s+(?=[A-Z`[*])/
const UNORDERED = /^ {0,3}[-*+]\s/
const TABLE_RULE = /^\s*\|[-:| ]+\|\s*$/

// Design 15.8.166: `text` without the smallest unit that holds `needle`, on the one prose line that
// has it: its sentences when the line is a paragraph alone between blank lines, else the whole line
// when it is a one-line bullet or a table body row. Null when that unit is anything else (a
// heading, a numbered step, a longer item or paragraph, code) or `needle` is not on exactly one line.
export function removeText(text, needle) {
  let want = String(needle ?? '').trim()
  if (!want) return null
  const lines = text.split('\n')
  const fm = splitFrontmatter(text)
  const prose = new Set(classify(fm.body, fm.offset).filter(l => l.kind === 'prose').map(l => l.n))
  const on = w => lines.flatMap((l, i) => (prose.has(i + 1) && l.includes(w) ? [i] : []))
  let hits = on(want)
  if (!hits.length) hits = on((want = unescapeHtml(want)))
  if (hits.length !== 1) return null
  const [i] = hits
  const line = lines[i]
  const blank = s => s === undefined || !s.trim()
  let rest
  if (/^\s*\|/.test(line)) {
    if (TABLE_RULE.test(line) || TABLE_RULE.test(lines[i + 1] ?? '')) return null
    rest = []
  } else if (UNORDERED.test(line)) {
    if (/^\s+\S/.test(lines[i + 1] ?? '')) return null
    rest = []
  } else {
    if (HEADING.test(line) || /^ {0,3}(\d+[.)]|>)/.test(line) || !blank(lines[i - 1]) || !blank(lines[i + 1])) return null
    const at = line.indexOf(want)
    let from = 0
    const sentences = line.split(SENTENCE).map(s => {
      const start = line.indexOf(s, from)
      from = start + s.length
      return { s, start, end: from }
    })
    rest = sentences.filter(x => x.end <= at || x.start >= at + want.length).map(x => x.s)
    rest = rest.length ? [rest.join(' ')] : []
  }
  lines.splice(i, 1, ...rest)
  // A removed paragraph leaves two blank lines side by side: keep one.
  if (!rest.length && blank(lines[i - 1]) && lines[i] !== undefined && blank(lines[i]) && i > 0) lines.splice(i, 1)
  return lines.join('\n')
}
