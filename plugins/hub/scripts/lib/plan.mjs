import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { loadCatalog } from './catalog.mjs'
import { parseOptions, result, usage } from './cli.mjs'
import { readEnv } from './env.mjs'
import { WORKSPACE } from './evidence.mjs'
import { checkedFile } from './facts.mjs'
import { entryEvidence } from './gate-evidence.mjs'
import { hashObject } from './git.mjs'
import { readInventory } from './inventory.mjs'
import { nameMatcher } from './glob.mjs'
import { readJsonl, writeJsonl } from './jsonl.mjs'
import { readLock } from './lock.mjs'
import { RUN_DIR, isSafeRelative, runDir } from './paths.mjs'
import { repoDirs } from './workspace.mjs'

const HEX40 = /^[0-9a-f]{40}$/

// Design 15.8.169: a refresh of one repository of a workspace keeps the workspace that its docs
// home's lock records, so the home's workspace pages can be refreshed with it.
function lockedWorkspace(dirs, ws, repo) {
  if (!ws || typeof ws !== 'object' || !Array.isArray(ws.repos) || !dirs[ws.home]) return false
  const recorded = readLock(dirs[ws.home])?.workspace?.repos
  const same = Array.isArray(recorded) && recorded.length === ws.repos.length && recorded.every(n => ws.repos.includes(n))
  return same && ws.repos.length > 1 && ws.repos.includes(repo)
}
const MODES = ['init', 'refresh', 'site']
const ACTIONS = ['create', 'update', 'propose', 'delete', 'dropped']
const KEPT = ['create', 'update', 'propose']
const WRITTEN = ['create', 'update']
const SKILL_PATH = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const DENY_RULE = /^[A-Za-z][A-Za-z0-9_]*\(.+\)$/
const KEBAB = '[a-z0-9]+(?:-[a-z0-9]+)*'
const SITE_WORKFLOW = '.github/workflows/docs-site.yml'

const escapeRe = s => s.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')

// The repo's name as a skill name part: lowercase, every run of other characters a `-`, so that a
// repo such as `dlujo_store` still gets kebab-case skills (`working-in-dlujo-store`).
export const skillSlug = repo =>
  repo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

// `{repo}` is the repo's skill slug; any other `{placeholder}` is a kebab-case segment.
function patternRe(pattern, repo) {
  const body = pattern
    .split(/(\{[^}]+\})/)
    .map(part => (part === '{repo}' ? escapeRe(skillSlug(repo)) : part.startsWith('{') ? KEBAB : escapeRe(part)))
    .join('')
  return new RegExp(`^${body}$`)
}

export function skillArchetype(catalog, repo, name) {
  // Most specific first: the procedure pattern also matches guardrail and style names.
  for (const key of ['working-in', 'guardrail', 'style', 'procedure']) {
    if (catalog.skills[key] && patternRe(catalog.skills[key].name, repo).test(name)) return key
  }
  return null
}

export function matchPage(catalog, rel) {
  const entries = Object.entries(catalog.pages)
  const fixed = entries.filter(([, p]) => !p.path.includes('{'))
  const patterned = entries.filter(([, p]) => p.path.includes('{'))
  for (const [key, spec] of [...fixed, ...patterned]) {
    if (patternRe(spec.path, '').test(rel)) return { key, spec }
  }
  return null
}

// Human answers never count, nor (for style) a convention a linter config already enforces
// (design 15.8.114, 15.8.143). `plan` and `check --round` count the same way.
export function countSupported(catalog, spec, factIds, facts) {
  const isConfig = nameMatcher(catalog.configFiles)
  const ignored = []
  let count = 0
  for (const id of factIds) {
    const fact = facts.get(id)
    if (!fact || fact.kind === 'human') continue
    const configOnly =
      fact.kind === 'convention' &&
      fact.evidence?.length &&
      fact.evidence.every(e => typeof e.path === 'string' && isConfig(e.path))
    if (spec.excludeConfigOnlyConventions && configOnly) ignored.push(id)
    else count++
  }
  return { count, ignored }
}

