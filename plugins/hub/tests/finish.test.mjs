import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { serializeLock, sortKeys } from '../scripts/lib/lock.mjs'
import { sandbox } from './helper.mjs'
import { propose, stage } from './gate-fixture.mjs'
import { SERVICE_FACTS, page, prepare } from './plan-fixture.mjs'
import { CONFIG, RELEASE, RUN_TESTS, approvedRun, blob, configText, lockedExtra, p1, p2, releaseText, runTestsText, s1, x1 } from './run-fixture.mjs'

const sb = sandbox()
after(() => sb.cleanup())

const SKILL = s1().path
const readLockOf = dir => JSON.parse(readFileSync(join(dir, '.claude', 'hub.lock.json'), 'utf8'))
const lockExists = dir => existsSync(join(dir, '.claude', 'hub.lock.json'))
const done = run => existsSync(join(run.ctx.root, '.hub-run', 'done.json'))
const absence = (id, pathspec) => ({ type: 'fact', id, kind: 'negative', claim: 'No job runs the end-to-end suite.', evidence: [{ absence: 'npm run e2e', pathspec }] })

describe('the lock (GEN-22)', () => {
  test('ids and format: hashes, blob and tree sources, sorted keys', () => {
    const run = approvedRun(sb, [s1(), p1({ facts: ['F2', 'F7'] })], { prepareOptions: { facts: [...SERVICE_FACTS, absence('F7', 'deploy/')] } })
    assert.equal(run.place().code, 0)
    const r = run.finish('--keep', 'all')
    assert.equal(r.code, 0, r.output)
    const dir = run.ctx.service
    const text = readFileSync(join(dir, '.claude', 'hub.lock.json'), 'utf8')
    const lock = JSON.parse(text)
    for (const [p, e] of Object.entries(lock.files)) assert.equal(e.hash, run.hash(p))
    assert.deepEqual(lock.files[CONFIG].sources, {
      'src/config.ts': sb.git(dir, 'rev-parse', 'HEAD:src/config.ts').trim(),
      'deploy/': sb.git(dir, 'rev-parse', 'HEAD:deploy').trim(),
    })
    assert.match(lock.documentedCommit, /^[0-9a-f]{40}$/)
    assert.equal(serializeLock(sortKeys(lock)), text)
    assert.equal(lock.files[SKILL].archetype, 'working-in')
  })

  test('sources come from the facts; an absence gives its folder; a human fact nothing', () => {
    for (const withMore of [false, true]) {
      const facts = withMore ? ['F1', 'F7', 'Q1'] : ['F1']
      const run = approvedRun(sb, [p1({ facts })], { prepareOptions: { facts: [...SERVICE_FACTS, absence('F7', '.github/workflows/')] } })
      run.ctx.appendChecked('service', { type: 'fact', id: 'Q1', kind: 'human', claim: 'Asked.', answer: 'yes', role: 'maintainer' })
      assert.equal(run.place().code, 0)
      assert.equal(run.finish('--keep', 'all').code, 0)
      const dir = run.ctx.service
      const expected = { '.github/workflows/ci.yml': sb.git(dir, 'rev-parse', 'HEAD:.github/workflows/ci.yml').trim() }
      if (withMore) expected['.github/workflows/'] = sb.git(dir, 'rev-parse', 'HEAD:.github/workflows').trim()
      assert.deepEqual(readLockOf(dir).files[CONFIG].sources, expected)
    }
  })

  test('scanAllow stays as the person left it', () => {
    const run = approvedRun(sb, [s1()], { extra: lockedExtra() })
    assert.equal(run.place().code, 0)
    assert.equal(run.finish('--keep', 'all').code, 0)
    assert.deepEqual(readLockOf(run.ctx.service).settings.scanAllow, ['Reviewed Name'])
  })

  test('in a workspace only the docs home has workspace; members point at it', () => {
    const ctx = prepare(sb, { workspace: true })
    const web = page('w1', CONFIG, 'reference', 'reads-env-vars', [])
    ctx.plan(
      { service: { files: [p1()] }, web: { files: [web] } },
      { workspace: { home: 'service', repos: ['service', 'web'] }, approved: true },
    )
    stage(sb, ctx, CONFIG, configText)
    stage(sb, ctx, CONFIG, '# Configuration\n\nThe client reads `API_BASE` in `src/client.ts`.\n', 'web')
    const hub = (...a) => sb.hub([...a, '--json'], { cwd: ctx.root })
    assert.equal(hub('place', ctx.planFile).code, 0)
    const r = hub('finish', ctx.planFile, '--keep', 'all')
    assert.equal(r.code, 0, r.output)
    const home = readLockOf(ctx.service)
    const member = readLockOf(ctx.web)
    assert.deepEqual(home.workspace, { repos: ['service', 'web'] })
    assert.equal(home.settings.docsHome, undefined)
    assert.equal(member.workspace, undefined)
    assert.equal(member.settings.docsHome, 'service')
    for (const d of [ctx.service, ctx.web]) assert.ok(!existsSync(join(d, '.claude', 'workspace.json')))
  })
})

