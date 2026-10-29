import type { Reader, Repo, Workspace } from './discover'

// The workspace briefing: absolute paths only, and only what exists on disk.

const MAX_SUMMARY = 160
const MAX_SKILL = 120

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/

const withoutFrontmatter = (text: string) => text.replace(FRONTMATTER, '')

// The first sentence of the first paragraph after the H1, or after the
// frontmatter when there is no H1; headings are skipped.
export function summaryOf(markdown: string) {
  const lines = withoutFrontmatter(markdown).split(/\r?\n/)
  const h1 = lines.findIndex(line => /^#\s/.test(line))
  const paragraph: string[] = []
  for (const line of lines.slice(h1 + 1)) {
    const text = line.trim()
    if (/^#{1,6}(\s|$)/.test(text)) {
      if (paragraph.length) break
      continue
    }
    if (!text) {
      if (paragraph.length) break
      continue
    }
    paragraph.push(text)
  }
  const joined = paragraph.join(' ')
  const sentence = /^(.+?[.!?])(\s|$)/.exec(joined)?.[1] ?? joined
  return sentence ? clip(sentence, MAX_SUMMARY) : ''
}

// A skill's one-line `description` from its frontmatter; undefined when it is
// missing or spans several lines.
export function skillDescription(skill: string) {
  const block = FRONTMATTER.exec(skill)?.[0]
  if (!block) return undefined
  const lines = block.split(/\r?\n/)
  const at = lines.findIndex(line => /^description:/.test(line))
  if (at < 0) return undefined
  const value = lines[at]?.slice('description:'.length).trim() ?? ''
  const continues = /^\s+\S/.test(lines[at + 1] ?? '')
  if (!value || /^[|>]/.test(value) || continues) return undefined
  const unquoted = /^(["'])(.*)\1$/.exec(value)?.[2] ?? value
  return clip(unquoted, MAX_SKILL)
}

const firstExisting = async (reader: Reader, paths: string[]) => {
  for (const path of paths) if (await reader.exists(path)) return path
  return undefined
}

async function repoEntry(reader: Reader, repo: Repo) {
  const docs = `${repo.path}/${repo.docsDir}`
  const index = await firstExisting(reader, [`${docs}/index.md`, `${docs}/README.md`])
  const summary = index ? summaryOf(await reader.read(index).catch(() => '')) : ''
  const lines = [`- ${repo.name} (${repo.path})${summary ? `: ${summary}` : ''}`]

  const rules: string[] = []
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    if (await reader.exists(`${repo.path}/${name}`)) rules.push(`${repo.path}/${name}`)
  }
  const refs = [rules.length && `Rules: ${rules.join(', ')}.`, index && `Docs: ${index}.`].filter(Boolean)
  if (refs.length) lines.push(`  ${refs.join(' ')}`)

  const skillsDir = `${repo.path}/.claude/skills`
  const skills: string[] = []
  for (const name of (await reader.listDirs(skillsDir).catch(() => [])).sort()) {
    const path = `${skillsDir}/${name}/SKILL.md`
    if (!(await reader.exists(path))) continue
    const description = skillDescription(await reader.read(path).catch(() => ''))
    skills.push(description ? `${path} (${description})` : path)
  }
  if (skills.length) lines.push(`  Skills (read the file before working there): ${skills.join('; ')}`)
  return lines.join('\n')
}

export async function workspaceBriefing(workspace: Workspace, reader: Reader) {
  if (!workspace.repos.length) return ''
  const lines = ['# Workspace', `Root: ${workspace.root}`]
  for (const repo of workspace.repos) lines.push(await repoEntry(reader, repo))

  const home = workspace.repos.find(repo => repo.name === workspace.home)
  const folder = home && `${home.path}/${home.docsDir}/workspace`
  // Without its index, the folder still holds the pages that span repos.
  const index = folder && `${folder}/index.md`
  const spanning =
    index && ((await reader.exists(index)) ? index : (await reader.dirOf(folder)) ? `${folder}/` : undefined)
  if (spanning) lines.push(`Pages that span repos: ${spanning}`)
  lines.push("A repo's own CLAUDE.md or AGENTS.md wins over any skill.")
  return lines.join('\n')
}
