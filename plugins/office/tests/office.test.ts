import { expect, mock, test } from 'claude-code/testing'
import type { AgentStatus } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const

const PANE_PROPS = {
  title: 'Office',
  isFocused: false,
  bodyColumns: 120,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

test('a posted finding can be read back from the board', async ($, on) => {
  mock.clock(on)
  await $.tool.call({
    tool: 'mcp__office__post',
    topic: 'build cache',
    text: 'the web app reads the cache key from the lockfile',
  })

  const found = await $.tool.call({ tool: 'mcp__office__board', query: 'cache' })
  expect(found.result).toContain('build cache')

  const missed = await $.tool.call({ tool: 'mcp__office__board', query: 'deploy' })
  expect(missed.result).toBe('The board has nothing on that yet.')
})

test('a reply to an unknown question is refused', async ($, on) => {
  mock.clock(on)
  const answered = await $.tool.call({ tool: 'mcp__office__reply', questionId: 'q9', answer: 'yes' })
  expect(answered.result).toBe('There is no question q9.')
})

test('the office pane draws an empty office and the board', async ($, on) => {
  mock.clock(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'office',
      surface,
      component: 'Pane',
      props: PANE_PROPS,
      requestId: 'office',
    })
    expect(await ui.find({ text: /office is empty/ })).toBeDefined()
    expect(await ui.find({ text: 'Board' })).toBeDefined()
  }
})

test('pause, play and stop drive the agent from its desk', async ($, on) => {
  mock.clock(on)
  let status: AgentStatus = 'running'
  on('agent.list', () => ({
    value: [{ id: 'abc123', description: 'read docs', type: 'general-purpose', status }],
  }))
  const stops: unknown[] = []
  on('tool.call', { tool: 'TaskStop' }, () => {
    stops.push('stop')
    status = 'killed'
    return { result: 'stopped' }
  })
  const sent: string[] = []
  on('session.send', (_$, e) => {
    sent.push(e.text)
    status = 'running'
    return { isDelivered: true }
  })
  const refresh = () => $.tool.call({ tool: 'mcp__office__roster' })
  await refresh()

  const ui = await $.ui.mount({
    plugin: 'office',
    surface: 'terminal',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'office',
  })

  await ui.press({ key: 'pause-abc123' })
  await refresh()
  expect(stops).toHaveLength(1)
  expect(await ui.find({ text: /paused/ })).toBeDefined()

  await ui.press({ key: 'play-abc123' })
  await refresh()
  expect(sent).toHaveLength(1)

  await ui.press({ key: 'stop-abc123' })
  expect(stops).toHaveLength(1)
  await ui.press({ key: 'cancel-abc123' })
  await ui.press({ key: 'stop-abc123' })
  await ui.press({ key: 'confirm-abc123' })
  expect(stops).toHaveLength(2)
})

test('a speed button sets the agent model and pressing it again clears it', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({
    value: [{ id: 'abc123', description: 'read docs', type: 'general-purpose', status: 'running' }],
  }))
  await $.tool.call({ tool: 'mcp__office__roster' })
  const ui = await $.ui.mount({
    plugin: 'office',
    surface: 'terminal',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'office',
  })

  await ui.press({ key: 'speed-fast-abc123' })
  expect(await ui.find({ text: /haiku/ })).toBeDefined()

  await ui.press({ key: 'speed-fast-abc123' })
  expect(await ui.find({ text: /session default/ })).toBeDefined()
})

test('a hire at a speed spawns the agent on that speed model alias', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/w/service' }))
  const models: (string | undefined)[] = []
  on('agent.spawn', (_$, e) => {
    models.push(e.model)
    return { model: 'claude-opus-5-5', agentId: 'abc123' }
  })

  await $.tool.call({ tool: 'mcp__office__hire', task: 'review', speed: 'deep', worktree: 'no' })
  expect(models).toEqual(['opus'])
})

test('a hire labels the desk with a readable summary of the task', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/w/service' }))
  const descriptions: string[] = []
  on('agent.spawn', (_$, e) => {
    descriptions.push(e.description)
    return { model: 'claude-opus-5-5', agentId: 'abc123' }
  })

  // A multi-line task: the desk label (agent.description) carries the collapsed,
  // word-trimmed summary rather than a raw mid-word slice of the first bytes.
  const task = 'investigate   the\nflaky login test and propose a fix'
  await $.tool.call({ tool: 'mcp__office__hire', task, worktree: 'no' })

  expect(descriptions[0]).toBe('investigate the flaky login test and propose a fix')
  expect(descriptions[0]).not.toContain('\n')
})

