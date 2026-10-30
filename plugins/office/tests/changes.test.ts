import { expect, test } from 'claude-code/testing'

import { changesFromMessages, filesOf, lineDiff, sharedFiles } from '../hooks/agents/changes'
import { isStreaming, liveFromMessages, liveLine, startLive, withChunk } from '../hooks/agents/activity'
import { contextMeter } from '../hooks/views/look'
import { EVEN_SPLIT, nudge, shares } from '../hooks/views/grid'
import { workspaceBriefing } from '../hooks/workspace/briefing'
import { discover } from '../hooks/workspace/discover'
import { relativeTo } from '../hooks/workspace/paths'
import { taskSummary } from '../hooks/workspace/texts'
import { fakeTree, repoFiles } from './tree'

const CHANGES = [
  { agentId: 'a', file: 'service/docs/index.md', before: 'x', after: 'y' },
  { agentId: 'b', file: 'service/docs/index.md', before: 'y', after: 'z' },
  { agentId: 'a', file: 'web/README.md', before: '', after: 'new' },
]

test('a line diff keeps only the lines that changed', () => {
  expect(lineDiff('one\ntwo\nthree', 'one\n2\nthree')).toEqual([
    { sign: '-', text: 'two' },
    { sign: '+', text: '2' },
  ])
})

test('files touched by two agents are reported as shared', () => {
  expect(filesOf(CHANGES, 'a')).toEqual(['service/docs/index.md', 'web/README.md'])
  expect(sharedFiles(CHANGES, 'a')).toEqual(['service/docs/index.md'])
})

test('paths are shown relative to the workspace', () => {
  expect(relativeTo('/w', '/w/service/x.py')).toBe('service/x.py')
})

test('the context meter turns red near the window', () => {
  expect(contextMeter({ used: 180_000, window: 200_000 })?.color).toBe('red')
  expect(contextMeter({ used: 20_000, window: 1_000_000 })?.bar).toBe('▓░░░░░░░')
  expect(contextMeter({ used: 20_000, window: 1_000_000 })?.label).toBe('20k/1M')
})

test("an agent's edits are read from its transcript, skipping failed ones", () => {
  const messages = [
    {
      role: 'assistant' as const,
      text: '',
      toolUses: [
        { tool: 'Write', tool_use_id: 't1', input: { file_path: '/w/service/new.py', content: 'x = 1' } },
        {
          tool: 'Edit',
          tool_use_id: 't2',
          input: { file_path: '/w/service/old.py', old_string: 'a', new_string: 'b' },
        },
        {
          tool: 'Edit',
          tool_use_id: 't3',
          isError: true as const,
          input: { file_path: '/w/service/old.py', old_string: 'zz', new_string: 'b' },
        },
        { tool: 'Read', tool_use_id: 't4', input: { file_path: '/w/service/old.py' } },
      ],
    },
  ]
  expect(changesFromMessages('a', messages, '/w')).toEqual([
    { agentId: 'a', file: 'service/new.py', before: '', after: 'x = 1' },
    { agentId: 'a', file: 'service/old.py', before: 'a', after: 'b' },
  ])
})

test('the live line follows the latest chunk', () => {
  let live = startLive(0)
  live = withChunk(live, { kind: 'thinking', index: 0, text: 'reading the\ndocs' })
  expect(liveLine(live, 3000)).toContain('3s · thinking: reading the docs')
  live = withChunk(live, { kind: 'tool', index: 1, id: 't1', name: 'Bash' })
  live = withChunk(live, { kind: 'input', index: 1, json: '{"command":"ls service"' })
  expect(liveLine(live, 5000)).toContain('→ Bash {"command":"ls service"')
})

test('grid splits move in steps and stay within bounds', () => {
  expect(nudge(EVEN_SPLIT, 'col', 1)).toEqual({ col: 0.6, row: 0.5 })
  let split = EVEN_SPLIT
  for (let i = 0; i < 10; i++) split = nudge(split, 'row', -1)
  expect(split.row).toBe(0.2)
  expect(shares(101, 2, 0.6)).toEqual([60, 41])
  expect(shares(100, 1, 0.6)).toEqual([100])
})

test('discovery and the briefing build the workspace context', async () => {
  const tree = fakeTree({
    ...repoFiles('/w/service'),
    '/w/service/docs/index.md': '# Service\n\nThe backend. It runs.',
  })
  const workspace = await discover(
    { options: { workspaceRoot: '/w', neverIsolate: ['infra'] }, repoRoot: null, sessionRoot: '/w' },
    tree.reader,
  )
  expect(workspace.repos).toEqual([
    { name: 'service', path: '/w/service', docsDir: 'docs', neverIsolate: false },
  ])
  const briefing = await workspaceBriefing(workspace, tree.reader)
  expect(briefing).toContain('# Workspace\nRoot: /w')
  expect(briefing).toContain('- service (/w/service): The backend.')
  expect(briefing).not.toContain('../')
  expect(await workspaceBriefing({ ...workspace, repos: [] }, tree.reader)).toBe('')
})

test('the live line falls back to the last step in the transcript', () => {
  const messages = [
    { role: 'user' as const, text: 'go', toolUses: [] },
    {
      role: 'assistant' as const,
      text: '',
      toolUses: [
        { tool: 'Bash', tool_use_id: 't1', input: { command: 'pytest', description: 'Run the tests' } },
      ],
    },
  ]
  const live = liveFromMessages(messages, 0, 2000)
  expect(liveLine(live, 4000)).toContain('4s · → Bash Run the tests')
  expect(isStreaming(live, 4000)).toBe(false)
  expect(isStreaming({ ...live, source: 'stream', at: 3000 }, 4000)).toBe(true)
})

test('the task summary collapses whitespace and trims a long task at a word boundary', () => {
  expect(taskSummary('review the diff')).toBe('review the diff')
  expect(taskSummary('investigate   the\nflaky\n\nlogin test')).toBe('investigate the flaky login test')

  const long = 'investigate the flaky login test and propose a fix'
  const summary = taskSummary(long, 40)
  expect(summary.length).toBeLessThanOrEqual(41)
  expect(summary.endsWith('…')).toBe(true)
  expect(summary).not.toContain('  ')
  expect(long.startsWith(summary.replace('…', '').trimEnd())).toBe(true)
})
