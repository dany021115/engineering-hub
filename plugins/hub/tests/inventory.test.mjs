import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { makeWorkspace, sandbox } from './helper.mjs'

const sb = sandbox()
after(() => sb.cleanup())
let n = 0
const fresh = opts => makeWorkspace(sb, { at: sb.path(`w${++n}`, 'w'), ...opts })
const inventory = (root, name) => JSON.parse(readFileSync(join(root, '.hub-run', 'inventory', `${name}.json`), 'utf8'))

function allText(dir) {
  let text = ''
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name)
    text += d.isDirectory() ? allText(p) : readFileSync(p, 'utf8')
  }
  return text
}

test('sensitive files listed unread, vendored excluded, submodules listed, env var names only (GEN-6)', () => {
  const w = fresh({
    extra: {
      service: {
        '.env.example': 'API_KEY=k-123\n',
        '.gitattributes': 'vendor/** linguist-vendored\n',
        'vendor/lib.js': 'module.exports = process.env.VENDOR_TOKEN\n',
      },
    },
  })
  const sub = sb.git(w.web, 'rev-parse', 'HEAD').trim()
  mkdirSync(join(w.service, 'lib', 'ext'), { recursive: true })
  sb.git(w.service, 'update-index', '--add', '--cacheinfo', `160000,${sub},lib/ext`)
  sb.commit(w.service, 'add a submodule')
  sb.write(join(w.service, '.env'), 'DB_URL=k-123\n')
  const r = sb.hub(['start', '--repo', w.service, '--json'], { cwd: w.service })
  assert.equal(r.code, 0, r.stderr)
  const inv = inventory(w.service, 'service')
  assert.ok(inv.sensitive.includes('.env.example'))
  assert.ok(inv.excluded.includes('vendor/'))
  assert.ok(inv.submodules.includes('lib/ext'))
  assert.deepEqual(inv.envVars, { DB_URL: ['src/config.ts'] })
  assert.equal(JSON.stringify(inv).includes('".env"'), false)
  assert.equal(allText(join(w.service, '.hub-run')).includes('k-123'), false)
})

test('folders Linguist treats as vendored are excluded without an attribute, unless one says otherwise (PUE-20)', () => {
  const files = { 'vendor/lib.js': 'x\n', 'third_party/a.py': 'x\n', 'Pods/b.m': 'x\n', 'static/app.min.js': 'x\n', 'static/app.js': 'x\n' }
  let w = fresh({ extra: { service: files } })
  assert.equal(sb.hub(['start', '--repo', w.service, '--json'], { cwd: w.service }).code, 0)
  assert.deepEqual(inventory(w.service, 'service').excluded, ['Pods/', 'static/app.min.js', 'third_party/', 'vendor/'])
  w = fresh({ extra: { service: { ...files, '.gitattributes': 'vendor/** linguist-vendored=false\n' } } })
  assert.equal(sb.hub(['start', '--repo', w.service, '--json'], { cwd: w.service }).code, 0)
  assert.deepEqual(inventory(w.service, 'service').excluded, ['Pods/', 'static/app.min.js', 'third_party/'])
})

test('an origin with user and password becomes the root URL without credentials (CON-17)', () => {
  const w = fresh()
  const secret = ['s3', 'cr', 'et'].join('')
  const user = ['us', 'er'].join('')
  const url = 'https://' + user + ':' + secret + '@' + 'git.example.com/org/web.git'
  sb.git(w.web, 'remote', 'add', 'origin', url)
  const r = sb.hub(['start', '--repo', w.service, '--repo', w.web, '--repo', w.infra, '--json'], { cwd: w.w })
  assert.equal(r.code, 0, r.stderr)
  const inv = inventory(w.w, 'web')
  assert.equal(inv.remote, 'https://git.example.com/org/web')
  const all = allText(join(w.w, '.hub-run'))
  assert.equal(all.includes(secret), false)
  assert.equal(inventory(w.w, 'infra').remote, null)
})

test('a docs folder with HTML moves the docs to documentation (CON-18)', () => {
  const w = fresh({ extra: { service: { 'docs/index.html': '<html></html>\n', 'docs/guide.md': '# Guide\n' } } })
  sb.hub(['start', '--repo', w.service], { cwd: w.service })
  assert.equal(inventory(w.service, 'service').docsDir, 'documentation')
})

test("an existing MkDocs site's docs_dir is the docs folder (CON-18)", () => {
  const w = fresh({ extra: { service: { 'mkdocs.yml': 'site_name: Service\ndocs_dir: handbook\n', 'handbook/index.md': '# Home\n' } } })
  sb.hub(['start', '--repo', w.service], { cwd: w.service })
  const inv = inventory(w.service, 'service')
  assert.equal(inv.docsDir, 'handbook')
  assert.equal(inv.docsSite, 'mkdocs')
})