export function loadPlanFile(file) {
  const path = resolve(file)
  if (!existsSync(path)) throw usage(`${path} does not exist`)
  const run = dirname(path)
  if (basename(run) !== RUN_DIR) throw usage(`a plan lives in <root>/${RUN_DIR}/, not in ${run}`)
  let plan
  try {
    plan = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw usage(`${path} is not valid JSON: ${err.message}`)
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw usage(`${path} is not a plan object`)
  return { path, plan, run, root: dirname(run) }
}

export function factIndex(root, repo) {
  const index = new Map()
  for (const name of [repo, WORKSPACE]) {
    for (const item of readJsonl(checkedFile(root, name)).items) if (item.type === 'fact') index.set(item.id, item)
  }
  return index
}

function diskSkills(dirs) {
  const found = new Map()
  for (const [repo, dir] of Object.entries(dirs)) {
    const base = join(dir, '.claude', 'skills')
    if (!existsSync(base)) continue
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (d.isDirectory() && existsSync(join(base, d.name, 'SKILL.md'))) {
        if (!found.has(d.name)) found.set(d.name, [])
        found.get(d.name).push(repo)
      }
    }
  }
  return found
}

function validateSite(plan, err) {
  for (const [repo, r] of Object.entries(plan.repos)) {
    for (const f of r.files ?? []) {
      const where = { repo, id: f.id, path: f.path }
      if (!['create', 'propose'].includes(f.action)) err(where, `a site plan only creates or proposes, not ${f.action}`)
      if (!(isSafeRelative(f.path) && (f.path.startsWith('docs-site/') || f.path === SITE_WORKFLOW))) {
        err(where, `a site plan only writes under docs-site/ or ${SITE_WORKFLOW}`)
      }
    }
  }
}

