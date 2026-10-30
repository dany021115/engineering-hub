import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { Question, QuestionStatus, Speed, Worker, Worktree } from '../types'
import {
  FLUSH_MS,
  isStreaming,
  liveFromMessages,
  startLive,
  usedTokens,
  windowOf,
  withChunk,
} from './agents/activity'
import { MAX_CHANGES, changesFromMessages } from './agents/changes'
import { LEAD, SPEEDS, isLive, isSpeed, labelIn, mergeStaff, rosterOf, toWorker } from './agents/staff'
import { handbackOf } from './agents/thread'
import { PANE, TITLE, agentOfPane, detailPaneId } from './views/elements'
import { EVEN_SPLIT, GridView, MAX_TILES, nudge } from './views/grid'
import { HistoryView } from './views/history'
import type { HistoryTab } from './views/history'
import { OfficeView } from './views/office'
import { workspaceBriefing } from './workspace/briefing'
import { discover, neverIsolatedOf } from './workspace/discover'
import type { Reader, Workspace } from './workspace/discover'
import {
  OFFICE_RULES,
  RESUME_MESSAGE,
  answerMessage,
  briefing,
  helperPrompt,
  questionMessage,
  sharedAnswer,
  taskSummary,
} from './workspace/texts'
import { NO_REPOS, TOOLS, hireTool, toolName } from './workspace/tools'
import type { ToolName } from './workspace/tools'
import { basename, isInside, parentOf } from './workspace/paths'
import {
  WORKTREES_FOLDER,
  applyChanges,
  git,
  gitRunner,
  isolatedTask,
  worktreeDiff,
  worktreePathFor,
} from './workspace/worktree'

const POLL_MS = 2000
const WORKTREE_FLAG = '--worktree'
const MAX_NOTES = 200

const workers = atom({ plugin: 'office', key: 'workers' } as const, [])
const notes = atom({ plugin: 'office', key: 'notes' } as const, [])
const questions = atom({ plugin: 'office', key: 'questions' } as const, [])
const paused = atom({ plugin: 'office', key: 'paused' } as const, [])
const stopping = atom({ plugin: 'office', key: 'stopping' } as const, '')
const speeds = atom({ plugin: 'office', key: 'speeds' } as const, {})
const answers = atom({ plugin: 'office', key: 'answers' } as const, {})
const removed = atom({ plugin: 'office', key: 'removed' } as const, [])
const viewing = atom({ plugin: 'office', key: 'viewing' } as const, '')
const tab = atom({ plugin: 'office', key: 'tab' } as const, 'chat')
const detailTabs = atom({ plugin: 'office', key: 'detailTabs' } as const, {})
const changes = atom({ plugin: 'office', key: 'changes' } as const, [])
const contexts = atom({ plugin: 'office', key: 'contexts' } as const, {})
const active = atom({ plugin: 'office', key: 'active' } as const, [])
const lives = atom({ plugin: 'office', key: 'lives' } as const, {})
const grid = atom({ plugin: 'office', key: 'grid' } as const, [])
const mode = atom({ plugin: 'office', key: 'mode' } as const, 'office')
const gridSplit = atom({ plugin: 'office', key: 'gridSplit' } as const, EVEN_SPLIT)
const gridOffsets = atom({ plugin: 'office', key: 'gridOffsets' } as const, {})
const isolation = atom({ plugin: 'office', key: 'isolation' } as const, false)
const nextIsolated = atom({ plugin: 'office', key: 'nextIsolated' } as const, false)
const worktrees = atom({ plugin: 'office', key: 'worktrees' } as const, {})

// Agents whose TaskStop is running for a pause: their turn ends then, which is not a finish.
const pausing = new Set<string>()

type Input = Record<string, unknown>

const field = (input: Input, key: string) => String(input[key] ?? '').trim()

async function refreshWorkers($: EngineInterface) {
  const current = await read($, workers)
  const listed = (await $.agent.list()).map(toWorker)
  const merged = mergeStaff(current, listed, await read($, removed), await read($, active))
  for (const worker of merged) await syncAgent($, worker.id, isLive(worker))
  if (JSON.stringify(current) === JSON.stringify(merged)) return merged

  await update($, workers, () => merged)
  const held = await read($, paused)
  const finished = merged.filter(
    worker => !isLive(worker) && current.some(before => before.id === worker.id && isLive(before)),
  )
  for (const worker of finished) {
    await recordHandback($, worker.id)
    await syncChanges($, worker.id)
    if (pausing.has(worker.id) || held.includes(worker.id)) continue
    await $.ui.toast(`${worker.label} finished: open Log to read the answer`)
  }
  return merged
}

