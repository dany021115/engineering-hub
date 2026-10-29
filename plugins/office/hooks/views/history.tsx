import type { SessionMessage } from 'claude-code'

import type { Change, ContextFill, Live, Worker, Worktree } from '../../types'
import { liveLine } from '../agents/activity'
import { lineDiff, sharedFiles } from '../agents/changes'
import { isLive } from '../agents/staff'
import { HANDBACK, lastAnswer, threadOf } from '../agents/thread'
import type { Speaker } from '../agents/thread'
import { relativePaths } from './elements'
import type { Elements } from './elements'
import { CLAUDE_ORANGE, contextMeter } from './look'

const MAX_CHAT_ENTRIES = 60
const MAX_STEP_ENTRIES = 200

export type HistoryTab = 'chat' | 'changes' | 'steps'

export type HistoryProps = {
  worker: Worker
  messages: readonly SessionMessage[]
  answer?: string
  tab: HistoryTab
  changes: Change[]
  context?: ContextFill
  live?: Live
  now: number
  worktree?: Worktree
  worktreeDiff?: string
  apply: () => void
  discard: () => void
  message: (text: string) => void
  workspaceRoot: string
  back: () => void
  backLabel: string
  showTab: (tab: HistoryTab) => void
  share: (answer: string) => void
}

const toolSummary = (input: Record<string, unknown>, root: string) =>
  relativePaths(typeof input.description === 'string' ? input.description : JSON.stringify(input), root)

const visibleUses = (message: SessionMessage) => message.toolUses.filter(use => use.tool !== HANDBACK)

const isShown = (message: SessionMessage) => Boolean(message.text.trim()) || visibleUses(message).length > 0

const SPEAKER_COLORS: Record<Speaker, string> = { you: 'cyan', agent: CLAUDE_ORANGE, office: 'yellow' }

export function HistoryView({ Box, Text, Button, Input, Markdown, Code }: Elements, props: HistoryProps) {
  const thread = threadOf(props.messages, props.answer)
  const answer = lastAnswer(thread)
  const meter = contextMeter(props.context)
  const back = (key: string) => (
    <Button key={key} hotkey="b" onPress={props.back}>
      {props.backLabel}
    </Button>
  )
  const tabButton = (tab: HistoryTab, label: string, place: string) => (
    <Button
      key={`tab-${tab}${place}`}
      variant={props.tab === tab ? 'primary' : 'secondary'}
      onPress={() => props.showTab(tab)}
    >
      {label}
    </Button>
  )

  const tabs = (place: string) => [
    tabButton('chat', 'Chat', place),
    tabButton('changes', 'Changes', place),
    tabButton('steps', 'Steps', place),
  ]

  const liveRow = props.live && isLive(props.worker) && (
    <Text key="live" color="green" dimColor wrap="truncate">
      {liveLine(props.live, props.now)}
    </Text>
  )

  const chatTab = thread.length ? (
    <Box flexDirection="column" gap={1}>
      {thread.slice(-MAX_CHAT_ENTRIES).map((entry, index) => (
        <Box key={`chat-${index}`} flexDirection="column">
          <Text bold color={SPEAKER_COLORS[entry.from]}>
            {entry.from === 'agent' ? props.worker.label : entry.from}
          </Text>
          {entry.from === 'agent' ? (
            <Markdown key={`reply-${index}`} text={relativePaths(entry.text, props.workspaceRoot)} />
          ) : (
            <Text>{relativePaths(entry.text, props.workspaceRoot)}</Text>
          )}
        </Box>
      ))}
      {liveRow}
      {!answer && !liveRow && <Text dimColor>No answer recorded.</Text>}
      {answer && (
        <Button key="share" onPress={() => props.share(answer)}>
          Send last answer to chat
        </Button>
      )}
    </Box>
  ) : (
    <Text dimColor>No conversation recorded yet.</Text>
  )

  const shown = props.messages.filter(isShown)
  const mine = props.changes.filter(change => change.agentId === props.worker.id)
  const conflicts = new Set(sharedFiles(props.changes, props.worker.id))
  const worktreeTab = props.worktree && (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>Isolated worktree: changes stay out of the repo until applied.</Text>
      {props.worktreeDiff ? (
        <Code key="worktree-diff" source={props.worktreeDiff} format="diff" />
      ) : (
        <Text dimColor>No changes in the worktree yet.</Text>
      )}
      <Box flexDirection="row" gap={1}>
        {props.worktreeDiff && (
          <Button key="apply" variant="primary" onPress={props.apply}>
            Apply to repo
          </Button>
        )}
        <Button key="discard" onPress={props.discard}>
          Discard worktree
        </Button>
      </Box>
    </Box>
  )

  const changesTab = worktreeTab ? (
    worktreeTab
  ) : mine.length ? (
    <Box flexDirection="column" gap={1}>
      {mine.map((change, index) => (
        <Box key={`change-${index}`} flexDirection="column">
          <Text bold wrap="truncate">
            {change.file}
            {conflicts.has(change.file) && <Text color="red"> ⚠ also changed by another agent</Text>}
          </Text>
          {lineDiff(change.before, change.after).map((line, lineIndex) => (
            <Text
              key={`diff-${index}-${lineIndex}`}
              color={line.sign === '+' ? 'green' : 'red'}
              wrap="truncate"
            >
              {line.sign} {line.text}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  ) : (
    <Text dimColor>No file changes recorded.</Text>
  )

  const entries = shown.slice(-MAX_STEP_ENTRIES)
  const stepsTab = (
    <Box flexDirection="column">
      {entries.length === 0 && <Text dimColor>No conversation recorded yet.</Text>}
      {entries.map((message, index) => (
        <Box key={`message-${index}`} flexDirection="column">
          {message.text.trim() && (
            <Text>
              <Text bold color={message.role === 'assistant' ? CLAUDE_ORANGE : 'cyan'}>
                {message.role === 'assistant' ? 'agent › ' : 'prompt › '}
              </Text>
              {relativePaths(message.text.trim(), props.workspaceRoot)}
            </Text>
          )}
          {visibleUses(message).map((use, useIndex) => (
            <Text key={`use-${index}-${useIndex}`} dimColor wrap="truncate">
              → {use.tool}: {toolSummary(use.input, props.workspaceRoot)}
            </Text>
          ))}
        </Box>
      ))}
      {liveRow}
    </Box>
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1}>
        {back('back')}
        {tabs('')}
        <Text bold>{props.worker.label}</Text>
        {meter && <Text color={meter.color}>{`${meter.bar} ${meter.label}`}</Text>}
        <Text dimColor wrap="truncate">
          {props.worker.task}
        </Text>
      </Box>
      {props.tab === 'chat' ? chatTab : props.tab === 'changes' ? changesTab : stepsTab}
      {Input && (
        <Input
          key="message"
          label={`Message ${props.worker.label}`}
          placeholder={isLive(props.worker) ? 'Add instructions' : 'Ask a follow-up and press Enter'}
          submitLabel="Send"
          onSubmit={(text: string) => props.message(text)}
        />
      )}
      <Box flexDirection="row" gap={1}>
        {back('back-bottom')}
        {tabs('-bottom')}
      </Box>
    </Box>
  )
}
