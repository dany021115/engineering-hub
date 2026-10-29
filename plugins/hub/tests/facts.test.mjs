import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { makeWorkspace, sandbox } from './helper.mjs'

const sb = sandbox()
after(() => sb.cleanup())
let n = 0

const SRC = {
  'src/a.ts': 'export const handler = () => null\n',
  'src/b.ts': 'export const handler = () => null\n',
  'src/c.ts': 'export const handler = () => null\n',
  '.editorconfig': 'root = true\n[*]\nindent_style = space\n',
}

// A prepared run on /w/service (one repo), or on /w (workspace) when `workspace` is set.
function prepared({ extra = {}, workspace = false } = {}) {
  const w = makeWorkspace(sb, { at: sb.path(`w${++n}`, 'w'), extra: { service: { ...SRC, ...extra } } })
  const root = workspace ? w.w : w.service
  const args = workspace ? ['--repo', w.service, '--repo', w.web, '--repo', w.infra] : ['--repo', w.service]
  const r = sb.hub(['start', ...args], { cwd: root })
  assert.equal(r.code, 0, r.stderr)
  return { ...w, root }
}

const fact = (id, kind, evidence, claim = `claim of ${id}`) => ({ type: 'fact', id, kind, claim, evidence })
const ci = { path: '.github/workflows/ci.yml', quote: 'run: npm test' }

function writeFacts(root, name, items) {
  sb.write(join(root, '.hub-run', 'facts', `${name}.jsonl`), items.map(i => JSON.stringify(i) + '\n').join(''))
}
const readJsonl = file =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
const checked = (root, name) => readJsonl(join(root, '.hub-run', 'facts', `${name}.checked.jsonl`))
const ids = (root, name) => checked(root, name).filter(i => i.type === 'fact').map(i => i.id)

describe('facts: quotes in HEAD (GEN-9)', () => {
  test('a made-up quote and one only in the modified copy are rejected with reasons, exit 1', () => {
    const w = prepared()
    sb.write(join(w.service, 'src/app.ts'), 'export function start() {\n  return "only in the working tree"\n}\n')
    writeFacts(w.root, 'service', [
      fact('F1', 'command', [ci]),
      fact('F2', 'config', [{ path: 'src/config.ts', quote: 'process.env.NEVER_THERE' }]),
      fact('F4', 'gotcha', [{ path: 'src/app.ts', quote: 'only in the working tree' }]),
    ])
    const r = sb.hub(['facts', '--repo', 'service', '--json'], { cwd: w.root })
    assert.equal(r.code, 1)
    const out = r.json()
    assert.deepEqual(out.rejected.map(x => x.id).sort(), ['F2', 'F4'])
    assert.ok(out.rejected.every(x => /quote not found in HEAD/.test(x.reason)))
    assert.deepEqual(ids(w.root, 'service'), ['F1'])
  })

  test('a quote written with HTML entities is found in HEAD (design 15.8.175)', () => {
    const w = prepared()
    writeFacts(w.root, 'service', [fact('F1', 'command', [{ path: 'package.json', quote: '&quot;test&quot;: &quot;node --test&quot;' }])])
    const r = sb.hub(['facts', '--repo', 'service', '--json'], { cwd: w.root })
    assert.equal(r.code, 0, r.output)
    assert.deepEqual(ids(w.root, 'service'), ['F1'])
  })

  test('the docs folder and the lock are rejected as evidence; a location may cite README.md', () => {
    const w = prepared({
      extra: {
        'docs/how-to/run-tests.md': '# Run tests\n\nRun `npm run test:all` first.\n',
        '.claude/hub.lock.json': '{ "schema": 1, "files": {} }\n',
      },
    })
    writeFacts(w.root, 'service', [
      fact('F1', 'command', [{ path: 'docs/how-to/run-tests.md', quote: 'npm run test:all' }]),
      fact('F2', 'command', [{ path: '.claude/hub.lock.json', quote: '"schema": 1' }]),
      fact('F3', 'location', [{ path: 'README.md', quote: 'The service answers API calls.' }]),
    ])
    const out = sb.hub(['facts', '--repo', 'service', '--json'], { cwd: w.root }).json()
    const reasons = Object.fromEntries(out.rejected.map(x => [x.id, x.reason]))
    assert.match(reasons.F1, /docs folder/)
    assert.match(reasons.F2, /lock/)
    assert.deepEqual(ids(w.root, 'service'), ['F3'])
  })

  test('an absence holds only when git grep finds nothing in HEAD', () => {
    const w = prepared()
    writeFacts(w.root, 'service', [
      fact('F7', 'negative', [{ absence: 'npm run e2e', pathspec: '.github/workflows/' }]),
      fact('F8', 'negative', [{ absence: 'npm test', pathspec: '.github/workflows/' }]),
    ])
    const r = sb.hub(['facts', '--repo', 'service', '--json'], { cwd: w.root })
    assert.equal(r.code, 1)
    assert.deepEqual(ids(w.root, 'service'), ['F7'])
  })

  test('verifier batches: at most 25 high-impact facts each, rationale in, architecture and flow out', () => {
    const w = prepared()
    const items = []
    for (let i = 1; i <= 52; i++) items.push(fact(`F${i}`, i <= 3 ? 'rationale' : 'command', [ci]))
    for (let i = 53; i <= 60; i++) items.push(fact(`F${i}`, i % 2 ? 'architecture' : 'flow', [ci]))
    writeFacts(w.root, 'service', items)
    assert.equal(sb.hub(['facts', '--repo', 'service'], { cwd: w.root }).code, 0)
    const dir = join(w.root, '.hub-run', 'batches')
    const files = readdirSync(dir).filter(f => f.startsWith('service-')).sort()
    assert.deepEqual(files, ['service-1.jsonl', 'service-2.jsonl', 'service-3.jsonl'])
    const batched = files.flatMap(f => readJsonl(join(dir, f)))
    for (const f of files) assert.ok(readJsonl(join(dir, f)).length <= 25)
    assert.equal(batched.length, 52)
    assert.equal(batched.filter(b => b.kind === 'rationale').length, 3)
    assert.equal(batched.some(b => ['architecture', 'flow'].includes(b.kind)), false)
    assert.deepEqual(Object.keys(batched[0]).sort(), ['claim', 'evidence', 'id', 'kind'])
  })

  test('facts without --repo exits 2 (GEN-3)', () => {
    const w = prepared()
    assert.equal(sb.hub(['facts'], { cwd: w.root }).code, 2)
  })
})