async function recordHandback($: EngineInterface, agentId: string) {
  const history = await $.session.messages({ agentId })
  const answer = 'deny' in history ? undefined : handbackOf(history)
  if (answer) await update($, answers, all => ({ ...all, [agentId]: answer }))
}

async function syncAgent($: EngineInterface, agentId: string, working: boolean) {
  const current = (await read($, lives))[agentId]
  if (!working) {
    if (current) await update($, lives, ({ [agentId]: _done, ...rest }) => rest)
    return
  }
  const now = await $.clock.now()
  if (isStreaming(current, now)) return syncChanges($, agentId)
  const history = await readHistory($, agentId)
  if (!history) return
  const live = liveFromMessages(history, current?.since ?? now, now)
  await update($, lives, all => ({ ...all, [agentId]: live }))
  await storeChanges($, agentId, history)
}

async function readHistory($: EngineInterface, agentId: string) {
  const history = await $.session.messages({ agentId }).catch(() => undefined)
  return !history || 'deny' in history ? undefined : history
}

async function syncChanges($: EngineInterface, agentId: string) {
  const history = await readHistory($, agentId)
  if (history) await storeChanges($, agentId, history)
}

async function storeChanges($: EngineInterface, agentId: string, history: readonly SessionMessage[]) {
  const latest = changesFromMessages(agentId, history, await rootOf($))
  const all = await read($, changes)
  const current = all.filter(change => change.agentId === agentId)
  if (JSON.stringify(current) === JSON.stringify(latest)) return
  await update($, changes, () =>
    [...all.filter(change => change.agentId !== agentId), ...latest].slice(-MAX_CHANGES),
  )
}

async function labelOf($: EngineInterface, id: string) {
  return labelIn(await read($, workers), id)
}

async function findWorker($: EngineInterface, ref: string) {
  if (ref === LEAD) return LEAD
  const staff = await refreshWorkers($)
  return staff.find(worker => worker.id === ref || worker.label === ref)?.id
}

type Options = { workspaceRoot?: unknown; neverIsolate?: unknown }
type Known = { workspace: Workspace; briefing: string }

const NO_WORKSPACE: Workspace = { root: '', repos: [], skipped: 0, warnings: [] }

let options: Options = {}
let known: Promise<Known> | undefined
// The office's own hires, by the label each is spawned with, until its spawn
// passes the hook: the hook sets where the agent works, since a `cwd` handed to
// the spawn call itself does not reach the agent.
const hiring = new Map<string, { cwd: string }>()

const readerOf = ($: EngineInterface): Reader => ({
  dirOf: path =>
    $.fs
      .stat(path, { resolve: true })
      .then(stat => (stat.kind === 'dir' ? (stat.realPath ?? path) : undefined))
      .catch(() => undefined),
  listDirs: dir =>
    $.fs
      .list(dir)
      .then(entries => entries.filter(entry => entry.kind === 'dir').map(entry => entry.name))
      .catch(() => []),
  exists: path => $.fs.exists(path).catch(() => false),
  read: path => $.fs.read(path),
})

async function discoverOnce($: EngineInterface): Promise<Known> {
  const reader = readerOf($)
  const repo = await $.session.repo().catch(() => null)
  const sessionRoot = await $.session.root().catch(() => '')
  const workspace = await discover({ options, repoRoot: repo?.root ?? null, sessionRoot }, reader).catch(
    () => NO_WORKSPACE,
  )
  return { workspace, briefing: await workspaceBriefing(workspace, reader).catch(() => '') }
}

// The workspace is found once per session: the first hook that needs it starts it.
const knownOf = ($: EngineInterface) => (known ??= discoverOnce($))

const workspaceOf = async ($: EngineInterface) => (await knownOf($)).workspace

// The root paths are shown relative to; none without a repo to brief on.
const rootOf = async ($: EngineInterface) => {
  const workspace = await workspaceOf($)
  return workspace.repos.length ? workspace.root : ''
}

