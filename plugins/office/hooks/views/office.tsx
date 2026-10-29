import type { Change, ContextFill, Live, Note, Question, Speed, Worker, Worktree } from '../../types'
import { liveLine } from '../agents/activity'
import { filesOf, sharedFiles } from '../agents/changes'
import { SPEEDS, SPEED_NAMES, isLive, speedSummary } from '../agents/staff'
import { firstLine } from './elements'
import type { Elements } from './elements'
import { CLAUDE_ORANGE, SPRITE, contextMeter, moodOf } from './look'

const BOARD_LINES = 5

export type DeskActions = {
  pause: (worker: Worker) => void
  play: (worker: Worker) => void
  askStop: (worker: Worker) => void
  confirmStop: (worker: Worker) => void
  cancelStop: () => void
  setSpeed: (worker: Worker, speed: Speed) => void
  view: (worker: Worker) => void
  split: (worker: Worker) => void
  pin: (worker: Worker) => void
  showGrid: () => void
  remove: (worker: Worker) => void
  hire: (task: string) => void
  toggleIsolation: () => void
  toggleNextIsolated: () => void
}

export type OfficeProps = {
  staff: Worker[]
  questions: Question[]
  notes: Note[]
  paused: string[]
  stopping: string
  speeds: Record<string, Speed>
  answers: Record<string, string>
  changes: Change[]
  contexts: Record<string, ContextFill>
  lives: Record<string, Live>
  now: number
  grid: string[]
  isolation: boolean
  nextIsolated: boolean
  worktrees: Record<string, Worktree>
  actions: DeskActions
}

const statusOf = (worker: Worker, paused: string[]) =>
  paused.includes(worker.id) && !isLive(worker) ? 'paused' : worker.status

const openQuestionsFor = (worker: Worker, questions: Question[]) =>
  questions.filter(question => question.to === worker.id && question.status === 'open').length

export function OfficeView({ Box, Text, Button, Input }: Elements, props: OfficeProps) {
  const { actions } = props

  const controls = (worker: Worker, status: string) => {
    if (props.stopping === worker.id) {
      return [
        <Text key={`ask-${worker.id}`}>Stop it?</Text>,
        <Button key={`confirm-${worker.id}`} onPress={() => actions.confirmStop(worker)}>
          Yes
        </Button>,
        <Button key={`cancel-${worker.id}`} onPress={actions.cancelStop}>
          No
        </Button>,
      ]
    }
    const log = [
      <Button key={`log-${worker.id}`} onPress={() => actions.view(worker)}>
        Log
      </Button>,
      <Button key={`split-${worker.id}`} onPress={() => actions.split(worker)}>
        ⧉
      </Button>,
      <Button
        key={`pin-${worker.id}`}
        variant={props.grid.includes(worker.id) ? 'primary' : 'secondary'}
        onPress={() => actions.pin(worker)}
      >
        ⊞
      </Button>,
    ]
    if (!isLive(worker) && status !== 'paused') {
      if (props.worktrees[worker.id]) return log
      return [
        ...log,
        <Button key={`remove-${worker.id}`} onPress={() => actions.remove(worker)}>
          ✕
        </Button>,
      ]
    }
    return [
      isLive(worker) ? (
        <Button key={`pause-${worker.id}`} onPress={() => actions.pause(worker)}>
          ⏸
        </Button>
      ) : (
        <Button key={`play-${worker.id}`} onPress={() => actions.play(worker)}>
          ▶
        </Button>
      ),
      <Button key={`stop-${worker.id}`} onPress={() => actions.askStop(worker)}>
        ■
      </Button>,
      ...log,
      ...SPEED_NAMES.map(speed => (
        <Button
          key={`speed-${speed}-${worker.id}`}
          variant={props.speeds[worker.id] === speed ? 'primary' : 'secondary'}
          onPress={() => actions.setSpeed(worker, speed)}
        >
          {SPEEDS[speed].label}
        </Button>
      )),
    ]
  }

  const desk = (worker: Worker) => {
    const live = isLive(worker)
    const status = statusOf(worker, props.paused)
    const mood = moodOf(status)
    const pending = openQuestionsFor(worker, props.questions)
    const meter = contextMeter(props.contexts[worker.id])
    const touched = filesOf(props.changes, worker.id).length
    const shared = sharedFiles(props.changes, worker.id).length
    const answer = props.answers[worker.id]
    const activity = live ? props.lives[worker.id] : undefined
    const detail = activity
      ? liveLine(activity, props.now)
      : answer && !live
        ? firstLine(answer)
        : speedSummary(props.speeds[worker.id])
    return (
      <Box key={`desk-${worker.id}`} flexDirection="row" gap={1}>
        <Box flexDirection="column">
          {SPRITE.map((line, index) => (
            <Text key={`sprite-${worker.id}-${index}`} color={CLAUDE_ORANGE} dimColor={!live}>
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" flexShrink={1}>
          <Text wrap="truncate">
            <Text bold>{worker.label}</Text> <Text color={mood.color}>{mood.text}</Text>
            {pending > 0 && <Text color="yellow"> ?{pending}</Text>}
            {props.worktrees[worker.id] && <Text color="cyan"> ⎇</Text>}
            {touched > 0 && <Text color="magenta"> Δ{touched}</Text>}
            {shared > 0 && <Text color="red"> ⚠{shared}</Text>} <Text dimColor>{worker.task}</Text>
          </Text>
          <Box flexDirection="row" columnGap={1}>
            {meter && <Text color={meter.color}>{`${meter.bar} ${meter.label}`}</Text>}
            {controls(worker, status)}
            <Text dimColor wrap="truncate">
              {detail}
            </Text>
          </Box>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1}>
        <Button
          key="isolation"
          variant={props.isolation ? 'primary' : 'secondary'}
          onPress={actions.toggleIsolation}
        >
          {props.isolation ? 'Worktrees: on' : 'Worktrees: off'}
        </Button>
        <Text dimColor>
          {props.isolation ? 'new agents work in their own git worktree' : 'new agents work in the repo'}
        </Text>
        <Button
          key="show-grid"
          variant={props.grid.length ? 'primary' : 'secondary'}
          onPress={actions.showGrid}
        >
          {`Grid (${props.grid.length})`}
        </Button>
      </Box>
      <Box flexDirection="column">
        {props.staff.length ? (
          props.staff.map(desk)
        ) : (
          <Text dimColor>The office is empty. Hire someone below.</Text>
        )}
      </Box>
      <Box flexDirection="column">
        <Text bold>Board</Text>
        {props.notes.length === 0 && <Text dimColor>Nothing posted yet.</Text>}
        {props.notes.slice(-BOARD_LINES).map((note, index) => (
          <Text key={`note-${index}`} wrap="truncate">
            · {note.topic} <Text dimColor>({note.author})</Text>
          </Text>
        ))}
      </Box>
      {Input && (
        <Box flexDirection="column">
          {!props.isolation && (
            <Box flexDirection="row" gap={1}>
              <Button
                key="next-isolated"
                variant={props.nextIsolated ? 'primary' : 'secondary'}
                onPress={actions.toggleNextIsolated}
              >
                ⎇ Next in worktree
              </Button>
              {props.nextIsolated && <Text dimColor>the next hire gets its own worktree</Text>}
            </Box>
          )}
          <Input
            key="hire"
            label={props.nextIsolated && !props.isolation ? 'Hire ⎇' : 'Hire'}
            placeholder="Describe a task and press Enter"
            submitLabel="Hire"
            onSubmit={(task: string) => actions.hire(task)}
          />
        </Box>
      )}
    </Box>
  )
}
