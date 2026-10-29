// An approved run on /w/service with its staged files, for the place and finish tests.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { overlayText, pageText, stage } from './gate-fixture.mjs'
import { overlay, page, prepare } from './plan-fixture.mjs'

export const blob = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex')
export const REASON = /^(gate:(skills|docs|scan|grounding|validate|facts)|review|target-dropped)$/

export const CONFIG = 'docs/reference/configuration.md'
export const RUN_TESTS = 'docs/how-to/run-tests.md'
export const RELEASE = 'docs/how-to/release.md'

export const configText = pageText('Configuration', [['## Settings', 'The service reads `DB_URL` in `src/config.ts`.']])
export const runTestsText = pageText(
  'Run the tests',
  [
    ['## Before you begin', 'Install the packages.'],
    ['## Steps', '1. Run the suite.'],
    ['## Verify', 'The suite passes.'],
  ],
  'This page shows how to run the service tests.',
)
export const releaseText = pageText(
  'Release',
  [
    ['## Before you begin', 'Merge the change.'],
    ['## Steps', '1. Tag the release.'],
    ['## Verify', 'The workflow passes.'],
  ],
  'This page shows how a release ships.',
)

export const s1 = () => overlay()
export const p1 = (extra = {}) => page('p1', CONFIG, 'reference', 'reads-env-vars', ['F2'], extra)
export const p2 = (extra = {}) => page('p2', RUN_TESTS, 'how-to', 'tests-need-setup', ['F1'], extra)
export const x1 = (text = 'Before editing, testing or committing here, read `.claude/skills/working-in-service/SKILL.md`.') => ({
  id: 'x1',
  path: 'CLAUDE.md',
  action: 'propose',
  offer: 'instructions-line',
  text,
  why: 'one pointer line',
})
export const g1 = (deny = ['Bash(npm run db:migrate)']) => ({
  id: 'g1',
  path: '.claude/settings.json',
  action: 'propose',
  offer: 'guardrail-deny',
  deny,
  why: 'pairs with s2',
})
export const e1 = () => ({ id: 'e1', path: '.claude/settings.json', action: 'propose', offer: 'team-settings', why: 'the team loads hub' })

export const TEXTS = { [s1().path]: overlayText(), [CONFIG]: configText, [RUN_TESTS]: runTestsText, [RELEASE]: releaseText }

// A lock that generated CONFIG and RELEASE, committed with them, for update and delete; the paths in
// `stale` cite a source whose id is no longer HEAD's, so they are affected.
export function lockedExtra({ stale = [] } = {}) {
  const lock = {
    schema: 1,
    generator: 'hub@0.1.0',
    documentedCommit: '0'.repeat(40),
    settings: { language: 'en', docsDir: 'docs', scanAllow: ['Reviewed Name'] },
    files: {
      [CONFIG]: { kind: 'page', type: 'reference', hash: blob(configText), sources: {} },
      [RELEASE]: { kind: 'page', type: 'how-to', hash: blob(releaseText), sources: {} },
    },
  }
  for (const p of stale) lock.files[p].sources = { 'src/config.ts': 'f'.repeat(40) }
  return { [CONFIG]: configText, [RELEASE]: releaseText, '.claude/hub.lock.json': JSON.stringify(lock, null, 2) + '\n' }
}

export function approvedRun(sb, files, { extra = {}, texts = {}, approved = true, questions = [], prepareOptions = {}, mode = 'init' } = {}) {
  const ctx = prepare(sb, { extra: { service: extra }, ...prepareOptions })
  ctx.plan({ service: { files, questions } }, { approved, mode })
  for (const f of files) {
    if (!['create', 'update', 'dropped'].includes(f.action) || !f.kind) continue
    const text = texts[f.path] ?? TEXTS[f.path]
    if (text !== undefined) stage(sb, ctx, f.path, text)
  }
  const run = (cmd, ...args) => sb.hub([cmd, ctx.planFile, ...args, '--json'], { cwd: ctx.root })
  return {
    ctx,
    place: () => run('place'),
    finish: (...args) => run('finish', ...args),
    check: round => run('check', '--round', String(round)),
    status: () =>
      sb
        .git(ctx.service, 'status', '--porcelain', '--untracked-files=all')
        .split('\n')
        .filter(Boolean)
        .map(l => l.slice(3)),
    statusZ: () => sb.git(ctx.service, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
    snapshot: () => readFileSync(join(ctx.root, '.hub-run', 'status', 'service.txt'), 'utf8'),
    placed: () => JSON.parse(readFileSync(join(ctx.root, '.hub-run', 'placed.json'), 'utf8')).repos.service,
    entry: id => ctx.readPlan().repos.service.files.find(f => f.id === id),
    read: p => readFileSync(join(ctx.service, p), 'utf8'),
    out: p => readFileSync(join(ctx.root, '.hub-run', 'out', 'service', p.replace(/^\.claude\//, '_claude/')), 'utf8'),
    hash: p => sb.git(ctx.service, 'hash-object', p).trim(),
  }
}