// The briefing reaches the main thread and spawns working inside the root, and
// every office hire wherever it works.
async function contextFor($: EngineInterface, cwd?: string, hired = false) {
  const { workspace, briefing } = await knownOf($)
  if (hired) return briefing
  const dir = cwd ?? (await $.session.cwd())
  return isInside(dir, workspace.root) ? briefing : ''
}

// Resolves to why the message was not stored, or undefined once it was.
async function deliver($: EngineInterface, to: string, text: string): Promise<string | undefined> {
  try {
    const stored = await $.session.append({
      message: { type: 'user', content: [{ type: 'text', text }] },
      agentId: to === LEAD ? undefined : to,
    })
    return stored.deny
  } catch (error) {
    return String(error)
  }
}

async function findQuestion($: EngineInterface, id: string) {
  return (await read($, questions)).find(question => question.id === id)
}

async function setStatus($: EngineInterface, id: string, status: QuestionStatus, helperId?: string) {
  const withStatus = ({ helperId: _previous, ...one }: Question): Question =>
    helperId ? { ...one, status, helperId } : { ...one, status }
  await update($, questions, all => all.map(one => (one.id === id ? withStatus(one) : one)))
}

async function postNote($: EngineInterface, author: string, topic: string, text: string) {
  await update($, notes, all => [...all, { author, topic, text }].slice(-MAX_NOTES))
}

const gitOf = ($: EngineInterface) =>
  gitRunner((argv, stdin) => $.process.run(argv, { stdin, timeoutMs: 120_000 }))

const runGit = ($: EngineInterface, argv: string[], stdin?: string) => gitOf($)(argv, stdin)

async function createWorktree($: EngineInterface, dir: string): Promise<Worktree | string> {
  const found = await runGit($, git.topLevel(dir))
  if (!found.ok) return 'not a git repo, so the agent works in place'
  const top = found.stdout.trim()
  const repo = basename(top)
  if (neverIsolatedOf(options.neverIsolate).includes(repo)) return `${repo} never uses worktrees`

  const path = worktreePathFor(parentOf(top), top, await $.clock.now())
  const added = await runGit($, git.add(top, path))
  if (!added.ok) return `worktree failed: ${added.stderr}`
  await ignoreWorktrees($, `${parentOf(top)}/${WORKTREES_FOLDER}`)
  return { repoRoot: top, path }
}

// The worktrees folder sits beside the repos, so git must not see it.
async function ignoreWorktrees($: EngineInterface, folder: string) {
  const ignore = `${folder}/.gitignore`
  if (await $.fs.exists(ignore).catch(() => false)) return
  await $.fs.write(ignore, '*\n').catch(() => undefined)
}

// A label no one on the board has: `<folder>-<n>`, the folder the hire works from.
async function freshLabel($: EngineInterface, dir: string) {
  const taken = new Set([...(await refreshWorkers($)).map(worker => worker.label), ...hiring.keys()])
  let n = 1
  while (taken.has(`${basename(dir)}-${n}`)) n++
  return `${basename(dir)}-${n}`
}

async function hire($: EngineInterface, task: string, cwd?: string, speed?: Speed, isolate?: boolean) {
  const dir = cwd ?? (await $.session.cwd())
  const label = await freshLabel($, dir)
  const wantsWorktree = isolate ?? (await read($, isolation))
  const isolated = wantsWorktree ? await createWorktree($, dir) : undefined
  if (typeof isolated === 'string') await $.ui.toast(`No worktree: ${isolated}`)
  const worktree = typeof isolated === 'object' ? isolated : undefined

  const summary = taskSummary(task)
  hiring.set(label, { cwd: worktree?.path ?? dir })
  const { agentId, deny } = await $.agent.spawn({
    subagentType: 'general-purpose',
    name: label,
    description: summary,
    prompt: worktree ? isolatedTask(task, worktree) : task,
    model: speed ? SPEEDS[speed].alias : undefined,
  })
  hiring.delete(label)
  if (deny || !agentId) {
    if (worktree) await runGit($, git.remove(worktree.repoRoot, worktree.path))
    return `Not hired: ${deny ?? 'unknown reason'}.`
  }
  if (worktree) await update($, worktrees, all => ({ ...all, [agentId]: worktree }))
  if (speed) await setSpeed($, agentId, speed)
  return `Hired ${label}${worktree ? ' in its own worktree' : ''} · ${summary}`
}