export function validatePlan(plan, { root, catalog }) {
  const errors = []
  const err = (where, message) => errors.push({ ...where, message })
  if (plan.schema !== 1) err({}, 'schema must be 1')
  if (!MODES.includes(plan.mode)) err({}, `mode must be one of ${MODES.join(', ')}`)
  if (typeof plan.generator !== 'string') err({}, 'generator must be a string')
  // A code, as the gates read it ('en' turns on the section checks), never a name such as "English".
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(plan.settings?.language ?? '')) err({}, 'settings.language must be a language code such as en or es')
  if (typeof plan.approved !== 'boolean') err({}, 'approved must be true or false')
  if (!plan.repos || typeof plan.repos !== 'object' || !Object.keys(plan.repos).length) {
    err({}, 'repos must name at least one repository')
    return errors
  }
  if (plan.mode === 'site') {
    validateSite(plan, err)
    return errors
  }

  const env = readEnv(root)
  const dirs = repoDirs(root)
  const names = Object.keys(plan.repos)
  const ws = plan.workspace
  if (names.length === 1 && ws !== null && !(plan.mode === 'refresh' && lockedWorkspace(dirs, ws, names[0]))) {
    err({}, "workspace must be null with one repository, unless a refresh keeps the workspace its docs home's lock records")
  }
  if (names.length > 1) {
    if (!ws || typeof ws !== 'object' || !Array.isArray(ws.repos)) err({}, 'workspace needs home and repos')
    else {
      if (!names.includes(ws.home)) err({}, `workspace.home ${ws.home} is not a repository of the plan`)
      for (const n of names) if (!ws.repos.includes(n)) err({ repo: n }, 'missing from workspace.repos')
    }
  }
  const home = ws?.home ?? null
  const onDisk = diskSkills(dirs)
  const planned = new Map()
  const ids = new Set()

  for (const [repo, r] of Object.entries(plan.repos)) {
    const dir = dirs[repo]
    if (!dir) {
      err({ repo }, `no repository named ${repo} in ${root}`)
      continue
    }
    if (!HEX40.test(r.head ?? '')) err({ repo }, 'head must be a 40-character commit id')
    // The facts were checked against the HEAD this run's inventory took; a head from memory is not it.
    const inventory = readInventory(runDir(root), repo)
    if (inventory?.head && HEX40.test(r.head ?? '') && r.head !== inventory.head) {
      err({ repo }, `head must be ${inventory.head}, the HEAD in inventory/${repo}.json`)
    }
    if (typeof r.docsDir !== 'string' || !(r.docsDir === '.' || isSafeRelative(r.docsDir))) {
      err({ repo }, 'docsDir must be a relative folder')
    }
    for (const key of ['files', 'rejected', 'questions']) {
      if (!Array.isArray(r[key])) err({ repo }, `${key} must be an array`)
    }
    if (!Array.isArray(r.files)) continue
    const lock = readLock(dir)
    const facts = factIndex(root, repo)
    const docsPrefix = r.docsDir === '.' ? '' : `${r.docsDir}/`
    const exists = p => existsSync(join(dir, p))
    const edited = p => exists(p) && hashObject(dir, p) !== lock.files[p].hash
    const inLock = p => Boolean(lock?.files?.[p])
    const questions = Array.isArray(r.questions) ? r.questions : []
    const live = r.files.filter(f => f.action !== 'dropped')
    const byId = new Map(r.files.map(f => [f.id, f]))
    const pageCounts = {}
    const keptSkills = []

    for (const f of r.files) {
      const where = { repo, id: f.id, path: f.path }
      if (typeof f.id !== 'string' || !f.id) err(where, 'every entry needs an id')
      else if (ids.has(f.id)) err(where, `id ${f.id} is used twice`)
      else ids.add(f.id)
      if (!isSafeRelative(f.path)) {
        err(where, 'path must be relative to the repository, without ..')
        continue
      }
      if (!ACTIONS.includes(f.action)) {
        err(where, `action must be one of ${ACTIONS.join(', ')}`)
        continue
      }
      if (WRITTEN.includes(f.action) && !['skill', 'page'].includes(f.kind)) err(where, 'kind must be skill or page')

      if (f.action === 'create' && exists(f.path)) {
        err(where, `path is taken: ${f.path} exists; use propose for a human file`)
      }
      if (f.action === 'update' || f.action === 'delete') {
        // A delete of a lock file that is already gone confirms the disappearance (design 8).
        if (!inLock(f.path)) err(where, `${f.action} needs a file of the lock`)
        else if (!exists(f.path)) {
          if (f.action === 'update') err(where, `${f.path} has disappeared from the repository; it is never recreated`)
        } else if (edited(f.path)) err(where, `${f.path} was edited by hand since it was generated: use propose`)
      }
      if (f.action === 'propose') {
        if (f.offer !== undefined) validateOffer(f, where)
        else {
          const special = catalog.instructionFiles.includes(f.path) || f.path === catalog.settingsFile
          const human = exists(f.path) && (!inLock(f.path) || edited(f.path))
          if (!special && !human) err(where, 'propose is for human, edited, instruction or settings files and offers')
        }
      }

      const factIds = f.facts ?? []
      if (!Array.isArray(factIds)) err(where, 'facts must be an array of fact ids')
      else for (const id of factIds) if (!facts.has(id)) err(where, `fact ${id} is not supported`)

      if (!KEPT.includes(f.action)) continue
      if (f.kind === 'skill') keptSkills.push(checkSkill(f, where, Array.isArray(factIds) ? factIds : []))
      if (f.kind === 'page' && WRITTEN.includes(f.action)) checkPage(f, where)
    }

    // Caps (design 6.1): by count, and nothing over-cap may outrank a kept skill.
    const kept = keptSkills.filter(Boolean)
    if (kept.length > catalog.caps.skillsPerRepo) {
      err({ repo }, `${kept.length} skills exceed caps.skillsPerRepo (${catalog.caps.skillsPerRepo})`)
    }
    const procedures = kept.filter(s => s.archetype === 'procedure').length
    if (procedures > catalog.caps.proceduresPerRepo) {
      err({ repo }, `${procedures} procedures exceed caps.proceduresPerRepo (${catalog.caps.proceduresPerRepo})`)
    }
    for (const rej of Array.isArray(r.rejected) ? r.rejected : []) {
      if (!catalog.rejectReasons.includes(rej?.reason)) {
        err({ repo, path: rej?.idea }, `reason ${JSON.stringify(rej?.reason)} is not in the closed list`)
        continue
      }
      if (rej.reason !== 'over-cap') continue
      const m = SKILL_PATH.exec(rej.idea ?? '')
      const archetype = m && skillArchetype(catalog, repo, m[1])
      if (!archetype) continue
      const priority = catalog.skills[archetype].priority
      const outranked = kept.filter(s => catalog.skills[s.archetype]?.priority > priority)
      if (outranked.length) {
        err(
          { repo, path: rej.idea },
          `over-cap ${archetype} outranks kept ${outranked.map(s => s.name).join(', ')}; keep it instead`,
        )
      }
    }

    checkInstructionLines()
    checkGuardrailPairs()

    function validateOffer(f, where) {
      const spec = catalog.offers[f.offer]
      if (!spec) return err(where, `unknown offer ${JSON.stringify(f.offer)}`)
      if (!spec.paths.includes(f.path)) err(where, `offer ${f.offer} goes to ${spec.paths.join(' or ')}`)
      if (spec.needsGitSource && !env.gitSource) {
        err(where, `offer ${f.offer} needs the claude CLI and a git source for engineering-hub; env.json has none`)
      }
      if (f.offer === 'instructions-line') {
        const target = exists('CLAUDE.md') ? 'CLAUDE.md' : 'AGENTS.md'
        if (f.path !== target) err(where, `the instructions line goes to ${target}`)
      }
      if (f.offer === 'guardrail-deny') {
        const ok = Array.isArray(f.deny) && f.deny.length && f.deny.every(d => typeof d === 'string' && DENY_RULE.test(d))
        if (!ok) err(where, 'deny must be a non-empty array of Tool(pattern) rules')
      }
    }

    function checkSkill(f, where, factIds) {
      const m = SKILL_PATH.exec(f.path)
      if (!m) return err(where, 'a skill lives at .claude/skills/<name>/SKILL.md')
      const name = m[1]
      const spec = catalog.skills[f.archetype]
      if (!spec) return err(where, `archetype must be one of ${Object.keys(catalog.skills).join(', ')}`)
      const { limits } = catalog
      if (!SKILL_NAME.test(name) || name.length > limits.skillNameMaxChars) {
        err(where, `skill name ${name} must be kebab-case, at most ${limits.skillNameMaxChars} characters`)
      }
      if (/claude|anthropic/.test(name)) err(where, `skill name ${name} may not contain claude or anthropic`)
      if (catalog.bundledSkillNames.includes(name)) err(where, `skill name ${name} hides a skill bundled with Claude Code`)
      if (!patternRe(spec.name, repo).test(name)) err(where, `a ${f.archetype} skill is named ${spec.name}`)
      const others = (onDisk.get(name) ?? []).filter(owner => owner !== repo)
      if (others.length) err(where, `skill name ${name} already exists on disk in ${others.join(', ')}`)
      if (planned.has(name)) err(where, `skill name ${name} is planned twice (also ${planned.get(name)})`)
      else planned.set(name, `${repo} ${f.id}`)

      const { count, ignored } = countSupported(catalog, spec, factIds, facts)
      if (count < spec.minFacts) {
        const note = ignored.length ? `; ${ignored.join(', ')} only cite linter or formatter config` : ''
        err(where, `${name} has ${count} supported facts, below minFacts ${spec.minFacts} for ${f.archetype}${note}`)
      }
      return { name, archetype: f.archetype, entry: f }
    }

    function checkPage(f, where) {
      if (!f.path.startsWith(docsPrefix)) return err(where, `pages live under the docs folder ${r.docsDir}/`)
      const rel = f.path.slice(docsPrefix.length)
      const match = matchPage(catalog, rel)
      if (!match) return err(where, `${f.path} is not a page of the catalog`)
      const { key, spec } = match
      if (!f.trigger) err(where, `${f.path} needs a trigger from its catalog entry: ${spec.when.join(', ')}`)
      else if (!spec.when.includes(f.trigger)) {
        err(where, `trigger ${f.trigger} is not in the when of ${f.path}: ${spec.when.join(', ')}`)
      }
      if (f.type !== undefined && f.type !== spec.type) err(where, `${f.path} is a ${spec.type} page`)
      if (spec.workspace) {
        if (!ws) err(where, 'workspace pages need a workspace of two or more repositories')
        else if (repo !== home) err(where, `workspace pages belong in the docs home ${home}, not in ${repo}`)
      }
      if (key === 'index' && f.action === 'create' && exists(`${docsPrefix}README.md`)) {
        err(where, `${docsPrefix}README.md is the index already: propose links to it instead`)
      }
      pageCounts[key] = (pageCounts[key] ?? 0) + 1
      const max = spec.max ?? 1
      if (pageCounts[key] > max) err(where, `the catalog allows at most ${max} ${spec.path} in a repository`)
    }

    // Design 15.8.109: one line that points at the overlay or, without it, at the docs index.
    function checkInstructionLines() {
      const overlayName = `working-in-${skillSlug(repo)}`
      const skillPath = `.claude/skills/${overlayName}/SKILL.md`
      const indexPath = `${docsPrefix}index.md`
      const writes = p => live.some(f => f.path === p && WRITTEN.includes(f.action))
      for (const f of live.filter(f => f.offer === 'instructions-line')) {
        const where = { repo, id: f.id, path: f.path }
        if (typeof f.text !== 'string' || !f.text.trim() || /[\r\n]/.test(f.text.trim())) {
          err(where, 'text must be exactly one line')
          continue
        }
        if (writes(skillPath)) {
          if (!f.text.includes(overlayName)) err(where, `the line must cite ${overlayName}`)
        } else if (writes(indexPath)) {
          if (!f.text.includes(indexPath)) err(where, `the line must cite ${indexPath}`)
        } else err(where, `nothing to point at: the plan writes neither ${overlayName} nor ${indexPath}`)
      }
    }

    // Design 15.8.142: the same P2 question decides a guardrail skill and its one deny entry.
    function checkGuardrailPairs() {
      const isGuardSkill = f => f?.kind === 'skill' && f.archetype === 'guardrail' && f.action !== 'dropped'
      const isDeny = f => f?.offer === 'guardrail-deny' && f.action !== 'dropped'
      const deciding = id => questions.filter(q => Array.isArray(q.decides) && q.decides.includes(id))
      for (const g of live.filter(isDeny)) {
        const where = { repo, id: g.id, path: g.path }
        const qs = deciding(g.id)
        if (!qs.length) err(where, `no P2 question decides ${g.id}; its guardrail skill's question must`)
        for (const q of qs) {
          if (!q.decides.some(id => isGuardSkill(byId.get(id)))) {
            err(where, `question ${q.id} decides ${g.id} but no guardrail skill`)
          }
        }
      }
      for (const s of live.filter(isGuardSkill)) {
        const name = SKILL_PATH.exec(s.path)?.[1] ?? s.path
        const where = { repo, id: s.id, path: s.path }
        const qs = deciding(s.id)
        if (!qs.length) err(where, `${name} needs a P2 question that decides it`)
        for (const q of qs) {
          const denies = q.decides.filter(id => isDeny(byId.get(id)))
          if (!denies.length) err(where, `${name} needs its guardrail-deny entry in question ${q.id}`)
          if (denies.length > 1) err(where, `${name} has more than one guardrail-deny entry: ${denies.join(', ')}`)
        }
      }
    }
  }
  return errors
}

