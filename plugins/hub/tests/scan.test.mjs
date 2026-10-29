import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { logNames, parseTerms } from '../scripts/lib/scan.mjs'
import { IDENTITY, makeWorkspace, sandbox } from './helper.mjs'

const sb = sandbox()
after(() => sb.cleanup())

// Sensitive inputs are built at run time, piece by piece (design 15.8.130).
const homePath = ['', 'Users', 'someone', 'project', 'notes.txt'].join('/')
const email = ['ana', 'corp-mail.io'].join('@')
const privateKey = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ') + '\nMIIEabc\n' + ['-----END', 'RSA PRIVATE KEY-----'].join(' ')

const TERMS = ['acme widget', 're:gr[ae]y\\s+goose', 'cs:BlueFox', 'zephyrine'].join('\n') + '\n'

test('scan errors name each finding; examples, synthetic roots and other-case cs: lines pass (PUE-6)', () => {
  const w = makeWorkspace(sb, { at: sb.path('scan-errors', 'w'), repos: ['service'] })
  const dir = sb.path('scan-errors', 'files')
  const files = {
    'home.md': `Notes live in ${homePath}.\n`,
    'email.md': `Write to ${email} for access.\n`,
    'author.md': `Written by ${IDENTITY.name} last spring.\n`,
    'key.txt': `${privateKey}\n`,
    'split.md': 'The acme\nwidget ships weekly.\n',
    'case.md': 'The ACME WIDGET ships weekly.\n',
    're.md': 'A GREY GOOSE flies.\n',
    'cs.md': 'The BlueFox team.\n',
    'zephyrine.txt': 'Nothing to see.\n',
    'cs-other.md': 'The bluefox team.\n',
    'clean.md': ['noreply@github.com', 'dev@example.com', 'ops@mail.example.org', '/w/service', '/x/work'].join('\n') + '\n',
  }
  for (const [name, text] of Object.entries(files)) sb.write(join(dir, name), text)
  const terms = sb.write(sb.path('scan-errors', 'terms.txt'), TERMS)
  const r = sb.hub(['scan', dir, '--authors', w.service, '--terms', terms, '--json'], { cwd: sb.path('scan-errors') })
  assert.equal(r.code, 1, r.output)
  const errors = r.json().errors
  const flagged = new Set(errors.map(e => e.path.split('/').pop()))
  for (const name of ['home.md', 'email.md', 'author.md', 'key.txt', 'split.md', 'case.md', 're.md', 'cs.md', 'zephyrine.txt']) {
    assert.ok(flagged.has(name), `${name} not flagged: ${r.output}`)
  }
  assert.ok(!flagged.has('cs-other.md'), 'a cs: line keeps case')
  assert.ok(!flagged.has('clean.md'), JSON.stringify(errors.filter(e => e.path.endsWith('clean.md'))))
  assert.ok(errors.some(e => e.path.endsWith('zephyrine.txt') && /in the file name/.test(e.message)))
  assert.ok(errors.some(e => e.path.endsWith('author.md') && e.message.includes(IDENTITY.name)))
})

test('a temporary file with a path inside a personal folder fails and is named', () => {
  const file = sb.write(sb.path('scan-home', 'page.md'), `See ${homePath}.\n`)
  const r = sb.hub(['scan', file])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /page\.md: line 1: a path inside a personal folder/)
})

test('a path git ignores is scanned when passed as an argument, not when its repo is scanned', () => {
  const w = makeWorkspace(sb, { at: sb.path('scan-ignored', 'w'), repos: ['service'] })
  sb.write(join(w.service, '.hub-run', '.gitignore'), '*\n')
  sb.write(join(w.service, '.hub-run', 'out', 'service', 'docs', 'index.md'), `# Docs\n\nAsk ${email}.\n`)
  const direct = sb.hub(['scan', '.hub-run/out/service', '--json'], { cwd: w.service })
  assert.equal(direct.code, 1, direct.output)
  assert.match(direct.json().errors[0].path, /\.hub-run\/out\/service\/docs\/index\.md$/)
  const whole = sb.hub(['scan', '.', '--json'], { cwd: w.service })
  assert.equal(whole.code, 0, whole.output)
})

test('outside a repo the walk skips .git and node_modules', () => {
  const dir = sb.path('scan-walk')
  sb.write(join(dir, 'node_modules', 'x', 'a.md'), `${email}\n`)
  sb.write(join(dir, 'ok.md'), 'Nothing here.\n')
  assert.equal(sb.hub(['scan', dir]).code, 0)
})

test('terms: plain terms ignore case and spacing, re: ignores case, cs: keeps it', () => {
  const [plain, re, cs] = parseTerms('acme  widget\nre:gr[ae]y\ncs:BlueFox\n# a comment\n\n')
  assert.ok(plain.re.test('ACME widget'))
  assert.ok(re.re.test('GREY'))
  assert.ok(cs.re.test('BlueFox') && !cs.re.test('bluefox'))
  // In CI the terms are a secret: findings name the line, never the term.
  assert.deepEqual([plain.label, cs.label], ['line 1 of the terms file', 'line 3 of the terms file'])
  assert.throws(() => parseTerms('re:BlueFox(\n'), (err) => !err.message.includes('BlueFox'))
})

test('the committer of merges made on github.com is no author; other one-word names are (PUE-6)', () => {
  const web = ['GitHub', ['noreply', 'github.com'].join('@')]
  const log = [
    [IDENTITY.name, IDENTITY.email, ...web],
    ['Builder', 'builder@example.com', 'Builder', 'builder@example.com'],
  ]
  assert.deepEqual(logNames(log.map(l => l.join('\0')).join('\n') + '\n').sort(), [IDENTITY.name, 'Builder'].sort())
})

test('GUIDs and IPv4 addresses are warnings', () => {
  const guid = ['123e4567', 'e89b', '12d3', 'a456', '426614174000'].join('-')
  const ip = [10, 1, 2, 3].join('.')
  const file = sb.write(sb.path('scan-warn', 'a.md'), `Id ${guid} on ${ip}.\n`)
  const r = sb.hub(['scan', file, '--json'])
  assert.equal(r.code, 0, r.output)
  assert.equal(r.json().warnings.length, 2)
})

test('a package name that contains auth-token is not a secret; a key that is one still is (PUE-6)', () => {
  const dir = sb.path('scan-names')
  const value = ['s3cr', 'etValue9'].join('')
  sb.write(join(dir, 'package-lock.json'), '{\n  "dependencies": {\n    "registry-auth-token": "^5.0.1"\n  }\n}\n')
  sb.write(join(dir, 'config.json'), `{\n  "auth-token": "${value}"\n}\n`)
  const r = sb.hub(['scan', dir, '--json'], { cwd: dir })
  assert.deepEqual(r.json().errors.map(e => e.path.split('/').pop()), ['config.json'], r.output)
})