async function hireFromPane($: EngineInterface, task: string) {
  const isolate = (await read($, nextIsolated)) || undefined
  await update($, nextIsolated, () => false)
  await $.ui.toast(await hire($, task, undefined, undefined, isolate))
}


async function forgetWorktree($: EngineInterface, agentId: string, worktree: Worktree) {
  await runGit($, git.remove(worktree.repoRoot, worktree.path))
  await update($, worktrees, ({ [agentId]: _gone, ...rest }) => rest)
}


async function applyWorktree($: EngineInterface, worker: Worker, worktree: Worktree) {
  const { ok, message } = await applyChanges(gitOf($), worktree)
  if (!ok) return $.ui.toast(message)
  await update($, worktrees, ({ [worker.id]: _gone, ...rest }) => rest)
  await $.ui.toast(`${worker.label}'s changes applied to ${basename(worktree.repoRoot)}`)
}

async function discardWorktree($: EngineInterface, worker: Worker, worktree: Worktree) {
  await forgetWorktree($, worker.id, worktree)
  await $.ui.toast(`${worker.label}'s worktree discarded`)
}

async function setSpeed($: EngineInterface, id: string, speed?: Speed) {
  await update($, speeds, all => {
    const { [id]: _previous, ...rest } = all
    return speed ? { ...rest, [id]: speed } : rest
  })
}

async function ask($: EngineInterface, from: string, to: string, text: string) {
  const id = `q${(await read($, questions)).length + 1}`
  const refused = await deliver($, to, questionMessage(id, await labelOf($, from), text))
  if (refused !== undefined) {
    await $.ui.toast(`Question to ${await labelOf($, to)} not delivered: ${refused}`)
    // An agent whose run ended has no loop left to take the question.
    if (/no running loop/.test(refused)) {
      return `${await labelOf($, to)} has finished, so it cannot take questions: read its answer in its Log, or hire a new agent.`
    }
    return `That agent could not be asked (${refused}). Check the board or ask someone else.`
  }
  const question: Question = { id, from, to, question: text, status: 'open' }
  await update($, questions, all => [...all, question])
  return `Question ${id} sent. The answer will arrive as a message; keep working meanwhile.`
}

async function reply($: EngineInterface, id: string, answer: string, author: string) {
  const question = await findQuestion($, id)
  if (!question) return `There is no question ${id}.`
  if (question.status === 'answered') return `Question ${id} is already answered.`

  const refused = await deliver($, question.from, answerMessage(id, author, answer))
  if (refused !== undefined) {
    await $.ui.toast(`Answer to ${id} not delivered: ${refused}`)
    return `The answer to ${id} could not be delivered (${refused}); the question stays open.`
  }
  await setStatus($, id, 'answered')
  await postNote($, author, question.question.slice(0, 80), answer)
  return `Answer to ${id} delivered.`
}

async function delegate($: EngineInterface, id: string, context: string) {
  const question = await findQuestion($, id)
  if (!question) return `There is no question ${id}.`
  if (question.status !== 'open') return `Question ${id} is already ${question.status}.`

  const { agentId, deny } = await $.agent.spawn({
    subagentType: 'general-purpose',
    description: `answer ${id}`,
    prompt: helperPrompt(question.question, context),
  })
  if (deny || !agentId) return `The helper could not start: ${deny ?? 'unknown reason'}.`

  await setStatus($, id, 'delegated', agentId)
  return `A helper is answering ${id}. Continue your work.`
}

// A delegated question closes only on a helper's real answer; otherwise it goes
// back on the board, open, for someone else to take.
async function settleHelper($: EngineInterface, helperId: string, turn: { reason: string; answer: string }) {
  const question = (await read($, questions)).find(
    one => one.helperId === helperId && one.status === 'delegated',
  )
  if (!question) return
  if (turn.reason === 'answer' && turn.answer.trim()) {
    await reply($, question.id, turn.answer, `helper of ${await labelOf($, question.to)}`)
    return
  }
  await setStatus($, question.id, 'open')
  await $.ui.toast(`The helper for ${question.id} ended without an answer: the question is open again`)
}

