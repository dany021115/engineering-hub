import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { makeWorkspace, sandbox } from './helper.mjs'

const sb = sandbox()
after(() => sb.cleanup())

const installed = `hub@${JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version}`
const P1 = 'docs/reference/configuration.md'
const P2 = 'docs/how-to/run-tests.md'
const S1 = '.claude/skills/working-in-service/SKILL.md'
const CI = '.github/workflows/ci.yml'

let n = 0
// `/w` with a lock in `service` over three generated files, committed; `sources` maps each path to
// its source keys, read from HEAD at lock time.
function locked({ generator = installed, sources = {} } = {}) {
  const dirs = makeWorkspace(sb, { at: sb.path(`w${++n}`) })
  const dir = dirs.service
  const texts = { [P1]: '# Configuration\n\nThe service reads `DB_URL`.\n', [P2]: '# Run the tests\n\nRun them.\n', [S1]: '---\nname: working-in-service\ndescription: Working in service.\n---\n\nRun `npm test`.\n' }
  for (const [p, t] of Object.entries(texts)) sb.write(join(dir, p), t)
  sb.commit(dir, 'generated')
  const id = (at, p) => sb.git(at, 'rev-parse', `HEAD:${p.replace(/\/$/, '')}`).trim()
  const files = {}
  for (const p of Object.keys(texts)) {
    const keys = sources[p] ?? []
    files[p] = {
      kind: p.startsWith('.claude') ? 'skill' : 'page',
      hash: id(dir, p),
      sources: Object.fromEntries(keys.map(k => [k, k.includes(':') ? id(dirs[k.split(':')[0]], k.split(':')[1]) : id(dir, k)])),
    }
  }
  const lock = { schema: 1, generator, documentedCommit: sb.git(dir, 'rev-parse', 'HEAD').trim(), settings: { language: 'en', docsDir: 'docs', scanAllow: [] }, files }
  sb.write(join(dir, '.claude', 'hub.lock.json'), JSON.stringify(lock, null, 2) + '\n')
  const base = sb.commit(dir, 'lock')
  return { dirs, dir, base }
}

const drift = (dir, ...flags) => sb.hub(['drift', '--repo', dir, ...flags])
const fileOf = (r, path) => r.json().repos[0].files.find(f => f.path === path)

