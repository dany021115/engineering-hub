import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { stagingFile } from '../scripts/lib/paths.mjs'
import { stage } from './gate-fixture.mjs'
import { sandbox } from './helper.mjs'
import { overlay, page, prepare } from './plan-fixture.mjs'
import { blob } from './run-fixture.mjs'

const sb = sandbox()
after(() => sb.cleanup())

const valid = { path: 'src/config.ts', quote: 'dbUrl: process.env.DB_URL' }
const invented = { path: 'src/config.ts', quote: 'dbUrl: process.env.DATABASE_URL' }
const finding = (file, evidence, problem = 'false') => ({ file, text: 'The page says otherwise.', problem, evidence, fix: 'Say what the code does.' })

function setup() {
  const ctx = prepare(sb)
  const p1 = page('p1', 'docs/reference/configuration.md', 'reference', 'reads-env-vars')
  const p2 = page('p2', 'docs/how-to/run-tests.md', 'how-to', 'tests-need-setup')
  ctx.plan({ service: { files: [overlay(), p1, p2] } }, { approved: true })
  const review = (findings, round = 1) => {
    const file = sb.write(join(ctx.root, '.hub-run', `findings-${round}.jsonl`), findings.map(f => JSON.stringify(f) + '\n').join(''))
    return sb.hub(['review', '--repo', 'service', '--in', file, '--round', String(round), '--json'], { cwd: ctx.root })
  }
  const entry = id => ctx.readPlan().repos.service.files.find(f => f.id === id)
  return { ctx, p1, p2, review, entry }
}

test('a finding that cites a staging path exits 2 and names it; the plan path is processed (GEN-17)', () => {
  const { review } = setup()
  const staging = 'out/service/_claude/skills/working-in-service/SKILL.md'
  let r = review([finding(staging, [valid])])
  assert.equal(r.code, 2)
  assert.match(r.stderr, new RegExp(staging.replace(/[./]/g, '\\$&')))
  r = review([finding(overlay().path, [valid])])
  assert.ok([0, 1].includes(r.code), r.output)
})

test('an invented quote is discarded and a valid one kept; nothing is dropped in round 1 (PUE-11)', () => {
  const { p1, review, entry } = setup()
  let r = review([finding(p1.path, [invented]), finding(p1.path, [valid])])
  assert.equal(r.code, 1, r.output)
  assert.equal(r.json().kept, 1)
  assert.equal(r.json().discarded, 1)
  assert.equal(entry('p1').action, 'create')
  r = review([finding(p1.path, [invented])])
  assert.equal(r.code, 0, r.output)
})

test('a finding kept in round 2 drops its entry with reason review (PUE-11)', () => {
  const { ctx, p1, review, entry } = setup()
  const r = review([finding(p1.path, [valid])], 2)
  assert.equal(r.code, 1)
  assert.equal(`${entry('p1').action} ${entry('p1').reason}`, 'dropped review')
  assert.equal(entry('p2').action, 'create')
  assert.ok(existsSync(join(ctx.root, '.hub-run', 'review', 'service-2.jsonl')))
})

test('wrong-command needs a citation too; an absence counts', () => {
  const { p2, review } = setup()
  assert.equal(review([finding(p2.path, [], 'wrong-command')]).code, 0)
  assert.equal(review([finding(p2.path, [{ absence: 'npm run e2e', pathspec: '.github/workflows/' }], 'wrong-command')]).code, 1)
  assert.equal(review([finding(p2.path, [], 'unsupported')]).code, 1)
})

test('a skill that repeats a planned how-to is kept without a citation and dropped in round 2 (CON-7)', () => {
  const { review, entry } = setup()
  const skill = overlay()
  assert.equal(review([finding(skill.path, [], 'duplicates-page')]).code, 1)
  assert.equal(entry(skill.id).action, 'create')
  assert.equal(review([finding(skill.path, [], 'duplicates-page')], 2).code, 1)
  assert.equal(`${entry(skill.id).action} ${entry(skill.id).reason}`, 'dropped review')
})

