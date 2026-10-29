import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { PLUGIN, makeWorkspace, sandbox } from './helper.mjs'
import { walkFiles } from '../scripts/lib/workspace.mjs'

const sb = sandbox()
sb.fake('npm', "process.stdout.write('11.19.0\\n')")
after(() => sb.cleanup())

const TEMPLATE = join(PLUGIN, 'templates', 'site')
const BASE = { 'README.md': '# Service\n', 'src/app.ts': 'export const ok = true\n', 'docs/index.md': '# Service docs\n\nThe service.\n' }
let n = 0
function repo(files = {}, { drop = [], origin } = {}) {
  const base = Object.fromEntries(Object.entries(BASE).filter(([p]) => !drop.includes(p)))
  const dir = sb.initRepo(sb.path(`r${++n}`, 'service'), { ...base, ...files })
  if (origin) sb.git(dir, 'remote', 'add', 'origin', origin)
  return dir
}
const hub = (dir, ...args) => sb.hub(args, { cwd: dir })
const into = (dir, ...extra) => hub(dir, 'site', '--repo', dir, '--into', 'docs-site', '--json', ...extra)
const run = (dir, ...p) => join(dir, '.hub-run', ...p)
const readPlan = dir => JSON.parse(readFileSync(run(dir, 'plan.json'), 'utf8'))
const staged = dir => join(run(dir, 'out', 'service', 'docs-site'))
const siteJson = dir => JSON.parse(readFileSync(join(staged(dir), 'site.json'), 'utf8'))
const status = dir => sb.git(dir, 'status', '--porcelain', '--untracked-files=all')
const lockText = (settings, files = {}) => JSON.stringify({ schema: 1, generator: 'hub@0.1.0', documentedCommit: '0'.repeat(40), settings, files })

describe('the report (SIT-13)', () => {
  test('without a lock: one repo, its home, a GitHub remote, the docs folder and the versions; nothing written', () => {
    const dir = repo({}, { origin: 'https://github.com/example/service.git' })
    const before = status(dir)
    const r = hub(dir, 'site', '--repo', dir, '--json')
    assert.equal(r.code, 0, r.output)
    const j = r.json()
    assert.deepEqual([j.mode, j.home, j.lock, j.hubSite, j.github, j.docsDir, j.npm], ['repo', 'service', false, false, true, 'docs', '11.19.0'])
    assert.equal(j.node, process.versions.node)
    assert.equal(status(dir), before)
    assert.ok(!existsSync(run(dir)))
  })

  test("--repo takes the repository's name as well as a folder", () => {
    const dir = repo()
    for (const value of ['service', '.']) {
      const r = hub(dir, 'site', '--repo', value, '--json')
      assert.equal(r.code, 0, r.output)
      assert.equal(r.json().repo, 'service')
    }
  })

  test('with a hub site in the lock it says so', () => {
    const dir = repo({ '.claude/hub.lock.json': lockText({ docsDir: 'docs' }, { 'docs-site/site.json': { kind: 'site', hash: 'x', sources: {} } }) })
    const r = hub(dir, 'site', '--json')
    assert.equal(r.code, 0, r.output)
    assert.equal(r.json().hubSite, true)
    assert.ok(!existsSync(run(dir)))
  })
})

