import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { IDENTITY, PLUGIN, makeWorkspace, sandbox } from './helper.mjs'

const sb = sandbox()
after(() => sb.cleanup())

test('an unknown command exits 2 with usage on stderr', () => {
  const r = sb.hub(['nope'])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /unknown command: nope/)
  assert.equal(r.stdout, '')
})

test('usage errors exit 2, also with --json', () => {
  const r = sb.hub(['start', '--bogus', '--json'])
  assert.equal(r.code, 2)
  assert.equal(r.json().ok, false)
})

test('the sandbox has no global git identity and still commits with the synthetic one', () => {
  assert.equal(existsSync(join(sb.home, '.gitconfig')), false)
  assert.deepEqual(readdirSync(sb.bin).sort(), ['git', 'node'])
  const dir = sb.initRepo(sb.path('identity'), { 'a.txt': 'a\n' })
  const who = sb.git(dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>').trim()
  assert.equal(who, `${IDENTITY.name} <${IDENTITY.email}>|${IDENTITY.name} <${IDENTITY.email}>`)
  assert.match(IDENTITY.email, /@example\.com$/)
})

test('the suite runs the same without claude on the PATH', () => {
  const { service } = makeWorkspace(sb, { at: sb.path('w-noclaude') })
  const r = sb.hub(['start', '--json'], { cwd: service })
  assert.equal(r.code, 0)
})

test('scripts import only node: built-ins and relative modules, and the plugin has no package.json', () => {
  const files = []
  const walk = dir => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name)
      if (d.isDirectory()) walk(p)
      else if (p.endsWith('.mjs')) files.push(p)
    }
  }
  walk(join(PLUGIN, 'scripts'))
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/from ['"]([^'"]+)['"]/g)) {
      assert.match(m[1], /^(node:|\.\/)/, `${f} imports ${m[1]}`)
    }
  }
  assert.equal(existsSync(join(PLUGIN, 'package.json')), false)
})
