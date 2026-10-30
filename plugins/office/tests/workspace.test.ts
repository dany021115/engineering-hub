import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { Register } from 'claude-code'

import { discover } from '../hooks/workspace/discover'
import type { DiscoverInput } from '../hooks/workspace/discover'
import { basename, isInside, parentOf, relativeTo } from '../hooks/workspace/paths'
import { gitRunner } from '../hooks/workspace/worktree'
import { fakeTree, lockOf, repoFiles, serveTree } from './tree'
import type { Files } from './tree'

test('a path is inside a root only at a separator, never by a shared prefix', () => {
  expect(isInside('/x/work-old/a', '/x/work')).toBe(false)
  expect(isInside('/x/work', '/x/work')).toBe(true)
  expect(isInside('/x/work/a', '/x/work')).toBe(true)
  expect(isInside('/x/work', '')).toBe(false)
})

test('the path helpers name a parent, a base name and a relative path', () => {
  expect(parentOf('/w/service')).toBe('/w')
  expect(parentOf('/w')).toBe('/')
  expect(basename('/w/service')).toBe('service')
  expect(basename('/w/service/')).toBe('service')
  expect(relativeTo('/w', '/w-old/service')).toBe('/w-old/service')
  expect(relativeTo('', '/w/service')).toBe('/w/service')
})

const W = repoFiles('/w/service', '/w/web', '/w/infra')
const LOCK = '.claude/hub.lock.json'
const HOME_LOCK = { [`/w/service/${LOCK}`]: lockOf({ workspace: { repos: ['service', 'web', 'infra'] } }) }

const NO_OPTIONS = { workspaceRoot: '', neverIsolate: '' }
const inGit = (repoRoot: string, options = NO_OPTIONS): DiscoverInput => ({ options, repoRoot, sessionRoot: repoRoot })
const outsideGit = (sessionRoot: string, options = NO_OPTIONS): DiscoverInput => ({ options, repoRoot: null, sessionRoot })

const run = (files: Files, input: DiscoverInput) => discover(input, fakeTree(files).reader)
const names = (found: { repos: { name: string }[] }) => found.repos.map(repo => repo.name)

test('discover: the configured folder is the root and its repos skip dot folders', async () => {
  const found = await run(
    { ...W, ...repoFiles('/w/.cache') },
    { options: { workspaceRoot: '/w', neverIsolate: '' }, repoRoot: null, sessionRoot: '/elsewhere' },
  )
  expect(found.root).toBe('/w')
  expect(names(found)).toEqual(['infra', 'service', 'web'])
  expect(found.warnings).toEqual([])
})

test('discover: a session outside git takes its folder as the root, or finds no repo', async () => {
  const found = await run(W, outsideGit('/w', { workspaceRoot: '/w/missing', neverIsolate: '' }))
  expect(found.root).toBe('/w')
  expect(names(found)).toEqual(['infra', 'service', 'web'])

  const empty = await run({ '/w/notes.txt': 'x', '/w/plain/a.txt': 'y' }, outsideGit('/w'))
  expect(empty.root).toBe('/w')
  expect(empty.repos).toEqual([])
})

test('discover: more than 30 repos keeps the first 30 and counts the rest', async () => {
  const many = Array.from({ length: 32 }, (_, i) => `/w/r${String(i + 1).padStart(2, '0')}`)
  const found = await run(repoFiles(...many), outsideGit('/w'))
  expect(names(found)).toEqual(many.slice(0, 30).map(path => basename(path)))
  expect(found.skipped).toBe(2)
  expect(found.warnings.join(' ')).toContain('skipped 2')
})

test('discover: the docs home and a member pointing at it give the same workspace', async () => {
  const files = {
    ...W,
    [`/w/service/${LOCK}`]: lockOf({ workspace: { repos: ['service', 'web', 'infra', 'gone'] } }),
    [`/w/web/${LOCK}`]: lockOf({ settings: { docsHome: 'service' } }),
  }
  for (const session of ['/w/service', '/w/web']) {
    const found = await run(files, inGit(session))
    expect(found.root).toBe('/w')
    expect(names(found)).toEqual(['infra', 'service', 'web'])
    expect(found.home).toBe('service')
  }
})

test('discover: a lone repo among siblings is its own root', async () => {
  const found = await run(W, inGit('/w/service'))
  expect(found.root).toBe('/w/service')
  expect(found.repos).toEqual([{ name: 'service', path: '/w/service', docsDir: 'docs', neverIsolate: false }])
})

test('discover: a missing, broken or plain docs home leaves the member alone', async () => {
  const member = { [`/w/web/${LOCK}`]: lockOf({ settings: { docsHome: 'service' } }) }
  const cases: [Files, number][] = [
    [{ ...W, [`/w/web/${LOCK}`]: lockOf({ settings: { docsHome: 'gone' } }) }, 0],
    [{ ...W, ...member, [`/w/service/${LOCK}`]: '{' }, 1],
    [{ ...W, ...member, [`/w/service/${LOCK}`]: lockOf({ settings: {} }) }, 0],
  ]
  for (const [files, warnings] of cases) {
    const found = await run(files, inGit('/w/web'))
    expect(found.root).toBe('/w/web')
    expect(names(found)).toEqual(['web'])
    expect(found.warnings).toHaveLength(warnings)
  }
})

test('discover: never isolated comes from the options alone', async () => {
  const files = { ...W, ...HOME_LOCK, [`/w/web/${LOCK}`]: lockOf({ settings: { neverIsolate: true } }) }
  const found = await run(files, outsideGit('/w', { workspaceRoot: '', neverIsolate: ['infra'] } as never))
  expect(found.repos.filter(repo => repo.neverIsolate).map(repo => repo.name)).toEqual(['infra'])
})

