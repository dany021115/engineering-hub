import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runDir } from './paths.mjs'

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function runState(root) {
  const dir = runDir(root)
  const has = name => existsSync(join(dir, name))
  let plan = null
  if (has('plan.json')) {
    try {
      plan = readJson(join(dir, 'plan.json'))
    } catch {
      plan = {}
    }
  }
  return {
    dir,
    exists: existsSync(dir),
    done: has('done.json'),
    placed: has('placed.json'),
    facts: has('facts'),
    plan,
  }
}

// Design 15.8.136: facts/, plan.json or placed.json make a resume point; anything else counts as empty.
export const inProgress = s => s.exists && !s.done && (s.facts || s.plan !== null || s.placed)

export function resumePoint(s) {
  if (!inProgress(s)) return { resume: null, discard: null }
  if (s.plan?.mode === 'site') return { resume: null, discard: s.placed ? 'finish --keep none' : 'start --discard' }
  if (s.placed) return { resume: 'P3', discard: 'finish --keep none' }
  if (s.plan) return { resume: 'P2', discard: 'start --discard' }
  return { resume: 'verify', discard: 'start --discard' }
}

export function clearRun(root) {
  rmSync(runDir(root), { recursive: true, force: true })
}
