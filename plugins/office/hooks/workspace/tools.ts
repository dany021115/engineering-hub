import { SPEED_NAMES } from '../agents/staff'

export type ToolName = 'roster' | 'board' | 'post' | 'ask' | 'reply' | 'delegate' | 'hire'

type ToolSpec = {
  name: ToolName
  description: string
  inputSchema: Record<string, unknown>
}

const schema = (properties: Record<string, string>, required: string[] = []) => ({
  type: 'object',
  properties: Object.fromEntries(
    Object.entries(properties).map(([key, description]) => [key, { type: 'string', description }]),
  ),
  required,
})

export const TOOLS: ToolSpec[] = [
  {
    name: 'roster',
    description:
      'List the agents working in the office and what each is doing. Check it before research another agent may already be doing.',
    inputSchema: schema({}),
  },
  {
    name: 'board',
    description:
      'Read the shared board of findings and answered questions, optionally filtered by a search text.',
    inputSchema: schema({ query: 'Text to filter notes by' }),
  },
  {
    name: 'post',
    description:
      'Publish a finding to the shared board so other agents reuse it instead of researching it again.',
    inputSchema: schema({ topic: 'Short title', text: 'The finding, with file paths where relevant' }, [
      'topic',
      'text',
    ]),
  },
  {
    name: 'ask',
    description:
      'Ask another agent (by id, name, or "lead") a question. Returns at once; the answer arrives later as a message.',
    inputSchema: schema({ to: 'Agent id, name, or "lead"', question: 'The question' }, ['to', 'question']),
  },
  {
    name: 'reply',
    description: 'Answer a question another agent asked you.',
    inputSchema: schema({ questionId: 'The id, e.g. q3', answer: 'The answer' }, ['questionId', 'answer']),
  },
  {
    name: 'delegate',
    description:
      'Hand a question you were asked to a new helper agent and keep working. The helper sends its answer to the asker.',
    inputSchema: schema(
      { questionId: 'The id, e.g. q3', context: 'What you already know that helps answer it' },
      ['questionId'],
    ),
  },
  {
    name: 'hire',
    description: 'Start a new agent on a task, optionally inside one repo of the workspace.',
    inputSchema: schema(
      {
        task: 'What the agent should do',
        repo: 'Repo to work in',
        speed: `One of ${SPEED_NAMES.join(', ')}: fast for lookups, deep for hard design or debugging`,
        worktree:
          '"yes" to run this agent alone in its own git worktree, "no" to work in the repo; omit to follow the office setting',
      },
      ['task'],
    ),
  },
]

export const NO_REPOS = 'No repos were found in the workspace'

// The hire tool as the session sees it: `repo` is one of the discovered repos.
export function hireTool(repos: string[]): ToolSpec {
  const base = TOOLS.find(tool => tool.name === 'hire') as ToolSpec
  const schema = base.inputSchema as { properties: Record<string, Record<string, unknown>> }
  const repo = repos.length
    ? { ...schema.properties.repo, enum: repos }
    : { ...schema.properties.repo, description: `${NO_REPOS}: leave it out` }
  return {
    ...base,
    description: repos.length
      ? `Start a new agent on a task, optionally inside one repo of the workspace (${repos.join(', ')}).`
      : `Start a new agent on a task. ${NO_REPOS}, so the agent works in the session's folder.`,
    inputSchema: { ...base.inputSchema, properties: { ...schema.properties, repo } },
  }
}

export const toolName = (name: ToolName) => `mcp__office__${name}`
