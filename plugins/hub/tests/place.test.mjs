import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { sandbox } from './helper.mjs'
import { overlayText, pageText, stage } from './gate-fixture.mjs'
import { page } from './plan-fixture.mjs'
import { CONFIG, RELEASE, REASON, RUN_TESTS, approvedRun, g1, lockedExtra, p1, p2, releaseText, s1, x1 } from './run-fixture.mjs'

const sb = sandbox()
after(() => sb.cleanup())

const home = ['', 'Users', 'someone', 'notes.txt'].join('/')
const reasons = run => run.ctx.readPlan().repos.service.files.filter(f => f.action === 'dropped').map(f => f.reason)

test('place copies what is approved, byte for byte, and records it (GEN-18)', () => {
  const run = approvedRun(sb, [s1(), p1(), p2({ action: 'dropped', reason: 'review' })])
  const r = run.place()
  assert.equal(r.code, 0, r.output)
  assert.deepEqual(run.status().sort(), ['.claude/skills/working-in-service/SKILL.md', CONFIG])
  assert.equal(run.read(s1().path), run.out(s1().path))
  assert.equal(run.read(CONFIG), run.out(CONFIG))
  const placed = run.placed().files
  assert.deepEqual(Object.keys(placed).sort(), ['.claude/skills/working-in-service/SKILL.md', CONFIG])
  for (const [p, info] of Object.entries(placed)) assert.equal(info.placed, run.hash(p))
})

test('update and delete keep the previous blob, which git finds (GEN-18)', () => {
  const u1 = { ...p1(), id: 'u1', action: 'update' }
  const d1 = { id: 'd1', path: RELEASE, action: 'delete', kind: 'page', why: 'the release flow is gone' }
  const run = approvedRun(sb, [u1, d1], { extra: lockedExtra(), texts: { [CONFIG]: '# Configuration\n\nThe service reads `DB_URL` and nothing else.\n' } })
  const r = run.place()
  assert.equal(r.code, 0, r.output)
  assert.equal(run.read(CONFIG), run.out(CONFIG))
  assert.ok(!existsSync(join(run.ctx.service, RELEASE)))
  const placed = run.placed().files
  for (const p of [CONFIG, RELEASE]) sb.git(run.ctx.service, 'cat-file', '-e', placed[p].previous)
  assert.equal(sb.git(run.ctx.service, 'cat-file', 'blob', placed[RELEASE].previous), releaseText)
})

test('a path taken after P2 stays as the person left it and is named (GEN-18)', () => {
  const run = approvedRun(sb, [s1(), p1()])
  sb.write(join(run.ctx.service, CONFIG), 'Mine.\n')
  const r = run.place()
  assert.equal(r.code, 1)
  assert.match(r.output, /configuration\.md[\s\S]*taken after P2/)
  assert.equal(run.read(CONFIG), 'Mine.\n')
})

test('place writes the offers and records the target of each proposal (GEN-19)', () => {
  const run = approvedRun(sb, [s1(), x1(), g1()])
  const before = run.read('CLAUDE.md')
  const r = run.place()
  assert.equal(r.code, 0, r.output)
  const proposals = join(run.ctx.root, '.hub-run', 'proposals', 'service')
  const line = x1().text
  assert.equal(readFileSync(join(proposals, 'x1.proposed'), 'utf8'), before + line + '\n')
  assert.deepEqual(JSON.parse(readFileSync(join(proposals, 'g1.proposed'), 'utf8')).permissions.deny, g1().deny)
  assert.equal(run.placed().proposals.x1.target, run.hash('CLAUDE.md'))
  assert.equal(run.placed().proposals.g1.target, null)
  assert.equal(run.read('CLAUDE.md'), before)
  assert.ok(!existsSync(join(run.ctx.service, '.claude', 'settings.json')))
  assert.deepEqual(run.status(), ['.claude/skills/working-in-service/SKILL.md'])
})

test('place lists a writer proposal next to the offers, so P3 can show it (GEN-20)', () => {
  const r1 = { id: 'r1', path: 'README.md', action: 'propose', kind: 'page', type: 'overview', trigger: 'always', facts: ['F1'], why: 'the team wrote the README' }
  const run = approvedRun(sb, [s1(), x1(), r1])
  const file = sb.write(join(run.ctx.root, '.hub-run', 'proposals', 'service', 'r1.proposed'), '# Service\n')
  const r = run.place()
  assert.equal(r.code, 0, r.output)
  assert.deepEqual(r.json().proposals.map(p => [p.id, p.path]).sort(), [['r1', 'README.md'], ['x1', 'CLAUDE.md']])
  assert.equal(r.json().proposals.find(p => p.id === 'r1').file, file)
})

test('a line whose target was dropped, in the rounds or by place, is dropped too (CON-19)', () => {
  for (const how of ['rounds', 'place']) {
    const files = how === 'rounds' ? [s1(), p1(), x1()] : [s1(), p1(), x1()]
    if (how === 'rounds') Object.assign(files[0], { action: 'dropped', reason: 'review' })
    const run = approvedRun(sb, files, { texts: how === 'place' ? { [s1().path]: overlayText(`\nRead ${home} first.\n`) } : {} })
    const before = run.read('CLAUDE.md')
    const r = run.place()
    assert.equal(r.code, how === 'place' ? 1 : 0, r.output)
    assert.ok(!existsSync(join(run.ctx.root, '.hub-run', 'proposals', 'service', 'x1.proposed')))
    assert.equal(`${run.entry('x1').action} ${run.entry('x1').reason}`, 'dropped target-dropped')
    assert.equal(run.read('CLAUDE.md'), before)
    for (const reason of reasons(run)) assert.match(reason, REASON)
  }
})

