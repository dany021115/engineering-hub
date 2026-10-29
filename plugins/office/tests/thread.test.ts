import { expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import { lineWindow, threadLines, threadOf } from '../hooks/agents/thread'

const says = (
  role: SessionMessage['role'],
  text: string,
  tools: [string, Record<string, unknown>][] = [],
) => ({
  role,
  text,
  toolUses: tools.map(([tool, input], index) => ({ tool, input, tool_use_id: `t${index}` })),
})

test('the thread pairs each prompt with its answer and drops the briefing', () => {
  const thread = threadOf([
    says('user', 'What does this repo do?\n\n# Working in the office\nrules'),
    says('assistant', '', [['Bash', {}]]),
    says('assistant', '', [['SubagentHandback', { message: 'It serves the public API.' }]]),
    says('user', 'Who calls it?'),
    says('assistant', 'The web app.'),
    says('user', '[office] Question q1 from lead: ping'),
  ])
  expect(thread).toEqual([
    { from: 'you', text: 'What does this repo do?' },
    { from: 'agent', text: 'It serves the public API.' },
    { from: 'you', text: 'Who calls it?' },
    { from: 'agent', text: 'The web app.' },
    { from: 'office', text: '[office] Question q1 from lead: ping' },
  ])
})

test('a tile scrolls a long answer line by line', () => {
  const thread = [
    { from: 'you' as const, text: 'first' },
    { from: 'agent' as const, text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') },
  ]
  const lines = threadLines(thread, 80, 'a1')
  expect(lines).toHaveLength(23)

  const latest = lineWindow(lines, 0, 5)
  expect(latest.lines.map(line => line.text)).toEqual(['line 15', 'line 16', 'line 17', 'line 18', 'line 19'])
  expect(latest.above).toBe(18)

  const top = lineWindow(lines, 999, 5)
  expect(top.lines[0]?.text).toBe('you')
  expect(top.below).toBe(18)
})
