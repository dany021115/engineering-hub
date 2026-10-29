import type { Worktree } from '../../types'
import { basename } from './paths'

export const WORKTREES_FOLDER = '.office-worktrees'

export const worktreePathFor = (workspaceRoot: string, repoRoot: string, stamp: number) =>
  `${workspaceRoot}/${WORKTREES_FOLDER}/${basename(repoRoot)}-${stamp.toString(36)}`

export const isolatedTask = (task: string, worktree: Worktree) =>
  `${task}\n\nYou work in ${worktree.path}, an isolated git worktree of ${worktree.repoRoot}, not in the repo itself. ` +
  `Do not commit, branch or push: the person reviews your diff and applies it.`

export const git = {
  topLevel: (dir: string) => ['git', '-C', dir, 'rev-parse', '--show-toplevel'],
  add: (repoRoot: string, path: string) => [
    'git',
    '-C',
    repoRoot,
    'worktree',
    'add',
    '--detach',
    path,
    'HEAD',
  ],
  intentToAdd: (path: string) => ['git', '-C', path, 'add', '--intent-to-add', '--all'],
  diff: (path: string) => ['git', '-C', path, 'diff', 'HEAD', '--binary'],
  check: (repoRoot: string) => ['git', '-C', repoRoot, 'apply', '--check', '-'],
  apply: (repoRoot: string) => ['git', '-C', repoRoot, 'apply', '-'],
  remove: (repoRoot: string, path: string) => ['git', '-C', repoRoot, 'worktree', 'remove', '--force', path],
}

export type ProcessRun = (
  argv: string[],
  stdin?: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export type GitRun = (argv: string[], stdin?: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>

// stdout comes back as git wrote it: a patch must reach git apply byte for byte.
export const gitRunner =
  (run: ProcessRun): GitRun =>
  async (argv, stdin) => {
    const { exitCode, stdout, stderr } = await run(argv, stdin)
    return { ok: exitCode === 0, stdout, stderr: stderr.trim() }
  }

export async function worktreeDiff(run: GitRun, worktree: Worktree) {
  await run(git.intentToAdd(worktree.path))
  return (await run(git.diff(worktree.path))).stdout
}

// Applies a worktree's changes to the working tree of its repo, nothing staged:
// the check runs first, so a patch that does not apply cleanly touches nothing.
// The worktree goes only once the changes landed.
export async function applyChanges(run: GitRun, worktree: Worktree) {
  const patch = await worktreeDiff(run, worktree)
  if (!patch.trim()) return { ok: false, message: 'Nothing to apply' }
  for (const argv of [git.check(worktree.repoRoot), git.apply(worktree.repoRoot)]) {
    const done = await run(argv, patch)
    if (!done.ok) return { ok: false, message: `Apply failed, worktree kept: ${done.stderr.split('\n')[0]}` }
  }
  await run(git.remove(worktree.repoRoot, worktree.path))
  return { ok: true, message: '' }
}