test('discover: the docs folder comes from each lock, docs by default', async () => {
  const files = { ...W, [`/w/web/${LOCK}`]: lockOf({ settings: { docsDir: 'documentation' } }) }
  const found = await run(files, outsideGit('/w'))
  expect(found.repos.find(repo => repo.name === 'web')?.docsDir).toBe('documentation')
  expect(found.repos.find(repo => repo.name === 'service')?.docsDir).toBe('docs')
})

test('discover: invalid entries in the listed repos are dropped one by one', async () => {
  const files = { ...W, [`/w/service/${LOCK}`]: lockOf({ workspace: { repos: ['service', 7, 'web', '..', 'a/b'] } }) }
  const found = await run(files, inGit('/w/service'))
  expect(found.root).toBe('/w')
  expect(names(found)).toEqual(['service', 'web'])
})

test('discover: a malformed workspace counts as none', async () => {
  for (const workspace of [{ repos: 'web' }, ['web']]) {
    const found = await run({ ...W, [`/w/service/${LOCK}`]: lockOf({ workspace }) }, inGit('/w/service'))
    expect(found.root).toBe('/w/service')
    expect(names(found)).toEqual(['service'])
  }
})

test('discover: an invalid docs folder falls back to docs', async () => {
  for (const docsDir of ['../x', '/x']) {
    const found = await run({ ...W, [`/w/infra/${LOCK}`]: lockOf({ settings: { docsDir } }) }, outsideGit('/w'))
    expect(found.repos.find(repo => repo.name === 'infra')?.docsDir).toBe('docs')
  }
})

test('discover: a broken lock gives a warning and discovery goes on', async () => {
  const found = await run({ ...W, [`/w/service/${LOCK}`]: '{' }, inGit('/w/service'))
  expect(found.root).toBe('/w/service')
  expect(names(found)).toEqual(['service'])
  expect(found.warnings).toHaveLength(1)
  expect(found.warnings[0]).toContain(`/w/service/${LOCK}`)
})

test('discover: an invalid docs home is ignored without reading any lock through it', async () => {
  for (const docsHome of ['./service', '..']) {
    const tree = fakeTree({ ...W, ...HOME_LOCK, [`/w/web/${LOCK}`]: lockOf({ settings: { docsHome } }) })
    const found = await discover(inGit('/w/web'), tree.reader)
    expect(found.root).toBe('/w/web')
    expect(names(found)).toEqual(['web'])
    expect(tree.reads).toEqual([`/w/web/${LOCK}`])
  }
})

// The kit side: the plugin itself, its fs, session and git calls answered from a fake tree.

const TASK = 'investigate the flaky login test and propose a fix'
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const

type Kit = ReturnType<typeof serveTree> & { tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] }

