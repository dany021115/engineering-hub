import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { after, describe, test } from 'node:test'
import { PLUGIN, makeWorkspace, sandbox } from './helper.mjs'

const sb = sandbox()
after(() => sb.cleanup())
let n = 0
const fresh = opts => makeWorkspace(sb, { at: sb.path(`w${++n}`, 'w'), ...opts })
const run = (dir, ...p) => join(dir, '.hub-run', ...p)
const allRepos = w => ['--repo', w.service, '--repo', w.web, '--repo', w.infra]

function snapshot(dir) {
  const out = {}
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[relative(dir, p)] = readFileSync(p, 'utf8')
    }
  }
  walk(dir)
  return out
}

describe('start --repo prepares .hub-run (GEN-6)', () => {
  test('the repo stays intact; catalog copy, .gitignore, env.json and the status photo', () => {
    const w = fresh()
    const r = sb.hub(['start', '--repo', w.service], { cwd: w.service })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(sb.git(w.service, 'status', '--porcelain'), '')
    assert.deepEqual(
      readFileSync(run(w.service, 'generator', 'catalog.json')),
      readFileSync(join(PLUGIN, 'generator', 'catalog.json')),
    )
    assert.equal(readFileSync(run(w.service, '.gitignore'), 'utf8'), '*\n')
    assert.ok(existsSync(run(w.service, 'env.json')))
    const photo = sb.git(w.service, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
    assert.equal(readFileSync(run(w.service, 'status', 'service.txt'), 'utf8'), photo)
  })

  test('the estimate per repo and in total comes before any plan', () => {
    const w = fresh()
    const out = sb.hub(['start', ...allRepos(w), '--json'], { cwd: w.w }).json()
    assert.deepEqual(Object.keys(out.estimate.perRepo).sort(), ['infra', 'service', 'web'])
    const sum = Object.values(out.estimate.perRepo).reduce((a, b) => a + b, 0) + out.estimate.workspace
    assert.equal(out.estimate.total, sum)
    assert.equal(out.estimate.confirm, out.estimate.total > 12)
    assert.equal(existsSync(run(w.w, 'plan.json')), false)
    // The plan's generator comes from start: the session never reads the plugin's folder.
    const { version } = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'))
    assert.equal(out.generator, `hub@${version}`)
    // A resumed run gets it from the plain `start` too.
    assert.equal(sb.hub(['start', '--json'], { cwd: w.w }).json().generator, `hub@${version}`)
  })

  test('default home: most Markdown in the docs folder, with and without --repo, and in one repo', () => {
    const w = fresh({
      extra: {
        service: { 'docs/a.md': '# A\n', 'docs/b.md': '# B\n', 'docs/c.md': '# C\n' },
        web: { 'docs/a.md': '# A\n', 'notes/1.md': '1', 'notes/2.md': '2', 'notes/3.md': '3', 'notes/4.md': '4' },
      },
    })
    assert.equal(sb.hub(['start', '--json'], { cwd: w.w }).json().home, 'service')
    assert.equal(sb.hub(['start', ...allRepos(w), '--json'], { cwd: w.w }).json().home, 'service')
    assert.equal(sb.hub(['start', '--json'], { cwd: w.web }).json().home, 'web')
  })

  test('default home tie-break: alphabetical, and the first repo when none has docs', () => {
    const w = fresh({
      extra: { service: { 'docs/a.md': '# A\n', 'docs/b.md': '# B\n' }, web: { 'docs/a.md': '# A\n', 'docs/b.md': '# B\n' } },
    })
    const bare = fresh()
    for (const [ws, home] of [
      [w, 'service'],
      [bare, 'infra'],
    ]) {
      assert.equal(sb.hub(['start', '--json'], { cwd: ws.w }).json().home, home)
      assert.equal(sb.hub(['start', ...allRepos(ws), '--json'], { cwd: ws.w }).json().home, home)
    }
  })

  test('the full photo names every untracked file and the workspace root listing skips repos', () => {
    const w = fresh()
    sb.write(join(w.service, 'tmp', 'a.txt'), 'scratch\n')
    sb.write(join(w.w, 'notes.md'), '# Notes\n')
    sb.write(join(w.w, 'node_modules', 'x.js'), 'x\n')
    const cfg = sb.write(sb.path(`gitconfig-${n}`), '[status]\n\tshowUntrackedFiles = no\n')
    const r = sb.hub(['start', ...allRepos(w)], { cwd: w.w, env: { GIT_CONFIG_GLOBAL: cfg } })
    assert.equal(r.code, 0, r.stderr)
    const lines = readFileSync(run(w.w, 'status', 'service.txt'), 'utf8').split('\0')
    assert.ok(lines.includes('?? tmp/a.txt'))
    assert.equal(lines.includes('?? tmp/'), false)
    const root = readFileSync(run(w.w, 'status', '.root.txt'), 'utf8').trim().split('\n')
    assert.equal(root.length, 1)
    const [size, time, path] = root[0].split('\t')
    assert.equal(path, 'notes.md')
    assert.equal(Number(size), statSync(join(w.w, 'notes.md')).size)
    assert.ok(!Number.isNaN(Date.parse(time)))
  })
})

describe('start --repo and earlier runs (GEN-5)', () => {
  const seed = (w, files) => {
    for (const [p, c] of Object.entries({ '.gitignore': '*\n', ...files })) sb.write(run(w.service, p), c)
  }

  test('a finished run is removed and a new one prepared', () => {
    const w = fresh()
    seed(w, { 'plan.json': '{}', 'placed.json': '{}', 'done.json': '{}' })
    const r = sb.hub(['start', '--repo', w.service, '--json'], { cwd: w.service })
    assert.equal(r.code, 0, r.stderr)
    for (const f of ['done.json', 'placed.json', 'plan.json']) assert.equal(existsSync(run(w.service, f)), false)
    assert.ok(existsSync(run(w.service, 'env.json')))
    assert.ok(existsSync(run(w.service, 'status', 'service.txt')))
  })

  test('a run without facts, plan or placed counts as empty and is rewritten', () => {
    const w = fresh()
    seed(w, { 'env.json': '{"stale":true}', 'inventory/service.json': '{}', 'status/service.txt': '' })
    assert.equal(sb.hub(['start', '--json'], { cwd: w.service }).json().resume, null)
    const r = sb.hub(['start', '--repo', w.service, '--json'], { cwd: w.service })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(JSON.parse(readFileSync(run(w.service, 'env.json'), 'utf8')).stale, undefined)
    assert.ok(existsSync(run(w.service, 'status', 'service.txt')))
  })

  test('an unfinished run makes start --repo exit 2 and leaves .hub-run untouched', () => {
    for (const files of [{ 'facts/service.jsonl': '' }, { 'plan.json': '{}' }, { 'placed.json': '{}' }]) {
      const w = fresh()
      seed(w, files)
      const before = snapshot(run(w.service))
      const r = sb.hub(['start', '--repo', w.service], { cwd: w.service })
      assert.equal(r.code, 2)
      assert.deepEqual(snapshot(run(w.service)), before)
    }
  })
})

describe('env.json records claude and the engineering-hub source (GEN-19)', () => {
  test('with a fake claude listing a github source, env.json keeps that entry', () => {
    const s2 = sandbox()
    try {
      const entry = {
        name: 'engineering-hub',
        source: 'github',
        repo: 'example-org/engineering-hub',
        installLocation: 'marketplaces/engineering-hub',
      }
      s2.fakeClaude([{ name: 'other', source: 'directory', path: 'x' }, entry])
      const w = makeWorkspace(s2)
      assert.equal(s2.hub(['start', '--repo', w.service], { cwd: w.service }).code, 0)
      const env = JSON.parse(readFileSync(run(w.service, 'env.json'), 'utf8'))
      assert.equal(env.claude, true)
      assert.deepEqual(env.marketplace, entry)
      assert.equal(env.gitSource, true)
    } finally {
      s2.cleanup()
    }
  })

  test('without claude on the PATH, env.json says so', () => {
    const w = fresh()
    sb.hub(['start', '--repo', w.service], { cwd: w.service })
    const env = JSON.parse(readFileSync(run(w.service, 'env.json'), 'utf8'))
    assert.deepEqual(env, { claude: false, marketplace: null, gitSource: false })
  })
})
