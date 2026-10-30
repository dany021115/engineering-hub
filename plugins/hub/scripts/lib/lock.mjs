import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { HubError } from './cli.mjs'
import { git, hashObject, revParse, topLevel } from './git.mjs'
import { lockPath } from './paths.mjs'

// Instruction files are the person's; the lock never tracks them (design 7).
const UNTRACKED = new Set(['CLAUDE.md', 'AGENTS.md'])

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(k => [k, sortKeys(value[k])]),
    )
  }
  return value
}

export const serializeLock = lock => JSON.stringify(sortKeys(lock), null, 2) + '\n'

export function readLock(repoDir) {
  const file = lockPath(repoDir)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new HubError(`${file} is not valid JSON: ${err.message}`)
  }
}

// `bare` leaves out the empty scanAllow a new lock gets: a site's first lock holds only docsDir (SIT-18).
export function writeLock(repoDir, lock, previous = readLock(repoDir), { bare = false } = {}) {
  const out = structuredClone(lock)
  out.settings ??= {}
  // Only the person edits scanAllow; a rewrite keeps it byte for byte (design 5.4).
  if (previous?.settings && 'scanAllow' in previous.settings) out.settings.scanAllow = previous.settings.scanAllow
  else if (!bare) out.settings.scanAllow ??= []
  out.files = Object.fromEntries(
    Object.entries(out.files ?? {}).filter(([p]) => !UNTRACKED.has(basename(p)) && p !== '.claude/workspace.json'),
  )
  const file = lockPath(repoDir)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, serializeLock(out))
  return out
}

export function fileEntry(repoDir, path, { kind, type, archetype, sources = {} }) {
  const entry = { kind, hash: hashObject(repoDir, path), sources }
  if (archetype) entry.archetype = archetype
  if (type) entry.type = type
  return entry
}

// A sibling repo is named by its folder, never by a path (the office's isRepoName).
export const isRepoName = name => typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..'

// The repos a lock relates to: its docs home, its workspace's repos and the owner of every
// `<repo>:<path>` source, so a member whose home is not checked out still knows its siblings.
export function relatedRepos(lock, self) {
  const names = []
  const add = name => {
    if (name !== self && !names.includes(name)) names.push(name)
  }
  if (lock?.settings && 'docsHome' in lock.settings) add(lock.settings.docsHome)
  for (const name of lock?.workspace?.repos ?? []) add(name)
  for (const entry of Object.values(lock?.files ?? {})) {
    for (const key of Object.keys(entry?.sources ?? {})) {
      const m = /^([A-Za-z0-9._-]+):(.+)$/.exec(key)
      if (m) add(m[1])
    }
  }
  return names
}

// Each related repo of the lock at `dir`, looked up next to it as currentId does: where it is,
// whether it is there, its lock, and what went wrong (a bad name or a lock that does not parse).
export function relatedLocks(dir, lock) {
  return relatedRepos(lock, basename(dir)).map(name => {
    if (!isRepoName(name)) return { name, dir: null, present: false, lock: null, problem: `${JSON.stringify(name)} is not a repository name` }
    const at = join(dirname(dir), name)
    if (!existsSync(at) || topLevel(at) !== at) return { name, dir: at, present: false, lock: null, problem: null }
    try {
      return { name, dir: at, present: true, lock: readLock(at), problem: null }
    } catch (err) {
      return { name, dir: at, present: true, lock: null, problem: err.message }
    }
  })
}

// Design 15.7.67: a quote's path gives its blob, an absence's pathspec its folder's tree,
// `<repo>:<path>` the sibling's object; a human fact gives nothing.
export function sourcesFromFacts(dirs, repo, facts) {
  const sources = {}
  const resolveIn = value => {
    const m = /^([A-Za-z0-9._-]+):(.+)$/.exec(value)
    const [owner, rel] = m && dirs[m[1]] ? [m[1], m[2]] : [repo, value]
    const clean = rel.replace(/\/+$/, '')
    const id = revParse(dirs[owner], `HEAD:${clean}`)
    if (!id) return
    const folder = git(dirs[owner], ['cat-file', '-t', id]).stdout.trim() === 'tree'
    const key = (owner === repo ? '' : `${owner}:`) + clean + (folder ? '/' : '')
    sources[key] = id
  }
  for (const fact of facts) {
    if (fact.kind === 'human') continue
    for (const ev of fact.evidence ?? []) {
      if (typeof ev.path === 'string') resolveIn(ev.path)
      else if (typeof ev.pathspec === 'string' && ev.pathspec) resolveIn(ev.pathspec)
    }
  }
  return sources
}
