import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { sandbox } from './helper.mjs'

const sb = sandbox()
sb.fake('npm', "process.stdout.write('11.19.0\\n')")
after(() => sb.cleanup())

const WORKFLOW = '.github/workflows/docs-site.yml'
const GITHUB = 'https://github.com/example/service.git'
const BASE = { 'README.md': '# Service\n', 'src/app.ts': 'export const ok = true\n', 'docs/index.md': '# Service docs\n\nThe service.\n' }
let n = 0
function repo(files = {}, { drop = [], origin = GITHUB } = {}) {
  const base = Object.fromEntries(Object.entries(BASE).filter(([p]) => !drop.includes(p)))
  const dir = sb.initRepo(sb.path(`w${++n}`, 'service'), { ...base, ...files })
  if (origin) sb.git(dir, 'remote', 'add', 'origin', origin)
  return dir
}
const hub = (dir, args) => sb.hub(args, { cwd: dir })
const planFile = dir => join(dir, '.hub-run', 'plan.json')
const proposal = (dir, id) => join(dir, '.hub-run', 'proposals', 'service', `${id}.proposed`)
const offers = dir => JSON.parse(readFileSync(planFile(dir), 'utf8')).repos.service.files.filter(f => f.offer === 'docs-site')
const readLock = dir => JSON.parse(readFileSync(join(dir, '.claude', 'hub.lock.json'), 'utf8'))

// site --into --workflow, plan --approve and place; returns place's result.
function placed(dir) {
  const into = hub(dir, ['site', '--repo', dir, '--into', 'docs-site', '--workflow', '--json'])
  assert.equal(into.code, 0, into.output)
  assert.equal(hub(dir, ['plan', planFile(dir), '--approve']).code, 0)
  return hub(dir, ['place', planFile(dir), '--json'])
}

describe('the docs-site.yml offer (SIT-21)', () => {
  test("filled with the lock's docs folder and the branch of origin/HEAD", () => {
    const lock = { schema: 1, generator: 'hub@0.1.0', documentedCommit: '0'.repeat(40), settings: { docsDir: 'documentation', language: 'en', scanAllow: [] }, files: {} }
    const dir = repo({ 'documentation/index.md': '# Docs\n', '.claude/hub.lock.json': JSON.stringify(lock, null, 2) + '\n' }, { drop: ['docs/index.md'] })
    sb.git(dir, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD')
    sb.git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    const r = placed(dir)
    assert.equal(r.code, 0, r.output)
    const ids = offers(dir).filter(f => f.path === WORKFLOW && f.action === 'propose').map(f => f.id)
    assert.equal(ids.length, 1)
    const text = readFileSync(proposal(dir, ids[0]), 'utf8')
    assert.doesNotMatch(text, /'docs\/\*\*'/)
    assert.match(text, /'documentation\/\*\*'/)
    assert.match(text, /'docs-site\/\*\*'/)
    assert.match(text, /branches: \['trunk'\]/)
    assert.doesNotMatch(text, /__DOCS_DIR__|__DEFAULT_BRANCH__/)
    const offered = r.json().proposals.find(p => p.id === ids[0])
    assert.equal(offered.path, WORKFLOW)
    assert.match(offered.note, /trunk/)
  })

  test('without origin/HEAD, the branch checked out', () => {
    const dir = repo()
    sb.git(dir, 'checkout', '-q', '-b', 'mainline')
    assert.equal(placed(dir).code, 0)
    assert.match(readFileSync(proposal(dir, 'w1'), 'utf8'), /branches: \['mainline'\]/)
  })

  test('accepted: the workflow is its proposal and the lock records it as ci', () => {
    const dir = repo()
    assert.equal(placed(dir).code, 0)
    const r = hub(dir, ['finish', planFile(dir), '--keep', 'all', '--apply', 'w1', '--json'])
    assert.equal(r.code, 0, r.output)
    assert.equal(readFileSync(join(dir, WORKFLOW), 'utf8'), readFileSync(proposal(dir, 'w1'), 'utf8'))
    const entry = readLock(dir).files[WORKFLOW]
    assert.equal(entry.kind, 'ci')
    assert.equal(entry.hash, sb.git(dir, 'hash-object', WORKFLOW).trim())
  })

  test('accepted after its target appeared: not applied, and the file there stays', () => {
    const dir = repo()
    assert.equal(placed(dir).code, 0)
    const mine = 'name: mine\non: push\njobs: {}\n'
    sb.write(join(dir, WORKFLOW), mine)
    const r = hub(dir, ['finish', planFile(dir), '--keep', 'all', '--apply', 'w1', '--json'])
    assert.equal(r.code, 1, r.output)
    assert.deepEqual(r.json().notApplied.map(x => x.id), ['w1'])
    assert.equal(readFileSync(join(dir, WORKFLOW), 'utf8'), mine)
  })

  test('not accepted: no workflow, the site kept and no ci entry', () => {
    const dir = repo()
    assert.equal(placed(dir).code, 0)
    assert.equal(hub(dir, ['finish', planFile(dir), '--keep', 'all']).code, 0)
    assert.ok(!existsSync(join(dir, WORKFLOW)) && existsSync(join(dir, 'docs-site')))
    assert.equal(Object.values(readLock(dir).files).filter(e => e.kind === 'ci').length, 0)
  })

  test('without a GitHub origin there is no offer, even when asked; an SSH GitHub origin counts', () => {
    const ssh = repo({}, { origin: 'git@github.com:example/service.git' })
    assert.equal(hub(ssh, ['site', '--repo', ssh, '--into', 'docs-site', '--workflow']).code, 0)
    assert.equal(offers(ssh).length, 1)
    const lookalike = repo({}, { origin: 'https://evilgithub.com/example/service.git' })
    assert.equal(hub(lookalike, ['site', '--repo', lookalike, '--into', 'docs-site', '--workflow']).code, 0)
    assert.deepEqual(offers(lookalike), [])
    const dir = repo({}, { origin: 'https://git.example.com/org/service.git' })
    const r = hub(dir, ['site', '--repo', dir, '--into', 'docs-site', '--workflow', '--json'])
    assert.equal(r.code, 0, r.output)
    assert.deepEqual(offers(dir), [])
    assert.match(JSON.stringify(r.json().warnings), /not on GitHub/)
  })
})
