import { classify, codeSpans, headings, isPathLike, isPlaceholder, splitFrontmatter } from './markdown.mjs'
import { HOME_PATH } from './scan.mjs'
import { hasType, parseYaml, typeOf } from './yaml.mjs'

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const DATE = /\b\d{4}-\d{2}-\d{2}\b/
export const VERSION = /\bv\d+\.\d+(?:\.\d+)?\b|\b\d+\.\d+\.\d+\b/
// `src/app.ts:42`, not `host.example.com:8080` inside a URL.
export const LINE_REF = /(?<![\w/:.@-])[\w./-]*[\w-]\.[A-Za-z][\w]*:\d+\b/
const DOUBLE_KEYS = ['hooks', 'context', 'agent', 'model']

// Frontmatter, name, description and body of one SKILL.md (PUE-2 to PUE-4).
//   folder      the skill's folder name
//   authoring   the lint for skills written by hand
//   archetype   the plan's or lock's archetype, when there is one
//   sections    check the archetype's required sections (only with a plan or lock, language en)
//   exists      path -> boolean for backticked paths; null skips the check (--authoring)
export function lintSkill(text, { folder, catalog, authoring = false, archetype = null, sections = false, exists = null }) {
  const out = []
  const err = message => out.push({ gate: 'skills', message })
  const fm = splitFrontmatter(text)
  if (!fm.present) {
    err('the frontmatter must start on line 1 with ---')
    return out
  }
  if (!fm.closed) {
    err('the frontmatter is never closed with ---')
    return out
  }
  const parsed = parseYaml(fm.raw)
  if (parsed.error) {
    err(`the frontmatter does not parse: ${parsed.error}`)
    return out
  }
  const data = parsed.data
  const keys = authoring ? catalog.frontmatterKeys.authoring : catalog.frontmatterKeys.generated
  const style = archetype ? archetype === 'style' : /-style$/.test(folder)
  for (const key of Object.keys(data)) {
    if (DOUBLE_KEYS.includes(key)) err(`the key ${key} is not allowed in a skill`)
    else if (!Object.hasOwn(keys, key)) {
      err(authoring ? `the key ${key} is not allowed` : `the key ${key} is not allowed in a generated skill`)
    } else if (!hasType(data[key], keys[key])) err(`the key ${key} must be a ${keys[key]}, not a ${typeOf(data[key])}`)
    else if (key === 'paths' && !authoring && !style) err('the key paths is only allowed in a <repo>-<language>-style skill')
  }

  const { limits } = catalog
  const name = data.name
  if (typeof name === 'string') {
    if (name !== folder) err(`name ${name} must equal its folder ${folder}`)
    if (!SKILL_NAME.test(name)) err(`name ${name} must be lower-case kebab-case`)
    if (name.length > limits.skillNameMaxChars) err(`name has ${name.length} characters, over ${limits.skillNameMaxChars}`)
    if (/claude|anthropic/.test(name)) err(`name ${name} may not contain claude or anthropic`)
    if (!authoring && catalog.bundledSkillNames.includes(name)) err(`name ${name} hides a skill bundled with Claude Code`)
  } else if (name === undefined) err('name is missing')

  const desc = data.description
  if (desc === undefined || desc === null) err('description is missing')
  else if (typeof desc === 'string') {
    if (!desc.trim()) err('description is empty')
    else if (desc.length > limits.descriptionMaxChars) {
      err(`description has ${desc.length} characters, over ${limits.descriptionMaxChars}`)
    } else if (desc.length > limits.descriptionWarnChars) {
      out.push({
        gate: 'skills',
        severity: 'warning',
        message: `description has ${desc.length} characters, over ${limits.descriptionWarnChars}`,
      })
    }
    if (/[<>]/.test(desc)) err('description may not contain < or >')
    const when = authoring && typeof data.when_to_use === 'string' ? data.when_to_use : ''
    if (when && desc.length + when.length > limits.descriptionWithWhenToUseMaxChars) {
      err(`description and when_to_use have ${desc.length + when.length} characters, over ${limits.descriptionWithWhenToUseMaxChars}`)
    }
  }

  // Blank lines around the body do not count against its budget.
  const body = [...fm.body]
  while (body.length && !body[body.length - 1].trim()) body.pop()
  let lead = 0
  while (lead < body.length && !body[lead].trim()) lead++
  const spec = archetype ? catalog.skills[archetype] : null
  const max = Math.min(spec?.maxLines ?? Infinity, limits.skillBodyMaxLines)
  if (body.length - lead > max) {
    err(`the body has ${body.length - lead} lines, over ${max}${spec ? ` for a ${archetype} skill` : ''}`)
  }

  const lines = classify(body, fm.offset)
  for (const l of lines) {
    const home = HOME_PATH.exec(l.text)
    if (home) err(`line ${l.n}: a path inside a personal folder: ${home[0]}`)
    const date = DATE.exec(l.text)
    if (date) err(`line ${l.n}: a date: ${date[0]}`)
    const version = VERSION.exec(l.text)
    if (version) err(`line ${l.n}: a version: ${version[0]}`)
    const ref = LINE_REF.exec(l.text)
    if (ref) err(`line ${l.n}: a line number: ${ref[0]}`)
  }

  if (exists) {
    for (const l of lines.filter(x => x.kind === 'prose')) {
      for (const span of codeSpans(l.text)) {
        if (!isPathLike(span) || isPlaceholder(span) || HOME_PATH.test(span)) continue
        if (!exists(span)) err(`line ${l.n}: the path ${span} does not exist`)
      }
    }
  }

  if (sections && spec) {
    const present = new Set(headings(lines).map(h => `${'#'.repeat(h.level)} ${h.text.trim()}`))
    for (const s of spec.required) if (!present.has(s)) err(`the ${archetype} skill needs the section ${s}`)
  }
  return out
}

export function skillName(text) {
  const fm = splitFrontmatter(text)
  if (!fm.closed) return null
  const parsed = parseYaml(fm.raw)
  return typeof parsed.data?.name === 'string' ? parsed.data.name : null
}
