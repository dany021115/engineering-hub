export const OFFICE_RULES = `# Working in the office

You share an office with other agents. The office tools (mcp__office__*) let you cooperate:
- Before researching something, call roster and board: someone may already know it.
- When you learn something others could reuse, post it to the board.
- Ask a colleague instead of repeating their research. Questions are asynchronous: keep working until the answer arrives.
- When you are asked a question, answer it with reply if you can do so quickly; otherwise delegate it to a helper and continue your task.
- Use hire to start an agent inside a specific repo.`

export const briefing = (roster: string, workspace: string) =>
  [OFFICE_RULES, `# Who is working now\n${roster}`, workspace].filter(Boolean).join('\n\n')

export const questionMessage = (id: string, asker: string, question: string) =>
  `[office] Question ${id} from ${asker}:\n${question}\n\n` +
  `Answer it with the office reply tool (questionId "${id}"), or hand it to a helper ` +
  `with the office delegate tool, then continue your own work.`

export const answerMessage = (id: string, author: string, answer: string) =>
  `[office] Answer to ${id} from ${author}:\n${answer}`

export const helperPrompt = (question: string, context: string) =>
  `A colleague in the office asked this question:\n${question}\n\n` +
  (context ? `Context from the agent who was asked:\n${context}\n\n` : '') +
  `Find the answer and finish with the answer alone; it is forwarded to them.`

export const RESUME_MESSAGE = '[office] You were paused. Resume your task where you left off.'

export const sharedAnswer = (label: string, task: string, answer: string) =>
  `[office] Answer from ${label} (${task}):\n\n${answer}`

// A one-line summary of a hire's task, for the desk label and the hire toast.
// The raw task is often several lines; a hard character cut lands mid-word, so
// collapse the whitespace and trim back to a word boundary before the ellipsis.
export const taskSummary = (task: string, max = 72) => {
  const line = task.replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  const cut = line.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}