function office(on: Parameters<typeof serveTree>[0], files: Files, session: { cwd: string; repo?: string }): Kit {
  mock.clock(on)
  const served = serveTree(on, files, session)
  const tools: Kit['tools'] = []
  on('tool.register', (_$, e) => {
    tools.push(e as Kit['tools'][number])
    return { value: { tool: `mcp__office__${e.name}` } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
  return { ...served, tools }
}

// The kit raises no session.start of its own: the tests start the session.
const start = ($: Engine, cwd = '/w') => $.session.start({ cwd, surface: null, isInteractive: false })

const hire = ($: Engine, input: Record<string, string> = {}) =>
  $.tool.call({ tool: 'mcp__office__hire', task: TASK, worktree: 'no', ...input })

const composed = async ($: Engine) =>
  (await $.prompt.compose(COMPOSE)).sections.find(section => section.id === 'office:context')?.text ?? ''

const hireTool = (kit: Kit) => kit.tools.find(tool => tool.name === 'hire')

test('root by userConfig: a hire is briefed on the configured folder', { options: { workspaceRoot: '/w' } }, async ($, on) => {
  const kit = office(on, { ...W }, { cwd: '/elsewhere' })
  await start($, '/elsewhere')
  await hire($, { repo: 'service' })
  expect(kit.spawns[0]?.prompt).toContain('Root: /w\n')
  for (const repo of ['infra', 'service', 'web']) expect(kit.spawns[0]?.prompt).toContain(`- ${repo} (/w/${repo})`)
})

test('dot folders: a dot folder with .git is not a repo', { options: { workspaceRoot: '/w' } }, async ($, on) => {
  const kit = office(on, { ...W, ...repoFiles('/w/.cache') }, { cwd: '/w' })
  await start($, '/w')
  expect((await hire($, { repo: '.cache' })).result).toBe('Unknown repo ".cache".')
  expect(hireTool(kit)?.description).toContain('(infra, service, web)')
  expect(kit.spawns).toHaveLength(0)
})

test('more than 30 repos: a toast says how many were skipped', async ($, on) => {
  const many = Array.from({ length: 32 }, (_, i) => `/w/r${String(i + 1).padStart(2, '0')}`)
  const kit = office(on, repoFiles(...many), { cwd: '/w' })
  await start($, '/w')
  await $.tool.call({ tool: 'mcp__office__roster' })
  expect(kit.toasts.some(text => text.includes('skipped 2'))).toBe(true)
})

test('folder outside git: its repos are the workspace, and with none there is no briefing', async ($, on) => {
  const kit = office(on, { ...W }, { cwd: '/w' })
  await start($, '/w')
  await hire($, { repo: 'web' })
  expect(kit.spawns[0]?.prompt).toContain('Root: /w\n')
  expect(await composed($)).toContain('# Workspace')
})

test('folder outside git without repos: neither the prompt nor a spawn is briefed', async ($, on) => {
  const kit = office(on, { '/w/notes/a.md': 'x' }, { cwd: '/w' })
  await start($, '/w')
  await hire($)
  expect(await composed($)).not.toContain('# Workspace')
  expect(kit.spawns[0]?.prompt).not.toContain('# Workspace')
})

test('docs home: a session in the home briefs every listed repo', async ($, on) => {
  const kit = office(on, { ...W, ...HOME_LOCK }, { cwd: '/w/service', repo: '/w/service' })
  await start($, '/w/service')
  const text = await composed($)
  expect(text).toContain('Root: /w\n')
  for (const repo of ['infra', 'service', 'web']) expect(text).toContain(`- ${repo} (/w/${repo})`)
  expect(hireTool(kit)?.description).toContain('(infra, service, web)')
})

test('member pointing at the home: a session in the member briefs the whole workspace', async ($, on) => {
  const files = { ...W, ...HOME_LOCK, [`/w/web/${LOCK}`]: lockOf({ settings: { docsHome: 'service' } }) }
  office(on, files, { cwd: '/w/web', repo: '/w/web' })
  await start($, '/w/web')
  const text = await composed($)
  expect(text).toContain('Root: /w\n')
  expect(text).toContain('- infra (/w/infra)')
})

test('lone repo among siblings: the workspace is that one repo', async ($, on) => {
  const kit = office(on, { ...W }, { cwd: '/w/service', repo: '/w/service' })
  await start($, '/w/service')
  const text = await composed($)
  expect(text).toContain('Root: /w/service\n')
  expect(text).toContain('- service (/w/service)')
  expect(text).not.toContain('/w/web')
  expect(hireTool(kit)?.description).toContain('(service)')
})

const MEMBER = { [`/w/web/${LOCK}`]: lockOf({ settings: { docsHome: 'service' } }) }
const MISSING_HOMES: [string, Files, number][] = [
  ['missing', { [`/w/web/${LOCK}`]: lockOf({ settings: { docsHome: 'gone' } }) }, 0],
  ['broken', { ...MEMBER, [`/w/service/${LOCK}`]: '{' }, 1],
  ['without a workspace', { ...MEMBER, [`/w/service/${LOCK}`]: lockOf({ settings: {} }) }, 0],
]
for (const [kind, locks, toasts] of MISSING_HOMES) {
  test(`missing home: a ${kind} home leaves the member as one repo`, async ($, on) => {
    const kit = office(on, { ...W, ...locks }, { cwd: '/w/web', repo: '/w/web' })
    await start($, '/w/web')
    expect(await composed($)).toContain('Root: /w/web\n')
    expect(hireTool(kit)?.description).toContain('(web)')
    expect(kit.toasts.filter(text => text.includes(LOCK))).toHaveLength(toasts)
  })
}

const worktreeAdds = (kit: Kit) => kit.ran.filter(run => run.argv.includes('worktree') && run.argv.includes('add'))

test('infra never isolated: only options.neverIsolate keeps a repo out of worktrees', { options: { neverIsolate: ['infra'] } }, async ($, on) => {
  const files = { ...W, [`/w/web/${LOCK}`]: lockOf({ settings: { neverIsolate: true } }) }
  const kit = office(on, files, { cwd: '/w' })
  await start($)
  await hire($, { repo: 'infra', worktree: 'yes' })
  expect(worktreeAdds(kit)).toHaveLength(0)
  expect(kit.spawns[0]?.cwd).toBe('/w/infra')
  await hire($, { repo: 'web', worktree: 'yes' })
  expect(worktreeAdds(kit)).toHaveLength(1)
  expect(kit.spawns[1]?.cwd).toMatch(/^\/w\/\.office-worktrees\/web-/)
})

test('worktrees in the parent with .gitignore: the first one ignores its folder', async ($, on) => {
  const kit = office(on, { ...W }, { cwd: '/w' })
  await start($)
  await hire($, { repo: 'service', worktree: 'yes' })
  const added = worktreeAdds(kit)[0]?.argv ?? []
  expect(added[added.length - 2]).toMatch(/^\/w\/\.office-worktrees\/service-/)
  expect(kit.files['/w/.office-worktrees/.gitignore']).toBe('*\n')
})

test('array, malformed object and invalid entries are dropped one by one', async ($, on) => {
  const kit = office(
    on,
    { ...W, [`/w/service/${LOCK}`]: lockOf({ workspace: { repos: ['service', 7, 'web', '..', 'a/b'] } }) },
    { cwd: '/w/service', repo: '/w/service' },
  )
  await start($, '/w/service')
  const text = await composed($)
  expect(text).toContain('Root: /w\n')
  expect(text).toContain('- service (/w/service)')
  expect(text).toContain('- web (/w/web)')
  expect(text).not.toContain('/w/infra')
  expect(hireTool(kit)?.description).toContain('(service, web)')
})

for (const workspace of [{ repos: 'web' }, ['web']]) {
  test(`a malformed workspace ${JSON.stringify(workspace)} counts as none and the session goes on`, async ($, on) => {
    office(on, { ...W, [`/w/service/${LOCK}`]: lockOf({ workspace }) }, { cwd: '/w/service', repo: '/w/service' })
    await start($, '/w/service')
    expect(await composed($)).toContain('Root: /w/service\n')
  })
}

test('broken lock (toast): a broken lock is toasted at start and the session goes on', async ($, on) => {
  const kit = office(on, { ...W, [`/w/service/${LOCK}`]: '{' }, { cwd: '/w/service', repo: '/w/service' })
  await start($, '/w/service')
  expect(kit.toasts.filter(text => text.includes(`/w/service/${LOCK}`))).toHaveLength(1)
  expect(await composed($)).toContain('Root: /w/service\n')
})

for (const docsHome of ['./service', '..']) {
  test(`an invalid docs home ${docsHome} is ignored and no lock is read through it`, async ($, on) => {
    const kit = office(on, { ...W, ...HOME_LOCK, [`/w/web/${LOCK}`]: lockOf({ settings: { docsHome } }) }, {
      cwd: '/w/web',
      repo: '/w/web',
    })
    await start($, '/w/web')
    expect(await composed($)).toContain('Root: /w/web\n')
    expect(kit.reads.filter(path => path.endsWith(LOCK))).toEqual([`/w/web/${LOCK}`])
  })
}

// The briefing (design §10.2): what the plugin composes, read from the fake tree.

const briefed = async ($: Engine, on: Parameters<typeof serveTree>[0], files: Files, cwd = '/w', repo?: string) => {
  const kit = office(on, files, { cwd, repo })
  await start($, cwd)
  return { kit, text: await composed($) }
}

test('only what exists: rules, docs and the spanning pages are listed when on disk', async ($, on) => {
  const { text } = await briefed(
    $,
    on,
    {
      ...W,
      ...HOME_LOCK,
      '/w/service/CLAUDE.md': 'x',
      '/w/service/AGENTS.md': 'x',
      '/w/service/docs/index.md': '# Service\n\nIt serves the public API.',
      '/w/service/docs/workspace/index.md': '# Workspace',
      '/w/web/AGENTS.md': 'x',
    },
    '/w/service',
    '/w/service',
  )
  expect(text).toContain('Root: /w\n')
  expect(text).toContain('- service (/w/service)')
  expect(text).toContain('Rules: /w/service/CLAUDE.md, /w/service/AGENTS.md.')
  expect(text).toContain('Docs: /w/service/docs/index.md')
  expect(text).toContain('Pages that span repos: /w/service/docs/workspace/index.md')
  expect(text).toContain('Rules: /w/web/AGENTS.md.')
  for (const absent of ['/w/web/CLAUDE.md', '/w/infra/CLAUDE.md', '/w/infra/AGENTS.md']) expect(text).not.toContain(absent)
  expect(text).toContain("A repo's own CLAUDE.md or AGENTS.md wins over any skill.")
})

test('home found by its lock: a session outside git still names the spanning pages', async ($, on) => {
  const { text } = await briefed($, on, { ...W, ...HOME_LOCK, '/w/service/docs/workspace/index.md': '# W' })
  expect(text).toContain('Pages that span repos: /w/service/docs/workspace/index.md')
})

test('home found by its lock: without a workspace index the briefing names its folder', async ($, on) => {
  const { text } = await briefed($, on, {
    ...W,
    ...HOME_LOCK,
    '/w/service/docs/workspace/interfaces.md': '# I',
  })
  expect(text).toContain('Pages that span repos: /w/service/docs/workspace/\n')
})

test('home found by its lock: without any workspace lock there is no spanning line', async ($, on) => {
  const { text } = await briefed($, on, { ...W, '/w/service/docs/workspace/index.md': '# W' })
  expect(text).not.toContain('Pages that span repos')
})

test('several homes: the first in alphabetical order wins, with a toast', async ($, on) => {
  const listed = lockOf({ workspace: { repos: ['service', 'web'] } })
  const { kit, text } = await briefed($, on, {
    ...W,
    [`/w/service/${LOCK}`]: listed,
    [`/w/web/${LOCK}`]: listed,
    '/w/service/docs/workspace/index.md': '# W',
    '/w/web/docs/workspace/index.md': '# W',
  })
  expect(text).toContain('Pages that span repos: /w/service/docs/workspace/index.md')
  expect(text).not.toContain('/w/web/docs/workspace/index.md')
  expect(kit.toasts.some(toast => toast.includes('service, web'))).toBe(true)
})

const summaryLine = (text: string, repo: string) => text.split('\n').find(line => line.startsWith(`- ${repo} (`)) ?? ''

test('frontmatter and headings are skipped: the summary is the first sentence', async ($, on) => {
  const index = '---\ntitle: Service\n---\n# Public API\n\n## Overview\n\nIt serves the public API. The web app calls it.\n'
  const { text } = await briefed($, on, { ...W, '/w/service/docs/index.md': index })
  expect(summaryLine(text, 'service')).toBe('- service (/w/service): It serves the public API.')
})

test('a long first sentence is cut at 159 characters and an ellipsis', async ($, on) => {
  const long = `${'a'.repeat(199)}.`
  const exact = `${'b'.repeat(159)}.`
  const { text } = await briefed($, on, {
    ...W,
    '/w/service/docs/index.md': `# S\n\n${long} Next.`,
    '/w/web/docs/index.md': `# W\n\n${exact} Next.`,
  })
  const service = summaryLine(text, 'service').replace('- service (/w/service): ', '')
  expect(service).toBe(`${long.slice(0, 159)}…`)
  expect(service).toHaveLength(160)
  expect(summaryLine(text, 'web')).toBe(`- web (/w/web): ${exact}`)
})

test('without an H1 the summary is the first paragraph after the frontmatter', async ($, on) => {
  const index = '---\ntitle: Web\n---\n\nIt calls the public API. It runs in the browser.\n'
  const { text } = await briefed($, on, { ...W, '/w/web/docs/index.md': index })
  expect(summaryLine(text, 'web')).toBe('- web (/w/web): It calls the public API.')
})

test('README.md is the index when there is no index.md', async ($, on) => {
  const { text } = await briefed($, on, {
    ...W,
    '/w/web/docs/README.md': '# Web\n\nIt calls the public API. It runs in the browser.',
  })
  expect(summaryLine(text, 'web')).toBe('- web (/w/web): It calls the public API.')
  expect(text).toContain('Docs: /w/web/docs/README.md.')
})

test('index.md wins over README.md for the summary and the docs line', async ($, on) => {
  const { text } = await briefed($, on, {
    ...W,
    '/w/web/docs/README.md': '# Web\n\nIt calls the public API.',
    '/w/web/docs/index.md': '# Web\n\nIt runs in the browser.',
  })
  expect(summaryLine(text, 'web')).toBe('- web (/w/web): It runs in the browser.')
  expect(text).toContain('Docs: /w/web/docs/index.md.')
  expect(text).not.toContain('/w/web/docs/README.md')
})

test('without an index the repo line is its path alone, with no docs line', async ($, on) => {
  const { text } = await briefed($, on, { ...W })
  expect(summaryLine(text, 'web')).toBe('- web (/w/web)')
  expect(text).not.toContain('Docs: /w/web')
})

test('docs folder: each lock names its own, docs by default', async ($, on) => {
  const { text } = await briefed($, on, {
    ...W,
    [`/w/web/${LOCK}`]: lockOf({ settings: { docsDir: 'documentation' } }),
    '/w/web/documentation/index.md': '# Web\n\nIt calls the public API.',
    '/w/service/docs/index.md': '# Service\n\nIt serves the public API.',
  })
  expect(text).toContain('Docs: /w/web/documentation/index.md.')
  expect(text).toContain('Docs: /w/service/docs/index.md.')
})

for (const docsDir of ['../x', '/x']) {
  test(`an invalid docs folder ${docsDir} falls back to docs in the briefing`, async ($, on) => {
    const { text } = await briefed($, on, {
      ...W,
      [`/w/infra/${LOCK}`]: lockOf({ settings: { docsDir } }),
      '/w/infra/docs/index.md': '# Infra\n\nIt holds the deploy scripts.',
    })
    expect(text).toContain('Docs: /w/infra/docs/index.md.')
  })
}

test('briefing only with existing SKILL.md files and no ../', async ($, on) => {
  const long = 'Use when working in the web app: '.padEnd(150, 'x')
  const { kit, text } = await briefed($, on, {
    ...W,
    '/w/web/.claude/skills/working-in-web/SKILL.md': `---\nname: working-in-web\ndescription: ${long}\n---\n# Body`,
    '/w/web/.claude/skills/web-forms/SKILL.md': '---\nname: web-forms\ndescription: |\n  Use for forms.\n  Two lines.\n---\n',
    '/w/web/.claude/skills/notes/readme.md': 'not a skill',
  })
  const skills = text.split('\n').find(line => line.includes('Skills (read the file before working there):')) ?? ''
  const described = /\/w\/web\/\.claude\/skills\/working-in-web\/SKILL\.md \(([^)]*)\)/.exec(skills)?.[1] ?? ''
  expect(described.length).toBeLessThanOrEqual(120)
  expect(long.startsWith(described.replace(/…$/, ''))).toBe(true)
  expect(skills).toContain('/w/web/.claude/skills/web-forms/SKILL.md')
  expect(skills).not.toContain('web-forms/SKILL.md (')
  expect(skills).not.toContain('notes')
  expect(text).not.toContain('../')
  await hire($, { repo: 'web', worktree: 'yes' })
  expect(kit.spawns[0]?.prompt).not.toContain('../')
})

// Who receives the briefing (OFI-10).

// A spawn the office did not start, as the engine raises it.
const foreign = (cwd: string, extra: Record<string, unknown> = {}) => ({
  tool_use_id: 't1',
  prompt: 'carry on',
  description: 'carry on',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'm',
  background: true,
  fork: false,
  cwd,
  ...extra,
}) as never

test('inside and outside the root: the prompt and a spawn inside get the briefing, one outside does not', async ($, on) => {
  const kit = office(on, { ...W }, { cwd: '/w' })
  await start($)
  expect(await composed($)).toContain('Root: /w\n')
  await $.agent.spawn(foreign('/w/web'))
  await $.agent.spawn(foreign('/elsewhere'))
  expect(kit.spawns[0]?.prompt).toContain('Root: /w\n')
  expect(kit.spawns[1]?.prompt).not.toContain('# Workspace')
})

test('session outside the root: the prompt has no briefing and a hire does', { options: { workspaceRoot: '/w' } }, async ($, on) => {
  const kit = office(on, { ...W }, { cwd: '/elsewhere' })
  await start($, '/elsewhere')
  expect(await composed($)).not.toContain('# Workspace')
  await hire($, { repo: 'service' })
  expect(kit.spawns[0]?.prompt).toContain('Root: /w\n')
})

test('hire outside the root: a lone repo hire in a worktree beside it is still briefed', async ($, on) => {
  const kit = office(on, { ...W }, { cwd: '/w/service', repo: '/w/service' })
  await start($, '/w/service')
  await hire($, { repo: 'service', worktree: 'yes' })
  expect(kit.spawns[0]?.cwd).toMatch(/^\/w\/\.office-worktrees\/service-/)
  expect(kit.spawns[0]?.prompt).toContain('Root: /w/service\n')
})

test('resume, fork and workflow: their prompt passes untouched', async ($, on) => {
  const kit = office(on, { ...W }, { cwd: '/w' })
  await start($)
  const spawns = [
    { resume: { agentId: 'a1' } },
    { fork: true },
    { workflow: { runId: 'wf_1', agentIndex: 1 } },
  ]
  for (const extra of spawns) await $.agent.spawn(foreign('/w/web', extra))
  expect(kit.spawns.map(spawn => spawn.prompt)).toEqual(['carry on', 'carry on', 'carry on'])
})

// hire takes only discovered repos (OFI-11).

const repoSchema = (kit: Kit) =>
  (hireTool(kit)?.inputSchema as { properties: Record<string, { enum?: string[] }> } | undefined)?.properties.repo

test('enum: hire lists exactly the discovered repos', async ($, on) => {
  const kit = office(on, { ...W }, { cwd: '/w' })
  await start($)
  expect(repoSchema(kit)?.enum).toEqual(['infra', 'service', 'web'])
})

test('rejection: an unknown repo is refused before any spawn', async ($, on) => {
  const kit = office(on, { ...W }, { cwd: '/w' })
  await start($)
  expect((await hire($, { repo: 'toString' })).result).toBe('Unknown repo "toString".')
  expect(kit.spawns).toHaveLength(0)
})

test('no repos: hire has no enum, says so, and refuses a repo', async ($, on) => {
  const kit = office(on, { '/w/notes/a.md': 'x' }, { cwd: '/w' })
  await start($)
  expect(repoSchema(kit)).toBeDefined()
  expect(repoSchema(kit)?.enum).toBeUndefined()
  expect(hireTool(kit)?.description).toContain('No repos were found')
  expect(String((await hire($, { repo: 'service' })).result)).toContain('No repos were found')
  expect(kit.spawns).toHaveLength(0)
})

// Apply (OFI-12, OFI-15): the worktree's diff reaches git apply as git wrote it.

const PANE = {
  title: 'Office',
  isFocused: false,
  bodyColumns: 120,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

async function pressApply($: Engine, on: Parameters<typeof serveTree>[0], diff: string, checkExit = 0) {
  const kit = office(on, { ...W }, { cwd: '/w' })
  on('session.messages', () => ({ value: [] }))
  await start($)
  kit.git.diff = diff
  kit.git.checkExit = checkExit
  expect((await hire($, { repo: 'service', worktree: 'yes' })).result).toContain('in its own worktree')
  await $.tool.call({ tool: 'mcp__office__roster' })
  const ui = await $.ui.mount({ plugin: 'office', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'office' })
  await ui.press({ key: 'log-agent1' })
  await ui.press({ key: 'tab-changes' })
  await ui.press({ key: 'apply' })
  const runs = kit.ran.filter(run => run.argv.includes('apply') || run.argv.includes('remove'))
  return { kit, runs, applies: runs.filter(run => run.argv.includes('apply')) }
}

const BLANK_CONTEXT = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n-one\n+two\n \n \n'
const BINARY =
  'diff --git a/logo.png b/logo.png\nnew file mode 100644\nindex 0000000..1111111\nGIT binary patch\nliteral 4\nLcmZ?wbaVgy0RR91\n\nliteral 0\nHcmV?d00001\n\n'

for (const [kind, diff] of [['ending in blank context', BLANK_CONTEXT], ['binary', BINARY]] as const) {
  test(`blank context and binary: a ${kind} patch reaches git apply byte for byte`, async ($, on) => {
    const { applies } = await pressApply($, on, diff)
    expect(applies).toHaveLength(2)
    for (const run of applies) expect(run.stdin).toBe(diff)
  })
}

test('argv: apply checks first, then applies, with no three-way merge and nothing staged', async ($, on) => {
  const { runs, applies } = await pressApply($, on, BLANK_CONTEXT)
  expect(applies.map(run => run.argv)).toEqual([
    ['git', '-C', '/w/service', 'apply', '--check', '-'],
    ['git', '-C', '/w/service', 'apply', '-'],
  ])
  expect(runs.at(-1)?.argv.slice(3, 5)).toEqual(['worktree', 'remove'])
})

test('failed check: nothing is applied and the worktree is kept', async ($, on) => {
  const { kit, runs } = await pressApply($, on, BLANK_CONTEXT, 1)
  expect(runs.map(run => run.argv.slice(3))).toEqual([['apply', '--check', '-']])
  expect(kit.toasts).toContain('Apply failed, worktree kept: error: patch failed')
})

test('the git runner keeps stdout as git wrote it', async () => {
  const run = gitRunner(async () => ({ exitCode: 0, stdout: ' x\n\n', stderr: ' warn \n' }))
  expect(await run(['git', 'diff'])).toEqual({ ok: true, stdout: ' x\n\n', stderr: 'warn' })
})

// A delegated question closes only on a helper's answer (OFI-13).

const UNANSWERED = [
  ['aborted', { reason: 'aborted', answer: 'half', isAborted: true }],
  ['empty', { reason: 'answer', answer: '', isAborted: false }],
] as const
for (const [kind, end] of UNANSWERED) {
  test(`aborted or empty turn: a ${kind} helper turn leaves q1 open and delivers nothing`, async ($, on) => {
    const kit = office(on, { ...W }, { cwd: '/w' })
    const session = mock.session(on)
    on('session.messages', () => ({ value: [] }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
    await start($)
    await hire($, { repo: 'service' })
    await $.tool.call({ tool: 'mcp__office__roster' })
    expect((await $.tool.call({ tool: 'mcp__office__ask', to: 'service-1', question: 'What does this repo do?' })).result).toContain('Question q1 sent')
    expect((await $.tool.call({ tool: 'mcp__office__delegate', questionId: 'q1' })).result).toContain('A helper is answering q1')

    await $.turn.complete({ agentId: 'agent2', durationMs: 1, turnId: 't1', ...end })

    expect(JSON.stringify(session.appended())).not.toContain('Answer to q1')
    expect(kit.toasts.some(toast => toast.includes('q1'))).toBe(true)
    const ui = await $.ui.mount({ plugin: 'office', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'office' })
    expect(await ui.find({ text: /\?1/ })).toBeDefined()
    // Open again, and with no helper: it can be delegated anew.
    expect((await $.tool.call({ tool: 'mcp__office__delegate', questionId: 'q1' })).result).toContain('A helper is answering q1')
  })
}

test('a helper turn with an answer closes q1 and delivers it', async ($, on) => {
  office(on, { ...W }, { cwd: '/w' })
  const session = mock.session(on)
  on('session.messages', () => ({ value: [] }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await start($)
  await hire($, { repo: 'service' })
  await $.tool.call({ tool: 'mcp__office__roster' })
  await $.tool.call({ tool: 'mcp__office__ask', to: 'service-1', question: 'What does this repo do?' })
  await $.tool.call({ tool: 'mcp__office__delegate', questionId: 'q1' })
  await $.turn.complete({ agentId: 'agent2', durationMs: 1, turnId: 't1', reason: 'answer', answer: 'It serves the public API.', isAborted: false })
  expect(JSON.stringify(session.appended())).toContain('Answer to q1')
})

// The engine's refusals are failures (OFI-14): the state changes only after delivery.

async function withHire($: Engine, on: Parameters<typeof serveTree>[0]) {
  const kit = office(on, { ...W }, { cwd: '/w' })
  on('session.messages', () => ({ value: [] }))
  await start($)
  await hire($, { repo: 'service' })
  await $.tool.call({ tool: 'mcp__office__roster' })
  const ui = await $.ui.mount({ plugin: 'office', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'office' })
  return { kit, ui }
}

const STOP_REFUSALS = [
  ['denied', { deny: 'busy' }, 'busy'],
  ['errored', { isError: true, result: null, text: 'no such task' }, 'no such task'],
] as const
for (const [kind, answer, reason] of STOP_REFUSALS) {
  test(`refused pause: a ${kind} TaskStop leaves the agent working and toasts why`, async ($, on) => {
    on('tool.call', { tool: 'TaskStop' }, () => answer as never)
    const { kit, ui } = await withHire($, on)
    await ui.press({ key: 'pause-agent1' })
    expect(kit.toasts).toContain(`Could not stop service-1: ${reason}`)
    expect(kit.toasts).not.toContain('service-1 paused')
    expect(await ui.find({ key: 'play-agent1' })).toBeUndefined()
  })
}

test('undelivered send: resuming a paused agent that cannot be reached keeps it paused', async ($, on) => {
  let stopped = false
  on('tool.call', { tool: 'TaskStop' }, () => {
    stopped = true
    return { result: 'stopped' } as never
  })
  on('session.send', () => ({ isDelivered: false, reason: 'gone' }))
  const { kit, ui } = await withHire($, on)
  await ui.press({ key: 'pause-agent1' })
  expect(stopped).toBe(true)
  kit.statuses.agent1 = 'killed'
  await $.tool.call({ tool: 'mcp__office__roster' })
  await ui.press({ key: 'play-agent1' })
  expect(kit.toasts.some(toast => toast.includes('gone'))).toBe(true)
  expect(kit.toasts).not.toContain('service-1 is back at work')
  expect(await ui.find({ key: 'play-agent1' })).toBeDefined()
})

test('undelivered send from the log: the paused agent stays paused and the toast says why', async ($, on) => {
  on('tool.call', { tool: 'TaskStop' }, () => ({ result: 'stopped' }) as never)
  on('session.send', () => ({ isDelivered: false, reason: 'gone' }))
  const { kit, ui } = await withHire($, on)
  await ui.press({ key: 'pause-agent1' })
  kit.statuses.agent1 = 'killed'
  await $.tool.call({ tool: 'mcp__office__roster' })
  await ui.press({ key: 'log-agent1' })
  await ui.input({ key: 'message', text: 'Also check the web docs' })
  expect(kit.toasts).toContain('Could not send to service-1: gone')
  expect(kit.toasts).not.toContain('Sent to service-1')
  await ui.press({ key: 'back-bottom' })
  expect(await ui.find({ key: 'play-agent1' })).toBeDefined()
})

test('pause: an agent paused on purpose is not announced as finished, even when its turn ends during the stop', async ($, on) => {
  let hired: Awaited<ReturnType<typeof withHire>> | undefined
  on('tool.call', { tool: 'TaskStop' }, async () => {
    if (hired) hired.kit.statuses.agent1 = 'killed'
    await $.tool.call({ tool: 'mcp__office__roster' })
    return { result: 'stopped' } as never
  })
  hired = await withHire($, on)
  const { kit, ui } = hired
  await ui.press({ key: 'pause-agent1' })
  await $.tool.call({ tool: 'mcp__office__roster' })
  expect(kit.toasts).toContain('service-1 paused')
  expect(kit.toasts.filter(toast => toast.includes('finished'))).toEqual([])
})

test('refused share: an answer the engine denies is not reported as in the chat', async ($, on) => {
  on('session.append', () => ({ deny: 'filtered' }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  const { kit, ui } = await withHire($, on)
  kit.statuses.agent1 = 'completed'
  await $.turn.complete({ agentId: 'agent1', durationMs: 1, turnId: 't1', reason: 'answer', answer: 'It serves the public API.', isAborted: false })
  await ui.press({ key: 'log-agent1' })
  await ui.press({ key: 'share' })
  expect(kit.toasts).toContain("Could not share service-1's answer: filtered")
  expect(kit.toasts).not.toContain("service-1's answer is in the chat")
})

test('refused question: a denied append registers nothing and toasts why', async ($, on) => {
  on('session.append', () => ({ deny: 'filtered' }))
  const { kit, ui } = await withHire($, on)
  const asked = await $.tool.call({ tool: 'mcp__office__ask', to: 'service-1', question: 'What does this repo do?' })
  expect(String(asked.result)).not.toContain('Question q1 sent')
  expect(kit.toasts.some(toast => toast.includes('filtered'))).toBe(true)
  expect(await ui.find({ text: /\?1/ })).toBeUndefined()
  expect((await $.tool.call({ tool: 'mcp__office__reply', questionId: 'q1', answer: 'x' })).result).toBe('There is no question q1.')
})

test('finished agent: asking it says it finished, with no raw engine error', async ($, on) => {
  on('session.append', () => ({ deny: 'refused: no running loop is agent1' }))
  await withHire($, on)
  const asked = String(
    (await $.tool.call({ tool: 'mcp__office__ask', to: 'service-1', question: 'Still there?' })).result,
  )
  expect(asked).toContain('service-1 has finished, so it cannot take questions')
  expect(asked).not.toContain('no running loop')
})

test('permission: the office allows its own board and message tools, and hire goes on to the person', async ($, on) => {
  on('tool.check', { tool: /^mcp__office__/ }, () => ({ decision: 'ask' as const }))
  await withHire($, on)
  for (const name of ['roster', 'board', 'post', 'ask', 'reply', 'delegate']) {
    expect((await $.tool.check({ tool: `mcp__office__${name}`, input: {} })).decision).toBe('allow')
  }
  expect((await $.tool.check({ tool: 'mcp__office__hire', input: {} })).decision).toBe('ask')
})

test('refused answer: a denied append leaves q1 unanswered and off the board', async ($, on) => {
  let refuse = false
  on('session.append', (_$, e, next) => (refuse ? { deny: 'filtered' } : next(e)))
  const { kit } = await withHire($, on)
  await $.tool.call({ tool: 'mcp__office__ask', to: 'service-1', question: 'Who calls it?' })
  refuse = true
  const replied = await $.tool.call({ tool: 'mcp__office__reply', questionId: 'q1', answer: 'The web app.' })
  expect(String(replied.result)).not.toContain('delivered.')
  expect(kit.toasts.some(toast => toast.includes('filtered'))).toBe(true)
  expect((await $.tool.call({ tool: 'mcp__office__board', query: 'web app' })).result).toBe('The board has nothing on that yet.')
  refuse = false
  expect((await $.tool.call({ tool: 'mcp__office__reply', questionId: 'q1', answer: 'The web app.' })).result).toBe('Answer to q1 delivered.')
})

test('briefing and isolated task: the root and the worktree are absolute, with no ../', async ($, on) => {
  const kit = office(on, { ...W }, { cwd: '/w' })
  await start($)
  expect(await composed($)).toContain('Root: /w\n')
  await hire($, { repo: 'service', worktree: 'yes' })
  const prompt = kit.spawns[0]?.prompt ?? ''
  expect(prompt).toMatch(/You work in \/w\/\.office-worktrees\/service-\S+, an isolated git worktree of \/w\/service/)
  expect(prompt).toContain('Root: /w\n')
  expect(prompt).not.toContain('../')
})

test('common prefix: a spawn in a sibling that shares the root prefix is not briefed', { options: { workspaceRoot: '/x/work' } }, async ($, on) => {
  const kit = office(on, { ...repoFiles('/x/work/a', '/x/work-old/a') }, { cwd: '/x/work' })
  await start($, '/x/work')
  await $.agent.spawn(foreign('/x/work/a'))
  await $.agent.spawn(foreign('/x/work-old/a'))
  expect(kit.spawns[0]?.prompt).toContain('Root: /x/work\n')
  expect(kit.spawns[1]?.prompt).not.toContain('# Workspace')
})

test('empty root: a tool summary keeps its paths whole', async ($, on) => {
  const kit = office(on, { '/w/notes/a.md': 'x' }, { cwd: '/w' })
  on('session.messages', () => ({
    value: [
      {
        role: 'assistant' as const,
        text: '',
        toolUses: [{ tool: 'Bash', tool_use_id: 't1', input: { command: 'make test', description: 'Run the tests in /w/service' } }],
      },
    ],
  }))
  await start($)
  await hire($)
  expect(kit.spawns).toHaveLength(1)
  await $.tool.call({ tool: 'mcp__office__roster' })
  const ui = await $.ui.mount({ plugin: 'office', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'office' })
  await ui.press({ key: 'log-agent1' })
  await ui.press({ key: 'tab-steps' })
  expect(await ui.find({ text: /Run the tests in \/w\/service/ })).toBeDefined()
})

// Fix 9 (OFI-20): hire names the agent and the office's spawn hook sets its folder.

// Loaded outside the office (the prepend tier): it stamps on the description the
// cwd a spawn carried before the office's hook, so the test reads what hire asked.
const STAMP = {
  name: 'stamp',
  tier: 'prepend' as const,
  register: (on => {
    on('agent.spawn', (_$, e, next) =>
      next({ ...e, description: `${e.description} [seen cwd=${e.cwd ?? 'none'}]` }),
    )
  }) satisfies Register,
}

test('the hook rewrites cwd: hire names each agent and the hook sets its folder', { plugins: [STAMP] }, async ($, on) => {
  const kit = office(on, { ...W }, { cwd: '/w' })
  await start($)
  await hire($, { repo: 'service' })
  await hire($, { repo: 'service', worktree: 'yes' })
  expect(kit.spawns.map(spawn => spawn.name)).toEqual(['service-1', 'service-2'])
  expect(kit.spawns[0]?.cwd).toBe('/w/service')
  expect(kit.spawns[1]?.cwd).toMatch(/^\/w\/\.office-worktrees\/service-/)
  await $.tool.call({ tool: 'mcp__office__roster' })
  const asked = await $.tool.call({ tool: 'mcp__office__ask', to: 'service-1', question: 'What does this repo do?' })
  expect(asked.result).toContain('Question q1 sent')
  expect(kit.spawns.map(spawn => spawn.description.endsWith('[seen cwd=none]'))).toEqual([true, true])
})

test('without a repo: a hire and /office --worktree take the session folder as their label', { plugins: [STAMP] }, async ($, on) => {
  const kit = office(on, { ...W }, { cwd: '/w/web', repo: '/w/web' })
  await start($, '/w/web')
  await hire($)
  await $.command.run({ command: 'office', args: `--worktree ${TASK}`, origin: {}, presentation: {} } as never)
  const [first, second] = kit.spawns
  expect(first?.name).toMatch(/^web-\d+$/)
  expect(second?.name).toMatch(/^web-\d+$/)
  expect(first?.name).not.toBe(second?.name)
  expect(first?.cwd).toBe('/w/web')
  expect(second?.cwd).toMatch(/^\/w\/\.office-worktrees\/web-/)
  expect(kit.spawns.every(spawn => spawn.description.endsWith('[seen cwd=none]'))).toBe(true)
})

test('without a repo outside git: a hire is labelled after the session folder', { plugins: [STAMP] }, async ($, on) => {
  const kit = office(on, { ...W }, { cwd: '/w' })
  await start($)
  await hire($)
  expect(kit.spawns[0]?.name).toMatch(/^w-\d+$/)
  expect(kit.spawns[0]?.cwd).toBe('/w')
  expect(kit.spawns[0]?.description.endsWith('[seen cwd=none]')).toBe(true)
})
