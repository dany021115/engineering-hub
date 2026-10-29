import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { PLUGIN, sandbox } from './helper.mjs'
import { guardrail, overlay, page, prepare, skill } from './plan-fixture.mjs'

const sb = sandbox()
after(() => sb.cleanup())

const procedure = (facts = ['F1', 'F6']) => skill('s3', 'service-run-migrations', 'procedure', facts)
const style = (facts = ['F11', 'F12', 'F14']) =>
  skill('s4', 'service-typescript-style', 'style', facts, { id: 's4' })
const withGuard = (ctx, files, extra = {}) => {
  const g = guardrail(extra)
  return { files: [...files, ...g.files], questions: [g.question] }
}

describe('offers need a git source (GEN-19)', () => {
  const offers = {
    e1: { id: 'e1', path: '.claude/settings.json', action: 'propose', offer: 'team-settings', why: 'team' },
    c1: { id: 'c1', path: '.github/workflows/hub-check.yml', action: 'propose', offer: 'hub-check', why: 'ci' },
  }
  const envs = {
    'no claude': null,
    'no engineering-hub': [{ name: 'other', source: 'github', repo: 'example-org/other' }],
    'directory source': [{ name: 'engineering-hub', source: 'directory', path: 'local/engineering-hub' }],
  }
  for (const [label, list] of Object.entries(envs)) {
    test(`${label}: team-settings and hub-check exit 1 naming the entry`, () => {
      const s = sandbox()
      try {
        if (list) s.fakeClaude(list)
        const ctx = prepare(s)
        for (const [id, offer] of Object.entries(offers)) {
          ctx.plan({ service: { files: [overlay(), offer] } })
          const r = ctx.run()
          assert.equal(r.code, 1, `${label} ${id}`)
          assert.match(r.output, new RegExp(`\\b${id}\\b.*git source`))
        }
      } finally {
        s.cleanup()
      }
    })
  }

  test('with a github or git source both offers pass', () => {
    for (const entry of [
      { name: 'engineering-hub', source: 'github', repo: 'example-org/engineering-hub', installLocation: 'x' },
      { name: 'engineering-hub', source: 'git', url: 'https://git.example.com/org/engineering-hub.git' },
    ]) {
      const s = sandbox()
      try {
        s.fakeClaude([entry])
        const ctx = prepare(s)
        ctx.plan({ service: { files: [overlay(), ...Object.values(offers)] } })
        const r = ctx.run()
        assert.equal(r.code, 0, r.output)
      } finally {
        s.cleanup()
      }
    }
  })
})

describe('the script obeys the catalog (CON-1)', () => {
  test('a plugin copy with skillsPerRepo 2 rejects three skills, the original accepts them', () => {
    const copy = sb.path('plugin-copy')
    for (const part of ['scripts', 'generator', '.claude-plugin']) cpSync(join(PLUGIN, part), join(copy, part), { recursive: true })
    const catalogFile = join(copy, 'generator', 'catalog.json')
    const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'))
    catalog.caps.skillsPerRepo = 2
    writeFileSync(catalogFile, JSON.stringify(catalog, null, 2))
    const ctx = prepare(sb)
    ctx.plan({ service: { files: [overlay(), procedure(), skill('s5', 'service-add-endpoint', 'procedure', ['F1', 'F2'])] } })
    const viaCopy = spawnSync(process.execPath, [join(copy, 'scripts', 'hub.mjs'), 'plan', ctx.planFile], {
      cwd: ctx.root,
      env: sb.env,
      encoding: 'utf8',
    })
    assert.equal(viaCopy.status, 1)
    assert.match(viaCopy.stderr, /skillsPerRepo \(2\)/)
    assert.equal(ctx.run().code, 0)
  })
})

