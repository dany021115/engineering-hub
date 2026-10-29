import type { SessionMessage } from 'claude-code'

import type { Change } from '../../types'
import { relativeTo } from '../workspace/paths'

export const MAX_CHANGES = 300

const MAX_TEXT = 4000

export type DiffLine = { sign: '+' | '-'; text: string }

export const clipText = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…` : text)

export const filesOf = (changes: Change[], agentId: string) => [
  ...new Set(changes.filter(change => change.agentId === agentId).map(change => change.file)),
]

export const sharedFiles = (changes: Change[], agentId: string) => {
  const mine = new Set(filesOf(changes, agentId))
  return [
    ...new Set(
      changes.filter(change => change.agentId !== agentId && mine.has(change.file)).map(c => c.file),
    ),
  ]
}

export const lineDiff = (before: string, after: string): DiffLine[] => {
  const old = before ? before.split('\n') : []
  const now = after ? after.split('\n') : []
  let head = 0
  while (head < old.length && head < now.length && old[head] === now[head]) head++
  let tail = 0
  while (
    tail < old.length - head &&
    tail < now.length - head &&
    old[old.length - 1 - tail] === now[now.length - 1 - tail]
  ) {
    tail++
  }
  return [
    ...old.slice(head, old.length - tail).map(text => ({ sign: '-' as const, text })),
    ...now.slice(head, now.length - tail).map(text => ({ sign: '+' as const, text })),
  ]
}

const EDIT_TOOLS: Record<string, (input: Record<string, unknown>) => Omit<Change, 'agentId'> | undefined> = {
  Edit: input => ({
    file: String(input.file_path),
    before: String(input.old_string),
    after: String(input.new_string),
  }),
  Write: input => ({ file: String(input.file_path), before: '', after: String(input.content) }),
  NotebookEdit: input => ({ file: String(input.notebook_path), before: '', after: String(input.new_source) }),
}

export const changesFromMessages = (agentId: string, messages: readonly SessionMessage[], root: string) =>
  messages.flatMap(message =>
    message.toolUses.flatMap(use => {
      const read = EDIT_TOOLS[use.tool]
      const change = read && !use.isError ? read(use.input) : undefined
      return change
        ? [
            {
              agentId,
              file: relativeTo(root, change.file),
              before: clipText(change.before),
              after: clipText(change.after),
            },
          ]
        : []
    }),
  )
