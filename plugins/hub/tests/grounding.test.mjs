import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { sandbox } from './helper.mjs'
import { check, messages, overlayText, stage } from './gate-fixture.mjs'
import { overlay, page, prepare } from './plan-fixture.mjs'

const sb = sandbox()
after(() => sb.cleanup())

const REF = ['docs/reference/configuration.md', 'reference', 'reads-env-vars']
const ref = line => `# Configuration\n\nThe service reads its settings from the environment.\n\n${line}\n`

describe('paths and identifiers in a planned page (PUE-7)', () => {
  const ctx = prepare(sb)
  const run = line => {
    ctx.plan({ service: { files: [page('p1', ...REF)] } })
    stage(sb, ctx, REF[0], ref(line))
    return check(sb, ctx)
  }
  const failing = {
    'a path that does not exist': ['The cache lives in `src/cache.ts`.', /the path src\/cache\.ts does not exist/],
    'an absolute path': ['The tool is `/opt/tool/bin/run`.', /the path \/opt\/tool\/bin\/run does not exist/],
    'an identifier found nowhere': ['Set `CACHE_KEY` before you start.', /the identifier CACHE_KEY appears nowhere/],
    'a member whose parts never share a file': ['It is `handler.DB_URL`.', /the identifier handler\.DB_URL appears nowhere/],
  }
  for (const [name, [line, expected]] of Object.entries(failing)) {
    test(`${name} fails`, () => {
      const r = run(line)
      assert.equal(r.code, 1, r.output)
      assert.match(messages(r).join('\n'), expected)
    })
  }
  const passing = {
    'a placeholder': 'Set `<cache-key>` to your own key.',
    'a placeholder path': 'Each repo keeps `<repo>/src/cache.ts`.',
    'a tracked path': 'The workflow is `.github/workflows/ci.yml`.',
    'an identifier of the code': 'The service reads `DB_URL` and `dbUrl`.',
    'a member whose parts share a file': 'The address comes from `config.DB_URL`.',
  }
  for (const [name, line] of Object.entries(passing)) {
    test(`${name} passes`, () => {
      const r = run(line)
      assert.equal(r.code, 0, r.output)
    })
  }
})

test('what the same run creates counts as existing, unless it is dropped', () => {
  const ctx = prepare(sb)
  const runTests = page('p2', 'docs/how-to/run-tests.md', 'how-to', 'tests-need-setup')
  const pageText = [
    '# Run the tests',
    '',
    'This page shows how to run the service tests; agents load `.claude/skills/working-in-service/SKILL.md` first.',
    '',
    '## Before you begin',
    '',
    'Install the packages.',
    '',
    '## Steps',
    '',
    '1. Run the suite.',
    '',
    '## Verify',
    '',
    'The suite passes.',
    '',
  ].join('\n')
  const skillText = overlayText('\n## Docs\n\nRunning the tests is in `docs/how-to/run-tests.md`; `.claude/hub.lock.json` lists its sources.\n')
  ctx.plan({ service: { files: [overlay(), runTests] } })
  stage(sb, ctx, overlay().path, skillText)
  stage(sb, ctx, runTests.path, pageText)
  let r = check(sb, ctx)
  assert.equal(r.code, 0, r.output)
  ctx.plan({ service: { files: [overlay(), { ...runTests, action: 'dropped', reason: 'review' }] } })
  r = check(sb, ctx)
  assert.equal(r.code, 1)
  assert.match(messages(r).join('\n'), /working-in-service\/SKILL\.md: line \d+: the path docs\/how-to\/run-tests\.md does not exist/)
})

test('a shell command no tracked file has is a warning; a sibling path is checked against the sibling', () => {
  const ctx = prepare(sb, { workspace: true })
  const path = 'docs/workspace/interfaces.md'
  const plan = () => ctx.plan({ service: { files: [page('p1', path, 'reference', 'two-sided-seam')] } }, { workspace: { home: 'service', repos: ['service', 'web'] } })
  const text = line => `# Interfaces\n\nThe web client calls the service.\n\n${line}\n`
  plan()
  stage(sb, ctx, path, text('Deploy it:\n\n```sh\nmake deploy-everything\n```'))
  let r = check(sb, ctx)
  assert.equal(r.code, 0, r.output)
  assert.match(JSON.stringify(r.json().warnings), /make deploy-everything/)
  stage(sb, ctx, path, text('The client lives in `web/src/routes.ts`.'))
  r = check(sb, ctx)
  assert.equal(r.code, 1)
  assert.match(messages(r).join('\n'), /the path web\/src\/routes\.ts does not exist/)
  stage(sb, ctx, path, text('The client lives in `web/src/client.ts` and reads `API_BASE`.'))
  r = check(sb, ctx)
  assert.equal(r.code, 0, r.output)
  // The docs home's own files, written the same way.
  stage(sb, ctx, path, text('The client lives in `web/src/client.ts`; the server reads it in `service/src/config.ts`.'))
  r = check(sb, ctx)
  assert.equal(r.code, 0, r.output)
})

test('only the repos of the run ground a page, and their names need no grounding (PUE-7)', () => {
  const extra = { web_app: { 'src/client.ts': 'export const API_BASE = ""\n' }, infra: { 'deploy/run.sh': 'export INFRA_ONLY=1\n' } }
  const ctx = prepare(sb, { workspace: true, repos: ['service', 'web_app', 'infra'], extra })
  const path = 'docs/workspace/interfaces.md'
  ctx.plan({ service: { files: [page('p1', path, 'reference', 'two-sided-seam')] } }, { workspace: { home: 'service', repos: ['service', 'web_app'] } })
  const run = line => {
    stage(sb, ctx, path, `# Interfaces\n\nThe web client calls the service.\n\n${line}\n`)
    return check(sb, ctx)
  }
  let r = run('The `web_app` client reads `API_BASE` in `web_app/src/client.ts`.')
  assert.equal(r.code, 0, r.output)
  // infra shares the folder but is not in the run.
  r = run('The deploy sets `INFRA_ONLY` in `infra/deploy/run.sh`.')
  assert.equal(r.code, 1)
  assert.match(messages(r).join('\n'), /the identifier INFRA_ONLY appears nowhere/)
  assert.match(messages(r).join('\n'), /the path infra\/deploy\/run\.sh does not exist/)
})

test('a command that exists only as the name of a tracked file is in the code (PUE-7)', () => {
  const ctx = prepare(sb, { extra: { service: { 'scripts/check_index_health.py': 'print("ok")\n' } } })
  const run = line => {
    ctx.plan({ service: { files: [page('p1', ...REF)] } })
    stage(sb, ctx, REF[0], ref(line))
    return check(sb, ctx)
  }
  let r = run('Run `check_index_health` after a deploy.')
  assert.equal(r.code, 0, r.output)
  r = run('Run `check_index_status` after a deploy.')
  assert.equal(r.code, 1)
  assert.match(messages(r).join('\n'), /the identifier check_index_status appears nowhere/)
})
