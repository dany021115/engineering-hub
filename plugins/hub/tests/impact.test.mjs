import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { readFirstHeadings } from '../scripts/lib/impact.mjs'
import { sandbox } from './helper.mjs'
import { cloneAlone, CONFIG, INTERFACES, lockedWorkspace, SERVICE_SKILL, WEB_SKILL } from './workspace-fixture.mjs'

const sb = sandbox()
after(() => sb.cleanup())

let n = 0
const ws = (opts = {}) => lockedWorkspace(sb, { at: sb.path(`imp-${++n}`), ...opts })
const impact = (dir, ...flags) => sb.hub(['impact', '--repo', dir, ...flags])
const status = dir => sb.git(dir, 'status', '--porcelain')
const append = (dir, path, text) => sb.write(join(dir, path), readFileSync(join(dir, path), 'utf8') + text)
const filesOf = (r, path) => r.json().paths.find(p => p.path === path).files
const VERIFY_LINE = 'Run `npm test` after `npm ci`, as the pull-request workflow does.'

describe('a read-only subcommand (IMP-1)', () => {
  test('read only', () => {
    const w = ws()
    const before = [status(w.service), status(w.web)]
    const r = impact(w.service, '--paths', 'src/config.ts', '--json')
    assert.equal(r.code, 0, r.output)
    assert.deepEqual([status(w.service), status(w.web)], before)
    assert.equal(existsSync(join(w.service, '.hub-run')), false)
  })

  test('no lock', () => {
    const dir = sb.initRepo(sb.path('imp-nolock', 'x'), { 'a.txt': 'a\n' })
    const r = impact(dir)
    assert.equal(r.code, 2)
    assert.match(r.stderr, /run \/hub:init first/)
    const u = sb.hub(['impact'])
    assert.equal(u.code, 2)
    assert.match(u.stderr, /usage: hub\.mjs impact --repo/)
  })

  test('working tree', () => {
    const w = ws()
    append(w.service, 'src/config.ts', 'export const port = 8080\n')
    sb.write(join(w.service, 'src/new.ts'), 'export const fresh = true\n')
    const r = impact(w.service, '--json')
    assert.equal(r.code, 0, r.output)
    assert.deepEqual(r.json().paths.map(p => p.path).sort(), ['src/config.ts', 'src/new.ts'])
  })

  test('workspace root', () => {
    const w = ws()
    const r = impact(w.w, '--paths', 'web/src/client.ts', '--json')
    assert.equal(r.code, 0, r.output)
    assert.equal(r.json().repo, 'web')
    assert.deepEqual(filesOf(r, 'src/client.ts').map(f => [f.repo, f.path]), [['service', INTERFACES]])
  })
})

describe('what cites each file (IMP-2)', () => {
  test('source and page', () => {
    const r = impact(ws().service, '--paths', 'src/config.ts', '--json')
    assert.equal(r.code, 0, r.output)
    const page = filesOf(r, 'src/config.ts').find(f => f.path === CONFIG)
    assert.deepEqual([page.repo, page.kind, page.type, page.state], ['service', 'page', 'reference', 'up to date'])
  })

  test('cited by the home', () => {
    const r = impact(ws().web, '--paths', 'src/client.ts', '--json')
    assert.equal(r.code, 0, r.output)
    assert.deepEqual(
      filesOf(r, 'src/client.ts').map(f => [f.repo, f.path]),
      [['service', INTERFACES]],
    )
  })

  test('edited page', () => {
    const w = ws()
    append(w.service, CONFIG, '\nA line of mine.\n')
    const r = impact(w.service, '--paths', 'src/config.ts', '--json')
    assert.equal(filesOf(r, 'src/config.ts').find(f => f.path === CONFIG).state, 'may be out of date')
  })

  test('sections to read', () => {
    let r = impact(ws().service, '--paths', 'src/app.ts', '--json')
    assert.equal(r.code, 0, r.output)
    const skill = filesOf(r, 'src/app.ts').find(f => f.repo === 'web' && f.path === WEB_SKILL)
    assert.ok(skill, r.output)
    assert.ok(skill.read.includes(`${WEB_SKILL}#Changes that cross repos`), JSON.stringify(skill))
    r = impact(ws({ language: 'es' }).service, '--paths', 'src/app.ts', '--json')
    assert.deepEqual(filesOf(r, 'src/app.ts').find(f => f.path === WEB_SKILL).read, [WEB_SKILL])
  })

  test('the read-first sections come from the skeletons', () => {
    assert.deepEqual(readFirstHeadings(), ['Guardrails', 'Changes that cross repos', 'Before you change it', 'Before you begin', 'Rules', 'Safe path'])
  })
})

