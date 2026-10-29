import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { PLUGIN, sandbox } from './helper.mjs'
import { approvedRun, s1 } from './run-fixture.mjs'
import { walkFiles } from '../scripts/lib/workspace.mjs'

// A fake npm that logs each call and creates what `ci` and `run build` create. It fails on demand:
// FAKE_NPM_FAIL=ci fails npm ci; =kill makes npm ci kill the hub that called it, as a cut-off build;
// FAKE_DIAGRAMS_OUTPUT and FAKE_BUILD_OUTPUT name files whose text the step prints before failing.
const FAKE_NPM = `const fs = require('node:fs')
const args = process.argv.slice(2).join(' ')
if (process.env.FAKE_NPM_LOG) fs.appendFileSync(process.env.FAKE_NPM_LOG, args + '\\n')
const fail = process.env.FAKE_NPM_FAIL
const failWith = file => { process.stdout.write(fs.readFileSync(file, 'utf8')); process.exit(1) }
if (args === '--version') process.stdout.write('11.19.0\\n')
else if (args === 'ci --ignore-scripts') {
  if (fail === 'ci') { process.stderr.write('npm error network\\n'); process.exit(1) }
  fs.mkdirSync('node_modules/dep', { recursive: true }); fs.writeFileSync('node_modules/dep/index.js', '')
  if (fail === 'kill') { process.kill(process.ppid, 'SIGKILL'); process.exit(0) }
} else if (args === 'run --silent check:diagrams') {
  if (process.env.FAKE_DIAGRAMS_OUTPUT) failWith(process.env.FAKE_DIAGRAMS_OUTPUT)
} else if (args === 'run build') {
  fs.mkdirSync('build', { recursive: true }); fs.writeFileSync('build/index.html', '')
  fs.mkdirSync('.docusaurus', { recursive: true }); fs.writeFileSync('.docusaurus/routes.js', '')
  if (process.env.FAKE_BUILD_OUTPUT) failWith(process.env.FAKE_BUILD_OUTPUT)
}`

const sb = sandbox()
sb.fake('npm', FAKE_NPM)
after(() => sb.cleanup())

const TEMPLATE = join(PLUGIN, 'templates', 'site')
const BUILD = ['docs-site/.docusaurus', 'docs-site/build', 'docs-site/node_modules']
const BASE = { 'README.md': '# Service\n', 'src/app.ts': 'export const ok = true\n', 'docs/index.md': '# Service docs\n\nThe service.\n' }
let n = 0
function repo(files = {}, { drop = [] } = {}) {
  const base = Object.fromEntries(Object.entries(BASE).filter(([p]) => !drop.includes(p)))
  return sb.initRepo(sb.path(`b${++n}`, 'service'), { ...base, ...files })
}
const hub = (dir, args, env = {}) => sb.hub(args, { cwd: dir, env })
const runFile = (dir, ...p) => join(dir, '.hub-run', ...p)
const planFile = dir => runFile(dir, 'plan.json')
const readPlan = dir => JSON.parse(readFileSync(planFile(dir), 'utf8'))
const readPlaced = dir => JSON.parse(readFileSync(runFile(dir, 'placed.json'), 'utf8')).repos.service
const readLock = dir => JSON.parse(readFileSync(join(dir, '.claude', 'hub.lock.json'), 'utf8'))
const status = dir => sb.git(dir, 'status', '--porcelain', '--untracked-files=all')
const head = dir => sb.git(dir, 'rev-parse', 'HEAD').trim()
const builtLeft = dir => BUILD.filter(p => existsSync(join(dir, p)))
const output = text => sb.write(sb.path(`out-${++n}.txt`), text)

