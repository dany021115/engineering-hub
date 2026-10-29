// The YAML subset a SKILL.md frontmatter uses: `key: scalar`, quoted strings, block and flow
// lists, block scalars. Anything a real YAML parser would reject is an error here too, because
// Claude Code then loads the skill with empty metadata (exp-skills c11).
const KEY = /^([A-Za-z0-9_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/

const indentOf = line => line.length - line.trimStart().length
const isBlank = line => !line.trim() || /^\s*#/.test(line)

function stripComment(value) {
  const i = value.search(/\s#/)
  return (i === -1 ? value : value.slice(0, i)).trim()
}

function plainScalar(value) {
  if (/^(true|True|TRUE)$/.test(value)) return true
  if (/^(false|False|FALSE)$/.test(value)) return false
  if (/^(null|Null|NULL|~)?$/.test(value)) return null
  if (/^[-+]?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

function checkPlain(value) {
  if (/^[`@]/.test(value)) return `a plain value may not start with ${value[0]}; quote it`
  if (/^[&*!%]/.test(value)) return 'anchors, aliases, tags and directives are not supported'
  if (/:(\s|$)/.test(value)) return 'a plain value may not contain ": "; quote it'
  return null
}

function unescapeDouble(s) {
  return s.replace(/\\(["\\/nt])/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c)
}

// A quoted scalar may run over several lines; it ends at its closing quote.
function quoted(lines, i, start) {
  const q = start[0]
  let text = start.slice(1)
  let j = i
  for (;;) {
    const close = q === '"' ? /(^|[^\\])(\\\\)*"/.exec(text) : /(^|[^'])('')*'(?!')/.exec(text)
    if (close) {
      const end = close.index + close[0].length
      const body = text.slice(0, end - 1)
      const rest = text.slice(end).trim()
      if (rest && !rest.startsWith('#')) return { error: `unexpected text after a quoted value: ${rest}` }
      const value = q === '"' ? unescapeDouble(body) : body.replace(/''/g, "'")
      return { value: value.replace(/\s*\n\s*/g, ' '), next: j + 1 }
    }
    j++
    if (j >= lines.length) return { error: `the quote ${q} is never closed` }
    text += '\n' + lines[j]
  }
}

function flowList(text) {
  const inner = text.trim()
  if (!inner.endsWith(']')) return { error: 'the [ list is never closed' }
  const body = inner.slice(1, -1).trim()
  if (!body) return { value: [] }
  return {
    value: body.split(',').map(s => {
      const t = s.trim()
      return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : plainScalar(t)
    }),
  }
}

function blockScalar(lines, i, indicator) {
  const out = []
  let j = i + 1
  while (j < lines.length && (!lines[j].trim() || indentOf(lines[j]) > 0)) out.push(lines[j++])
  while (out.length && !out[out.length - 1].trim()) out.pop()
  const pad = Math.min(...out.filter(l => l.trim()).map(indentOf), Infinity)
  const body = out.map(l => l.slice(Number.isFinite(pad) ? pad : 0))
  const value = indicator.startsWith('|') ? body.join('\n') : body.join(' ').replace(/\s+/g, ' ').trim()
  return { value, next: j }
}

// Indented lines under `key:` with no value: a block list, or a nested map kept as an object.
function nested(lines, i) {
  let j = i + 1
  const block = []
  while (j < lines.length && (isBlank(lines[j]) || indentOf(lines[j]) > 0)) {
    if (!isBlank(lines[j])) block.push(lines[j])
    j++
  }
  if (!block.length) return { value: null, next: j }
  if (block.every(l => /^\s*-(\s|$)/.test(l))) {
    const items = []
    for (const l of block) {
      const v = l.trim().slice(1).trim()
      if (/^(["']).*\1$/.test(v)) items.push(v.slice(1, -1))
      else {
        const problem = checkPlain(stripComment(v))
        if (problem) return { error: problem }
        items.push(plainScalar(stripComment(v)))
      }
    }
    return { value: items, next: j }
  }
  if (block.every(l => KEY.test(l.trim()))) return { value: {}, next: j }
  return { error: `cannot parse the indented lines under line ${i + 1}` }
}

export function parseYaml(raw) {
  const lines = raw.split('\n').map(l => l.replace(/\r$/, ''))
  const data = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line)) {
      i++
      continue
    }
    if (indentOf(line) > 0) return { error: `line ${i + 1}: unexpected indentation` }
    const m = KEY.exec(line)
    if (!m) return { error: `line ${i + 1}: expected "key: value"` }
    const key = m[1]
    if (Object.hasOwn(data, key)) return { error: `line ${i + 1}: the key ${key} appears twice` }
    const value = (m[2] ?? '').trim()
    let r
    if (!value || value.startsWith('#')) r = nested(lines, i)
    else if (value[0] === '"' || value[0] === "'") r = quoted(lines, i, value)
    else if (value[0] === '[') r = { ...flowList(stripComment(value)), next: i + 1 }
    else if (value[0] === '{') r = { value: {}, next: i + 1 }
    else if (/^[|>][-+]?\s*(#.*)?$/.test(value)) r = blockScalar(lines, i, value)
    else {
      // A plain scalar continues on more-indented lines, folded with spaces.
      let text = stripComment(value)
      let j = i + 1
      while (j < lines.length && lines[j].trim() && indentOf(lines[j]) > 0) text += ' ' + stripComment(lines[j++].trim())
      const problem = checkPlain(text)
      r = problem ? { error: problem } : { value: plainScalar(text), next: j }
    }
    if (r.error) return { error: `line ${i + 1} (${key}): ${r.error}` }
    data[key] = r.value
    i = r.next
  }
  return { data }
}

export function typeOf(value) {
  if (Array.isArray(value)) return 'list'
  if (value === null) return 'null'
  return typeof value
}

// Catalog types: string, boolean, string-or-list.
export function hasType(value, type) {
  if (type === 'string') return typeof value === 'string'
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'string-or-list') {
    return typeof value === 'string' || (Array.isArray(value) && value.every(v => typeof v === 'string'))
  }
  return false
}