test('a step of an agent at a speed names the full model id and the speed effort alone', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({
    value: [{ id: 'abc123', description: 'read docs', type: 'general-purpose', status: 'running' }],
  }))
  const sent: Record<string, unknown>[] = []
  on('turn.step', async function* (_$, e) {
    sent.push({ ...e })
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  await $.tool.call({ tool: 'mcp__office__roster' })
  const ui = await $.ui.mount({
    plugin: 'office',
    surface: 'terminal',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'office',
  })
  await ui.press({ key: 'speed-deep-abc123' })

  for await (const _chunk of $.turn.step({
    turnId: 't1',
    index: 0,
    model: 'claude-opus-5-5[1m]',
    effort: 'max',
    messageCount: 3,
    agentId: 'abc123',
  })) {
  }

  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
  expect(sent[0]).not.toHaveProperty('alias')
  expect(sent[0]).not.toHaveProperty('label')
})

test('a finished agent stays on its desk with its answer until removed', async ($, on) => {
  mock.clock(on)
  const session = mock.session(on)
  on('ui.toast', () => ({ value: undefined }))
  let listed = [
    { id: 'abc123', description: 'read docs', type: 'general-purpose', status: 'running' as AgentStatus },
  ]
  on('agent.list', () => ({ value: listed }))
  on('session.messages', () => ({
    value: [{ role: 'assistant' as const, text: 'The docs live in service/docs.', toolUses: [] }],
  }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  const refresh = () => $.tool.call({ tool: 'mcp__office__roster' })
  await refresh()

  await $.turn.complete({
    agentId: 'abc123',
    answer: 'The docs live in service/docs.',
    durationMs: 10,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  listed = []
  await refresh()

  const ui = await $.ui.mount({
    plugin: 'office',
    surface: 'terminal',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'office',
  })
  expect(await ui.find({ text: /done/ })).toBeDefined()

  await ui.press({ key: 'log-abc123' })
  expect(await ui.find({ key: 'reply-0' })).toBeDefined()
  await ui.press({ key: 'share' })
  expect(JSON.stringify(session.appended())).toContain('Answer from abc123')

  await ui.press({ key: 'tab-steps-bottom' })
  expect(await ui.find({ text: /service\/docs/ })).toBeDefined()

  expect(await ui.find({ key: 'back-bottom' })).toBeDefined()
  await ui.press({ key: 'back-bottom' })
  expect(await ui.find({ key: 'remove-abc123' })).toBeDefined()
  await ui.press({ key: 'remove-abc123' })
  expect(await ui.find({ text: /office is empty/ })).toBeDefined()
})

test('a message from the log reaches the agent', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({
    value: [
      { id: 'abc123', description: 'fix docs', type: 'general-purpose', status: 'completed' as AgentStatus },
    ],
  }))
  on('session.messages', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  const sent: string[] = []
  on('session.send', (_$, e) => {
    sent.push(e.text)
    return { isDelivered: true }
  })
  await $.tool.call({ tool: 'mcp__office__roster' })

  const ui = await $.ui.mount({
    plugin: 'office',
    surface: 'terminal',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'office',
  })
  await ui.press({ key: 'log-abc123' })
  await ui.input({ key: 'message', text: 'Also check the web docs' })
  expect(sent).toEqual(['Also check the web docs'])
})

test('a working agent shows its status and context meter', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({
    value: [
      { id: 'abc123', description: 'read docs', type: 'general-purpose', status: 'running' as AgentStatus },
    ],
  }))
  on('turn.step', async function* () {
    return {
      turnId: 't1',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 1000,
        output_tokens: 1000,
        cache_read_input_tokens: 98_000,
        cache_creation_input_tokens: 0,
      },
    }
  })
  await $.tool.call({ tool: 'mcp__office__roster' })
  for await (const _chunk of $.turn.step({
    turnId: 't1',
    index: 0,
    model: 'claude-opus-5-5',
    messageCount: 3,
    agentId: 'abc123',
  })) {
  }

  const ui = await $.ui.mount({
    plugin: 'office',
    surface: 'terminal',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'office',
  })
  expect(await ui.find({ text: /working/ })).toBeDefined()
  expect(await ui.find({ text: /100k\/200k/ })).toBeDefined()
})

