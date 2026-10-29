import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { HubError } from './cli.mjs'
import { gitAvailable, headCommit, topLevel } from './git.mjs'

const MIN_NODE = 22

export function preflight(cwd) {
  const major = Number(process.versions.node.split('.')[0])
  if (major < MIN_NODE) throw new HubError(`Node ${MIN_NODE} or later is required; this is ${process.version}.`)
  if (!gitAvailable()) throw new HubError('git is not installed or not on the PATH; install git and start again.')
  const here = realpathSync(cwd)
  const top = topLevel(here)
  if (top && realpathSync(top) !== here) {
    throw new HubError(`The session started in a subfolder: start Claude Code in ${realpathSync(top)} and run it again.`)
  }
  return { cwd: here, top: top ? here : null }
}

// The run root: the repo's top level, or the workspace folder.
export function resolveRoot(cwd) {
  const here = realpathSync(cwd)
  const top = topLevel(here)
  return top ? realpathSync(top) : here
}

const isRepoDir = dir => existsSync(join(dir, '.git'))

export function childRepos(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && isRepoDir(join(root, d.name)))
    .map(d => d.name)
    .sort()
}

export function isWorkspaceRoot(root) {
  return !isRepoDir(root)
}

// Name -> folder of every repo the run root holds.
export function repoDirs(root) {
  if (!isWorkspaceRoot(root)) return { [basename(root)]: root }
  return Object.fromEntries(childRepos(root).map(n => [n, join(root, n)]))
}

export function discover({ cwd, top }, maxRepos) {
  const warnings = []
  const skipped = []
  if (top) {
    if (!headCommit(top)) throw new HubError(`${top} has no commits yet; make a first commit and run it again.`)
    return { mode: 'repo', root: top, repos: [basename(top)], skipped, warnings }
  }
  const repos = []
  for (const name of childRepos(cwd)) {
    if (!headCommit(join(cwd, name))) skipped.push({ name, reason: 'no commits' })
    else repos.push(name)
  }
  if (repos.length > maxRepos) {
    const cut = repos.length - maxRepos
    warnings.push({ message: `only the first ${maxRepos} repositories are used; ${cut} skipped by the cap` })
    for (const name of repos.splice(maxRepos)) skipped.push({ name, reason: 'over the repository cap' })
  }
  return { mode: 'workspace', root: cwd, repos, skipped, warnings }
}

// Design 15.7.61-62: the only repo; else most Markdown in its docs folder, ties alphabetical.
export function defaultHome(counts) {
  const names = Object.keys(counts).sort()
  let best = names[0] ?? null
  for (const n of names) if (counts[n] > counts[best]) best = n
  return best
}

export function walkFiles(dir, skip, rel = '') {
  const out = []
  for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${d.name}` : d.name
    if (skip(p, d)) continue
    if (d.isDirectory()) out.push(...walkFiles(dir, skip, p))
    else if (d.isFile()) out.push(p)
  }
  return out
}

// Files at a workspace root with size and time, outside every repo, `.hub-run/` and `node_modules`.
export function rootListing(root) {
  const skip = (p, d) =>
    d.isDirectory() && (d.name === '.hub-run' || d.name === 'node_modules' || isRepoDir(join(root, p)))
  return walkFiles(root, skip)
    .sort()
    .map(p => {
      const st = statSync(join(root, p))
      return `${st.size}\t${st.mtime.toISOString()}\t${p}`
    })
}

