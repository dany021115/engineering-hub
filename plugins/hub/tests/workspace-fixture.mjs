// A two-repo workspace with committed locks: the docs home `service` and its member `web`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { frontmatter, overlayText, pageText } from './gate-fixture.mjs'
import { makeWorkspace } from './helper.mjs'
import { blob, configText } from './run-fixture.mjs'

export const CONFIG = 'docs/reference/configuration.md'
export const INTERFACES = 'docs/workspace/interfaces.md'
export const SERVICE_SKILL = '.claude/skills/working-in-service/SKILL.md'
export const WEB_SKILL = '.claude/skills/working-in-web/SKILL.md'

export const interfacesText = pageText(
  'Interfaces',
  [['## Web and service', 'The client in `web/src/client.ts` calls the service started in `service/src/app.ts`.']],
  'This page lists the contracts between the repositories.',
)

export const webSkillText = (extra = '') =>
  frontmatter('working-in-web', 'Working in the web repository. Use before editing, testing or committing in web.') +
  [
    '',
    "The repository's CLAUDE.md rules first; this skill only adds what it leaves out.",
    '',
    '## Verify like CI',
    '',
    'Run `npm test`, as the pull-request workflow does.',
    '',
    '## Changes that cross repos',
    '',
    'The client calls the service started in `service/src/app.ts`: land the service side first.',
    extra,
    '## Hand-off',
    '',
    'Say which checks ran and which did not.',
    '',
  ].join('\n')

const version = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version

const lockText = lock => JSON.stringify(lock, null, 2) + '\n'

// `texts` replaces a generated file's text; `language` sets both locks' language.
export function lockedWorkspace(sb, { at = sb.path('ws'), texts = {}, language = 'en' } = {}) {
  const generated = {
    service: { [CONFIG]: configText, [INTERFACES]: interfacesText, [SERVICE_SKILL]: overlayText() },
    web: { [WEB_SKILL]: webSkillText() },
  }
  for (const repo of Object.keys(generated)) Object.assign(generated[repo], texts[repo] ?? {})
  const w = makeWorkspace(sb, { at, repos: ['service', 'web'], extra: generated })
  const id = (repo, path) => sb.git(w[repo], 'rev-parse', `HEAD:${path}`).trim()
  const head = repo => sb.git(w[repo], 'rev-parse', 'HEAD').trim()
  const entry = (repo, path, rest, sources) => ({ ...rest, hash: blob(generated[repo][path]), sources })
  const settings = { language, docsDir: 'docs', scanAllow: [] }
  const locks = {
    service: {
      schema: 1,
      generator: `hub@${version}`,
      documentedCommit: head('service'),
      settings,
      workspace: { repos: ['service', 'web'] },
      files: {
        [CONFIG]: entry('service', CONFIG, { kind: 'page', type: 'reference' }, { 'src/config.ts': id('service', 'src/config.ts') }),
        [INTERFACES]: entry(
          'service',
          INTERFACES,
          { kind: 'page', type: 'reference' },
          { 'src/app.ts': id('service', 'src/app.ts'), 'web:src/client.ts': id('web', 'src/client.ts') },
        ),
        [SERVICE_SKILL]: entry(
          'service',
          SERVICE_SKILL,
          { kind: 'skill', archetype: 'working-in' },
          { '.github/workflows/ci.yml': id('service', '.github/workflows/ci.yml') },
        ),
      },
    },
    web: {
      schema: 1,
      generator: `hub@${version}`,
      documentedCommit: head('web'),
      settings: { ...settings, docsHome: 'service' },
      files: {
        [WEB_SKILL]: entry(
          'web',
          WEB_SKILL,
          { kind: 'skill', archetype: 'working-in' },
          { 'service:src/app.ts': id('service', 'src/app.ts'), 'package.json': id('web', 'package.json') },
        ),
      },
    },
  }
  for (const repo of ['service', 'web']) {
    sb.write(join(w[repo], '.claude', 'hub.lock.json'), lockText(locks[repo]))
    sb.commit(w[repo], 'lock')
  }
  return { ...w, locks, generated }
}

// A clone of one repo in a folder of its own, as GitHub Actions checks it out.
export function cloneAlone(sb, from, name) {
  const to = sb.path(`alone-${name}-${Math.random().toString(36).slice(2, 8)}`, name)
  sb.git(sb.base, 'clone', '-q', from, to)
  return to
}
