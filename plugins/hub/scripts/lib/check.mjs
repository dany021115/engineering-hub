import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { loadCatalog } from './catalog.mjs'
import { parseOptions, result, usage } from './cli.mjs'
import { confinement } from './confine.mjs'
import { optionalLinters, validateSkills } from './external.mjs'
import { fileGates, lockRoot, lockTargets, overCap, planTargets, skillOwners, treeState } from './gates.mjs'
import { lsFiles, topLevel } from './git.mjs'
import { lintSkill, skillName } from './lint-skills.mjs'
import { readLock } from './lock.mjs'
import { stagingFile } from './paths.mjs'
import { loadPlanFile } from './plan.mjs'
import { isWorkspaceRoot, walkFiles } from './workspace.mjs'

function record(res, target, findings) {
  for (const f of findings) {
    const finding = { repo: target.repo, id: target.id, path: target.path, ...f }
    ;(f.severity === 'warning' ? res.warnings : res.errors).push(finding)
  }
}

// Round 2 (design 15.7.66, 15.8.139): every entry still failing a gate becomes dropped.
function dropFailing(plan, path, res) {
  const dropped = []
  for (const e of res.errors) {
    if (!e.id || !e.gate || e.gate === 'confinement') continue
    const f = plan.repos[e.repo]?.files?.find(x => x.id === e.id)
    if (!f || f.action === 'dropped') continue
    f.action = 'dropped'
    f.reason = `gate:${e.gate}`
    dropped.push({ repo: e.repo, id: f.id, path: f.path, reason: f.reason })
  }
  if (dropped.length) writeFileSync(path, JSON.stringify(plan, null, 2) + '\n')
  return dropped
}

function checkPlan(file, round, catalog, res) {
  const { path, plan, root } = loadPlanFile(file)
  const state = treeState(root, { plan, catalog, language: plan.settings?.language ?? 'en', mode: 'plan' })
  const repos = Object.keys(plan.repos ?? {})
  for (const repo of repos) if (!state.dirs[repo]) throw usage(`no repository named ${repo} in ${root}`)
  const owners = skillOwners(state)
  for (const repo of repos) {
    const targets = planTargets(state, repo)
    overCap(state, repo, targets)
    for (const t of targets) record(res, t, fileGates(t, state, { owners }))

    const skills = targets.filter(t => t.kind === 'skill' && ['create', 'update'].includes(t.entry.action))
    const validated = validateSkills(stagingFile(root, repo, '.claude/skills'), skills)
    if (validated.warning) res.warnings.push({ repo, message: validated.warning })
    for (const f of validated.findings) record(res, f.target ?? { repo }, [{ gate: 'validate', message: f.message }])

    const pages = targets.filter(t => t.kind === 'page')
    const linted = optionalLinters(state.dirs[repo], pages)
    for (const w of linted.warnings) res.warnings.push({ repo, message: w })
    for (const f of linted.findings) record(res, f.target, [{ gate: 'docs', message: f.message }])
    res.data.targets.push(...targets.map(t => `${repo}:${t.path}`))
  }
  // Before place nothing writes in a repo outside .hub-run/: any change is unexpected (PUE-8).
  for (const f of confinement(root, state.dirs, repos, isWorkspaceRoot(root))) {
    res.errors.push({ repo: f.repo, path: f.path, gate: f.gate, message: `${f.message}; nothing was deleted: decide what to keep` })
  }
  res.data.round = round
  res.data.dropped = round === 2 ? dropFailing(plan, path, res) : []
}