describe('skill names, caps and minFacts (CON-4 to CON-8)', () => {
  test('a name that exists on disk in another repo collides (CON-4)', () => {
    const ctx = prepare(sb, {
      workspace: true,
      repos: ['service', 'web'],
      extra: { web: { '.claude/skills/working-in-service/SKILL.md': '---\nname: working-in-service\n---\n' } },
    })
    ctx.plan(
      { service: { files: [overlay()] }, web: { files: [] } },
      { workspace: { home: 'service', repos: ['service', 'web'] } },
    )
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, /working-in-service/)
  })

  test('four skills exceed the cap (CON-5)', () => {
    const ctx = prepare(sb)
    ctx.plan({ service: withGuard(ctx, [overlay(), procedure(), style()], { answer: null }) })
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, /skillsPerRepo \(3\)/)
  })

  test('over-cap by priority: a dropped procedure may not outrank a kept style (CON-5)', () => {
    const ctx = prepare(sb)
    const proc = '.claude/skills/service-run-migrations/SKILL.md'
    const sty = '.claude/skills/service-typescript-style/SKILL.md'
    ctx.plan({
      service: { ...withGuard(ctx, [overlay(), style()]), rejected: [{ idea: proc, reason: 'over-cap' }] },
    })
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.ok(r.output.includes(proc))
    assert.match(r.output, /outranks kept service-typescript-style/)
    ctx.plan({
      service: { ...withGuard(ctx, [overlay(), procedure()]), rejected: [{ idea: sty, reason: 'over-cap' }] },
    })
    assert.equal(ctx.run().code, 0)
    const overCap = ctx.readPlan().repos.service.rejected.filter(x => x.reason === 'over-cap').map(x => x.idea)
    assert.deepEqual(overCap, [sty])
  })

  test('an overlay below minFacts, also when a human fact fills the gap (CON-6)', () => {
    const ctx = prepare(sb)
    ctx.appendChecked('service', { type: 'fact', id: 'Q1', kind: 'human', claim: 'q', answer: 'yes', role: 'maintainer' })
    for (const facts of [['F1'], ['F1', 'Q1']]) {
      ctx.plan({ service: { files: [overlay(facts)] } })
      const r = ctx.run()
      assert.equal(r.code, 1)
      assert.match(r.output, /minFacts/)
    }
  })

  test('a procedure with one fact and a style with two fail minFacts, naming both (CON-7)', () => {
    const ctx = prepare(sb)
    ctx.plan({ service: { files: [overlay(), procedure(['F1']), style(['F11', 'F12'])] } })
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, /minFacts/)
    assert.match(r.output, /service-run-migrations/)
    assert.match(r.output, /service-typescript-style/)
  })

  test('a convention only a linter config enforces does not count for a style skill (CON-7)', () => {
    const ctx = prepare(sb)
    ctx.plan({ service: { files: [overlay(), style(['F11', 'F12', 'F13'])] } })
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, /minFacts/)
    assert.match(r.output, /service-typescript-style/)
    assert.match(r.output, /F13/)
    ctx.plan({ service: { files: [overlay(), style(['F11', 'F12', 'F13', 'F14'])] } })
    assert.equal(ctx.run().code, 0)
  })

  test('a guardrail without supported facts fails minFacts (CON-8)', () => {
    const ctx = prepare(sb)
    ctx.plan({ service: withGuard(ctx, [overlay()], { facts: [] }) })
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, /minFacts/)
  })

  test('invalid deny rules and a second deny entry fail; one valid rule passes (CON-8)', () => {
    const ctx = prepare(sb)
    for (const deny of [[], ['npm run db:migrate']]) {
      ctx.plan({ service: withGuard(ctx, [overlay()], { deny }) })
      const r = ctx.run()
      assert.equal(r.code, 1)
      assert.match(r.output, /\bg1\b/)
    }
    const g = guardrail()
    const g2 = { ...g.files[1], id: 'g2' }
    ctx.plan({
      service: { files: [overlay(), ...g.files, g2], questions: [{ ...g.question, decides: ['s2', 'g1', 'g2'] }] },
    })
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, /service-db-guardrails.*g1, g2/)
    ctx.plan({ service: withGuard(ctx, [overlay()]) })
    assert.equal(ctx.run().code, 0)
  })

  test('a guardrail-deny no question decides, or decided apart from its skill, fails (CON-8)', () => {
    const ctx = prepare(sb)
    const g = guardrail()
    const q2 = { id: 'Q2', text: 'Keep the deny rule?', decides: ['g1'], default: 'no', answer: null, role: null }
    for (const questions of [[{ ...g.question, decides: ['s2'] }], [{ ...g.question, decides: ['s2'] }, q2]]) {
      ctx.plan({ service: { files: [overlay(), ...g.files], questions } })
      const r = ctx.run()
      assert.equal(r.code, 1)
      assert.match(r.output, /\bg1\b/)
    }
    ctx.plan({ service: { files: [overlay(), ...g.files], questions: [g.question] } })
    assert.equal(ctx.run().code, 0)
  })
})