async function runTool($: EngineInterface, name: ToolName, input: Input, caller: string): Promise<string> {
  switch (name) {
    case 'roster':
      return rosterOf(await refreshWorkers($), caller)
    case 'board': {
      const query = field(input, 'query').toLowerCase()
      const matches = (await read($, notes)).filter(note =>
        `${note.topic} ${note.text}`.toLowerCase().includes(query),
      )
      return matches.length
        ? matches.map(note => `## ${note.topic} (by ${note.author})\n${note.text}`).join('\n\n')
        : 'The board has nothing on that yet.'
    }
    case 'post':
      await postNote($, await labelOf($, caller), field(input, 'topic'), field(input, 'text'))
      return 'Posted to the board.'
    case 'ask': {
      const target = await findWorker($, field(input, 'to'))
      if (!target) return `Nobody called "${field(input, 'to')}" is in the office. Use roster.`
      if (target === caller) return 'You cannot ask yourself.'
      return ask($, caller, target, field(input, 'question'))
    }
    case 'reply':
      return reply($, field(input, 'questionId'), field(input, 'answer'), await labelOf($, caller))
    case 'delegate':
      return delegate($, field(input, 'questionId'), field(input, 'context'))
    case 'hire': {
      const repo = field(input, 'repo')
      const { repos } = await workspaceOf($)
      if (repo && !repos.length) return `${NO_REPOS}, so "${repo}" cannot be hired in: leave repo out.`
      const byName = Object.fromEntries(repos.map(one => [one.name, one]))
      if (repo && !Object.hasOwn(byName, repo)) return `Unknown repo "${repo}".`
      const known = repo ? byName[repo] : undefined
      const speedName = field(input, 'speed')
      if (speedName && !isSpeed(speedName)) return `Unknown speed "${speedName}".`
      const speed = speedName && isSpeed(speedName) ? speedName : undefined
      const worktree = field(input, 'worktree')
      if (worktree && worktree !== 'yes' && worktree !== 'no') return 'worktree must be "yes" or "no".'
      const cwd = known?.path
      return hire($, field(input, 'task'), cwd, speed, worktree ? worktree === 'yes' : undefined)
    }
  }
}

async function stopTask($: EngineInterface, worker: Worker) {
  const why = await $.tool
    .call({ tool: 'TaskStop', task_id: worker.id })
    .then(done => done.deny ?? (done.isError ? (done.text ?? 'TaskStop failed') : undefined))
    .catch((error: unknown) => String(error))
  if (why === undefined) return true
  await $.ui.toast(`Could not stop ${worker.label}: ${why}`)
  return false
}

async function pause($: EngineInterface, worker: Worker) {
  pausing.add(worker.id)
  try {
    if (!(await stopTask($, worker))) return
    await update($, paused, ids => [...ids.filter(id => id !== worker.id), worker.id])
  } finally {
    pausing.delete(worker.id)
  }
  await $.ui.toast(`${worker.label} paused`)
}

async function play($: EngineInterface, worker: Worker) {
  const sent = await $.session
    .send({ to: { agentId: worker.id }, text: RESUME_MESSAGE })
    .catch((error: unknown) => ({ isDelivered: false as const, reason: String(error) }))
  if (!sent.isDelivered) return $.ui.toast(`Could not resume ${worker.label}: ${sent.reason}`)
  await update($, paused, ids => ids.filter(id => id !== worker.id))
  await $.ui.toast(`${worker.label} is back at work`)
}

async function remove($: EngineInterface, worker: Worker) {
  await update($, removed, ids => [...ids, worker.id])
  await update($, workers, all => all.filter(one => one.id !== worker.id))
  await update($, answers, ({ [worker.id]: _answer, ...rest }) => rest)
  await update($, changes, all => all.filter(change => change.agentId !== worker.id))
  await update($, contexts, ({ [worker.id]: _fill, ...rest }) => rest)
  await update($, grid, ids => ids.filter(id => id !== worker.id))
  await setSpeed($, worker.id, undefined)
}

type Elements = Parameters<typeof OfficeView>[0]
type Viewport = { rows: number; columns: number }

const paneSize = (e: { props: { bodyColumns: number; scroll: { bodyRows: number } } }): Viewport => ({
  rows: e.props.scroll.bodyRows,
  columns: e.props.bodyColumns,
})
type HistoryNav = {
  tab: HistoryTab
  backLabel: string
  back: () => void
  showTab: (tab: HistoryTab) => void
}