describe('site --into (SIT-12, SIT-14, SIT-15)', () => {
  test('without a lock: .hub-run/ like start --repo, an unapproved plan of exactly the staged files, git sees nothing', () => {
    const dir = repo()
    const r = into(dir)
    assert.equal(r.code, 0, r.output)
    const plan = readPlan(dir)
    assert.deepEqual([plan.mode, plan.approved], ['site', false])
    const creates = plan.repos.service.files.filter(f => f.action === 'create').map(f => f.path).sort()
    assert.deepEqual(creates, walkFiles(staged(dir), () => false).map(p => `docs-site/${p}`).sort())
    assert.equal(readFileSync(run(dir, '.gitignore'), 'utf8'), '*\n')
    assert.ok(existsSync(run(dir, 'env.json')) && existsSync(run(dir, 'status', 'service.txt')))
    assert.equal(status(dir), '')
    assert.ok(!existsSync(join(dir, 'docs-site')))
  })

  test('README.md as the index: staged, the repository untouched', () => {
    const dir = repo({ 'docs/README.md': '# Handbook\n' }, { drop: ['docs/index.md'] })
    assert.equal(into(dir).code, 0)
    assert.ok(existsSync(staged(dir)) && !existsSync(join(dir, 'docs-site')))
  })

  test('a clean staging: the template byte for byte, and a site.json with only the title and noIndex', () => {
    const dir = repo()
    assert.equal(into(dir, '--title', 'Service docs').code, 0)
    const skip = (p, d) => ['node_modules', 'build', '.docusaurus'].includes(d.name)
    const mine = walkFiles(TEMPLATE, skip).filter(p => p !== 'site.json').sort()
    assert.deepEqual(walkFiles(staged(dir), () => false).filter(p => p !== 'site.json').sort(), mine)
    for (const p of mine) assert.ok(readFileSync(join(TEMPLATE, p)).equals(readFileSync(join(staged(dir), p))), p)
    assert.deepEqual(siteJson(dir), { title: 'Service docs', noIndex: true })
  })

  test('no hand-added values, and no credential of the remote under .hub-run/', () => {
    const secret = ['pa', 'ss', 'w0rd', 'x9'].join('')
    const dir = repo({ 'docs/config.md': '# Config\n\n```toml\nname = "service"\n```\n' }, { origin: [['https://tester', secret].join(':'), 'github.com/example/service.git'].join('@') })
    assert.equal(into(dir).code, 0)
    const json = siteJson(dir)
    assert.ok(!('editUrl' in json || 'prism' in json || 'labels' in json))
    const files = walkFiles(run(dir), () => false)
    assert.ok(files.every(p => !readFileSync(run(dir, p), 'utf8').includes(secret)))
  })

  test("the docs folder: the lock's, or the one chosen in P1", () => {
    let dir = repo({ 'documentation/index.md': '# Docs\n', '.claude/hub.lock.json': lockText({ docsDir: 'documentation' }) }, { drop: ['docs/index.md'] })
    assert.equal(into(dir).code, 0, 'lock')
    assert.equal(siteJson(dir).docsDir, '../documentation')
    dir = repo({ 'documentation/index.md': '# Docs\n' }, { drop: ['docs/index.md'] })
    const r = into(dir, '--docs', 'documentation')
    assert.equal(r.code, 0, r.output)
    assert.equal(siteJson(dir).docsDir, '../documentation')
  })

  test('approve passes without facts; a path or an action outside the site fails naming the entry', () => {
    const dir = repo({}, { origin: 'https://github.com/example/service.git' })
    assert.equal(into(dir).code, 0)
    const file = run(dir, 'plan.json')
    const original = readFileSync(file, 'utf8')
    for (const change of [
      p => p.repos.service.files.push({ id: 'x1', path: 'docs/extra.md', action: 'create', kind: 'page', why: 'more' }),
      p => (p.repos.service.files[0].action = 'delete'),
    ]) {
      const p = JSON.parse(original)
      change(p)
      sb.write(file, JSON.stringify(p))
      const r = hub(dir, 'plan', file, '--approve', '--json')
      assert.equal(r.code, 1, r.output)
      assert.match(JSON.stringify(r.json().errors), /"id":"(x1|s1)"/)
      assert.equal(readPlan(dir).approved, false)
    }
    sb.write(file, original)
    const placeEarly = hub(dir, 'place', file, '--json')
    assert.equal(placeEarly.code, 2)
    assert.ok(!existsSync(join(dir, 'docs-site')))
    const r = hub(dir, 'plan', file, '--approve', '--json')
    assert.equal(r.code, 0, r.output)
    assert.equal(readPlan(dir).approved, true)

    const other = repo({}, { origin: 'https://github.com/example/service.git' })
    assert.equal(into(other, '--workflow').code, 0)
    assert.ok(readPlan(other).repos.service.files.some(f => f.path === '.github/workflows/docs-site.yml' && f.action === 'propose' && f.offer === 'docs-site'))
    assert.equal(hub(other, 'plan', run(other, 'plan.json'), '--approve').code, 0)
  })

  test('after a finished init: its .hub-run/ goes, the new one comes, and place works', () => {
    const dir = repo({ '.gitignore': '.hub-run/\n' })
    sb.write(run(dir, 'done.json'), '{}\n')
    sb.write(run(dir, 'placed.json'), '{}\n')
    sb.write(run(dir, 'plan.json'), JSON.stringify({ schema: 1, mode: 'init', repos: {} }))
    const r = into(dir)
    assert.equal(r.code, 0, r.output)
    assert.ok(!existsSync(run(dir, 'done.json')) && !existsSync(run(dir, 'placed.json')))
    assert.ok(existsSync(run(dir, 'status', 'service.txt')) && existsSync(run(dir, 'env.json')))
    assert.equal(readPlan(dir).mode, 'site')
    assert.equal(hub(dir, 'plan', run(dir, 'plan.json'), '--approve').code, 0)
    const placed = hub(dir, 'place', run(dir, 'plan.json'), '--json')
    assert.equal(placed.code, 0, placed.output)
    assert.ok(existsSync(join(dir, 'docs-site', 'docusaurus.config.js')))
  })

  test('start --discard after site --into leaves nothing', () => {
    const dir = repo()
    const before = status(dir)
    assert.equal(into(dir).code, 0)
    assert.equal(hub(dir, 'start', '--discard').code, 0)
    assert.ok(!existsSync(run(dir)) && !existsSync(join(dir, 'docs-site')))
    assert.equal(status(dir), before)
  })

  test('in a workspace the root listing is taken, like start --repo', () => {
    const dirs = makeWorkspace(sb, { at: sb.path('ws', 'w'), extra: { service: { 'docs/index.md': '# Service docs\n' } } })
    sb.write(join(dirs.w, 'notes.md'), 'A note.\n')
    const r = sb.hub(['site', '--repo', dirs.service, '--into', 'docs-site', '--json'], { cwd: dirs.w })
    assert.equal(r.code, 0, r.output)
    const lines = readFileSync(join(dirs.w, '.hub-run', 'status', '.root.txt'), 'utf8').split('\n').filter(Boolean)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /notes\.md/)
    assert.ok(readdirSync(join(dirs.w, '.hub-run', 'out')).includes('service'))
  })
})