describe('keep, discard and what changed since place (GEN-20, GEN-21)', () => {
  test('keep without some: the rest is undone and stays out of the lock', () => {
    const run = approvedRun(sb, [s1(), p1()])
    assert.equal(run.place().code, 0)
    const r = run.finish('--keep', 's1')
    assert.equal(r.code, 0, r.output)
    assert.ok(existsSync(join(run.ctx.service, SKILL)))
    assert.ok(!existsSync(join(run.ctx.service, CONFIG)))
    assert.deepEqual(Object.keys(readLockOf(run.ctx.service).files), [SKILL])
  })

  test('discarding with an edit: the edit stays, no lock, HEAD unmoved, done.json written', () => {
    const run = approvedRun(sb, [s1(), p1()])
    assert.equal(run.place().code, 0)
    sb.write(join(run.ctx.service, CONFIG), configText + '\nMy own note.\n')
    const r = run.finish('--keep', 'none')
    assert.equal(r.code, 0, r.output)
    assert.ok(!existsSync(join(run.ctx.service, SKILL)))
    assert.equal(run.read(CONFIG), configText + '\nMy own note.\n')
    assert.match(r.stdout, /changed/)
    assert.deepEqual(r.json().changed.map(c => c.path), [CONFIG])
    assert.ok(!lockExists(run.ctx.service))
    assert.equal(sb.git(run.ctx.service, 'rev-parse', 'HEAD').trim(), run.ctx.readPlan().repos.service.head)
    assert.ok(done(run))
  })

  test('discarding an update and a delete restores both; an edited update stays', () => {
    for (const edit of [false, true]) {
      const u1 = { ...p1(), id: 'u1', action: 'update' }
      const d1 = { id: 'd1', path: RELEASE, action: 'delete', kind: 'page', why: 'gone' }
      const run = approvedRun(sb, [u1, d1], { extra: lockedExtra(), texts: { [CONFIG]: '# Configuration\n\nThe service reads `DB_URL` only.\n' } })
      assert.equal(run.place().code, 0)
      if (edit) sb.write(join(run.ctx.service, CONFIG), 'Edited by hand.\n')
      const r = run.finish('--keep', 'none')
      assert.equal(r.code, 0, r.output)
      assert.equal(run.hash(RELEASE), blob(releaseText))
      if (edit) {
        assert.equal(run.read(CONFIG), 'Edited by hand.\n')
        assert.ok(r.json().changed.some(c => c.id === 'u1'))
      } else assert.equal(run.hash(CONFIG), blob(configText))
    }
  })

  test('a target changed since place is not applied and is not unexpected (GEN-21)', () => {
    const run = approvedRun(sb, [s1(), x1()])
    assert.equal(run.place().code, 0)
    sb.write(join(run.ctx.service, 'CLAUDE.md'), run.read('CLAUDE.md') + 'A rule of mine.\n')
    const r = run.finish('--keep', 'all', '--apply', 'x1')
    assert.equal(r.code, 1, r.output)
    assert.deepEqual(r.json().notApplied.map(n => n.id), ['x1'])
    assert.deepEqual(r.json().unexpected, [])
    assert.ok(done(run))
    assert.ok(existsSync(join(run.ctx.root, '.hub-run', 'proposals', 'service', 'x1.proposed')))
  })

  test('a proposal over the lock dropped in the rounds keeps the old entry (GEN-25)', () => {
    const original = configText
    const edited = configText + '\nA paragraph of mine.\n'
    const lock = { schema: 1, generator: 'hub@0.1.0', documentedCommit: '0'.repeat(40), settings: { language: 'en', docsDir: 'docs', scanAllow: [] }, files: { [CONFIG]: { kind: 'page', type: 'reference', hash: blob(original), sources: {} } } }
    const run = approvedRun(sb, [s1(), { id: 'p1', path: CONFIG, action: 'propose', why: 'edited by hand' }], {
      extra: { [CONFIG]: edited, '.claude/hub.lock.json': JSON.stringify(lock, null, 2) + '\n' },
    })
    propose(sb, run.ctx, 'p1', edited + '\n## Limits\n')
    run.check(1)
    run.check(2)
    assert.equal(run.entry('p1').reason, 'gate:docs')
    assert.equal(run.place().code, 0)
    const r = run.finish('--keep', 'all')
    assert.equal(r.code, 0, r.output)
    assert.equal(run.read(CONFIG), edited)
    assert.equal(readLockOf(run.ctx.service).files[CONFIG].hash, blob(original))
    const d = sb.hub(['drift', '--repo', run.ctx.service, '--json'])
    assert.equal(d.code, 0, d.output)
    assert.equal(d.json().repos[0].files.find(f => f.path === CONFIG).edited, true)
  })
})

