// Shared pieces for the gate tests: skill and page texts, staging writes and check runs.
import { join } from 'node:path'
import { proposalFile, stagingFile } from '../scripts/lib/paths.mjs'

export const frontmatter = (name, description, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n`

export const OVERLAY_BODY = [
  '',
  "The repository's CLAUDE.md rules first; this skill only adds what it leaves out.",
  '',
  '## Verify like CI',
  '',
  'Run `npm test` after `npm ci`, as the pull-request workflow does.',
  '',
  '## Hand-off',
  '',
  'Say which checks ran and which did not.',
  '',
].join('\n')

export const overlayText = (extraBody = '', extraFm = '') =>
  frontmatter('working-in-service', 'Working in the service repository. Use before editing, testing or committing in service.', extraFm) +
  OVERLAY_BODY +
  extraBody

export function skillText(name, sections, { description, body = 'Keep it short.' } = {}) {
  const parts = sections.map(s => `${s}\n\n${body}\n`)
  return frontmatter(name, description ?? `The ${name} rules of the service repository. Use when that area changes.`) + '\n' + parts.join('\n')
}

// A page that passes every gate of its type, with optional extra sections.
export function pageText(title, sections = [], intro = 'This page explains how the service reads its settings.') {
  const parts = sections.map(([h, b]) => `${h}\n\n${b}\n`)
  return `# ${title}\n\n${intro}\n\n${parts.join('\n')}`
}

export function stage(sb, ctx, path, text, repo = 'service') {
  return sb.write(stagingFile(ctx.root, repo, path), text)
}

export function propose(sb, ctx, id, text, repo = 'service') {
  return sb.write(proposalFile(ctx.root, repo, id), text)
}

export function check(sb, ctx, round = 1, env = {}) {
  return sb.hub(['check', ctx.planFile, '--round', String(round), '--json'], { cwd: ctx.root, env })
}

export const errorsOf = r => {
  try {
    return r.json().errors ?? []
  } catch {
    return []
  }
}

export const messages = r => errorsOf(r).map(e => `${e.path ?? ''}: ${e.message}`)

export function writeSkill(sb, base, folder, text) {
  return sb.write(join(base, folder, 'SKILL.md'), text)
}