// Design 15.7.59: every decided entry needs a "yes"; answers become human facts, by role.
function approve(plan, root) {
  const errors = []
  const answers = []
  for (const [repo, r] of Object.entries(plan.repos)) {
    const byId = new Map((r.files ?? []).map(f => [f.id, f]))
    for (const q of r.questions ?? []) {
      const decided = (q.decides ?? []).map(id => byId.get(id)).filter(f => f && f.action !== 'dropped')
      if (decided.length && q.answer !== 'yes') {
        const list = decided.map(f => `${f.id} (${f.path})`).join(', ')
        errors.push({ repo, id: q.id, message: `question ${q.id} decides ${list} without a "yes"` })
      }
      if (q.answer === null || q.answer === undefined) continue
      if (typeof q.role !== 'string' || !q.role.trim()) {
        errors.push({ repo, id: q.id, message: 'an answered question needs the role of who answered' })
        continue
      }
      answers.push({ repo, q })
    }
  }
  if (errors.length) return errors
  for (const repo of new Set(answers.map(a => a.repo))) {
    const file = checkedFile(root, repo)
    const mine = answers.filter(a => a.repo === repo).map(a => a.q)
    const items = readJsonl(file).items.filter(i => !(i.type === 'fact' && mine.some(q => q.id === i.id)))
    const human = mine.map(q => ({
      type: 'fact',
      id: q.id,
      kind: 'human',
      claim: q.text,
      answer: q.answer,
      role: q.role,
    }))
    writeJsonl(file, [...items, ...human])
  }
  plan.approved = true
  return errors
}