describe('refresh (GEN-25, GEN-26)', () => {
  const OLD = '0'.repeat(40)
  const u1 = () => ({ ...p1(), id: 'u1', action: 'update' })

  test('an affected file left untreated keeps documentedCommit; the treated one gets a new hash and sources', () => {
    const run = approvedRun(sb, [u1()], { mode: 'refresh', extra: lockedExtra({ stale: [CONFIG, RELEASE] }), texts: { [CONFIG]: '# Configuration\n\nThe service reads `DB_URL` only.\n' } })
    assert.equal(run.place().code, 0)
    const r = run.finish('--keep', 'all')
    assert.equal(r.code, 0, r.output)
    const lock = readLockOf(run.ctx.service)
    assert.equal(lock.documentedCommit, OLD)
    assert.equal(lock.files[CONFIG].hash, run.hash(CONFIG))
    assert.deepEqual(lock.files[CONFIG].sources, { 'src/config.ts': sb.git(run.ctx.service, 'rev-parse', 'HEAD:src/config.ts').trim() })
    assert.match(JSON.stringify(r.json().warnings), /affected and not updated/)
    assert.equal(r.json().message, 'Update the generated skills and docs')
  })

  test('with every affected file treated, documentedCommit moves to HEAD', () => {
    const run = approvedRun(sb, [u1()], { mode: 'refresh', extra: lockedExtra({ stale: [CONFIG] }), texts: { [CONFIG]: '# Configuration\n\nThe service reads `DB_URL` only.\n' } })
    assert.equal(run.place().code, 0)
    assert.equal(run.finish('--keep', 'all').code, 0)
    assert.equal(readLockOf(run.ctx.service).documentedCommit, run.ctx.readPlan().repos.service.head)
  })

  test('a confirmed disappearance leaves the lock and the file is never recreated', () => {
    for (const keep of ['all', 'none']) {
      const d1 = { id: 'd1', path: RELEASE, action: 'delete', kind: 'page', why: 'deleted by the person' }
      const run = approvedRun(sb, [d1], { mode: 'refresh', approved: false, extra: lockedExtra(), prepareOptions: { before: w => rmSync(join(w.service, RELEASE)) } })
      const approve = run.ctx.run('--approve')
      assert.equal(approve.code, 0, approve.output)
      assert.equal(run.place().code, 0, 'place')
      const r = run.finish('--keep', keep)
      assert.equal(r.code, 0, r.output)
      assert.ok(!existsSync(join(run.ctx.service, RELEASE)))
      assert.equal(RELEASE in readLockOf(run.ctx.service).files, keep === 'none')
    }
  })

  test('a proposal over an edited file: accepted it is tracked again, rejected it leaves the lock', () => {
    const edited = configText + '\nA paragraph of mine.\n'
    for (const accept of [true, false]) {
      const run = approvedRun(sb, [{ id: 'p1', path: CONFIG, action: 'propose', why: 'edited by hand' }], { mode: 'refresh', extra: { ...lockedExtra({ stale: [CONFIG] }), [CONFIG]: edited } })
      propose(sb, run.ctx, 'p1', edited + '\nThe service also reads `DB_URL` in tests.\n')
      assert.equal(run.place().code, 0)
      const r = run.finish('--keep', 'all', ...(accept ? ['--apply', 'p1'] : []))
      assert.equal(r.code, 0, r.output)
      const lock = readLockOf(run.ctx.service)
      if (accept) {
        assert.equal(lock.files[CONFIG].hash, run.hash(CONFIG))
        assert.deepEqual(lock.files[CONFIG].sources, { 'src/config.ts': sb.git(run.ctx.service, 'rev-parse', 'HEAD:src/config.ts').trim() })
      }
      else {
        assert.equal(run.read(CONFIG), edited)
        assert.ok(!(CONFIG in lock.files))
      }
      assert.equal(lock.documentedCommit, run.ctx.readPlan().repos.service.head)
    }
  })
})