describe('classes (GEN-23)', () => {
  const { dir, base } = locked({ sources: { [S1]: [CI], [P1]: ['src/config.ts'] } })
  sb.write(join(dir, P1), readFileSync(join(dir, P1), 'utf8') + '\nA line of mine.\n')
  rmSync(join(dir, P2))
  sb.write(join(dir, CI), readFileSync(join(dir, CI), 'utf8') + '      - run: npm run lint\n')
  sb.write(join(dir, 'openapi.yaml'), 'openapi: 3.0.0\n')
  sb.write(join(dir, 'src/cache.ts'), 'export const ttl = process.env.CACHE_TTL\n')
  sb.commit(dir, 'change ci, add a contract and a variable')

  test('edited, missing, affected and new evidence, exit 0', () => {
    const r = drift(dir, '--json')
    assert.equal(r.code, 0, r.output)
    assert.equal(fileOf(r, P1).edited, true)
    assert.deepEqual(fileOf(r, P1).affected, [])
    assert.equal(fileOf(r, P2).missing, true)
    assert.deepEqual(fileOf(r, S1).affected, [CI])
    const evidence = r.json().repos[0].newEvidence
    assert.deepEqual(evidence.find(e => e.path === 'openapi.yaml'), { path: 'openapi.yaml', class: 'contracts' })
    assert.ok(evidence.some(e => e.env === 'CACHE_TTL'), JSON.stringify(evidence))
    assert.ok(!evidence.some(e => e.env === 'DB_URL'), 'DB_URL was there before')
  })

  test('--since with --annotate warns on the file whose sources the range changed', () => {
    const r = drift(dir, '--since', base, '--annotate')
    assert.equal(r.code, 0, r.output)
    assert.match(r.stdout, new RegExp(`^::warning file=${S1.replace(/[.]/g, '\\.')}::`, 'm'))
    assert.doesNotMatch(r.stdout, /::warning file=docs\//)
  })

  test('a --since ref that does not exist warns and exits 0 (GEN-27)', () => {
    const r = drift(dir, '--since', 'f'.repeat(40), '--annotate')
    assert.equal(r.code, 0, r.output)
    assert.match(r.stderr, /is not a commit in this clone/)
    assert.doesNotMatch(r.stdout, /::warning/)
  })
})

test('an unreachable documentedCommit and another generator: same states, evidence skipped, /hub:init suggested', () => {
  const { dir } = locked({ generator: 'hub@0.0.1', sources: { [S1]: [CI] } })
  sb.write(join(dir, CI), readFileSync(join(dir, CI), 'utf8') + '      - run: npm run lint\n')
  sb.write(join(dir, 'openapi.yaml'), 'openapi: 3.0.0\n')
  sb.commit(dir, 'change ci')
  const clone = sb.path(`shallow-${n}`)
  sb.git(sb.base, 'clone', '-q', '--depth', '1', `file://${dir}`, clone)
  const full = drift(dir, '--json')
  const r = drift(clone, '--json')
  assert.equal(r.code, 0, r.output)
  assert.deepEqual(r.json().repos[0].files, full.json().repos[0].files)
  assert.deepEqual(r.json().repos[0].newEvidence, [])
  assert.ok(full.json().repos[0].newEvidence.length > 0)
  const warnings = JSON.stringify(r.json().warnings)
  assert.match(warnings, /documentedCommit .* is not in this clone/)
  assert.match(warnings, /hub@0\.0\.1.*run \/hub:init/)
})

test('a sibling source is compared with the sibling on disk, and is unknown without it', () => {
  const { dirs, dir } = locked({ sources: { [P1]: ['web:src/client.ts'] } })
  let r = drift(dir, '--json')
  assert.equal(fileOf(r, P1), undefined, r.output)
  sb.write(join(dirs.web, 'src/client.ts'), "export const API_BASE = '/api/v2'\n")
  sb.commit(dirs.web, 'move the api')
  r = drift(dir, '--json')
  assert.deepEqual(fileOf(r, P1).affected, ['web:src/client.ts'])
  rmSync(dirs.web, { recursive: true, force: true })
  r = drift(dir, '--json')
  assert.deepEqual(fileOf(r, P1).unknown, ['web:src/client.ts'])
  assert.equal(r.code, 0)
})

test('a repository without a lock exits 2 and points to /hub:init', () => {
  const dirs = makeWorkspace(sb, { at: sb.path('nolock') })
  const r = drift(dirs.service)
  assert.equal(r.code, 2)
  assert.match(r.stderr, /run \/hub:init first/)
})

describe('--advance (GEN-24)', () => {
  const lockFile = dir => join(dir, '.claude', 'hub.lock.json')
  const readLock = dir => JSON.parse(readFileSync(lockFile(dir), 'utf8'))
  const head = dir => sb.git(dir, 'rev-parse', 'HEAD').trim()

  test('without affected files it moves documentedCommit to HEAD and changes only the lock', () => {
    const { dir } = locked({ sources: { [S1]: [CI] } })
    sb.write(join(dir, 'NOTES.txt'), 'unrelated\n')
    sb.commit(dir, 'a commit that touches no source')
    const before = readFileSync(lockFile(dir), 'utf8')
    const r = drift(dir, '--advance')
    assert.equal(r.code, 0, r.output)
    assert.equal(readLock(dir).documentedCommit, head(dir))
    assert.equal(sb.git(dir, 'status', '--short'), ' M .claude/hub.lock.json\n')
    const after = readFileSync(lockFile(dir), 'utf8')
    assert.equal(after.replace(head(dir), 'X'), before.replace(JSON.parse(before).documentedCommit, 'X'))
  })

  test('an edited file does not stop it and keeps its entry; an affected one leaves the lock as it was', () => {
    const { dir } = locked({ sources: { [S1]: [CI] } })
    sb.write(join(dir, P1), readFileSync(join(dir, P1), 'utf8') + '\nA line of mine.\n')
    sb.commit(dir, 'edit a page by hand')
    const entry = readLock(dir).files[P1]
    let r = drift(dir, '--advance')
    assert.equal(r.code, 0, r.output)
    assert.equal(readLock(dir).documentedCommit, head(dir))
    assert.deepEqual(readLock(dir).files[P1], entry)

    sb.write(join(dir, CI), readFileSync(join(dir, CI), 'utf8') + '      - run: npm run lint\n')
    sb.commit(dir, 'change ci')
    const before = readFileSync(lockFile(dir), 'utf8')
    r = drift(dir, '--advance')
    assert.equal(r.code, 0, r.output)
    assert.match(r.stderr, /affected, so documentedCommit stays/)
    assert.equal(readFileSync(lockFile(dir), 'utf8'), before)
  })
})
