import type { SessionMessage } from 'claude-code'

export type Speaker = 'you' | 'agent' | 'office'

export type ThreadEntry = { from: Speaker; text: string }

export const HANDBACK = 'SubagentHandback'

const BRIEFING_MARKS = ['\n\n# Working in the office', '\n\nYou work in an isolated git worktree']

const withoutBriefing = (text: string) =>
  BRIEFING_MARKS.reduce((kept, mark) => kept.split(mark)[0] ?? kept, text).trim()

const isPrompt = (message: SessionMessage) =>
  message.role === 'user' && Boolean(message.text.trim()) && !message.toolResults?.length

const replyOf = (message: SessionMessage) => {
  const handback = message.toolUses.find(use => use.tool === HANDBACK)
  if (handback && typeof handback.input.message === 'string') return handback.input.message
  return message.text.trim() || undefined
}

export const handbackOf = (messages: readonly SessionMessage[]) => {
  for (const message of [...messages].reverse()) {
    const handback = message.toolUses.find(use => use.tool === HANDBACK)
    if (handback && typeof handback.input.message === 'string') return handback.input.message
  }
  return undefined
}

export function threadOf(messages: readonly SessionMessage[], stored?: string): ThreadEntry[] {
  const thread: ThreadEntry[] = []
  let reply: string | undefined
  const flush = () => {
    if (reply) thread.push({ from: 'agent', text: reply })
    reply = undefined
  }

  for (const message of messages) {
    if (isPrompt(message)) {
      flush()
      const text = withoutBriefing(message.text)
      thread.push({ from: text.startsWith('[office]') ? 'office' : 'you', text })
    } else if (message.role === 'assistant') {
      reply = replyOf(message) ?? reply
    }
  }
  flush()

  if (stored && !thread.some(entry => entry.from === 'agent')) thread.push({ from: 'agent', text: stored })
  return thread
}

export const lastAnswer = (thread: ThreadEntry[]) =>
  [...thread].reverse().find(entry => entry.from === 'agent')?.text

export type ThreadLine = { from: Speaker; text: string; isHeader: boolean }

export type LineWindow = { lines: ThreadLine[]; above: number; below: number }

const wrapLine = (line: string, width: number) => {
  if (line.length <= width) return [line]
  const pieces: string[] = []
  for (let start = 0; start < line.length; start += width) pieces.push(line.slice(start, start + width))
  return pieces
}

export function threadLines(thread: ThreadEntry[], columns: number, agentLabel: string): ThreadLine[] {
  const width = Math.max(20, columns)
  return thread.flatMap(entry => [
    { from: entry.from, text: entry.from === 'agent' ? agentLabel : entry.from, isHeader: true },
    ...entry.text
      .split('\n')
      .flatMap(line => wrapLine(line, width))
      .map(text => ({ from: entry.from, text, isHeader: false })),
  ])
}

export function lineWindow(lines: ThreadLine[], offsetFromEnd: number, rows: number): LineWindow {
  const size = Math.max(1, rows)
  const offset = Math.min(Math.max(0, offsetFromEnd), Math.max(0, lines.length - size))
  const end = lines.length - offset
  const start = Math.max(0, end - size)
  return { lines: lines.slice(start, end), above: start, below: lines.length - end }
}
