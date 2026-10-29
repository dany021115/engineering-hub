import type { SessionMessage } from 'claude-code'

import type { ContextFill, Live, Worker } from '../../types'
import { liveLine } from '../agents/activity'
import { isLive } from '../agents/staff'
import { lineWindow, threadLines, threadOf } from '../agents/thread'
import { relativePaths } from './elements'
import type { Elements } from './elements'
import { CLAUDE_ORANGE, contextMeter, moodOf } from './look'

export const MAX_TILES = 4

export type Split = { col: number; row: number }

export const EVEN_SPLIT: Split = { col: 0.5, row: 0.5 }

const SPLIT_STEP = 0.1
const SPLIT_MIN = 0.2
const SPLIT_MAX = 0.8

export const nudge = (split: Split, axis: keyof Split, step: 1 | -1): Split => ({
  ...split,
  [axis]: Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round((split[axis] + step * SPLIT_STEP) * 10) / 10)),
})

export const shares = (total: number, count: number, ratio: number) => {
  if (count <= 1) return [total]
  const first = Math.floor(total * ratio)
  return [first, total - first]
}

const TILE_CHROME_ROWS = 6
const HEADER_ROWS = 1

export type Tile = {
  worker: Worker
  messages: readonly SessionMessage[]
  answer?: string
  context?: ContextFill
  live?: Live
}

export type GridProps = {
  tiles: Tile[]
  now: number
  rows: number
  columns: number
  back: () => void
  expand: (worker: Worker) => void
  unpin: (worker: Worker) => void
  message: (worker: Worker, text: string) => void
  split: Split
  resize: (axis: keyof Split, step: 1 | -1) => void
  resetSize: () => void
  offsets: Record<string, number>
  scroll: (worker: Worker, offset: number) => void
  workspaceRoot: string
}

export const shapeOf = (count: number) => ({
  perRow: count <= 1 ? 1 : 2,
  rowCount: count <= 2 ? 1 : 2,
})

export function GridView({ Box, Text, Button, Input, Markdown }: Elements, props: GridProps) {
  const { perRow, rowCount } = shapeOf(props.tiles.length)
  const widths = shares(props.columns - (perRow - 1), perRow, props.split.col)
  const heights = shares(props.rows - HEADER_ROWS - (rowCount - 1), rowCount, props.split.row)

  const tile = (
    { worker, messages, answer, context, live }: Tile,
    place: number,
    row: number,
    alone: boolean,
  ) => {
    const tileWidth = alone ? props.columns : (widths[place] ?? props.columns)
    const tileRows = heights[row] ?? props.rows
    const mood = moodOf(worker.status)
    const meter = contextMeter(context)
    const offset = props.offsets[worker.id] ?? 0
    const bodyRows = tileRows - TILE_CHROME_ROWS
    const step = Math.max(1, Math.floor(bodyRows / 2))
    const thread = threadOf(messages, answer).map(entry => ({
      ...entry,
      text: relativePaths(entry.text, props.workspaceRoot).replace(/\*\*|`/g, ''),
    }))
    const view = lineWindow(threadLines(thread, tileWidth - 4, worker.label), offset, bodyRows)
    return (
      <Box
        key={`tile-${worker.id}`}
        flexDirection="column"
        width={tileWidth}
        height={tileRows}
        borderStyle="round"
        borderDimColor={!isLive(worker)}
        paddingX={1}
        overflow="hidden"
      >
        <Box flexDirection="row" gap={1}>
          <Text bold>{worker.label}</Text>
          <Text color={mood.color}>{mood.text}</Text>
          {meter && <Text color={meter.color}>{`${meter.bar} ${meter.label}`}</Text>}
          {view.above > 0 && (
            <Button key={`older-${worker.id}`} onPress={() => props.scroll(worker, offset + step)}>
              ▲
            </Button>
          )}
          {view.below > 0 && (
            <Button key={`newer-${worker.id}`} onPress={() => props.scroll(worker, offset - step)}>
              ▼
            </Button>
          )}
          <Button key={`expand-${worker.id}`} onPress={() => props.expand(worker)}>
            ⤢
          </Button>
          <Button key={`unpin-${worker.id}`} onPress={() => props.unpin(worker)}>
            ✕
          </Button>
        </Box>
        <Text dimColor wrap="truncate">
          {worker.task}
        </Text>
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {view.lines.map((line, index) => (
            <Text
              key={`line-${worker.id}-${index}`}
              bold={line.isHeader}
              color={line.isHeader ? (line.from === 'agent' ? CLAUDE_ORANGE : 'cyan') : undefined}
              wrap="truncate"
            >
              {line.text || ' '}
            </Text>
          ))}
        </Box>
        {live && isLive(worker) && (
          <Text color="green" dimColor wrap="truncate">
            {liveLine(live, props.now)}
          </Text>
        )}
        {Input && (
          <Input
            key={`tile-message-${worker.id}`}
            placeholder={`Message ${worker.label}`}
            submitLabel="Send"
            onSubmit={(text: string) => props.message(worker, text)}
          />
        )}
      </Box>
    )
  }

  const sizeButton = (key: string, label: string, hotkey: string, onPress: () => void) => (
    <Button key={`size-${key}`} hotkey={hotkey} onPress={onPress}>
      {label}
    </Button>
  )

  const rows = Array.from({ length: rowCount }, (_, index) =>
    props.tiles.slice(index * perRow, index * perRow + perRow),
  )

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Button key="grid-back" hotkey="b" onPress={props.back}>
          ← Office
        </Button>
        {perRow > 1 && sizeButton('narrow', '◂', 'h', () => props.resize('col', -1))}
        {perRow > 1 && sizeButton('widen', '▸', 'l', () => props.resize('col', 1))}
        {rowCount > 1 && sizeButton('shorter', '▴', 'k', () => props.resize('row', -1))}
        {rowCount > 1 && sizeButton('taller', '▾', 'j', () => props.resize('row', 1))}
        {(perRow > 1 || rowCount > 1) && sizeButton('even', '=', 'r', props.resetSize)}
        <Text dimColor>⊞ on an agent's row adds it here, up to {MAX_TILES}</Text>
      </Box>
      {props.tiles.length === 0 ? (
        <Text dimColor>No agents pinned yet.</Text>
      ) : (
        rows.map((row, index) => (
          <Box key={`grid-row-${index}`} flexDirection="row" gap={1}>
            {row.map((one, place) => tile(one, place, index, row.length === 1))}
          </Box>
        ))
      )}
    </Box>
  )
}
