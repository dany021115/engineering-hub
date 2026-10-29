import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { sandbox } from './helper.mjs'
import { skillText, stage } from './gate-fixture.mjs'
import { guardrail, page, prepare } from './plan-fixture.mjs'
import { CONFIG, RUN_TESTS, approvedRun, e1, g1, lockedExtra, p1, p2, s1, x1 } from './run-fixture.mjs'

const sb = sandbox()
after(() => sb.cleanup())

const GITHUB = { name: 'engineering-hub', source: 'github', repo: 'example-org/engineering-hub', installLocation: 'cache/engineering-hub' }
const GIT = { name: 'engineering-hub', source: 'git', url: 'https://git.example.com/org/engineering-hub.git' }
const SETTINGS = '.claude/settings.json'
const previousSettings = { permissions: { allow: ['Bash(npm test)'], deny: ['Bash(rm -rf /)'] }, env: { FOO: '1' } }
const home = ['', 'Users', 'someone', 'notes.txt'].join('/')
const proposalOf = (run, id) => join(run.ctx.root, '.hub-run', 'proposals', 'service', `${id}.proposed`)
const settingsOf = run => JSON.parse(run.read(SETTINGS))

// Each claude variant needs its own PATH, so its own sandbox.
function withClaude(list, body) {
  const s = sandbox()
  try {
    if (list) s.fakeClaude(list)
    return body(s)
  } finally {
    s.cleanup()
  }
}

describe('settings patches (GEN-19)', () => {
  test('one patch without the other, and both, keep the earlier keys', () => {
    withClaude([GITHUB], s => {
      for (const apply of ['g1', 'e1,g1']) {
        const run = approvedRun(s, [e1(), g1()], { extra: { [SETTINGS]: JSON.stringify(previousSettings, null, 2) + '\n' } })
        assert.equal(run.place().code, 0)
        const r = run.finish('--keep', 'all', '--apply', apply)
        assert.equal(r.code, 0, r.output)
        const now = settingsOf(run)
        assert.deepEqual(now.permissions.allow, previousSettings.permissions.allow)
        assert.deepEqual(now.permissions.deny, ['Bash(rm -rf /)', ...g1().deny])
        assert.deepEqual(now.env, previousSettings.env)
        if (apply === 'g1') {
          assert.equal(now.enabledPlugins, undefined)
          assert.equal(now.extraKnownMarketplaces, undefined)
        } else {
          assert.equal(now.enabledPlugins['hub@engineering-hub'], true)
          assert.deepEqual(now.extraKnownMarketplaces['engineering-hub'].source, { source: 'github', repo: GITHUB.repo })
        }
      }
    })
  })

  test('an edited CLAUDE.md stops x1; a key added by hand to the settings survives g1', () => {
    let run = approvedRun(sb, [s1(), x1(), g1()], { extra: { [SETTINGS]: JSON.stringify(previousSettings, null, 2) + '\n' } })
    assert.equal(run.place().code, 0)
    const mine = run.read('CLAUDE.md') + 'A rule of mine.\n'
    sb.write(join(run.ctx.service, 'CLAUDE.md'), mine)
    let r = run.finish('--keep', 'all', '--apply', 'x1')
    assert.equal(r.code, 1)
    assert.match(r.output, /x1/)
    assert.equal(run.read('CLAUDE.md'), mine)
    assert.ok(existsSync(proposalOf(run, 'x1')))

    run = approvedRun(sb, [s1(), x1(), g1()], { extra: { [SETTINGS]: JSON.stringify(previousSettings, null, 2) + '\n' } })
    assert.equal(run.place().code, 0)
    sb.write(join(run.ctx.service, SETTINGS), JSON.stringify({ ...previousSettings, outputStyle: 'brief' }, null, 2) + '\n')
    r = run.finish('--keep', 'all', '--apply', 'g1')
    assert.equal(r.code, 0, r.output)
    assert.ok(settingsOf(run).permissions.deny.includes(g1().deny[0]))
    assert.equal(settingsOf(run).outputStyle, 'brief')
  })
})

