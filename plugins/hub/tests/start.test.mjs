import assert from 'node:assert/strict'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { makeWorkspace, sandbox } from './helper.mjs'

const sb = sandbox()
after(() => sb.cleanup())
let n = 0
const fresh = opts => makeWorkspace(sb, { at: sb.path(`w${++n}`, 'w'), ...opts })

const plan = mode => JSON.stringify({ schema: 1, mode, repos: {}, approved: false })

describe('start without --repo (GEN-4)', () => {
  test('workspace: alphabetical candidates, repos without commits skipped, modified files named', () => {
    const w = fresh()
    sb.write(join(w.web, 'src/app.ts'), 'export const changed = true\n')
    sb.initRepo(join(w.w, '.cache'), { 'x.txt': 'x\n' })
    sb.initRepo(join(w.w, 'empty'), {}, { commit: false })
    mkdirSync(join(w.w, 'notes'))
    const r = sb.hub(['start', '--json'], { cwd: w.w })
    assert.equal(r.code, 0, r.stderr)
    const out = r.json()
    assert.equal(out.mode, 'workspace')
    assert.deepEqual(out.candidates, ['infra', 'service', 'web'])
    assert.deepEqual(out.skipped, [{ name: 'empty', reason: 'no commits' }])
    assert.ok(out.warnings.some(w => w.repo === 'web' && w.message.includes('src/app.ts')))
  })

  test('more than 30 repos: the first 30 and a warning about the 2 skipped', () => {
    const root = sb.path('many')
    for (let i = 1; i <= 32; i++) sb.initRepo(join(root, `r${String(i).padStart(2, '0')}`), { 'a.txt': `${i}\n` })
    const out = sb.hub(['start', '--json'], { cwd: root }).json()
    assert.equal(out.candidates.length, 30)
    assert.equal(out.candidates[0], 'r01')
    assert.equal(out.candidates.at(-1), 'r30')
    assert.ok(out.warnings.some(w => /2 skipped/.test(w.message)))
  })

  test('stop in a subfolder, naming the top level, without creating .hub-run', () => {
    const w = fresh()
    const r = sb.hub(['start'], { cwd: join(w.service, 'src') })
    assert.equal(r.code, 2)
    assert.ok(r.stderr.includes(w.service))
    assert.equal(existsSync(join(w.service, '.hub-run')), false)
  })

  test('stop without git on the PATH', () => {
    const w = fresh()
    const bin = sb.path('node-only')
    mkdirSync(bin)
    symlinkSync(process.execPath, join(bin, 'node'))
    const r = sb.hub(['start'], { cwd: w.service, env: { PATH: bin } })
    assert.equal(r.code, 2)
    assert.match(r.stderr, /git/)
    assert.equal(existsSync(join(w.service, '.hub-run')), false)
  })

  test('start --json is valid JSON and exits 0 (GEN-3)', () => {
    const w = fresh()
    const r = sb.hub(['start', '--json'], { cwd: w.service })
    assert.equal(r.code, 0)
    const out = r.json()
    assert.equal(out.mode, 'repo')
    assert.deepEqual(out.candidates, ['service'])
    assert.equal(out.home, 'service')
  })
})

describe('resume points and discard (GEN-5)', () => {
  const run = (w, files) => {
    for (const [p, c] of Object.entries({ '.gitignore': '*\n', ...files })) sb.write(join(w.service, '.hub-run', p), c)
  }

  test('facts, plan.json and placed.json resume from verification, P2 and P3', () => {
    const cases = [
      [{ 'facts/service.jsonl': '' }, 'verify'],
      [{ 'facts/service.jsonl': '', 'plan.json': plan('init') }, 'P2'],
      [{ 'plan.json': plan('init'), 'placed.json': '{}' }, 'P3'],
    ]
    for (const [files, resume] of cases) {
      const w = fresh()
      run(w, files)
      const out = sb.hub(['start', '--json'], { cwd: w.service }).json()
      assert.equal(out.resume, resume)
    }
  })

  test('no resume point without facts, plan or placed, nor after done.json', () => {
    for (const files of [
      { 'env.json': '{}', 'inventory/service.json': '{}', 'status/service.txt': '' },
      { 'plan.json': plan('init'), 'placed.json': '{}', 'done.json': '{}' },
    ]) {
      const w = fresh()
      run(w, files)
      const out = sb.hub(['start', '--json'], { cwd: w.service }).json()
      assert.equal(out.resume, null)
      assert.equal(out.discard, null)
    }
  })

  test('discard before place removes .hub-run and leaves git status alone', () => {
    const w = fresh()
    run(w, { 'plan.json': plan('init') })
    const before = sb.git(w.service, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
    const r = sb.hub(['start', '--discard'], { cwd: w.service })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(existsSync(join(w.service, '.hub-run')), false)
    assert.equal(sb.git(w.service, 'status', '--porcelain=v1', '-z', '--untracked-files=all'), before)
  })

  test('discard after place exits 2, keeps everything and names finish --keep none', () => {
    const w = fresh()
    run(w, { 'plan.json': plan('init'), 'placed.json': '{}' })
    const r = sb.hub(['start', '--discard'], { cwd: w.service })
    assert.equal(r.code, 2)
    assert.match(r.stderr, /finish --keep none/)
    assert.equal(existsSync(join(w.service, '.hub-run', 'placed.json')), true)
  })

  test('a half-done site plan is only offered for discard', () => {
    const w = fresh()
    run(w, { 'plan.json': plan('site') })
    const out = sb.hub(['start', '--json'], { cwd: w.service }).json()
    assert.equal(out.resume, null)
    assert.equal(out.discard, 'start --discard')
    assert.equal(out.sitePlan, true)
    assert.equal(sb.hub(['start', '--discard'], { cwd: w.service }).code, 0)
    assert.equal(existsSync(join(w.service, '.hub-run')), false)
  })
})