describe('pages of the catalog (CON-11, CON-13, CON-18)', () => {
  const explanation = (id, topic) => page(id, `docs/explanation/${topic}.md`, 'explanation', 'non-obvious-mechanism', ['F3'])

  test('three explanation pages exceed the cap', () => {
    const ctx = prepare(sb)
    ctx.plan({ service: { files: [overlay(), explanation('e1', 'retries'), explanation('e2', 'caching'), explanation('e3', 'locking')] } })
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, /at most 2 explanation/)
  })

  test('a path outside the catalog fails, naming it', () => {
    const ctx = prepare(sb)
    ctx.plan({ service: { files: [overlay(), page('p1', 'docs/troubleshooting.md', 'how-to', 'always')] } })
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, /docs\/troubleshooting\.md/)
  })

  test('run-tests without a trigger, or with one outside its when, fails naming it', () => {
    const ctx = prepare(sb)
    for (const trigger of [null, 'reads-env-vars']) {
      ctx.plan({ service: { files: [overlay(), page('p1', 'docs/how-to/run-tests.md', 'how-to', trigger, ['F1'])] } })
      const r = ctx.run()
      assert.equal(r.code, 1)
      assert.match(r.output, /docs\/how-to\/run-tests\.md/)
    }
  })

  test('a workspace page outside the docs home fails, naming the page and the repo', () => {
    const ctx = prepare(sb, { workspace: true, repos: ['service', 'web'] })
    ctx.plan(
      { service: { files: [overlay()] }, web: { files: [page('w1', 'docs/workspace/index.md', 'overview', 'docs-home', [])] } },
      { workspace: { home: 'service', repos: ['service', 'web'] } },
    )
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, /docs\/workspace\/index\.md/)
    assert.match(r.output, /\bweb\b/)
  })

  test('interfaces.md on a one-sided seam fails, naming the page and the fact (CON-13)', () => {
    const ctx = prepare(sb, {
      workspace: true,
      repos: ['service', 'web'],
      wsFacts: [
        { type: 'fact', id: 'F20', kind: 'seam', claim: 'one side', evidence: [{ path: 'service:src/config.ts', quote: 'process.env.DB_URL' }] },
        {
          type: 'fact',
          id: 'F21',
          kind: 'seam',
          claim: 'two sides',
          evidence: [
            { path: 'service:src/app.ts', quote: "import { config } from './config'" },
            { path: 'web:src/client.ts', quote: "export const API_BASE = '/api/v1'" },
          ],
        },
      ],
    })
    const ws = { workspace: { home: 'service', repos: ['service', 'web'] } }
    const iface = facts => page('i1', 'docs/workspace/interfaces.md', 'reference', 'two-sided-seam', facts)
    ctx.plan({ service: { files: [overlay(), iface(['F20'])] }, web: { files: [] } }, ws)
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, /docs\/workspace\/interfaces\.md/)
    assert.match(r.output, /F20/)
    ctx.plan({ service: { files: [overlay(), iface(['F21'])] }, web: { files: [] } }, ws)
    assert.equal(ctx.run().code, 0)
  })

  test('human pages are only proposed, never created', () => {
    const ctx = prepare(sb, {
      extra: { service: { 'docs/index.md': '# Docs\n', 'docs/how-to/run-tests.md': '# Run tests\n' } },
    })
    ctx.plan({ service: { files: [overlay(), page('p1', 'docs/how-to/run-tests.md', 'how-to', 'tests-need-setup', ['F1'])] } })
    const taken = ctx.run()
    assert.equal(taken.code, 1)
    assert.match(taken.output, /path is taken/)
    const propose = (id, path) => ({ id, path, action: 'propose', why: 'link the new pages' })
    ctx.plan({ service: { files: [overlay(), propose('x2', 'docs/index.md'), propose('x3', 'docs/how-to/run-tests.md')] } })
    assert.equal(ctx.run().code, 0)
  })

  test('README.md in the docs folder is the index: index.md is not created, README.md is proposed', () => {
    const ctx = prepare(sb, { extra: { service: { 'docs/README.md': '# Docs\n' } } })
    ctx.plan({ service: { files: [overlay(), page('p1', 'docs/index.md', 'overview', 'always', ['F1'])] } })
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, /README\.md is the index/)
    ctx.plan({ service: { files: [overlay(), { id: 'x2', path: 'docs/README.md', action: 'propose', why: 'links' }] } })
    assert.equal(ctx.run().code, 0)
  })

  test("an existing site's folder holds the pages and its config is only proposed", () => {
    const ctx = prepare(sb, {
      extra: { service: { 'mkdocs.yml': 'site_name: Service\ndocs_dir: handbook\n', 'handbook/index.md': '# Home\n' } },
    })
    const cfg = path => page('p1', path, 'reference', 'reads-env-vars')
    const nav = { id: 'x2', path: 'mkdocs.yml', action: 'propose', why: 'navigation' }
    ctx.plan({ service: { docsDir: 'handbook', files: [overlay(), cfg('handbook/reference/configuration.md'), nav] } })
    assert.equal(ctx.run().code, 0)
    ctx.plan({ service: { docsDir: 'handbook', files: [overlay(), cfg('docs/reference/configuration.md')] } })
    const r = ctx.run()
    assert.equal(r.code, 1)
    assert.match(r.output, /under the docs folder handbook/)
  })
})