describe('facts: rules by kind and the cap (GEN-10, CON-7, CON-13)', () => {
  test('beyond 150, invalid quotes are rejected first and the first 150 valid kept in order', () => {
    const w = prepared()
    const bad = new Set([10, 40, 80, 120, 149])
    const items = []
    for (let i = 1; i <= 165; i++) {
      items.push(fact(`F${i}`, 'location', [bad.has(i) ? { path: 'README.md', quote: 'not in the readme at all' } : ci]))
    }
    writeFacts(w.root, 'service', items)
    const r = sb.hub(['facts', '--repo', 'service', '--json'], { cwd: w.root })
    assert.equal(r.code, 1)
    const out = r.json()
    assert.equal(out.rejected.length, 5)
    assert.equal(out.overCap, 10)
    const expected = []
    for (let i = 1; i <= 155; i++) if (!bad.has(i)) expected.push(`F${i}`)
    assert.deepEqual(ids(w.root, 'service'), expected)
  })

  test('a convention needs quotes in 3 files or one in a config file', () => {
    const w = prepared()
    const q = p => ({ path: p, quote: 'export const handler = () => null' })
    writeFacts(w.root, 'service', [
      fact('F1', 'convention', [q('src/a.ts'), q('src/b.ts')]),
      fact('F2', 'convention', [q('src/a.ts'), q('src/b.ts'), q('src/c.ts')]),
      fact('F3', 'convention', [{ path: '.editorconfig', quote: 'indent_style = space' }]),
    ])
    const r = sb.hub(['facts', '--repo', 'service', '--json'], { cwd: w.root })
    assert.equal(r.code, 1)
    const out = r.json()
    assert.deepEqual(out.rejected.map(x => x.id), ['F1'])
    assert.match(out.rejected[0].reason, /3 different files/)
    assert.deepEqual(ids(w.root, 'service'), ['F2', 'F3'])
  })

  test('a seam with quotes in one repo is rejected; one with both sides is kept', () => {
    const w = prepared({ workspace: true })
    writeFacts(w.root, '_workspace', [
      fact('F20', 'seam', [{ path: 'service:src/config.ts', quote: 'process.env.DB_URL' }]),
      fact('F21', 'seam', [
        { path: 'service:src/app.ts', quote: "import { config } from './config'" },
        { path: 'web:src/client.ts', quote: "export const API_BASE = '/api/v1'" },
      ]),
    ])
    const r = sb.hub(['facts', '--repo', '_workspace', '--json'], { cwd: w.root })
    assert.equal(r.code, 1)
    const out = r.json()
    assert.deepEqual(out.rejected.map(x => x.id), ['F20'])
    assert.match(out.rejected[0].reason, /two repositories/)
    assert.deepEqual(ids(w.root, '_workspace'), ['F21'])
  })
})

describe('verdicts (GEN-11)', () => {
  function verified(verdicts) {
    const w = prepared()
    writeFacts(w.root, 'service', [
      fact('F1', 'command', [ci]),
      fact('F2', 'config', [{ path: 'src/config.ts', quote: 'dbUrl: process.env.DB_URL' }], 'The service reads PORT.'),
      fact('F3', 'gotcha', [ci]),
    ])
    assert.equal(sb.hub(['facts', '--repo', 'service'], { cwd: w.root }).code, 0)
    const file = sb.write(join(w.root, '.hub-run', 'verdicts', 'service-1.jsonl'), verdicts.map(v => JSON.stringify(v) + '\n').join(''))
    return { w, r: sb.hub(['verdicts', '--repo', 'service', '--in', file, '--json'], { cwd: w.root }) }
  }

  test('a checked correction becomes F2c and F2 stops being supported', () => {
    const { w, r } = verified([
      { id: 'F1', verdict: 'supported' },
      {
        id: 'F2',
        verdict: 'contradicted',
        claim: 'The service reads DB_URL.',
        evidence: [{ path: 'src/config.ts', quote: 'process.env.DB_URL' }],
      },
    ])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(ids(w.root, 'service'), ['F1', 'F2c', 'F3'])
    const f2c = checked(w.root, 'service').find(i => i.id === 'F2c')
    assert.equal(f2c.claim, 'The service reads DB_URL.')
  })

  test('a made-up correction exits 1 and leaves neither F2 nor F2c', () => {
    const { w, r } = verified([
      {
        id: 'F2',
        verdict: 'contradicted',
        claim: 'The service reads PORT_NUMBER.',
        evidence: [{ path: 'src/config.ts', quote: 'process.env.PORT_NUMBER' }],
      },
    ])
    assert.equal(r.code, 1)
    assert.deepEqual(ids(w.root, 'service'), ['F1', 'F3'])
  })

  test('not-found drops the fact', () => {
    const { w, r } = verified([{ id: 'F3', verdict: 'not-found' }])
    assert.equal(r.code, 0)
    assert.deepEqual(ids(w.root, 'service'), ['F1', 'F2'])
  })
})
