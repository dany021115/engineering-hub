import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { sandbox } from './helper.mjs'
import { check, errorsOf, frontmatter, messages, overlayText, pageText, propose, stage, writeSkill } from './gate-fixture.mjs'
import { overlay, page, prepare } from './plan-fixture.mjs'

const sb = sandbox()
after(() => sb.cleanup())

const blob = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex')
const GATE_REASON = /^gate:(skills|docs|scan|grounding|validate|facts)$/
const entry = (ctx, id, repo = 'service') => ctx.readPlan().repos[repo].files.find(f => f.id === id)
const REF = ['docs/reference/configuration.md', 'reference', 'reads-env-vars']
const cleanRef = pageText('Configuration', [['## Settings', 'The service reads `DB_URL` in `src/config.ts`.']])

describe('exit codes (PUE-1)', () => {
  test('a broken skill exits 1, a long description 0 with a warning, a missing plan 2, no git 2', () => {
    const broken = sb.path('exits', 'broken')
    writeSkill(sb, broken, 'name-mismatch', frontmatter('other-name', 'Name differs. Use when probing.') + '\nBody.\n')
    const valid = sb.path('exits', 'valid')
    writeSkill(sb, valid, 'long-ok', frontmatter('long-ok', `Probe. ${'x'.repeat(593)}`) + '\nBody.\n')
    for (const json of [[], ['--json']]) {
      assert.equal(sb.hub(['check', '--skills', broken, ...json]).code, 1)
      const ok = sb.hub(['check', '--skills', valid, ...json])
      assert.equal(ok.code, 0)
      assert.match(ok.output, /over 500/)
      assert.equal(sb.hub(['check', sb.path('exits', '.hub-run', 'plan.json'), '--round', '1', ...json]).code, 2)
    }
    const noGit = sandbox({ withGit: false })
    try {
      writeSkill(noGit, noGit.path('valid'), 'long-ok', frontmatter('long-ok', 'Probe. Use when probing.') + '\nBody.\n')
      for (const json of [[], ['--json']]) assert.equal(noGit.hub(['check', '--skills', noGit.path('valid'), ...json]).code, 2)
    } finally {
      noGit.cleanup()
    }
  })
})