test('an agent resumed after leaving the list shows as working while it steps', async ($, on) => {
  mock.clock(on)
  let listed: { id: string; description: string; type: string; status: AgentStatus }[] = [
    { id: 'abc123', description: 'read docs', type: 'general-purpose', status: 'completed' },
  ]
  on('agent.list', () => ({ value: listed }))
  on('turn.step', async function* () {
    return { turnId: 't2', index: 0, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: null }
  })
  await $.tool.call({ tool: 'mcp__office__roster' })
  listed = []
  for await (const _chunk of $.turn.step({
    turnId: 't2',
    index: 0,
    model: 'claude-opus-5-5',
    messageCount: 5,
    agentId: 'abc123',
  })) {
  }

  const ui = await $.ui.mount({
    plugin: 'office',
    surface: 'terminal',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'office',
  })
  expect(await ui.find({ text: /working/ })).toBeDefined()
})

test('an agent opens in a pane of its own with its own tab', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({
    value: [
      { id: 'abc123', description: 'read docs', type: 'general-purpose', status: 'running' as AgentStatus },
    ],
  }))
  on('session.messages', () => ({ value: [] }))
  const opened: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  await $.tool.call({ tool: 'mcp__office__roster' })

  const office = await $.ui.mount({
    plugin: 'office',
    surface: 'terminal',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'office',
  })
  await office.press({ key: 'split-abc123' })
  expect(opened).toEqual(['office-abc123'])

  const detail = await $.ui.mount({
    plugin: 'office',
    surface: 'terminal',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'office-abc123',
  })
  await detail.press({ key: 'tab-steps' })
  expect(await detail.find({ text: /Close/ })).toBeDefined()
  expect(await office.find({ key: 'split-abc123' })).toBeDefined()
})

test('next in worktree applies to one hire and then resets', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  const ran: string[][] = []
  on('process.run', (_$, e) => {
    ran.push([...e.argv])
    return {
      value: {
        exitCode: 1,
        stdout: '',
        stderr: 'not a repo',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'abc123' }))
  on('session.cwd', () => ({ value: '/w/service' }))

  const ui = await $.ui.mount({
    plugin: 'office',
    surface: 'terminal',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'office',
  })
  await ui.press({ key: 'next-isolated' })
  await ui.input({ key: 'hire', text: 'isolated task' })
  expect(ran.some(argv => argv.includes('rev-parse'))).toBe(true)

  ran.length = 0
  await ui.input({ key: 'hire', text: 'normal task' })
  expect(ran).toHaveLength(0)
})

test('pinned agents tile the grid, two to a row', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({
    value: ['a1', 'a2', 'a3'].map(id => ({
      id,
      description: `task ${id}`,
      type: 'general-purpose',
      status: 'running' as AgentStatus,
    })),
  }))
  on('session.messages', () => ({ value: [] }))
  await $.tool.call({ tool: 'mcp__office__roster' })

  const ui = await $.ui.mount({
    plugin: 'office',
    surface: 'terminal',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'office',
  })
  for (const id of ['a1', 'a2', 'a3']) await ui.press({ key: `pin-${id}` })
  await ui.press({ key: 'show-grid' })
  expect(await ui.findAll({ key: 'grid-row-0' })).toHaveLength(1)
  expect(await ui.findAll({ key: 'grid-row-1' })).toHaveLength(1)
  expect(await ui.find({ key: 'tile-a3' })).toBeDefined()

  await ui.press({ key: 'size-widen' })
  await ui.press({ key: 'size-taller' })
  await ui.press({ key: 'size-even' })
  await ui.press({ key: 'unpin-a3' })
  expect(await ui.find({ key: 'grid-row-1' })).toBeUndefined()
  await ui.press({ key: 'grid-back' })
  expect(await ui.find({ key: 'show-grid' })).toBeDefined()
})

test('the changes tab shows the edits from the agent transcript', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({
    value: [
      { id: 'abc123', description: 'fix docs', type: 'general-purpose', status: 'completed' as AgentStatus },
    ],
  }))
  on('session.messages', () => ({
    value: [
      {
        role: 'assistant' as const,
        text: '',
        toolUses: [
          {
            tool: 'Edit',
            tool_use_id: 't1',
            input: { file_path: 'docs/index.md', old_string: 'old line', new_string: 'new line' },
          },
        ],
      },
    ],
  }))
  await $.tool.call({ tool: 'mcp__office__roster' })

  const ui = await $.ui.mount({
    plugin: 'office',
    surface: 'terminal',
    component: 'Pane',
    props: PANE_PROPS,
    requestId: 'office',
  })
  await ui.press({ key: 'log-abc123' })
  await ui.press({ key: 'tab-changes' })
  expect(await ui.find({ text: /\+ new line/ })).toBeDefined()
  expect(await ui.find({ text: /- old line/ })).toBeDefined()
})
