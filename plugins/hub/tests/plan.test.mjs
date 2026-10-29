import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { sandbox } from './helper.mjs'
import { guardrail, overlay, page, prepare } from './plan-fixture.mjs'

const sb = sandbox()
after(() => sb.cleanup())

const checkedFacts = ctx =>
  readFileSync(join(ctx.root, '.hub-run', 'facts', 'service.checked.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(i => i.type === 'fact')

describe('plan schema and actions (GEN-12)', () => {
  test('a valid plan exits 0', () => {
    const ctx = prepare(sb)
    ctx.plan({ service: { files: [overlay(), page('p1', 'docs/reference/configuration.md', 'reference', 'reads-env-vars')] } })
    const r = ctx.run('--json')
    assert.equal(r.code, 0, r.stdout)
    assert.equal(r.json().ok, true)
  })

  test('a create on a path taken outside the lock and a reason outside the list exit 1 naming both', () => {
    const ctx = prepare(sb, { extra: { service: { 'docs/index.md': '# Service docs\n' } } })
    ctx.plan({
      service: {
        files: [overlay(), page('p1', 'docs/index.md', 'overview', 'always', ['F1'])],
        rejected: [{ idea: 'docs/how-to/run-locally.md', reason: 'too-long' }],
      },
    })
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, /docs\/index\.md/)
    assert.match(r.output, /too-long/)
  })

  test('re-init over an edited lock file: update exits 1, propose exits 0', () => {
    const path = 'docs/reference/configuration.md'
    const ctx = prepare(sb, { extra: { service: { [path]: '# Configuration\n\nEdited by hand.\n' } } })
    sb.write(
      join(ctx.service, '.claude', 'hub.lock.json'),
      JSON.stringify({
        schema: 1,
        generator: 'hub@0.1.0',
        documentedCommit: ctx.head('service'),
        settings: { language: 'en', docsDir: 'docs', scanAllow: [] },
        files: { [path]: { kind: 'page', type: 'reference', hash: '0'.repeat(40), sources: {} } },
      }),
    )
    const entry = action => ({ ...page('u1', path, 'reference', 'reads-env-vars'), action })
    ctx.plan({ service: { files: [overlay(), entry('update')] } })
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, /edited by hand/)
    ctx.plan({ service: { files: [overlay(), entry('propose')] } })
    assert.equal(ctx.run().code, 0)
  })

  test('one repo needs workspace: null', () => {
    const ctx = prepare(sb)
    ctx.plan({ service: { files: [overlay()] } }, { workspace: { home: 'service', repos: ['service'] } })
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, /workspace must be null/)
  })

  test("a refresh of one repository keeps the workspace its docs home's lock records", () => {
    const lock = { schema: 1, generator: 'hub@0.1.0', documentedCommit: '0'.repeat(40), settings: { language: 'en', docsDir: 'docs', scanAllow: [] }, workspace: { repos: ['service', 'web'] }, files: {} }
    const ctx = prepare(sb, { workspace: true, repos: ['service', 'web'], extra: { service: { '.claude/hub.lock.json': JSON.stringify(lock) + '\n' } } })
    const run = (workspace, mode = 'refresh') => {
      ctx.plan({ service: { files: [overlay()] } }, { mode, workspace })
      return ctx.run().output
    }
    assert.doesNotMatch(run({ home: 'service', repos: ['web', 'service'] }), /workspace must be null/)
    assert.match(run({ home: 'service', repos: ['service', 'infra'] }), /workspace must be null/)
    assert.match(run({ home: 'service' }), /workspace must be null/)
    assert.match(run({ home: 'service', repos: ['service', 'web'] }, 'init'), /workspace must be null/)
  })

  test('the language is a code, never a name', () => {
    const ctx = prepare(sb)
    for (const [language, code] of [['English', 1], ['en', 0], ['es', 0], ['pt-BR', 0]]) {
      ctx.plan({ service: { files: [overlay()] } }, { settings: { language } })
      const r = ctx.run()
      assert.equal(r.code, code, `${language}: ${r.output}`)
      if (code) assert.match(r.output, /settings\.language must be a language code/)
    }
  })

  test("a head other than the one in this run's inventory exits 1 naming it", () => {
    const ctx = prepare(sb)
    const body = ctx.plan({ service: { files: [overlay()] } })
    const inventory = JSON.parse(readFileSync(join(ctx.root, '.hub-run', 'inventory', 'service.json'), 'utf8')).head
    assert.equal(body.repos.service.head, inventory)
    body.repos.service.head = 'a'.repeat(40)
    sb.write(ctx.planFile, JSON.stringify(body))
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, new RegExp(`head must be ${inventory}`))
  })
})

