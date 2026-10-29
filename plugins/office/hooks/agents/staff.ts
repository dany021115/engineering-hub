import type { AgentInfo } from 'claude-code'

import type { Speed, Worker } from '../../types'

export const LEAD = 'lead'

const LIVE_STATUSES = ['pending', 'running', 'waiting', 'idle']

export const isLive = (worker: Worker) => LIVE_STATUSES.includes(worker.status)

export const toWorker = (agent: AgentInfo): Worker => ({
  id: agent.id,
  label: agent.name ?? agent.id.slice(0, 6),
  type: agent.type,
  task: agent.description,
  status: agent.status,
})

export const labelIn = (staff: Worker[], id: string) =>
  id === LEAD ? LEAD : (staff.find(worker => worker.id === id)?.label ?? id.slice(0, 6))

export const rosterOf = (staff: Worker[], exclude?: string) => {
  const lines = staff
    .filter(worker => isLive(worker) && worker.id !== exclude)
    .map(worker => `- ${worker.label} (${worker.type}, ${worker.status}): ${worker.task}`)
  return lines.length ? lines.join('\n') : 'Nobody else is working right now.'
}

export const mergeStaff = (current: Worker[], latest: Worker[], removed: string[], active: string[]) => {
  const listed = new Set(latest.map(worker => worker.id))
  const gone = current
    .filter(worker => !listed.has(worker.id))
    .map(worker => (isLive(worker) ? { ...worker, status: 'completed' } : worker))
  return [...gone, ...latest]
    .filter(worker => !removed.includes(worker.id))
    .map(worker => (active.includes(worker.id) ? { ...worker, status: 'running' } : worker))
}

type Effort = 'low' | 'medium' | 'high'

// The Agent tool behind a spawn takes only an alias; a step names the full model id.
type Profile = { label: string; alias: string; model: string; effort?: Effort }

export const SPEEDS: Record<Speed, Profile> = {
  fast: { label: 'Fast', alias: 'haiku', model: 'claude-haiku-5-5' },
  balanced: { label: 'Mid', alias: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium' },
  deep: { label: 'Deep', alias: 'opus', model: 'claude-opus-5-5', effort: 'high' },
}

export const SPEED_NAMES = Object.keys(SPEEDS) as Speed[]

export const isSpeed = (value: string): value is Speed => value in SPEEDS

export const speedSummary = (speed?: Speed) => {
  if (!speed) return 'session default'
  const { alias, effort } = SPEEDS[speed]
  return `${alias}${effort ? ` · ${effort}` : ''}`
}