test('in round 2 a finding about one sentence takes only it out of the staged file; one it cannot drops the entry (PUE-11)', () => {
  const { ctx, p1, p2, review, entry } = setup()
  stage(sb, ctx, p1.path, '# Configuration\n\nThe service reads its settings. It also reads `DB_URL` from a vault.\n\n## Settings\n\n- `DB_URL` in `src/config.ts`.\n- A wrong bullet.\n')
  stage(sb, ctx, p2.path, '# Run the tests\n\nThis page shows how to run them.\n\n## Steps\n\n1. A wrong step.\n2. Run the suite.\n')
  const about = (file, text) => ({ ...finding(file, [valid]), text })
  const texts = ['It also reads `DB_URL` from a vault.', 'A wrong bullet.']
  const r = review([...texts.map(t => about(p1.path, t)), about(p2.path, 'A wrong step.')], 2)
  assert.equal(r.code, 1, r.output)
  assert.equal(entry('p1').action, 'create')
  assert.equal(readFileSync(stagingFile(ctx.root, 'service', p1.path), 'utf8'), '# Configuration\n\nThe service reads its settings.\n\n## Settings\n\n- `DB_URL` in `src/config.ts`.\n')
  assert.deepEqual(r.json().trimmed, [{ id: 'p1', path: p1.path, texts }])
  // A numbered step is part of a procedure: the entry goes whole.
  assert.equal(`${entry('p2').action} ${entry('p2').reason}`, 'dropped review')
})

test('a citation or a sentence quoted with HTML entities still names its text (design 15.8.175)', () => {
  const { ctx, p1, review, entry } = setup()
  stage(sb, ctx, p1.path, '# Configuration\n\nThe service reads its settings.\n\n`<database-url>` is the URL of the database.\n')
  const escaped = { path: 'package.json', quote: '&quot;test&quot;: &quot;node --test&quot;' }
  let r = review([finding(p1.path, [escaped])])
  assert.equal(r.code, 1, r.output)
  assert.deepEqual([r.json().kept, r.json().discarded], [1, 0])
  r = review([{ ...finding(p1.path, [valid]), text: '`&lt;database-url&gt;` is the URL of the database.' }], 2)
  assert.equal(r.code, 1, r.output)
  assert.equal(entry('p1').action, 'create')
  assert.equal(readFileSync(stagingFile(ctx.root, 'service', p1.path), 'utf8'), '# Configuration\n\nThe service reads its settings.\n')
})

test('a finding on a line the person wrote into a file they edited is left to them (GEN-25)', () => {
  const path = 'docs/reference/configuration.md'
  const generated = '# Configuration\n\nThe service reads `DB_URL` in `src/config.ts`.\n'
  const lock = { schema: 1, generator: 'hub@0.1.0', documentedCommit: '0'.repeat(40), settings: { language: 'en', docsDir: 'docs', scanAllow: [] }, files: { [path]: { kind: 'page', type: 'reference', hash: blob(generated), sources: {} } } }
  const ctx = prepare(sb, { extra: { service: { [path]: generated, '.claude/hub.lock.json': JSON.stringify(lock) + '\n' } } })
  sb.write(join(ctx.service, path), generated + '\nAsk a teammate for the env file.\n')
  const e1 = { id: 'e1', path, action: 'propose', kind: 'page', type: 'reference', trigger: 'reads-env-vars', why: 'edited by hand', facts: ['F2'] }
  ctx.plan({ service: { files: [e1] } }, { mode: 'refresh', approved: true })
  const findings = [
    { file: path, text: 'Ask a teammate for the env file.', problem: 'unsupported', evidence: [], fix: 'Drop it.' },
    { ...finding(path, [valid]), text: 'The service reads `DB_URL` in `src/config.ts`.' },
  ]
  const file = sb.write(join(ctx.root, '.hub-run', 'findings-own.jsonl'), findings.map(f => JSON.stringify(f) + '\n').join(''))
  const r = sb.hub(['review', '--repo', 'service', '--in', file, '--round', '1', '--json'], { cwd: ctx.root })
  assert.equal(r.code, 1, r.output)
  const out = r.json()
  assert.deepEqual([out.kept, out.left], [1, 1])
  assert.match(JSON.stringify(out.warnings), /left to the person, on a line they wrote by hand: unsupported: Ask a teammate/)
})
