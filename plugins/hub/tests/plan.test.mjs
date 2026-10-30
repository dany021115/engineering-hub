import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { sandbox } from './helper.mjs'
import { guardrail, overlay, page, prepare, SERVICE_FACTS } from './plan-fixture.mjs'

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

const factOf = (id, kind, evidence, claim = `claim of ${id}`) => ({ type: 'fact', id, kind, claim, evidence })
const rowOf = (r, id) => r.json().evidence.find(e => e.id === id)

describe('the evidence of each entry (EVI-1)', () => {
  const CONF = 'docs/reference/configuration.md'

  test('impact order', () => {
    const ctx = prepare(sb)
    ctx.plan({ service: { files: [page('p1', CONF, 'reference', 'reads-env-vars', ['F6', 'F1'])] } })
    const r = ctx.run('--json')
    const row = rowOf(r, 'p1')
    assert.deepEqual([row.fact, row.more], ['F1', 1], r.output)
    assert.equal(row.text, `p1 ${CONF}: quote · .github/workflows/ci.yml:${row.line} · "run: npm test" (+1 more)`)
  })

  test('no human facts', () => {
    const ctx = prepare(sb)
    ctx.appendChecked('service', { type: 'fact', id: 'Q1', kind: 'human', claim: 'Does a merge deploy?', answer: 'no', role: 'maintainer' })
    ctx.plan({ service: { files: [page('p1', CONF, 'reference', 'reads-env-vars', ['Q1']), page('p2', 'docs/reference/cli.md', 'reference', null, ['Q1', 'F2'])] } })
    const r = ctx.run('--json')
    assert.equal(rowOf(r, 'p1').evidence, null)
    assert.equal(rowOf(r, 'p1').text, `p1 ${CONF}: no evidence`)
    assert.equal(rowOf(r, 'p2').fact, 'F2')
  })

  test('labels', () => {
    const facts = [...SERVICE_FACTS, factOf('F20', 'location', [{ path: 'src/app.ts', quote: 'export function start()' }])]
    const ctx = prepare(sb, { facts })
    ctx.appendChecked('service', { ...factOf('F3c', 'gotcha', [{ path: '.github/workflows/ci.yml', quote: 'run: npm ci' }]), corrects: 'F3' })
    sb.write(join(ctx.root, '.hub-run', 'verdicts', 'service-1.jsonl'), JSON.stringify({ id: 'F1', verdict: 'supported' }) + '\n')
    ctx.plan({
      service: {
        files: [
          page('p1', CONF, 'reference', 'reads-env-vars', ['F1']),
          page('p2', 'docs/reference/cli.md', 'reference', null, ['F3c']),
          page('p3', 'docs/reference/api.md', 'reference', null, ['F20']),
        ],
      },
    })
    const r = ctx.run('--json')
    assert.deepEqual(['p1', 'p2', 'p3'].map(id => rowOf(r, id).label), ['verified', 'corrected', 'quote'], r.output)
  })

  test('absence and cut', () => {
    const long = `export const banner = '${'x'.repeat(180)}'`
    const facts = [
      ...SERVICE_FACTS,
      factOf('F21', 'negative', [{ absence: 'npm run e2e', pathspec: '.github/workflows/' }]),
      factOf('F22', 'config', [{ path: 'src/banner.ts', quote: long }]),
    ]
    const ctx = prepare(sb, { facts, extra: { service: { 'src/banner.ts': long + '\n' } } })
    ctx.plan({ service: { files: [page('p1', CONF, 'reference', 'reads-env-vars', ['F21']), page('p2', 'docs/reference/cli.md', 'reference', null, ['F22'])] } })
    const r = ctx.run('--json')
    assert.deepEqual([rowOf(r, 'p1').absence, rowOf(r, 'p1').pathspec], ['npm run e2e', '.github/workflows/'], r.output)
    const quote = rowOf(r, 'p2').quote
    assert.equal([...quote].length, 120)
    assert.ok(quote.endsWith('…'))
    assert.equal(rowOf(r, 'p2').line, 1)
  })
})

describe('no quote with a secret reaches the gate (EVI-2)', () => {
  const secret = ['s3cr', 'et99'].join('')
  const assignment = ['pass', 'word'].join('') + ` = "${secret}"`
  const facts = [factOf('F30', 'config', [{ path: 'src/db.ts', quote: assignment }]), ...SERVICE_FACTS]
  const extra = { service: { 'src/db.ts': `const ${assignment}\n` } }

  test('quote with a secret', () => {
    const ctx = prepare(sb, { facts, extra })
    ctx.plan({ service: { files: [page('p1', 'docs/reference/configuration.md', 'reference', 'reads-env-vars', ['F30'])] } })
    const r = ctx.run('--json')
    const row = rowOf(r, 'p1')
    assert.equal(row.withheld, 'a secret assignment', r.output)
    assert.equal(row.quote, undefined)
    assert.ok(!r.stdout.includes(secret))
  })

  test('next clean fact', () => {
    const ctx = prepare(sb, { facts, extra })
    ctx.plan({ service: { files: [page('p1', 'docs/reference/configuration.md', 'reference', 'reads-env-vars', ['F30', 'F2'])] } })
    const r = ctx.run('--json')
    assert.equal(rowOf(r, 'p1').fact, 'F2', r.output)
    assert.ok(!r.stdout.includes(secret))
  })
})