async function renderHistory($: EngineInterface, elements: Elements, worker: Worker, nav: HistoryNav) {
  const worktree = (await read($, worktrees))[worker.id]
  const history = await $.session.messages({ agentId: worker.id })
  return HistoryView(elements, {
    worker,
    messages: 'deny' in history ? [] : history,
    answer: (await read($, answers))[worker.id],
    tab: nav.tab,
    changes: await read($, changes),
    context: (await read($, contexts))[worker.id],
    live: (await read($, lives))[worker.id],
    now: await $.clock.now(),
    worktree,
    worktreeDiff: worktree && nav.tab === 'changes' ? await worktreeDiff(gitOf($), worktree) : undefined,
    apply: () => void (worktree && applyWorktree($, worker, worktree)),
    discard: () => void (worktree && discardWorktree($, worker, worktree)),
    message: text => void message($, worker, text),
    workspaceRoot: await rootOf($),
    back: nav.back,
    backLabel: nav.backLabel,
    showTab: nav.showTab,
    share: answer => void shareAnswer($, worker, answer),
  })
}

async function renderDetail($: EngineInterface, elements: Elements, agentId: string) {
  const close = () => void $.ui.close({ id: detailPaneId(agentId) })
  const worker = (await read($, workers)).find(one => one.id === agentId)
  if (!worker) {
    const { Box, Text, Button } = elements
    return (
      <Box flexDirection="column">
        <Text dimColor>This agent is no longer in the office.</Text>
        <Button key="close" onPress={close}>
          ✕ Close
        </Button>
      </Box>
    )
  }
  return renderHistory($, elements, worker, {
    tab: (await read($, detailTabs))[agentId] ?? 'chat',
    backLabel: '✕ Close',
    back: close,
    showTab: next =>
      void syncChanges($, agentId)
        .then(() => update($, detailTabs, all => ({ ...all, [agentId]: next })))
        .then(() => scrollToEnd($, detailPaneId(agentId))),
  })
}

async function scrollTo($: EngineInterface, paneId: string, to: 'start' | 'end') {
  await $.ui.scroll({ to, in: paneId }).catch(() => undefined)
}

const scrollToEnd = ($: EngineInterface, paneId: string) => scrollTo($, paneId, 'end')

async function split($: EngineInterface, worker: Worker) {
  await syncChanges($, worker.id)
  const opened = await $.ui.open({
    id: detailPaneId(worker.id),
    title: `${worker.label} · ${worker.task.slice(0, 30)}`,
  })
  if (!opened.isPlaced) await $.ui.toast('Widen the terminal to show another pane')
}

async function pin($: EngineInterface, worker: Worker) {
  const pinned = await read($, grid)
  if (pinned.includes(worker.id)) return update($, grid, ids => ids.filter(id => id !== worker.id))
  if (pinned.length >= MAX_TILES) return $.ui.toast(`The grid holds ${MAX_TILES} agents: unpin one first`)
  await update($, grid, ids => [...ids, worker.id])
}

async function renderGrid($: EngineInterface, elements: Elements, viewport?: Viewport) {
  const staff = await read($, workers)
  const pinned = (await read($, grid)).flatMap(id => staff.filter(worker => worker.id === id))
  const allAnswers = await read($, answers)
  const allContexts = await read($, contexts)
  const allLives = await read($, lives)
  const tiles = []
  for (const worker of pinned) {
    const history = await $.session.messages({ agentId: worker.id }).catch(() => undefined)
    tiles.push({
      worker,
      messages: !history || 'deny' in history ? [] : history,
      answer: allAnswers[worker.id],
      context: allContexts[worker.id],
      live: allLives[worker.id],
    })
  }
  return GridView(elements, {
    tiles,
    now: await $.clock.now(),
    rows: viewport?.rows ?? 30,
    columns: viewport?.columns ?? 120,
    workspaceRoot: await rootOf($),
    back: () => void update($, mode, () => 'office'),
    expand: one =>
      void update($, mode, () => 'office')
        .then(() => update($, tab, () => 'chat'))
        .then(() => update($, viewing, () => one.id)),
    unpin: one => void update($, grid, ids => ids.filter(id => id !== one.id)),
    split: await read($, gridSplit),
    resize: (axis, step) => void update($, gridSplit, current => nudge(current, axis, step)),
    resetSize: () => void update($, gridSplit, () => EVEN_SPLIT),
    offsets: await read($, gridOffsets),
    scroll: (one, offset) => void update($, gridOffsets, all => ({ ...all, [one.id]: Math.max(0, offset) })),
    message: (one, text) => void message($, one, text),
  })
}