describe('done.json, refusals and confinement (GEN-5, GEN-13, PUE-8)', () => {
  test('a finished run: place and finish exit 2, start offers nothing and start --repo starts over', () => {
    const run = approvedRun(sb, [s1()])
    assert.equal(run.place().code, 0)
    assert.equal(run.finish('--keep', 'all').code, 0)
    assert.ok(done(run))
    const before = run.statusZ()
    assert.equal(run.place().code, 2)
    assert.equal(run.finish('--keep', 'all').code, 2)
    assert.equal(run.statusZ(), before)
    const s = sb.hub(['start', '--json'], { cwd: run.ctx.root })
    assert.equal(s.json().resume, null)
    const again = sb.hub(['start', '--repo', run.ctx.service, '--json'], { cwd: run.ctx.root })
    assert.equal(again.code, 0, again.output)
    const hubRun = join(run.ctx.root, '.hub-run')
    for (const f of ['done.json', 'placed.json', 'plan.json']) assert.ok(!existsSync(join(hubRun, f)), f)
    assert.ok(existsSync(join(hubRun, 'env.json')) && existsSync(join(hubRun, 'status', 'service.txt')))
  })

  test('an unapproved plan: finish exits 2 before touching anything and writes no done.json', () => {
    const run = approvedRun(sb, [s1()], { approved: false })
    const r = run.finish('--keep', 'all')
    assert.equal(r.code, 2)
    assert.ok(!done(run))
    assert.equal(run.statusZ(), run.snapshot())
  })

  test('a stray file after place: finish exits 1, names it, keeps it, and still leaves the lock and done.json', () => {
    const run = approvedRun(sb, [s1()])
    assert.equal(run.place().code, 0)
    sb.write(join(run.ctx.service, 'stray.md'), 'Stray.\n')
    const r = run.finish('--keep', 'all')
    assert.equal(r.code, 1)
    assert.deepEqual(r.json().unexpected, ['service:stray.md'])
    assert.ok(existsSync(join(run.ctx.service, 'stray.md')))
    assert.ok(lockExists(run.ctx.service) && done(run))
    assert.equal(sb.hub(['start', '--json'], { cwd: run.ctx.root }).json().resume, null)
  })

  const noUntracked = sb.write(sb.path('git-config-no-untracked'), '[status]\n\tshowUntrackedFiles = no\n')
  for (const [label, env] of [
    ['isolated config', {}],
    ['status.showUntrackedFiles=no', { GIT_CONFIG_GLOBAL: noUntracked }],
  ]) {
    test(`the full snapshot in finish catches a new planned folder and the workspace root (${label})`, () => {
      for (const [name, where] of [
        ['service:docs/how-to/notes.md', ctx => join(ctx.service, 'docs', 'how-to', 'notes.md')],
        ['notes.md', ctx => join(ctx.w, 'notes.md')],
      ]) {
        const ctx = prepare(sb, { workspace: true, env })
        ctx.plan({ service: { files: [p2()] } }, { workspace: { home: 'service', repos: ['service'] }, approved: true })
        stage(sb, ctx, RUN_TESTS, runTestsText)
        const hub = (...a) => sb.hub([...a, '--json'], { cwd: ctx.root, env })
        assert.equal(hub('place', ctx.planFile).code, 0)
        const file = sb.write(where(ctx), 'stray\n')
        const r = hub('finish', ctx.planFile, '--keep', 'all')
        assert.equal(r.code, 1, r.output)
        assert.deepEqual(r.json().unexpected, [name])
        assert.ok(existsSync(file))
        assert.ok(existsSync(join(ctx.root, '.hub-run', 'done.json')))
      }
    })
  }
})