describe('approval (GEN-13, CON-8)', () => {
  test('approve stores the answer as a human fact with its role and sets approved', () => {
    const ctx = prepare(sb)
    const g = guardrail({ answer: 'yes' })
    ctx.plan({ service: { files: [overlay(), ...g.files], questions: [g.question] } })
    const r = ctx.run('--approve')
    assert.equal(r.code, 0, r.output)
    assert.equal(ctx.readPlan().approved, true)
    const human = checkedFacts(ctx).find(f => f.id === 'Q1')
    assert.equal(human.kind, 'human')
    assert.equal(human.answer, 'yes')
    assert.equal(human.role, 'maintainer')
    assert.deepEqual(Object.keys(human).sort(), ['answer', 'claim', 'id', 'kind', 'role', 'type'])
  })

  test('a guardrail without "yes" passes validation, fails approval, and passes once removed', () => {
    for (const answer of [null, 'no']) {
      const ctx = prepare(sb)
      const g = guardrail({ answer })
      ctx.plan({ service: { files: [overlay(), ...g.files], questions: [g.question] } })
      assert.equal(ctx.run().code, 0)
      const r = ctx.run('--approve')
      assert.equal(r.code, 1)
      assert.match(r.output, /service-db-guardrails/)
      assert.match(r.output, /g1/)
      assert.equal(ctx.readPlan().approved, false)
      ctx.plan({ service: { files: [overlay()], questions: [g.question] } })
      assert.equal(ctx.run('--approve').code, 0)
      assert.equal(
        ctx.readPlan().repos.service.files.some(f => f.path.endsWith('guardrails/SKILL.md')),
        false,
      )
    }
  })
})

describe('verdicts reach the plan (GEN-11)', () => {
  function withVerdicts(verdicts) {
    const ctx = prepare(sb)
    const file = sb.write(
      join(ctx.root, '.hub-run', 'verdicts', 'service-1.jsonl'),
      verdicts.map(v => JSON.stringify(v) + '\n').join(''),
    )
    sb.hub(['verdicts', '--repo', 'service', '--in', file], { cwd: ctx.root })
    return ctx
  }
  const cfg = facts => page('p1', 'docs/reference/configuration.md', 'reference', 'reads-env-vars', facts)

  test('a checked correction: citing F2 exits 1, citing F2c exits 0', () => {
    const ctx = withVerdicts([
      {
        id: 'F2',
        verdict: 'contradicted',
        claim: 'The service reads DB_URL.',
        evidence: [{ path: 'src/config.ts', quote: 'process.env.DB_URL' }],
      },
    ])
    ctx.plan({ service: { files: [overlay(), cfg(['F2'])] } })
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, /F2 is not supported/)
    ctx.plan({ service: { files: [overlay(), cfg(['F2c'])] } })
    assert.equal(ctx.run().code, 0)
  })

  test('a made-up correction: citing F2 or F2c exits 1', () => {
    const ctx = withVerdicts([
      {
        id: 'F2',
        verdict: 'contradicted',
        claim: 'The service reads PORT_NUMBER.',
        evidence: [{ path: 'src/config.ts', quote: 'process.env.PORT_NUMBER' }],
      },
    ])
    for (const id of ['F2', 'F2c']) {
      ctx.plan({ service: { files: [overlay(), cfg([id])] } })
      assert.equal(ctx.run().code, 1)
    }
  })

  test('not-found: citing F3 exits 1 and names F3', () => {
    const ctx = withVerdicts([{ id: 'F3', verdict: 'not-found' }])
    ctx.plan({ service: { files: [overlay(['F1', 'F3'])] } })
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, /F3/)
  })
})
