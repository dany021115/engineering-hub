import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { statusZ } from './git.mjs'
import { runDir } from './paths.mjs'
import { rootListing } from './workspace.mjs'

// `git status --porcelain=v1 -z --untracked-files=all` as path -> XY; a rename's second field
// is its old path (design 15.8.120).
export function parseStatus(text) {
  const map = new Map()
  const parts = text.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    map.set(entry.slice(3), xy)
    if (/[RC]/.test(xy)) i++
  }
  return map
}

function diff(before, after) {
  const out = new Set()
  for (const [p, xy] of after) if (before.get(p) !== xy) out.add(p)
  for (const p of before.keys()) if (!after.has(p)) out.add(p)
  return out
}

const fromRootListing = lines => new Map(lines.filter(Boolean).map(l => [l.split('\t').slice(2).join('\t'), l]))

// Paths that changed since `start` took its snapshot: per repo against status/<repo>.txt and,
// in a workspace, the root's own files against status/.root.txt.
export function changedSince(root, dirs, repos, workspace) {
  const changed = { repos: {}, root: [] }
  for (const repo of repos) {
    const snap = join(runDir(root), 'status', `${repo}.txt`)
    const before = existsSync(snap) ? parseStatus(readFileSync(snap, 'utf8')) : new Map()
    const after = parseStatus(statusZ(dirs[repo]).toString('utf8'))
    changed.repos[repo] = [...diff(before, after)].filter(p => p !== '.hub-run' && !p.startsWith('.hub-run/')).sort()
  }
  if (workspace) {
    const snap = join(runDir(root), 'status', '.root.txt')
    const before = existsSync(snap) ? fromRootListing(readFileSync(snap, 'utf8').split('\n')) : new Map()
    changed.root = [...diff(before, fromRootListing(rootListing(root)))].sort()
  }
  return changed
}

// Everything that changed and is not in `allowed[repo]`, as findings; nothing is ever deleted.
export function confinement(root, dirs, repos, workspace, allowed = {}) {
  const changed = changedSince(root, dirs, repos, workspace)
  const findings = []
  for (const repo of repos) {
    const ok = allowed[repo] ?? new Set()
    const extra = changed.repos[repo].filter(p => !ok.has(p))
    if (extra.length) {
      findings.push({ repo, gate: 'confinement', message: `files changed outside the plan: ${extra.join(', ')}`, paths: extra })
    }
  }
  if (changed.root.length) {
    findings.push({
      gate: 'confinement',
      path: root,
      message: `files changed at the workspace root: ${changed.root.join(', ')}`,
      paths: changed.root,
    })
  }
  return findings
}
