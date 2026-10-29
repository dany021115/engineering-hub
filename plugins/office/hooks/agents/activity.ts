import type { ModelUsage, SessionMessage, TurnStepChunk } from 'claude-code'

import type { Live } from '../../types'

const TAIL = 160
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FRAME_MS = 400

export const FLUSH_MS = 400

const STREAM_FRESH_MS = 5000

const tail = (text: string) => text.replace(/\s+/g, ' ').slice(-TAIL)

export const startLive = (since: number): Live => ({
  since,
  at: since,
  source: 'stream',
  kind: 'thinking',
  text: '',
})

export function withChunk(live: Live, chunk: TurnStepChunk): Live {
  switch (chunk.kind) {
    case 'thinking':
    case 'text':
      return live.kind === chunk.kind
        ? { ...live, text: tail(live.text + chunk.text) }
        : { ...live, kind: chunk.kind, tool: undefined, text: tail(chunk.text) }
    case 'tool':
      return { ...live, kind: 'tool', tool: chunk.name, text: '' }
    case 'input':
      return live.kind === 'tool' ? { ...live, text: tail(live.text + chunk.json) } : live
    default:
      return live
  }
}

const describe = (input: Record<string, unknown>) =>
  typeof input.description === 'string' ? input.description : JSON.stringify(input)

export function liveFromMessages(messages: readonly SessionMessage[], since: number, at: number): Live {
  const base = { since, at, source: 'transcript' as const }
  const last = [...messages].reverse().find(message => message.role === 'assistant')
  const use = last?.toolUses.at(-1)
  if (use) return { ...base, kind: 'tool', tool: use.tool, text: tail(describe(use.input)) }
  if (last?.text.trim()) return { ...base, kind: 'text', text: tail(last.text) }
  return { ...base, kind: 'thinking', text: '' }
}

export const isStreaming = (live: Live | undefined, now: number) =>
  live?.source === 'stream' && now - live.at < STREAM_FRESH_MS

const seconds = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`

export function liveLine(live: Live, now: number) {
  const frame = FRAMES[Math.floor(now / FRAME_MS) % FRAMES.length]
  const activity = live.kind === 'tool' ? `→ ${live.tool} ${live.text}` : `${live.kind}: ${live.text}`
  return `${frame} ${seconds(now - live.since)} · ${activity.trim()}`
}

const STANDARD_WINDOW = 200_000
const LONG_WINDOW = 1_000_000

export const windowOf = (model: string) => (model.includes('[1m]') ? LONG_WINDOW : STANDARD_WINDOW)

export const usedTokens = (usage: ModelUsage) =>
  usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
