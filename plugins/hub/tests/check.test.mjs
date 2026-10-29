import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { proposalFile, stagingFile, toStagingPath } from '../scripts/lib/paths.mjs'
import { sandbox } from './helper.mjs'
import { overlay, page, prepare } from './plan-fixture.mjs'

const sb = sandbox()
after(() => sb.cleanup())

test('one function turns plan paths into staging paths, every .claude segment into _claude', () => {
  assert.equal(toStagingPath('.claude/skills/x/SKILL.md'), '_claude/skills/x/SKILL.md')
  assert.equal(toStagingPath('docs/a/.claude/b.md'), 'docs/a/_claude/b.md')
  assert.equal(toStagingPath('docs/index.md'), 'docs/index.md')
  assert.equal(stagingFile('/r', 'service', '.claude/skills/x/SKILL.md'), '/r/.hub-run/out/service/_claude/skills/x/SKILL.md')
  assert.equal(proposalFile('/r', 'service', 'x1'), '/r/.hub-run/proposals/service/x1.proposed')
})

function written() {
  const ctx = prepare(sb)
  const files = [overlay(), page('p1', 'docs/reference/configuration.md', 'reference', 'reads-env-vars')]
  ctx.plan({ service: { files } })
  sb.write(
    stagingFile(ctx.root, 'service', files[0].path),
    '---\nname: working-in-service\ndescription: Working in the service repository.\n---\n\n## Verify like CI\n\n## Hand-off\n',
  )
  sb.write(stagingFile(ctx.root, 'service', files[1].path), '# Configuration\n\nThe service reads `DB_URL`.\n')
  return ctx
}

test('check on a plan without findings exits 0, with and without --json', () => {
  const ctx = written()
  const plain = sb.hub(['check', ctx.planFile, '--round', '1'], { cwd: ctx.root })
  assert.equal(plain.code, 0, plain.output)
  const json = sb.hub(['check', ctx.planFile, '--round', '1', '--json'], { cwd: ctx.root })
  assert.equal(json.code, 0)
  const out = json.json()
  assert.equal(out.ok, true)
  assert.deepEqual(out.targets.sort(), [
    'service:.claude/skills/working-in-service/SKILL.md',
    'service:docs/reference/configuration.md',
  ])
})

test('check on a lock without findings exits 0, with and without --json', () => {
  const ctx = written()
  const page = 'docs/reference/configuration.md'
  sb.write(join(ctx.service, page), '# Configuration\n\nThe service reads `DB_URL` from the environment.\n')
  const hash = sb.git(ctx.service, 'hash-object', page).trim()
  const lock = sb.write(
    join(ctx.service, '.claude', 'hub.lock.json'),
    JSON.stringify({ schema: 1, settings: { language: 'en' }, files: { [page]: { kind: 'page', type: 'reference', hash, sources: {} } } }),
  )
  assert.equal(sb.hub(['check', '--lock', lock], { cwd: ctx.service }).code, 0)
  const out = sb.hub(['check', '--lock', lock, '--json'], { cwd: ctx.service })
  assert.equal(out.code, 0)
  assert.deepEqual(out.json().targets, [page])
})

test('check --skills walks the folders for SKILL.md files', () => {
  const dir = sb.path('skills')
  sb.write(join(dir, 'a', 'SKILL.md'), '---\nname: a\ndescription: A.\n---\n')
  const r = sb.hub(['check', '--skills', dir, '--authoring', '--json'])
  assert.equal(r.code, 0, r.output)
  assert.equal(r.json().targets.length, 1)
})

test('check exits 2 on a missing plan, a missing round, a missing folder or two modes', () => {
  const ctx = written()
  const missing = join(ctx.root, '.hub-run', 'nope.json')
  assert.equal(sb.hub(['check', missing, '--round', '1'], { cwd: ctx.root }).code, 2)
  assert.equal(sb.hub(['check', missing, '--round', '1', '--json'], { cwd: ctx.root }).code, 2)
  assert.equal(sb.hub(['check', ctx.planFile], { cwd: ctx.root }).code, 2)
  assert.equal(sb.hub(['check', '--skills', sb.path('none')]).code, 2)
  assert.equal(sb.hub(['check', ctx.planFile, '--round', '1', '--lock', ctx.planFile], { cwd: ctx.root }).code, 2)
})

test('a planned file missing from staging is an error', () => {
  const ctx = prepare(sb)
  ctx.plan({ service: { files: [overlay()] } })
  const r = sb.hub(['check', ctx.planFile, '--round', '1'], { cwd: ctx.root })
  assert.equal(r.code, 1)
  assert.match(r.output, /nothing written/)
})
