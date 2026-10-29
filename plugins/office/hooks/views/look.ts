import type { ContextFill } from '../../types'

export const CLAUDE_ORANGE = '#D97757'

export const SPRITE = ['▄█▄', '▀ ▀']

type Mood = { text: string; color?: string }

const MOODS: Record<string, Mood> = {
  pending: { text: 'arriving', color: 'cyan' },
  running: { text: 'working', color: 'green' },
  waiting: { text: 'waiting', color: 'yellow' },
  paused: { text: 'paused', color: 'yellow' },
  idle: { text: 'idle' },
  completed: { text: 'done', color: 'blue' },
  failed: { text: 'failed', color: 'red' },
  killed: { text: 'stopped' },
}

export const moodOf = (status: string): Mood => MOODS[status] ?? { text: status }

const BAR_WIDTH = 8

const compact = (tokens: number) =>
  tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}k`

export const contextMeter = (fill?: ContextFill) => {
  if (!fill) return undefined
  const ratio = Math.min(1, fill.used / fill.window)
  const filled = fill.used > 0 ? Math.max(1, Math.round(ratio * BAR_WIDTH)) : 0
  return {
    bar: `${'▓'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`,
    label: `${compact(fill.used)}/${compact(fill.window)}`,
    color: ratio >= 0.8 ? 'red' : ratio >= 0.5 ? 'yellow' : 'green',
  }
}
