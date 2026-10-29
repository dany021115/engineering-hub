export type Worker = {
  id: string
  label: string
  type: string
  task: string
  status: string
}

export type Note = {
  author: string
  topic: string
  text: string
}

export type Speed = 'fast' | 'balanced' | 'deep'

export type Change = {
  agentId: string
  file: string
  before: string
  after: string
}

export type ContextFill = { used: number; window: number }

export type Worktree = { repoRoot: string; path: string }

export type Live = {
  since: number
  at: number
  source: 'stream' | 'transcript'
  kind: 'thinking' | 'text' | 'tool'
  tool?: string
  text: string
}

export type QuestionStatus = 'open' | 'delegated' | 'answered'

export type Question = {
  id: string
  from: string
  to: string
  question: string
  status: QuestionStatus
  helperId?: string
}

declare module 'claude-code' {
  interface PluginState {
    office: {
      workers: Worker[]
      notes: Note[]
      questions: Question[]
      paused: string[]
      stopping: string
      speeds: Record<string, Speed>
      answers: Record<string, string>
      removed: string[]
      viewing: string
      tab: 'chat' | 'changes' | 'steps'
      detailTabs: Record<string, 'chat' | 'changes' | 'steps'>
      changes: Change[]
      contexts: Record<string, ContextFill>
      active: string[]
      lives: Record<string, Live>
      grid: string[]
      mode: 'office' | 'grid'
      gridSplit: { col: number; row: number }
      gridOffsets: Record<string, number>
      isolation: boolean
      nextIsolated: boolean
      worktrees: Record<string, Worktree>
    }
  }
}