describe('confinement in check (PUE-8)', () => {
  test('a file written outside the plan fails, an earlier change does not, and nothing is deleted', () => {
    const ctx = prepare(sb, { before: w => sb.write(join(w.service, 'src', 'app.ts'), 'export const changed = 1\n') })
    ctx.plan({ service: { files: [page('p1', ...REF)] } })
    stage(sb, ctx, REF[0], cleanRef)
    assert.equal(check(sb, ctx).code, 0)
    sb.write(join(ctx.service, 'notes.md'), 'Notes.\n')
    const r = check(sb, ctx)
    assert.equal(r.code, 1)
    const all = messages(r).join('\n')
    assert.match(all, /files changed outside the plan: notes\.md/)
    assert.doesNotMatch(all, /src\/app\.ts/)
    assert.ok(existsSync(join(ctx.service, 'notes.md')))
  })

  const noUntracked = sb.write(sb.path('git-config-no-untracked'), '[status]\n\tshowUntrackedFiles = no\n')
  for (const [label, env] of [
    ['isolated config', {}],
    ['status.showUntrackedFiles=no', { GIT_CONFIG_GLOBAL: noUntracked }],
  ]) {
    test(`the full snapshot catches new folders, old untracked folders and the workspace root (${label})`, () => {
      const cases = {
        'service/scratch/new.txt': ctx => join(ctx.service, 'scratch', 'new.txt'),
        'notes.md': ctx => join(ctx.w, 'notes.md'),
        'service/docs/how-to/notes.md': ctx => join(ctx.service, 'docs', 'how-to', 'notes.md'),
      }
      for (const [name, where] of Object.entries(cases)) {
        const ctx = prepare(sb, { workspace: true, env, before: w => sb.write(join(w.service, 'scratch', 'old.txt'), 'old\n') })
        const p1 = page('p1', 'docs/how-to/run-tests.md', 'how-to', 'tests-need-setup')
        ctx.plan({ service: { files: [p1] } }, { workspace: { home: 'service', repos: ['service'] } })
        stage(sb, ctx, p1.path, '# Run the tests\n\nHow to run them.\n')
        const file = sb.write(where(ctx), 'stray\n')
        const r = check(sb, ctx, 1, env)
        assert.equal(r.code, 1, name)
        const conf = errorsOf(r).filter(e => e.gate === 'confinement').map(e => e.message).join('\n')
        assert.ok(conf.includes(name.replace(/^service\//, '')), `${name}: ${conf}`)
        assert.doesNotMatch(conf, /old\.txt/)
        assert.ok(existsSync(file))
      }
    })
  }
})

describe('plugin validate (PUE-9)', () => {
  test('without claude on the PATH check warns and the own lint catches c11', () => {
    const ctx = prepare(sb)
    ctx.plan({ service: { files: [overlay()] } })
    stage(sb, ctx, overlay().path, overlayText().replace('description: Working', 'description: "Working'))
    let r = check(sb, ctx)
    assert.equal(r.code, 1)
    assert.match(JSON.stringify(r.json().warnings), /plugin validate did not run/)
    assert.match(messages(r).join('\n'), /does not parse/)
    stage(sb, ctx, overlay().path, overlayText())
    r = check(sb, ctx)
    assert.equal(r.code, 0, r.output)
    assert.match(JSON.stringify(r.json().warnings), /plugin validate did not run/)
  })
})

describe('rounds and dropped (PUE-11, GEN-17)', () => {
  test('a file that never converges is dropped in round 2 only', () => {
    const ctx = prepare(sb)
    const p1 = page('p1', ...REF)
    const p2 = page('p2', 'docs/how-to/run-tests.md', 'how-to', 'tests-need-setup')
    ctx.plan({ service: { files: [p1, p2] } }, { approved: true })
    stage(sb, ctx, p1.path, cleanRef + '\n## Limits\n')
    stage(
      sb,
      ctx,
      p2.path,
      pageText('Run the tests', [
        ['## Before you begin', 'Install the packages.'],
        ['## Steps', '1. Run the suite.'],
        ['## Verify', 'The suite passes.'],
      ]),
    )
    assert.equal(check(sb, ctx, 1).code, 1)
    assert.equal(entry(ctx, 'p1').action, 'create')
    assert.equal(entry(ctx, 'p1').reason, undefined)
    const r = check(sb, ctx, 2)
    assert.equal(r.code, 1)
    assert.equal(entry(ctx, 'p1').action, 'dropped')
    assert.match(entry(ctx, 'p1').reason, GATE_REASON)
    assert.equal(entry(ctx, 'p1').reason, 'gate:docs')
    assert.equal(entry(ctx, 'p2').action, 'create')
  })

  for (const mode of ['refresh', 'init']) {
    test(`a proposal over an edited lock page goes through the rounds (${mode})`, () => {
      const original = '# Configuration\n\nThe service reads `DB_URL`.\n'
      const edited = '# Configuration\n\nThe service reads `DB_URL` from the environment.\n'
      const lock = {
        schema: 1,
        generator: 'hub@0.1.0',
        documentedCommit: '0'.repeat(40),
        settings: { language: 'en', docsDir: 'docs', scanAllow: [] },
        files: { [REF[0]]: { kind: 'page', type: 'reference', hash: blob(original), sources: {} } },
      }
      const ctx = prepare(sb, { extra: { service: { [REF[0]]: edited, '.claude/hub.lock.json': JSON.stringify(lock, null, 2) + '\n' } } })
      ctx.plan({ service: { files: [{ id: 'p1', path: REF[0], action: 'propose', why: 'edited by hand' }] } }, { mode, approved: true })
      propose(sb, ctx, 'p1', edited + '\n## Limits\n')
      const r1 = check(sb, ctx, 1)
      assert.equal(r1.code, 1)
      assert.ok(errorsOf(r1).some(e => e.path === REF[0] && e.gate === 'docs'), r1.output)
      assert.doesNotMatch(r1.output, /p1\.proposed/)
      const plain = sb.hub(['check', ctx.planFile, '--round', '1'], { cwd: ctx.root })
      assert.match(plain.stderr, /docs\/reference\/configuration\.md/)
      assert.doesNotMatch(plain.stderr, /p1\.proposed/)
      check(sb, ctx, 2)
      assert.equal(`${entry(ctx, 'p1').action} ${entry(ctx, 'p1').reason}`, 'dropped gate:docs')
      for (const f of ctx.readPlan().repos.service.files.filter(f => f.action === 'dropped')) {
        if (f.reason.startsWith('gate:')) assert.match(f.reason, GATE_REASON)
      }
    })
  }
})

describe("the writer's facts (CON-6)", () => {
  const ctx = prepare(sb)
  sb.write(join(ctx.root, '.hub-run', 'verdicts.jsonl'), JSON.stringify({ id: 'F2', verdict: 'contradicted', claim: 'x', evidence: [{ path: 'src/config.ts', quote: 'no such quote at all' }] }) + '\n')
  sb.hub(['verdicts', '--repo', 'service', '--in', join(ctx.root, '.hub-run', 'verdicts.jsonl')], { cwd: ctx.root })
  ctx.appendChecked('service', { type: 'fact', id: 'Q1', kind: 'human', claim: 'Does it deploy?', answer: 'yes', role: 'maintainer' })
  const run = facts => {
    ctx.plan({ service: { files: [overlay(facts)] } })
    stage(sb, ctx, overlay().path, overlayText())
    return check(sb, ctx)
  }
  test('one fact is below minFacts', () => {
    const r = run(['F1'])
    assert.equal(r.code, 1)
    assert.match(messages(r).join('\n'), /working-in-service\/SKILL\.md: 1 supported facts, below minFacts 2/)
  })
  test('a contradicted fact is named', () => {
    const r = run(['F1', 'F5', 'F2'])
    assert.equal(r.code, 1)
    assert.match(messages(r).join('\n'), /fact F2 is not a supported fact/)
  })
  test('a human fact is valid but never counts', () => {
    assert.equal(run(['F1', 'F5', 'Q1']).code, 0)
    const r = run(['F1', 'Q1'])
    assert.equal(r.code, 1)
    assert.match(messages(r).join('\n'), /minFacts 2/)
    assert.equal(ctx.run().code, 1)
    assert.match(ctx.run().output, /minFacts/)
  })
})

describe('Vale (PUE-12)', () => {
  const vsb = sandbox()
  after(() => vsb.cleanup())
  const log = vsb.path('vale.log')
  const run = (extra, { withVale }) => {
    const ctx = prepare(vsb, { extra: { service: extra } })
    ctx.plan({ service: { files: [page('p1', ...REF)] } })
    stage(vsb, ctx, REF[0], cleanRef)
    if (withVale) {
      vsb.fake(
        'vale',
        `require('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n')
console.log('stdin.md:3:5:Vale.Spelling:Did you really mean "sevice"?'); process.exit(1)`,
      )
    }
    const r = check(vsb, ctx)
    return r
  }
  test('configured Vale blocks; without config it never runs; configured and missing it warns', () => {
    let r = run({ '.vale.ini': 'StylesPath = styles\nMinAlertLevel = error\n' }, { withVale: true })
    assert.equal(r.code, 1, r.output)
    assert.match(messages(r).join('\n'), /Vale: .*sevice/)
    const calls = readFileSync(log, 'utf8').trim().split('\n').length
    r = run({}, { withVale: true })
    assert.equal(r.code, 0, r.output)
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, calls)
    vsb.cleanup()
  })

  test('configured and not installed: a warning', () => {
    const plain = sandbox()
    try {
      const ctx = prepare(plain, { extra: { service: { '.vale.ini': 'MinAlertLevel = error\n' } } })
      ctx.plan({ service: { files: [page('p1', ...REF)] } })
      stage(plain, ctx, REF[0], cleanRef)
      const r = check(plain, ctx)
      assert.equal(r.code, 0, r.output)
      assert.match(JSON.stringify(r.json().warnings), /Vale is configured .* but not installed/)
    } finally {
      plain.cleanup()
    }
  })
})