describe('the spot check in done.json (EVI-6)', () => {
  const sampled = run => {
    assert.equal(run.place().code, 0)
    const r = sb.hub(['sample', run.ctx.planFile, '--json'], { cwd: run.ctx.root })
    assert.equal(r.code, 0, r.output)
    return r.json().items
  }
  const doneOf = run => JSON.parse(readFileSync(join(run.ctx.root, '.hub-run', 'done.json'), 'utf8'))
  const finishText = (run, ...args) => sb.hub(['finish', run.ctx.planFile, ...args], { cwd: run.ctx.root })

  test('numbers', () => {
    const run = approvedRun(sb, [s1(), p1(), p2()])
    const items = sampled(run)
    assert.equal(items.length, 5)
    const r = finishText(run, '--keep', 'all', '--spot', '2,4')
    assert.equal(r.code, 0, r.output)
    const pick = n => ({ repo: items[n - 1].repo, path: items[n - 1].path, line: items[n - 1].line, text: items[n - 1].text })
    assert.deepEqual(doneOf(run).spot, { sampled: 5, answer: 'some', mismatched: [pick(2), pick(4)] })
    const where = [pick(2), pick(4)].map(m => `${m.repo} ${m.path}:${m.line}`).join(', ')
    assert.ok(r.stdout.includes(`spot check: 5 sampled, 2 did not match: ${where}\n`), r.output)
  })

  test('none and absent', () => {
    let run = approvedRun(sb, [s1(), p1()])
    const items = sampled(run)
    let r = finishText(run, '--keep', 'all', '--spot', 'none')
    assert.equal(r.code, 0, r.output)
    assert.deepEqual(doneOf(run).spot, { sampled: items.length, answer: 'none', mismatched: [] })
    assert.match(r.stdout, /^spot check: not checked$/m)
    run = approvedRun(sb, [s1(), p1()])
    sampled(run)
    r = run.finish('--keep', 'all')
    assert.equal(r.code, 0, r.output)
    assert.equal('spot' in doneOf(run), false)
    assert.equal('spot' in r.json(), false)
  })

  test('invalid', () => {
    const run = approvedRun(sb, [s1(), p1(), p2()])
    assert.equal(sampled(run).length, 5)
    const before = run.status()
    for (const value of ['9', 'two', '2,x', '']) {
      const r = run.finish('--keep', 'all', '--spot', value)
      assert.equal(r.code, 2, `${JSON.stringify(value)}: ${r.output}`)
      assert.equal(done(run), false)
      assert.equal(lockExists(run.ctx.service), false)
      assert.deepEqual(run.status(), before)
    }
    assert.match(run.finish('--keep', 'all', '--spot', '9').stderr, /there is no sentence 9 in the sample/)
  })
})
