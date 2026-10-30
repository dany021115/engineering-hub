import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileEntry, readLock, relatedLocks, relatedRepos, serializeLock, sourcesFromFacts, writeLock } from '../scripts/lib/lock.mjs'
import { gitEnv, makeWorkspace, sandbox } from './helper.mjs'
import { cloneAlone, lockedWorkspace } from './workspace-fixture.mjs'

const sb = sandbox()
const saved = { ...process.env }
// The lock module runs git in this process: isolate it like the CLI runs.
before(() => Object.assign(process.env, gitEnv(), { HOME: sb.home }))
after(() => {
  process.env = saved
  sb.cleanup()
})

test('ids and format: hashes, blob and tree sources, sorted keys, two spaces, final newline (GEN-22)', () => {
  const w = makeWorkspace(sb)
  const page = 'docs/reference/configuration.md'
  sb.write(join(w.service, page), '# Configuration\n\nThe service reads `DB_URL`.\n')
  const facts = [
    { type: 'fact', id: 'F1', kind: 'command', evidence: [{ path: '.github/workflows/ci.yml', quote: 'run: npm test' }] },
    { type: 'fact', id: 'F7', kind: 'negative', evidence: [{ absence: 'npm run e2e', pathspec: 'deploy/' }] },
    { type: 'fact', id: 'F9', kind: 'seam', evidence: [{ path: 'web:src/client.ts', quote: 'API_BASE' }] },
    { type: 'fact', id: 'Q1', kind: 'human', claim: 'Does a merge deploy?', answer: 'no', role: 'maintainer' },
  ]
  const dirs = { service: w.service, web: w.web }
  const head = sb.git(w.service, 'rev-parse', 'HEAD').trim()
  const lock = {
    schema: 1,
    generator: 'hub@0.1.0',
    documentedCommit: head,
    settings: { language: 'en', docsDir: 'docs', docsHome: 'service' },
    files: {
      [page]: fileEntry(w.service, page, { kind: 'page', type: 'reference', sources: sourcesFromFacts(dirs, 'service', facts) }),
      'CLAUDE.md': { kind: 'page', hash: 'x', sources: {} },
    },
  }
  writeLock(w.service, lock)
  const file = join(w.service, '.claude', 'hub.lock.json')
  const bytes = readFileSync(file, 'utf8')
  const parsed = JSON.parse(bytes)
  assert.equal(serializeLock(parsed), bytes)
  assert.ok(bytes.endsWith('}\n'))
  assert.match(bytes, /^\{\n {2}"documentedCommit"/)
  assert.match(parsed.documentedCommit, /^[0-9a-f]{40}$/)
  const entry = parsed.files[page]
  assert.equal(entry.hash, sb.git(w.service, 'hash-object', page).trim())
  assert.deepEqual(entry.sources, {
    '.github/workflows/ci.yml': sb.git(w.service, 'rev-parse', 'HEAD:.github/workflows/ci.yml').trim(),
    'deploy/': sb.git(w.service, 'rev-parse', 'HEAD:deploy').trim(),
    'web:src/client.ts': sb.git(w.web, 'rev-parse', 'HEAD:src/client.ts').trim(),
  })
  assert.deepEqual(Object.keys(parsed.files), [page])
  assert.deepEqual(parsed.settings.scanAllow, [])
  assert.equal(existsSync(join(w.service, '.claude', 'workspace.json')), false)
})

test('rewriting a lock keeps settings.scanAllow as the person left it', () => {
  const w = makeWorkspace(sb, { at: sb.path('w2') })
  const file = sb.write(
    join(w.service, '.claude', 'hub.lock.json'),
    JSON.stringify({ schema: 1, settings: { language: 'en', scanAllow: ['example-name', 'build-bot'] }, files: {} }),
  )
  writeLock(w.service, { schema: 1, settings: { language: 'en', scanAllow: [] }, files: {} })
  assert.deepEqual(readLock(w.service).settings.scanAllow, ['example-name', 'build-bot'])
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).settings.scanAllow, ['example-name', 'build-bot'])
})

test('related repos: the docs home, the workspace and the owners of sibling sources, once each', () => {
  const lock = {
    settings: { docsHome: 'service' },
    workspace: { repos: ['service', 'web'] },
    files: { 'a.md': { sources: { 'web:src/a.ts': 'x', 'infra:deploy/': 'y', 'src/own.ts': 'z' } } },
  }
  assert.deepEqual(relatedRepos(lock, 'service'), ['web', 'infra'])
  assert.deepEqual(relatedRepos(lock, 'web'), ['service', 'infra'])
  assert.deepEqual(relatedRepos({ settings: { language: 'en' }, files: {} }, 'service'), [])
})

test('related locks: present siblings with their lock, absent ones, bad names and unreadable locks never throw', () => {
  const w = lockedWorkspace(sb, { at: sb.path('rel') })
  const [home] = relatedLocks(w.web, readLock(w.web))
  assert.deepEqual([home.name, home.present, home.dir, home.problem], ['service', true, w.service, null])
  assert.deepEqual(home.lock.workspace.repos, ['service', 'web'])
  assert.deepEqual(
    relatedLocks(w.service, readLock(w.service)).map(r => [r.name, r.present]),
    [['web', true]],
  )
  const alone = cloneAlone(sb, w.web, 'web')
  assert.deepEqual(
    relatedLocks(alone, readLock(alone)).map(r => [r.name, r.present, r.lock, r.problem]),
    [['service', false, null, null]],
  )
  for (const bad of ['..', 'a/b', '', '.']) {
    const [r] = relatedLocks(w.web, { settings: { docsHome: bad }, files: {} })
    assert.equal(r.present, false)
    assert.match(r.problem, /is not a repository name/)
  }
  sb.write(join(w.service, '.claude', 'hub.lock.json'), '{ broken')
  const [broken] = relatedLocks(w.web, readLock(w.web))
  assert.equal(broken.present, true)
  assert.equal(broken.lock, null)
  assert.match(broken.problem, /is not valid JSON/)
})