describe('other repos, said as they are (IMP-3)', () => {
  test('text of another repo', () => {
    const r = impact(ws().web, '--paths', 'src/client.ts')
    assert.equal(r.code, 0, r.output)
    assert.match(r.stdout, /a generated file of service cites this file: service\/docs\/workspace\/interfaces\.md/)
  })

  test('home alone', () => {
    const alone = cloneAlone(sb, ws().web, 'web')
    let r = impact(alone, '--paths', 'src/client.ts', '--json')
    assert.equal(r.code, 0, r.output)
    assert.match(JSON.stringify(r.json().warnings), /service is not next to this repository, so its generated files were not checked/)
    r = impact(alone, '--paths', 'src/client.ts')
    assert.match(r.stdout, /^unknown: service is not next to this repository/m)
  })
})

describe('what to run (IMP-4)', () => {
  test('covered', () => {
    const r = impact(ws().service, '--paths', 'src/config.ts', '--json')
    assert.equal(r.code, 0, r.output)
    assert.equal(r.json().verifyFrom, SERVICE_SKILL)
    assert.ok(r.json().verify.includes(VERIFY_LINE), r.output)
  })

  test('not covered', () => {
    const r = impact(ws().service, '--paths', 'src/new.ts')
    assert.equal(r.code, 0, r.output)
    assert.match(r.stdout, /^ {2}not covered: run the full Verify like CI set$/m)
  })

  test('generated path', () => {
    const r = impact(ws().service, '--paths', CONFIG, '--json')
    assert.ok(r.json().verify.includes('hub.mjs check --lock .claude/hub.lock.json'), r.output)
  })

  test('an edited working-in skill is marked, and without one the CI files stand in', () => {
    const w = ws()
    append(w.service, SERVICE_SKILL, '\nA line of mine.\n')
    let r = impact(w.service, '--paths', 'src/config.ts', '--json')
    assert.ok(r.json().verify.includes(`${VERIFY_LINE} (edited by hand since it was generated)`), r.output)
    const lockFile = join(w.service, '.claude', 'hub.lock.json')
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
    delete lock.files[SERVICE_SKILL]
    sb.write(lockFile, JSON.stringify(lock, null, 2) + '\n')
    r = impact(w.service, '--paths', 'src/new.ts', '--json')
    assert.equal(r.json().verifyFrom, 'CI workflows')
    assert.ok(r.json().verify.includes('.github/workflows/ci.yml'), r.output)
    r = impact(w.service, '--paths', 'src/new.ts')
    assert.match(r.stdout, /not covered: run every CI workflow/)
  })
})

test('the owners by path, never by name (IMP-5)', () => {
  const w = ws()
  const handle = '@' + ['team', 'owner'].join('-')
  sb.write(join(w.service, '.github', 'CODEOWNERS'), `* ${handle}\n`)
  sb.commit(w.service, 'owners')
  let r = impact(w.service, '--paths', 'src/config.ts', '--json')
  assert.equal(r.json().owners, '.github/CODEOWNERS')
  r = impact(w.service, '--paths', 'src/config.ts')
  assert.match(r.stdout, /^owners: see \.github\/CODEOWNERS$/m)
  assert.ok(!r.stdout.includes(handle) && !r.stderr.includes(handle))
})