// site --into, plan --approve and place, as /hub:site runs them.
function placed(dir, { title, workflow = false, docs } = {}) {
  const into = ['site', '--repo', dir, '--into', 'docs-site', '--json', ...(title ? ['--title', title] : []), ...(workflow ? ['--workflow'] : []), ...(docs ? ['--docs', docs] : [])]
  assert.equal(hub(dir, into).code, 0, 'site --into')
  assert.equal(hub(dir, ['plan', planFile(dir), '--approve']).code, 0, 'plan --approve')
  return hub(dir, ['place', planFile(dir), '--json'])
}
const build = (dir, env = {}, json = true) => hub(dir, ['site', '--repo', dir, '--build', 'docs-site', ...(json ? ['--json'] : [])], env)
const finish = (dir, keep, json = true) => hub(dir, ['finish', planFile(dir), '--keep', keep, ...(json ? ['--json'] : [])])

describe('placing the site (SIT-15)', () => {
  test('docs-site/ is the staging, file for file', () => {
    const dir = repo()
    assert.equal(placed(dir, { title: 'Service docs' }).code, 0)
    const staged = runFile(dir, 'out', 'service', 'docs-site')
    const files = walkFiles(staged, () => false).sort()
    assert.deepEqual(walkFiles(join(dir, 'docs-site'), () => false).sort(), files)
    for (const p of files) assert.ok(readFileSync(join(staged, p)).equals(readFileSync(join(dir, 'docs-site', p))), p)
  })

  test('a file written by hand before /hub:site stays as it is, and the output names it', () => {
    const mine = 'node_modules\n# mine\n'
    const dir = repo({ 'docs-site/.gitignore': mine })
    const r = placed(dir)
    assert.equal(r.code, 1, r.output)
    assert.match(JSON.stringify(r.json().errors), /docs-site\/\.gitignore/)
    assert.equal(readFileSync(join(dir, 'docs-site', '.gitignore'), 'utf8'), mine)
  })

  test('a title with a personal path: site.json is not placed and is dropped by a gate', () => {
    const dir = repo()
    const title = ['', 'Users', 'someone', 'service'].join('/')
    const r = placed(dir, { title })
    assert.equal(r.code, 1, r.output)
    assert.ok(!existsSync(join(dir, 'docs-site', 'site.json')))
    const entry = readPlan(dir).repos.service.files.find(f => f.path === 'docs-site/site.json')
    assert.equal(entry.action, 'dropped')
    assert.match(entry.reason, /^gate:/)
    assert.match(r.output, /docs-site\/site\.json/)
  })
})