describe('the git source (GEN-19)', () => {
  for (const [label, entry, source] of [
    ['github', GITHUB, { repo: GITHUB.repo, source: 'github' }],
    ['git', GIT, { source: 'git', url: GIT.url }],
  ]) {
    test(`${label}: env.json keeps the entry and e1 carries only source and ${label === 'github' ? 'repo' : 'url'}`, () => {
      withClaude([entry], s => {
        const ctx = prepare(s)
        const env = JSON.parse(readFileSync(join(ctx.root, '.hub-run', 'env.json'), 'utf8'))
        assert.deepEqual(env.marketplace, entry)
        ctx.plan({ service: { files: [e1()] } })
        assert.equal(ctx.run().code, 0)
        assert.equal(ctx.run('--approve').code, 0)
        assert.equal(s.hub(['place', ctx.planFile], { cwd: ctx.root }).code, 0)
        const text = readFileSync(join(ctx.root, '.hub-run', 'proposals', 'service', 'e1.proposed'), 'utf8')
        assert.doesNotMatch(text, /installLocation/)
        const patch = JSON.parse(text)
        assert.equal(patch.enabledPlugins['hub@engineering-hub'], true)
        assert.deepEqual(patch.extraKnownMarketplaces['engineering-hub'].source, source)
      })
    })
  }

  const without = {
    'no claude': null,
    'no engineering-hub': [{ name: 'other', source: 'github', repo: 'example-org/other' }],
    'a local folder': [{ name: 'engineering-hub', source: 'directory', path: 'local/engineering-hub' }],
  }
  for (const [label, list] of Object.entries(without)) {
    test(`${label}: plan refuses e1 and c1, and place writes no team settings`, () => {
      withClaude(list, s => {
        const ctx = prepare(s)
        for (const offer of [e1(), { id: 'c1', path: '.github/workflows/hub-check.yml', action: 'propose', offer: 'hub-check', why: 'ci' }]) {
          ctx.plan({ service: { files: [offer] } })
          const r = ctx.run()
          assert.equal(r.code, 1)
          assert.match(r.output, new RegExp(`\\b${offer.id}\\b`))
        }
        ctx.plan({ service: { files: [e1()] } }, { approved: true })
        const placed = s.hub(['place', ctx.planFile, '--json'], { cwd: ctx.root })
        assert.equal(placed.code, 0)
        assert.match(JSON.stringify(placed.json().warnings), /no git source/)
        assert.ok(!existsSync(join(ctx.root, '.hub-run', 'proposals', 'service', 'e1.proposed')))
      })
    })
  }
})

describe('applying proposals (GEN-5, GEN-20, PUE-6, CON-8)', () => {
  test('a proposal with a personal path is not applied; finish exits 1 and still closes', () => {
    const run = approvedRun(sb, [s1(), x1(`Read \`.claude/skills/working-in-service/SKILL.md\` and ${home}.`)])
    assert.equal(run.place().code, 0)
    const before = run.read('CLAUDE.md')
    const r = run.finish('--keep', 'all', '--apply', 'x1')
    assert.equal(r.code, 1)
    assert.deepEqual(r.json().notApplied.map(n => n.id), ['x1'])
    assert.match(r.json().notApplied[0].reason, /personal folder/)
    assert.equal(run.read('CLAUDE.md'), before)
    assert.ok(existsSync(join(run.ctx.service, '.claude', 'hub.lock.json')))
    assert.ok(existsSync(join(run.ctx.root, '.hub-run', 'done.json')))
    assert.equal(sb.hub(['start', '--json'], { cwd: run.ctx.root }).json().resume, null)
  })

  test('nothing chosen in P3 changes no instruction, settings or workflow file', () => {
    const run = approvedRun(sb, [s1(), x1(), g1()])
    assert.equal(run.place().code, 0)
    assert.equal(run.finish('--keep', 'all').code, 0)
    assert.equal(sb.git(run.ctx.service, 'status', '--short', '--', 'CLAUDE.md', SETTINGS, '.github/workflows'), '')
  })

  test('a confirmed guardrail: approved, placed and its deny rule applied (CON-8)', () => {
    const ctx = prepare(sb)
    const g = guardrail({ answer: 'yes' })
    ctx.plan({ service: { files: g.files, questions: [g.question] } })
    assert.equal(ctx.run('--approve').code, 0)
    assert.equal(ctx.readPlan().approved, true)
    stage(sb, ctx, g.files[0].path, skillText('service-db-guardrails', ['## Rules', '## Safe path']))
    const hub = (...a) => sb.hub(a, { cwd: ctx.root })
    assert.equal(hub('place', ctx.planFile).code, 0)
    assert.ok(existsSync(join(ctx.root, '.hub-run', 'proposals', 'service', 'g1.proposed')))
    const r = hub('finish', ctx.planFile, '--keep', 'all', '--apply', 'g1')
    assert.equal(r.code, 0, r.output)
    assert.ok(existsSync(join(ctx.service, '.claude', 'skills', 'service-db-guardrails', 'SKILL.md')))
    assert.deepEqual(JSON.parse(readFileSync(join(ctx.service, SETTINGS), 'utf8')).permissions.deny, g.files[1].deny)
  })
})