function checkLock(file, catalog, res) {
  const path = resolve(file)
  if (!existsSync(path)) throw usage(`${path} does not exist`)
  const dir = dirname(dirname(path))
  const lock = readLock(dir)
  if (!lock || resolve(dir, '.claude', 'hub.lock.json') !== path) throw usage(`${path} is not <repo>/.claude/hub.lock.json`)
  const root = lockRoot(dir)
  const repo = basename(dir)
  const state = treeState(root, { catalog, language: lock.settings?.language ?? 'en', mode: 'lock', repo })
  const targets = lockTargets(state, repo)
  overCap(state, repo, targets)
  // Design 15.7.76: unedited skills and pages pass every gate; edited files and site and ci
  // entries only the scan.
  for (const t of targets) record(res, t, fileGates(t, state))
  res.data.targets.push(...targets.map(t => t.path))
  res.data.edited = targets.filter(t => t.edited).map(t => t.path)
}

function checkSkills(dirs, authoring, catalog, res) {
  const groups = []
  for (const d of dirs) {
    const dir = resolve(d)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw usage(`${dir} is not a folder`)
    const skip = (p, ent) => ent.isDirectory() && (ent.name === 'node_modules' || ent.name === '.git')
    const top = topLevel(dir)
    const tracked = top ? new Set(lsFiles(top)) : new Set()
    const exists = p => !p.startsWith('/') && (tracked.has(p) || (p.endsWith('/') && [...tracked].some(x => x.startsWith(p))))
    const targets = walkFiles(dir, skip)
      .filter(p => basename(p) === 'SKILL.md')
      .map(p => ({ path: relative(process.cwd(), join(dir, p)) || p, file: join(dir, p), kind: 'skill' }))
    groups.push({ targets, exists })
  }
  // Without --authoring: the rules of generated skills except archetype sections and language
  // (design 15.8.116), plus the cap per folder and unique names across folders.
  const names = new Map()
  for (const { targets, exists } of groups) {
    for (const [i, t] of targets.entries()) {
      const text = readFileSync(t.file, 'utf8')
      const folder = basename(dirname(t.file))
      const found = lintSkill(text, { folder, catalog, authoring, exists: authoring ? null : exists })
      if (!authoring) {
        if (i >= catalog.caps.skillsPerRepo) {
          found.push({ gate: 'skills', message: `${targets.length} skills in ${dirname(dirname(t.path))}, over caps.skillsPerRepo (${catalog.caps.skillsPerRepo})` })
        }
        const name = skillName(text)
        if (name && names.has(name)) found.push({ gate: 'skills', message: `skill name ${name} is also used by ${names.get(name)}` })
        else if (name) names.set(name, t.path)
      }
      record(res, t, found)
    }
    res.data.targets.push(...targets.map(t => t.path))
  }
}

export default function check(argv) {
  const { values, positionals } = parseOptions(
    argv,
    {
      round: { type: 'string' },
      lock: { type: 'string' },
      skills: { type: 'string', multiple: true },
      authoring: { type: 'boolean' },
    },
    { positionals: true },
  )
  const catalog = loadCatalog()
  const res = result()
  res.data = { targets: [] }
  const plans = values.skills ? 0 : positionals.length
  const modes = [plans > 0, Boolean(values.lock), Boolean(values.skills)].filter(Boolean).length
  if (modes !== 1) throw usage('usage: hub.mjs check <plan.json> --round <n> | --lock <file> | --skills <dir>... [--authoring]')
  if (values.authoring && !values.skills) throw usage('--authoring only applies to --skills')
  if (values.skills) {
    // `--skills a b` leaves extra folders as positionals.
    checkSkills([...values.skills, ...positionals], values.authoring === true, catalog, res)
  } else if (values.lock) {
    checkLock(values.lock, catalog, res)
  } else {
    if (positionals.length !== 1) throw usage('check takes one plan.json')
    const round = Number(values.round)
    if (![1, 2].includes(round)) throw usage('--round must be 1 or 2')
    checkPlan(positionals[0], round, catalog, res)
  }
  res.lines.push(`checked ${res.data.targets.length} files: ${res.errors.length} errors, ${res.warnings.length} warnings`)
  for (const d of res.data.dropped ?? []) res.lines.push(`dropped ${d.repo} ${d.id} ${d.path}: ${d.reason}`)
  return res
}
