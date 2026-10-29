import { join } from 'node:path'

export const RUN_DIR = '.hub-run'

// The only translation between a plan path and its staging path, and only in this direction:
// a `.claude` segment makes every agent Write ask for permission, `_claude` does not (design 15.7.55).
export function toStagingPath(planPath) {
  return planPath
    .split('/')
    .map(seg => (seg === '.claude' ? '_claude' : seg))
    .join('/')
}

export const runDir = root => join(root, RUN_DIR)

export const stagingFile = (root, repo, planPath) => join(runDir(root), 'out', repo, toStagingPath(planPath))

export const proposalFile = (root, repo, id) => join(runDir(root), 'proposals', repo, `${id}.proposed`)

export const lockPath = repoDir => join(repoDir, '.claude', 'hub.lock.json')

// A relative path that stays inside its repo.
export function isSafeRelative(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\')) return false
  return !p.split('/').some(seg => seg === '..' || seg === '' || seg === '.')
}