describe('the hub-check workflow (GEN-19, GEN-27, GEN-28, PUE-6, PUE-8)', () => {
  const WORKFLOW = '.github/workflows/hub-check.yml'
  const c1 = (id = 'c1') => ({ id, path: WORKFLOW, action: 'propose', offer: 'hub-check', why: 'checks every pull request' })

  for (const [label, entry, url] of [
    ['github', GITHUB, 'https://github.com/example-org/engineering-hub'],
    ['git', GIT, GIT.url],
  ]) {
    test(`${label}: place fills the template URL, never a version; finish --apply tracks it as ci`, () => {
      withClaude([entry], s => {
        const run = approvedRun(s, [s1(), c1()])
        assert.equal(run.place().code, 0)
        const text = readFileSync(proposalOf(run, 'c1'), 'utf8')
        assert.ok(text.includes(`"${url}"`), text)
        assert.doesNotMatch(text, /__HUB_TEMPLATE_URL__|hub--v[0-9]|(^|[\s;&|])claude\s/m)
        assert.match(text, /^permissions:\n  contents: read$/m)
        for (const line of text.split('\n').filter(l => l.includes('uses:'))) assert.match(line, /@[0-9a-f]{40}\b/)
        assert.match(text, /fetch-depth: 0/)
        assert.match(text, /node-version: 24/)
        assert.match(text, /secrets\.HUB_TEMPLATE_TOKEN/)
        assert.match(text, /hub\.lock\.json/)

        // The clone step's tag, run against a lock generated by hub@0.1.0.
        const line = text.split('\n').find(l => l.trim().startsWith('version="$('))
        const at = s.write(join(s.path('tag'), '.claude', 'hub.lock.json'), JSON.stringify({ generator: 'hub@0.1.0' }))
        const tag = spawnSync('/bin/bash', ['-c', `${line.trim()}; printf 'hub--v%s' "$version"`], { cwd: join(at, '..', '..'), env: s.env, encoding: 'utf8' })
        assert.equal(tag.stdout, 'hub--v0.1.0', tag.stderr)

        const r = run.finish('--keep', 'all', '--apply', 'c1')
        assert.equal(r.code, 0, r.output)
        assert.equal(run.read(WORKFLOW), text)
        assert.equal(JSON.parse(run.read('.claude/hub.lock.json')).files[WORKFLOW].kind, 'ci')
      })
    })
  }

  test('a proposal with a personal path is not applied while a clean workflow is (PUE-6)', () => {
    withClaude([GITHUB], s => {
      const run = approvedRun(s, [s1(), x1(`Read \`.claude/skills/working-in-service/SKILL.md\` and ${home}.`), c1('x2')])
      assert.equal(run.place().code, 0)
      const before = run.read('CLAUDE.md')
      const r = run.finish('--keep', 'all', '--apply', 'x1,x2')
      assert.equal(r.code, 1)
      assert.deepEqual(r.json().notApplied.map(n => n.id), ['x1'])
      assert.equal(run.read('CLAUDE.md'), before)
      assert.ok(existsSync(join(run.ctx.service, WORKFLOW)))
      assert.ok(existsSync(join(run.ctx.root, '.hub-run', 'done.json')))
    })
  })

  test('closing with discards and offers changes exactly the kept, the edited and the accepted (PUE-8)', () => {
    withClaude([GITHUB], s => {
      const update = { ...p1(), id: 'p2', action: 'update' }
      const created = { ...p2(), id: 'p3' }
      const run = approvedRun(s, [s1(), update, created, x1(), c1('x2')], { extra: lockedExtra() })
      assert.equal(run.place().code, 0)
      const previous = run.placed().files[CONFIG].previous
      s.write(join(run.ctx.service, RUN_TESTS), run.read(RUN_TESTS) + '\nA note of mine.\n')
      const r = run.finish('--keep', 's1', '--apply', 'x1,x2')
      assert.equal(r.code, 0, r.output)
      assert.equal(run.hash(CONFIG), previous)
      assert.ok(r.json().changed.some(c => c.id === 'p3'))
      assert.equal(JSON.parse(run.read('.claude/hub.lock.json')).files[WORKFLOW].kind, 'ci')
      assert.deepEqual(run.status().sort(), ['.claude/hub.lock.json', s1().path, 'CLAUDE.md', WORKFLOW, RUN_TESTS].sort())
    })
  })
})