describe('the instructions line (CON-19)', () => {
  const line = text => ({ id: 'x1', path: 'CLAUDE.md', action: 'propose', offer: 'instructions-line', text, why: 'pointer' })
  const index = page('p0', 'docs/index.md', 'overview', 'always', ['F1'])
  const skillLine = 'Before editing, testing or committing here, read `.claude/skills/working-in-service/SKILL.md`.'

  test('four malformed lines fail naming x1; a one-line Spanish text citing the skill passes', () => {
    const ctx = prepare(sb)
    const cases = [
      [overlay(), line(`${skillLine}\nSecond line.`)],
      [overlay(), index, line('Read `docs/index.md` first.')],
      [index, line(skillLine)],
      [line('Read `docs/index.md` first.')],
    ]
    for (const files of cases) {
      ctx.plan({ service: { files } })
      const r = ctx.run()
      assert.equal(r.code, 1)
      assert.match(r.output, /\bx1\b/)
    }
    ctx.plan({
      service: { files: [overlay(), line('Antes de editar aquí, lee la skill `working-in-service`.')] },
    })
    assert.equal(ctx.run().code, 0)
  })
})

test("a repo name that is not kebab-case still gets skills, named after its slug", async () => {
  const { loadCatalog } = await import('../scripts/lib/catalog.mjs')
  const { skillArchetype, skillSlug } = await import('../scripts/lib/plan.mjs')
  const catalog = loadCatalog()
  assert.equal(skillSlug('dlujo_store'), 'dlujo-store')
  assert.equal(skillArchetype(catalog, 'dlujo_store', 'working-in-dlujo-store'), 'working-in')
  assert.equal(skillArchetype(catalog, 'dlujo_store', 'dlujo-store-play-release-guardrails'), 'guardrail')
  assert.equal(skillArchetype(catalog, 'dlujo_store', 'working-in-dlujo_store'), null)
  assert.equal(skillArchetype(catalog, 'My.Repo', 'my-repo-add-route'), 'procedure')
})