export default function planCommand(argv) {
  const { values, positionals } = parseOptions(argv, { approve: { type: 'boolean' } }, { positionals: true })
  if (positionals.length !== 1) throw usage('usage: hub.mjs plan <plan.json> [--approve] [--json]')
  const { path, plan, root } = loadPlanFile(positionals[0])
  const catalog = loadCatalog()
  const res = result()
  res.errors.push(...validatePlan(plan, { root, catalog }))
  if (!res.errors.length && values.approve) {
    res.errors.push(...(plan.mode === 'site' ? [] : approve(plan, root)))
    if (!res.errors.length) {
      plan.approved = true
      writeFileSync(path, JSON.stringify(plan, null, 2) + '\n')
    }
  }
  const entries = Object.values(plan.repos ?? {}).reduce((n, r) => n + (r.files?.length ?? 0), 0)
  res.data = { plan: path, entries, approved: plan.approved === true }
  // EVI-1: the checked fact behind each entry, for the P2 text; a site plan has no facts.
  if (plan.mode !== 'site') {
    const { rows, warnings } = entryEvidence(root, plan, catalog)
    res.data.evidence = rows
    res.warnings.push(...warnings)
  }
  if (!res.errors.length) res.lines.push(values.approve ? `plan approved: ${path}` : `plan is valid: ${entries} entries`)
  return res
}