test('place refuses a plan that is not approved and leaves the repo as in its snapshot (GEN-13)', () => {
  const run = approvedRun(sb, [s1(), p1()], { approved: false })
  const r = run.place()
  assert.equal(r.code, 2)
  assert.equal(run.statusZ(), run.snapshot())
  assert.ok(!existsSync(join(run.ctx.root, '.hub-run', 'placed.json')))
})

test('a file that never converged is not placed; its sister is copied as staged (PUE-11)', () => {
  const run = approvedRun(sb, [p1(), p2()])
  stage(sb, run.ctx, CONFIG, readFileSync(join(run.ctx.root, '.hub-run', 'out', 'service', CONFIG), 'utf8') + '\n## Limits\n')
  assert.equal(run.check(1).code, 1)
  assert.equal(run.check(2).code, 1)
  assert.match(run.entry('p1').reason, /^gate:/)
  assert.equal(run.place().code, 0)
  assert.deepEqual(run.status(), [RUN_TESTS])
  assert.equal(run.read(RUN_TESTS), run.out(RUN_TESTS))
})

test('a finding kept in round 2 keeps its file out (PUE-11)', () => {
  const run = approvedRun(sb, [p1(), p2()])
  const findings = sb.write(
    join(run.ctx.root, '.hub-run', 'findings.jsonl'),
    JSON.stringify({ file: CONFIG, text: 'Wrong.', problem: 'false', evidence: [{ path: 'src/config.ts', quote: 'dbUrl: process.env.DB_URL' }] }) + '\n',
  )
  const r = sb.hub(['review', '--repo', 'service', '--in', findings, '--round', '2'], { cwd: run.ctx.root })
  assert.equal(r.code, 1)
  assert.equal(`${run.entry('p1').action} ${run.entry('p1').reason}`, 'dropped review')
  assert.equal(run.place().code, 0)
  assert.deepEqual(run.status(), [RUN_TESTS])
})

test('place gates every file again and drops what fails (PUE-11)', () => {
  const run = approvedRun(sb, [s1(), p1(), p2()])
  stage(sb, run.ctx, CONFIG, `# Configuration\n\nThe settings live in ${home} on a laptop.\n`)
  stage(sb, run.ctx, RUN_TESTS, '# Run the tests\n\nHow to run them.\n\n## Before you begin\n\nNothing.\n\n## Steps\n\n```\nnpm test\n```\n\n## Verify\n\nIt passes.\n')
  const r = run.place()
  assert.equal(r.code, 1, r.output)
  assert.deepEqual(Object.keys(run.placed().files), ['.claude/skills/working-in-service/SKILL.md'])
  assert.equal(`${run.entry('p1').action} ${run.entry('p1').reason}`, 'dropped gate:scan')
  assert.equal(`${run.entry('p2').action} ${run.entry('p2').reason}`, 'dropped gate:docs')
  assert.deepEqual(run.status(), ['.claude/skills/working-in-service/SKILL.md'])
  for (const reason of reasons(run)) assert.match(reason, REASON)
})

// An index that links to p1 and p2 while p2 was dropped in review, and an overlay that names it.
const INDEX = 'docs/index.md'
const SKILL = s1().path
const toConfig = '- [Configuration](reference/configuration.md) for the settings.'
const toTests = '[Run the tests](how-to/run-tests.md) before a change.'
function indexRun(intro, list) {
  const files = [s1(), page('i1', INDEX, 'overview', null), p1(), p2({ action: 'dropped', reason: 'review' })]
  const index = pageText('Service', [['## Where to start', list]], intro)
  return approvedRun(sb, files, { texts: { [SKILL]: overlayText('\nStart from `docs/index.md`.\n'), [INDEX]: index } })
}
const checkLock = run => sb.hub(['check', '--lock', '.claude/hub.lock.json'], { cwd: run.ctx.service })

test('place prunes what in an index links to a dropped page and keeps the rest (PUE-11)', () => {
  // The second list loses its only item, so its introduction goes with it.
  const run = indexRun(`This page is the entry point. See ${toTests}`, `${toConfig}\n- ${toTests}\n\nBefore a change:\n\n- ${toTests}`)
  const r = run.place()
  assert.equal(r.code, 0, r.output)
  assert.match(r.output, /removed 2 list lines and 2 sentences that linked to dropped pages/)
  assert.deepEqual(run.status().sort(), [SKILL, INDEX, CONFIG].sort())
  assert.equal(run.read(INDEX), `# Service\n\nThis page is the entry point.\n\n## Where to start\n\n${toConfig}\n`)
  assert.equal(run.finish('--keep', 'all').code, 0)
  const lock = checkLock(run)
  assert.equal(lock.code, 0, lock.output)
})

test('what names a file that place drops is dropped too, until nothing more drops (PUE-11)', () => {
  // A paragraph of two lines is not pruned: its link fails the docs gate.
  const run = indexRun(`This page is the entry point,\nand ${toTests}`, toConfig)
  const r = run.place()
  assert.equal(r.code, 1, r.output)
  assert.equal(`${run.entry('i1').action} ${run.entry('i1').reason}`, 'dropped gate:docs')
  assert.equal(`${run.entry('s1').action} ${run.entry('s1').reason}`, 'dropped gate:skills')
  assert.deepEqual(run.status(), [CONFIG])
  for (const reason of reasons(run)) assert.match(reason, REASON)
  assert.equal(run.finish('--keep', 'all').code, 0)
  const lock = checkLock(run)
  assert.equal(lock.code, 0, lock.output)
})

test('place exits 2 once the run is finished', () => {
  const run = approvedRun(sb, [s1()])
  sb.write(join(run.ctx.root, '.hub-run', 'done.json'), '{}\n')
  assert.equal(run.place().code, 2)
  assert.deepEqual(run.status(), [])
})