describe('site --build (SIT-17)', () => {
  test('green: exit 0, the lockfile unchanged, the three folders recorded and hidden from git', () => {
    const dir = repo()
    assert.equal(placed(dir).code, 0)
    const r = build(dir)
    assert.equal(r.code, 0, r.output)
    assert.ok(readFileSync(join(TEMPLATE, 'package-lock.json')).equals(readFileSync(join(dir, 'docs-site', 'package-lock.json'))))
    assert.doesNotMatch(status(dir), /node_modules\/|\/build\/|\.docusaurus\//)
    assert.deepEqual(readPlaced(dir).build, BUILD)
  })

  test('a failed npm ci exits 2, neither checks nor builds, and the folders are already recorded', () => {
    const dir = repo()
    assert.equal(placed(dir).code, 0)
    const log = sb.path(`npm-${n}.log`)
    const r = build(dir, { FAKE_NPM_LOG: log, FAKE_NPM_FAIL: 'ci' })
    assert.equal(r.code, 2, r.output)
    assert.doesNotMatch(readFileSync(log, 'utf8'), /run --silent check:diagrams|run build/)
    assert.deepEqual(readPlaced(dir).build, BUILD)
  })

  test('a build cut off during npm ci still has node_modules recorded, and a discard removes it', () => {
    const dir = repo()
    assert.equal(placed(dir).code, 0)
    const r = build(dir, { FAKE_NPM_FAIL: 'kill' })
    assert.notEqual(r.code, 0)
    assert.ok(existsSync(join(dir, 'docs-site', 'node_modules')))
    assert.ok(readPlaced(dir).build.includes('docs-site/node_modules'))
    assert.equal(build(dir).code, 0, 'the retry')
    const f = finish(dir, 'none')
    assert.equal(f.code, 0, f.output)
    assert.ok(!existsSync(join(dir, 'docs-site')))
  })

  test('a folder that was there before the build is never recorded nor removed', () => {
    const dir = repo()
    assert.equal(placed(dir).code, 0)
    const own = sb.write(join(dir, 'docs-site', 'node_modules', 'own', 'note.txt'), 'mine\n')
    assert.equal(build(dir).code, 0)
    assert.deepEqual(readPlaced(dir).build, ['docs-site/.docusaurus', 'docs-site/build'])
    finish(dir, 'none')
    assert.ok(existsSync(own))
  })

  test('a broken diagram names the file and line, in the docs folder of site.json', () => {
    const dir = repo({ 'documentation/index.md': '# Docs\n' }, { drop: ['docs/index.md'] })
    assert.equal(placed(dir, { docs: 'documentation' }).code, 0)
    const r = build(dir, { FAKE_DIAGRAMS_OUTPUT: output('guides/run-locally.md:19: Parse error on line 2:\n1 mermaid error(s) in 1 file(s)\n') }, false)
    assert.equal(r.code, 1, r.output)
    assert.match(r.stderr, /documentation\/guides\/run-locally\.md: line 19: a broken mermaid diagram: Parse error on line 2:/)
  })

  test('every broken link and anchor, colored or not: links by file and line, anchors by page', () => {
    const page = '# Run locally\n\nSee [deploy](deploy) and [the variables](../reference/config.md#env-vars).\n'
    const dir = repo({ 'docs/guides/run-locally.md': page, 'docs/guides/index.md': '# Guides\n\nSee [ops](/ops/runbook).\n', 'docs/reference/config.md': '# Config\n' })
    assert.equal(placed(dir).code, 0)
    const red = line => `\x1b[31m${line}\x1b[39m\n`
    const text = [
      red('  - Broken link on source page path = /guides/:'),
      red('     -> linking to /ops/runbook'),
      red('  - Broken link on source page path = /guides/run-locally:'),
      red('     -> linking to deploy (resolved as: /guides/deploy)'),
      red('     -> linking to /elsewhere'),
      '  - Broken anchor on source page path = /guides/run-locally:\n',
      '     -> linking to /reference/config#env-vars\n',
      '     -> linking to /reference/config#limits\n',
      'Cause: Markdown link with URL \x1b[36m`deploy.md`\x1b[39m in source file \x1b[36m"../docs/guides/run-locally.md"\x1b[39m (\x1b[33m16\x1b[39m:\x1b[33m5\x1b[39m) couldn\'t be resolved.\n',
    ].join('')
    const r = build(dir, { FAKE_BUILD_OUTPUT: output(text) }, false)
    assert.equal(r.code, 1, r.output)
    for (const expected of [
      /docs\/guides\/index\.md: line 3: the page \/guides\/ has a broken link: \/ops\/runbook/,
      /docs\/guides\/run-locally\.md: line 3: the page \/guides\/run-locally has a broken link: deploy \(resolved as \/guides\/deploy\)/,
      /docs\/guides\/run-locally\.md: the page \/guides\/run-locally has a broken link: \/elsewhere/,
      /docs\/guides\/run-locally\.md: line 3: the page \/guides\/run-locally has a broken anchor: \/reference\/config#env-vars/,
      /docs\/guides\/run-locally\.md: the page \/guides\/run-locally has a broken anchor: \/reference\/config#limits/,
      /docs\/guides\/run-locally\.md: line 16: the link deploy\.md cannot be resolved/,
    ]) assert.match(r.stderr, expected)
  })

  test('output the parser does not know still fails the build and shows its end', () => {
    const dir = repo()
    assert.equal(placed(dir).code, 0)
    const r = build(dir, { FAKE_BUILD_OUTPUT: output('Something unexpected happened in the bundler\n') }, false)
    assert.equal(r.code, 1, r.output)
    assert.match(r.stderr, /the build failed:[\s\S]*Something unexpected happened in the bundler/)
  })
})

describe('the lock of the site (SIT-18)', () => {
  test('a new lock: the site alone, its files matching the disk, documentedCommit at HEAD', () => {
    const dir = repo()
    assert.equal(placed(dir).code, 0)
    assert.equal(build(dir).code, 0)
    const r = finish(dir, 'all')
    assert.equal(r.code, 0, r.output)
    const lock = readLock(dir)
    assert.deepEqual(lock.settings, { docsDir: 'docs' })
    assert.deepEqual([...new Set(Object.values(lock.files).map(e => e.kind))], ['site'])
    assert.equal(lock.schema, 1)
    assert.match(lock.generator, /^hub@/)
    assert.equal(lock.documentedCommit, head(dir))
    const untracked = sb.git(dir, 'ls-files', '-o', '--exclude-standard', 'docs-site').split('\n').filter(Boolean).sort()
    assert.deepEqual(untracked, Object.keys(lock.files).sort())
    for (const [p, e] of Object.entries(lock.files)) {
      assert.equal(e.hash, sb.git(dir, 'hash-object', p).trim(), p)
      assert.deepEqual(e.sources, {})
    }
    // Keeping the site keeps the build output, hidden by its .gitignore.
    assert.deepEqual(builtLeft(dir), BUILD)

    // Drift sees an edited site file, and never an affected one.
    sb.write(join(dir, 'docs', 'index.md'), '# Service docs\n\nThe service, changed.\n')
    sb.commit(dir, 'change the docs')
    sb.write(join(dir, 'docs-site', 'src', 'css', 'custom.css'), ':root {}\n')
    const d = hub(dir, ['drift', '--repo', dir, '--json'])
    assert.equal(d.code, 0, d.output)
    const files = d.json().repos[0].files
    assert.equal(files.find(f => f.path === 'docs-site/src/css/custom.css').edited, true)
    assert.ok(files.every(f => !f.affected.length), JSON.stringify(files))
  })

  test("an init lock only gains the site's entries", () => {
    const init = {
      schema: 1,
      generator: 'hub@0.1.0',
      documentedCommit: '0'.repeat(40),
      settings: { docsDir: 'docs', language: 'en', scanAllow: ['Reviewed Name'] },
      files: { 'docs/index.md': { kind: 'page', type: 'overview', hash: 'f'.repeat(40), sources: { 'src/app.ts': 'e'.repeat(40) } } },
    }
    const dir = repo({ '.claude/hub.lock.json': JSON.stringify(init, null, 2) + '\n' })
    assert.equal(placed(dir).code, 0)
    assert.equal(finish(dir, 'all').code, 0)
    const lock = readLock(dir)
    const site = Object.keys(lock.files).filter(p => lock.files[p].kind === 'site')
    assert.deepEqual(site.sort(), walkFiles(join(dir, 'docs-site'), () => false).map(p => `docs-site/${p}`).sort())
    lock.files = Object.fromEntries(Object.entries(lock.files).filter(([, e]) => e.kind !== 'site'))
    assert.deepEqual(lock, init)
  })

  test('an unapproved site plan: finish exits 2 for the approval and writes no lock', () => {
    const dir = repo()
    assert.equal(hub(dir, ['site', '--repo', dir, '--into', 'docs-site']).code, 0)
    const r = finish(dir, 'all', false)
    assert.equal(r.code, 2, r.output)
    assert.match(r.stderr, /not approved/)
    assert.ok(!existsSync(join(dir, '.claude', 'hub.lock.json')))
  })
})

describe('closing (SIT-19, SIT-14)', () => {
  test('discarding after a build leaves no docs-site/, no lock and the same git status', () => {
    const dir = repo()
    const before = status(dir)
    assert.equal(placed(dir).code, 0)
    assert.equal(build(dir).code, 0)
    assert.deepEqual(builtLeft(dir), BUILD)
    const r = finish(dir, 'none')
    assert.equal(r.code, 0, r.output)
    assert.ok(!existsSync(join(dir, 'docs-site')))
    assert.ok(!existsSync(join(dir, '.claude', 'hub.lock.json')))
    assert.equal(status(dir), before)
    assert.deepEqual(r.json().removed.map(x => x.path).sort(), BUILD)
  })

  test('with a .gitignore written by hand, a discard still removes the build output and a keep removes what git would see', () => {
    const mine = 'node_modules\n# mine\n'
    for (const keep of ['none', 'all']) {
      const dir = repo({ 'docs-site/.gitignore': mine })
      assert.equal(placed(dir).code, 1)
      assert.equal(build(dir).code, 0)
      const r = finish(dir, keep)
      assert.equal(r.code, 0, r.output)
      assert.equal(readFileSync(join(dir, 'docs-site', '.gitignore'), 'utf8'), mine)
      assert.deepEqual(builtLeft(dir), keep === 'none' ? [] : ['docs-site/node_modules'])
      assert.deepEqual(r.json().unexpected, [])
    }
  })

  test('a placed.json with paths outside a build folder of the site removes nothing else', () => {
    const dir = repo()
    const outside = sb.write(join(dir, '..', 'outside', 'keep.txt'), 'mine\n')
    const own = sb.write(join(dir, 'src', 'keep.ts'), 'export {}\n')
    assert.equal(placed(dir).code, 0)
    const file = runFile(dir, 'placed.json')
    const p = JSON.parse(readFileSync(file, 'utf8'))
    p.repos.service.build = ['../outside', 'docs-site/../../outside', 'src', 'docs-site/../src', '/tmp', '..', '../outside/node_modules']
    sb.write(file, JSON.stringify(p))
    const r = finish(dir, 'none')
    assert.equal(r.code, 0, r.output)
    assert.ok(existsSync(outside) && existsSync(own))
  })

  test('after a finished init, with its lock and its pages not committed yet, the site run keeps all and finishes with 0', () => {
    const init = { schema: 1, generator: 'hub@0.1.0', documentedCommit: '0'.repeat(40), settings: { docsDir: 'docs', language: 'en', scanAllow: [] }, files: { 'docs/how-to/run-tests.md': { kind: 'page', type: 'how-to', hash: 'f'.repeat(40), sources: {} } } }
    const dir = repo({ '.gitignore': '.hub-run/\n' })
    sb.write(join(dir, '.claude', 'hub.lock.json'), JSON.stringify(init, null, 2) + '\n')
    sb.write(join(dir, 'docs', 'how-to', 'run-tests.md'), '# Run the tests\n\nRun them.\n')
    sb.write(runFile(dir, 'done.json'), '{}\n')
    sb.write(runFile(dir, 'placed.json'), '{}\n')
    assert.equal(placed(dir).code, 0)
    const r = finish(dir, 'all')
    assert.equal(r.code, 0, r.output)
    assert.deepEqual(r.json().unexpected, [])
    const lock = readLock(dir)
    assert.ok(lock.files['docs/how-to/run-tests.md'] && lock.files['docs-site/docusaurus.config.js'])
  })

  test('the finish report speaks of the docs site, not of skills', () => {
    const dir = repo()
    assert.equal(placed(dir).code, 0)
    const r = finish(dir, 'all', false)
    assert.equal(r.code, 0, r.output)
    assert.match(r.stdout, /suggested message: Add the docs site/)
    assert.doesNotMatch(r.stdout, /skills are active/)
  })
})

test('without a hub site, check, place and finish never call npm (PUE-10)', () => {
  const log = sb.path('npm-init.log')
  const env = { FAKE_NPM_LOG: log }
  const run = approvedRun(sb, [s1()])
  const call = (cmd, ...args) => sb.hub([cmd, run.ctx.planFile, ...args], { cwd: run.ctx.root, env })
  assert.ok([0, 1].includes(call('check', '--round', '1').code))
  assert.equal(call('place').code, 0)
  assert.equal(call('finish', '--keep', 'all').code, 0)
  assert.ok(!existsSync(log), existsSync(log) ? readFileSync(log, 'utf8') : '')
})