describe('the instructions line (CON-19)', () => {
  const line = x1().text
  test('with CLAUDE.md and AGENTS.md the line goes to CLAUDE.md only', () => {
    const ctx = prepare(sb, { extra: { service: { 'AGENTS.md': '# Agents\n\nRead the docs.\n' } } })
    ctx.plan({ service: { files: [s1(), x1()] } })
    assert.equal(ctx.run().code, 0, ctx.run().output)
    ctx.plan({ service: { files: [s1(), { ...x1(), path: 'AGENTS.md' }] } })
    assert.equal(ctx.run().code, 1)
  })

  test('without either file the line is a new AGENTS.md that does not exist until accepted', () => {
    const run = approvedRun(sb, [s1(), { ...x1(), path: 'AGENTS.md' }], {
      prepareOptions: {
        before: w => {
          rmSync(join(w.service, 'CLAUDE.md'))
          sb.commit(w.service, 'no instructions file')
        },
      },
    })
    run.ctx.plan({ service: { files: [s1(), { ...x1(), path: 'AGENTS.md' }] } })
    assert.equal(run.ctx.run().code, 0, run.ctx.run().output)
    run.ctx.plan({ service: { files: [s1(), { ...x1(), path: 'AGENTS.md' }] } }, { approved: true })
    assert.equal(run.place().code, 0)
    assert.equal(readFileSync(proposalOf(run, 'x1'), 'utf8'), line + '\n')
    assert.ok(!existsSync(join(run.ctx.service, 'AGENTS.md')))
  })

  test('without an overlay the line points at docs/index.md; without either there is no line', () => {
    const index = page('p0', 'docs/index.md', 'overview', 'always')
    const text = 'Before editing here, read `docs/index.md`.'
    const run = approvedRun(sb, [index, x1(text)], {
      texts: { 'docs/index.md': '# Service docs\n\nThis folder documents the service.\n\n## Where to start\n\nRead this page first.\n' },
    })
    run.ctx.plan({ service: { files: [index, x1(text)] } })
    assert.equal(run.ctx.run().code, 0, run.ctx.run().output)
    run.ctx.plan({ service: { files: [index, x1(text)] } }, { approved: true })
    const before = run.read('CLAUDE.md')
    assert.equal(run.place().code, 0)
    assert.equal(readFileSync(proposalOf(run, 'x1'), 'utf8'), before + text + '\n')
    run.ctx.plan({ service: { files: [x1(text)] } })
    assert.equal(run.ctx.run().code, 1)
  })
})
