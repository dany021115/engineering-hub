import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { sandbox } from './helper.mjs'

// One sandbox with a fake npm, one without.
const sb = sandbox()
sb.fake('npm', "process.stdout.write('11.19.0\\n')")
const bare = sandbox()
after(() => {
  sb.cleanup()
  bare.cleanup()
})

const BASE = { 'README.md': '# Service\n', 'src/app.ts': 'export const ok = true\n', 'docs/index.md': '# Service docs\n\nThe service.\n' }
let n = 0
// $R: a `service` repo with docs/index.md and one commit; `drop` removes base files.
function repo(files = {}, { drop = [], s = sb } = {}) {
  const base = Object.fromEntries(Object.entries(BASE).filter(([p]) => !drop.includes(p)))
  return s.initRepo(s.path(`r${++n}`, 'service'), { ...base, ...files })
}
const site = (dir, { s = sb, env = {} } = {}) => s.hub(['site', '--repo', dir, '--into', 'docs-site'], { cwd: dir, env })
const status = (dir, s = sb) => s.git(dir, 'status', '--porcelain', '--untracked-files=all')
const nothingWritten = dir => !existsSync(join(dir, 'docs-site')) && !existsSync(join(dir, '.hub-run', 'plan.json'))

describe('site --into preflight (SIT-12)', () => {
  test('no index: exits 2 naming docs/index.md and writes nothing', () => {
    const dir = repo({ 'docs/guide.md': '# Guide\n' }, { drop: ['docs/index.md'] })
    const before = status(dir)
    const r = site(dir)
    assert.equal(r.code, 2, r.output)
    assert.match(r.stderr, /docs\/index\.md/)
    assert.ok(nothingWritten(dir))
    assert.equal(status(dir), before)
  })

  test('README.md as the index passes', () => {
    const dir = repo({ 'docs/README.md': '# Handbook\n' }, { drop: ['docs/index.md'] })
    const r = site(dir)
    assert.equal(r.code, 0, r.output)
  })

  for (const [where, files] of [
    ['docs', { 'docs/README.md': '# Also\n' }],
    ['docs/guides', { 'docs/guides/index.md': '# Guides\n', 'docs/guides/README.md': '# Guides\n' }],
  ]) {
    test(`two indexes in ${where}: exits 2 naming the folder`, () => {
      const dir = repo(files)
      const r = site(dir)
      assert.equal(r.code, 2, r.output)
      assert.match(r.stderr, new RegExp(`${where.replace('/', '\\/')} has both index\\.md and README\\.md`))
      assert.ok(nothingWritten(dir))
    })
  }

  for (const [name, files] of [
    ['mkdocs.yml', { 'mkdocs.yml': 'site_name: Service\n' }],
    ['docs/conf.py', { 'docs/conf.py': 'project = "service"\n', 'docs/index.rst': 'Service\n=======\n' }],
    ['website/docusaurus.config.js', { 'website/docusaurus.config.js': 'export default {}\n' }],
  ]) {
    test(`another site (${name}): exits 2 naming it, nothing written`, () => {
      const dir = repo(files)
      const before = status(dir)
      const r = site(dir)
      assert.equal(r.code, 2, r.output)
      assert.match(r.stderr, new RegExp(`another site is already here: ${name.replace(/[./]/g, '\\$&')}`))
      assert.ok(nothingWritten(dir))
      assert.equal(status(dir), before)
    })
  }

  for (const [label, files] of [
    ['an application conf.py without index.rst', { 'conf.py': 'DEBUG = False\n' }],
    ['a site below a child folder', { 'examples/demo/docusaurus.config.js': 'export default {}\n' }],
  ]) {
    test(`not another site: ${label}`, () => {
      const r = site(repo(files))
      assert.equal(r.code, 0, r.output)
    })
  }

  test('an unfinished run: exits 2 naming it, and its plan does not change', () => {
    const dir = repo({ '.gitignore': '.hub-run/\n' })
    const plan = sb.write(join(dir, '.hub-run', 'plan.json'), JSON.stringify({ schema: 1, mode: 'init', repos: {} }) + '\n')
    const before = readFileSync(plan, 'utf8')
    const r = site(dir)
    assert.equal(r.code, 2, r.output)
    assert.match(r.stderr, /unfinished run/)
    assert.equal(readFileSync(plan, 'utf8'), before)
  })

  test('an old Node or no npm: exits 2 naming the requirement', () => {
    let r = site(repo(), { env: { HUB_NODE_VERSION: '22.11.0' } })
    assert.equal(r.code, 2, r.output)
    assert.match(r.stderr, /Node 22\.12 or later is required; this is 22\.11\.0/)
    const dir = repo({}, { s: bare })
    r = site(dir, { s: bare })
    assert.equal(r.code, 2, r.output)
    assert.match(r.stderr, /npm is required/)
    assert.ok(nothingWritten(dir))
  })
})

test('a hub site in the lock: exits 2, and the repository and the finished run stay as they are (SIT-16)', () => {
  const config = 'export default {}\n'
  const lock = { schema: 1, generator: 'hub@0.1.0', documentedCommit: '0'.repeat(40), settings: { docsDir: 'docs' }, files: { 'docs-site/docusaurus.config.js': { kind: 'site', hash: 'x', sources: {} } } }
  const dir = repo({ 'docs-site/docusaurus.config.js': config, 'docs-site/src/css/custom.css': ':root {}\n', '.claude/hub.lock.json': JSON.stringify(lock), '.gitignore': '.hub-run/\n' })
  sb.write(join(dir, 'docs-site', 'src', 'css', 'custom.css'), ':root { --ifm-color-primary: #000; }\n')
  const plan = sb.write(join(dir, '.hub-run', 'plan.json'), JSON.stringify({ schema: 1, mode: 'site', repos: {} }) + '\n')
  sb.write(join(dir, '.hub-run', 'done.json'), '{}\n')
  const before = { status: status(dir), plan: readFileSync(plan, 'utf8'), css: readFileSync(join(dir, 'docs-site', 'src', 'css', 'custom.css'), 'utf8') }
  const r = site(dir)
  assert.equal(r.code, 2, r.output)
  assert.match(r.stderr, /already has a hub site \(docs-site\/\): updating an installed site is out of scope/)
  assert.doesNotMatch(r.stderr, /another site/)
  assert.equal(status(dir), before.status)
  assert.equal(readFileSync(plan, 'utf8'), before.plan)
  assert.equal(readFileSync(join(dir, 'docs-site', 'src', 'css', 'custom.css'), 'utf8'), before.css)
  assert.ok(existsSync(join(dir, '.hub-run', 'done.json')))
})