async function renderPane($: EngineInterface, elements: Elements, viewport?: Viewport) {
  if ((await read($, mode)) === 'grid') return renderGrid($, elements, viewport)
  const viewed = await read($, viewing)
  const worker = (await read($, workers)).find(one => one.id === viewed)
  if (worker) {
    return renderHistory($, elements, worker, {
      tab: await read($, tab),
      backLabel: '← Back',
      back: () => void update($, viewing, () => '').then(() => scrollTo($, PANE, 'start')),
      showTab: next =>
        void syncChanges($, worker.id)
          .then(() => update($, tab, () => next))
          .then(() => scrollToEnd($, PANE)),
    })
  }

  return OfficeView(elements, {
    staff: await read($, workers),
    questions: await read($, questions),
    notes: await read($, notes),
    paused: await read($, paused),
    stopping: await read($, stopping),
    speeds: await read($, speeds),
    answers: await read($, answers),
    changes: await read($, changes),
    contexts: await read($, contexts),
    lives: await read($, lives),
    now: await $.clock.now(),
    grid: await read($, grid),
    isolation: await read($, isolation),
    nextIsolated: await read($, nextIsolated),
    worktrees: await read($, worktrees),
    actions: {
      pause: one => void pause($, one),
      play: one => void play($, one),
      askStop: one => void update($, stopping, () => one.id),
      confirmStop: one => void stop($, one),
      cancelStop: () => void update($, stopping, () => ''),
      setSpeed: (one, speed) =>
        void read($, speeds).then(all => setSpeed($, one.id, all[one.id] === speed ? undefined : speed)),
      view: one =>
        void syncChanges($, one.id)
          .then(() => update($, tab, () => 'chat'))
          .then(() => update($, viewing, () => one.id))
          .then(() => scrollToEnd($, PANE)),
      split: one => void split($, one),
      pin: one => void pin($, one),
      showGrid: () => void update($, mode, () => 'grid'),
      remove: one => void remove($, one),
      toggleIsolation: () => void update($, isolation, on => !on),
      toggleNextIsolated: () => void update($, nextIsolated, on => !on),
      hire: task => {
        if (task.trim()) void hireFromPane($, task.trim())
      },
    },
  })
}

async function message($: EngineInterface, worker: Worker, text: string) {
  if (!text.trim()) return
  const sent = await $.session
    .send({ to: { agentId: worker.id }, text: text.trim() })
    .catch((error: unknown) => ({ isDelivered: false as const, reason: String(error) }))
  if (!sent.isDelivered) return $.ui.toast(`Could not send to ${worker.label}: ${sent.reason}`)
  await update($, paused, ids => ids.filter(id => id !== worker.id))
  await update($, answers, ({ [worker.id]: _answer, ...rest }) => rest)
  await scrollToEnd($, PANE)
  await scrollToEnd($, detailPaneId(worker.id))
  await $.ui.toast(`Sent to ${worker.label}`)
}

async function shareAnswer($: EngineInterface, worker: Worker, answer: string) {
  const text = sharedAnswer(worker.label, worker.task, answer)
  const why =
    (await deliver($, LEAD, text)) ??
    (await $.session
      .append({ message: { type: 'system', content: [{ type: 'text', text }] } })
      .then(stored => stored.deny)
      .catch((error: unknown) => String(error)))
  if (why !== undefined) return $.ui.toast(`Could not share ${worker.label}'s answer: ${why}`)
  await $.ui.toast(`${worker.label}'s answer is in the chat`)
}

async function stop($: EngineInterface, worker: Worker) {
  await update($, stopping, () => '')
  await update($, paused, ids => ids.filter(id => id !== worker.id))
  if (isLive(worker) && !(await stopTask($, worker))) return
  await $.ui.toast(`${worker.label} went home`)
}

export const register: Register = (on, config) => {
  options = config
  known = undefined
  hiring.clear()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'office',
      description: 'Open the office, or hire an agent: /office [--worktree] <task>',
      argumentHint: '[--worktree] [task]',
    })
    const workspace = await workspaceOf($)
    for (const warning of workspace.warnings) await $.ui.toast(warning)
    const repos = workspace.repos.map(repo => repo.name)
    for (const tool of TOOLS) {
      await $.tool.register({ ...(tool.name === 'hire' ? hireTool(repos) : tool), isDeferred: false })
    }

    $.clock.every(POLL_MS, async () => {
      const busy = (await refreshWorkers($)).filter(isLive).length
      await $.ui.status(busy ? `office: ${busy} at work` : undefined)
    })
    return next(e)
  })

  on('command.run', { command: 'office' }, async ($, e) => {
    const args = e.args.trim()
    const isolate = args.startsWith(WORKTREE_FLAG)
    const task = isolate ? args.slice(WORKTREE_FLAG.length).trim() : args
    if (task) return { text: await hire($, task, undefined, undefined, isolate || undefined) }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Office opened.' }
  })

  // The office's tools only read and write its own board and messages, so it allows them itself: a
  // prompt would stall a hired agent. hire, which starts agents, still asks. Each hook names its tool
  // exactly: called from an agent's loop, a registered tool reaches no hook whose matcher is a pattern
  // (pilot P2.4; tests/smoke-cwd.sh checks it in a real session).
  for (const tool of TOOLS.filter(one => one.name !== 'hire')) {
    on('tool.check', { tool: toolName(tool.name) }, () => ({ decision: 'allow' as const }))
  }

  for (const tool of TOOLS) {
    on('tool.call', { tool: toolName(tool.name) }, async ($, e) => ({
      result: await runTool($, tool.name, e, e.agentId ?? LEAD),
    })).catch(($, e, next) => (next.called ? next(e) : { deny: `The office ${e.tool} tool failed.` }))
  }

  on('agent.spawn', async ($, e, next) => {
    // A resumed run, a fork and a workflow agent keep their prompt as it is.
    if (e.resume || e.fork || e.workflow) return next(e)
    const hired = e.name !== undefined ? hiring.get(e.name) : undefined
    const cwd = hired?.cwd ?? e.cwd
    const roster = rosterOf(await refreshWorkers($))
    const prompt = `${e.prompt}\n\n${briefing(roster, await contextFor($, cwd, hired !== undefined))}`
    return next(cwd === undefined ? { ...e, prompt } : { ...e, cwd, prompt })
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const text = [OFFICE_RULES, await contextFor($)].filter(Boolean).join('\n\n')
    return { sections: [...composed.sections, { id: 'office:context', text, scope: 'session' }] }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) {
      const agentId = e.agentId
      await update($, active, ids => ids.filter(id => id !== agentId))
      await update($, lives, ({ [agentId]: _done, ...rest }) => rest)
      await refreshWorkers($)
      await update($, answers, all => ({ ...all, [agentId]: e.answer }))
      await settleHelper($, agentId, e)
    }
    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) return yield* next(e)
    const agentId = e.agentId
    if (!(await read($, active)).includes(agentId)) {
      await update($, active, ids => [...ids, agentId])
      await refreshWorkers($)
    }
    const speed = (await read($, speeds))[agentId]
    const { effort: _sessionEffort, ...rest } = e
    const profile = speed ? SPEEDS[speed] : undefined
    const step = !profile
      ? e
      : profile.effort
        ? { ...rest, model: profile.model, effort: profile.effort }
        : { ...rest, model: profile.model }

    let live = (await read($, lives))[agentId] ?? startLive(await $.clock.now())
    let flushedAt = 0
    const stream = next(step)
    let piece = await stream.next()
    while (!piece.done) {
      yield piece.value
      live = withChunk(live, piece.value)
      const now = await $.clock.now()
      if (now - flushedAt >= FLUSH_MS) {
        flushedAt = now
        const snapshot = { ...live, at: now, source: 'stream' as const }
        await update($, lives, all => ({ ...all, [agentId]: snapshot }))
      }
      piece = await stream.next()
    }
    const finalLive = { ...live, at: await $.clock.now(), source: 'stream' as const }
    await update($, lives, all => ({ ...all, [agentId]: finalLive }))

    const result = piece.value
    const usage = result.usage
    if (usage) {
      const fill = { used: usedTokens(usage), window: windowOf(step.model) }
      await update($, contexts, all => ({ ...all, [agentId]: fill }))
    }
    return result
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    const agentId = agentOfPane(e.requestId)
    return agentId ? renderDetail($, $.ui.resolve(e), agentId) : next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) =>
    renderPane($, $.ui.resolve(e), paneSize(e)),
  )
}
