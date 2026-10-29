import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { BASE_FILES, sandbox } from './helper.mjs'
import { messages } from './gate-fixture.mjs'

const sb = sandbox()
after(() => sb.cleanup())

const blob = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex')
const email = ['ana', 'corp-mail.io'].join('@')
let n = 0

const CONFIG = 'docs/reference/configuration.md'
const clean = '# Configuration\n\nThe service reads `DB_URL` from the environment in `src/config.ts`.\n'
const faulty = clean + '\n## Limits\n'

// A service repo whose lock lists `entries`: path -> { kind, type?, archetype?, generated, sources? },
// where `generated` is the text the lock hashed (the file on disk may differ: edited by hand).
function lockRepo(files, entries, { settings = {} } = {}) {
  const lockFiles = {}
  for (const [p, e] of Object.entries(entries)) {
    const { generated, ...rest } = e
    lockFiles[p] = { sources: {}, ...rest, hash: blob(generated) }
  }
  const lock = {
    schema: 1,
    generator: 'hub@0.1.0',
    documentedCommit: '0'.repeat(40),
    settings: { language: 'en', docsDir: 'docs', scanAllow: [], ...settings },
    files: lockFiles,
  }
  const dir = sb.initRepo(sb.path(`lock-${++n}`, 'service'), {
    ...BASE_FILES.service,
    ...files,
    '.claude/hub.lock.json': JSON.stringify(lock, null, 2) + '\n',
  })
  return dir
}

const checkLock = (dir, ...flags) => sb.hub(['check', '--lock', join(dir, '.claude', 'hub.lock.json'), '--json', ...flags], { cwd: dir })

describe('edited files and site and ci entries only get the scan (PUE-1)', () => {
  const site = 'docs-site/sections.js'
  const ci = '.github/workflows/hub-check.yml'
  const siteText = "module.exports = ['TODO']\n"
  const ciText = 'name: hub-check\non: [pull_request]\n'
  const base = (pageNow, ciNow = ciText) =>
    lockRepo(
      { [CONFIG]: pageNow, [site]: siteText, [ci]: ciNow },
      {
        [CONFIG]: { kind: 'page', type: 'reference', generated: clean },
        [site]: { kind: 'site', generated: siteText },
        [ci]: { kind: 'ci', generated: ciNow },
      },
    )

  test('an edited page with an empty section and unedited site and ci entries pass', () => {
    const r = checkLock(base(faulty))
    assert.equal(r.code, 0, r.output)
    assert.deepEqual(r.json().edited, [CONFIG])
  })

  test('the same fault in an unedited page fails', () => {
    const dir = lockRepo({ [CONFIG]: faulty }, { [CONFIG]: { kind: 'page', type: 'reference', generated: faulty } })
    const r = checkLock(dir)
    assert.equal(r.code, 1)
    assert.match(messages(r).join('\n'), /section "Limits" is empty/)
  })

  test('an email in the edited page or in hub-check.yml fails', () => {
    let r = checkLock(base(`${faulty}\nWrite to ${email}.\n`))
    assert.equal(r.code, 1)
    assert.match(messages(r).join('\n'), /configuration\.md: line \d+: an email address/)
    r = checkLock(base(clean, `${ciText}# owner ${email}\n`))
    assert.equal(r.code, 1)
    assert.match(messages(r).join('\n'), /hub-check\.yml: line \d+: an email address/)
  })
})

test('a GUID and a one-word author warn; scanAllow exempts a reviewed name, never a token (PUE-6)', () => {
  const token = ['gh', 'p_', 'A1b2C3d4'.repeat(5)].join('')
  const guid = ['123e4567', 'e89b', '12d3', 'a456', '426614174000'].join('-')
  const notes = 'docs/reference/configuration.md'
  const text = `# Configuration\n\nRequest ${guid} came from Solo and Rita Lane.\n\nThe key is ${token} here.\n`
  const dir = lockRepo({ [notes]: text }, { [notes]: { kind: 'page', type: 'reference', generated: text } }, { settings: { scanAllow: ['Rita Lane', token] } })
  sb.write(join(dir, 'a.txt'), 'a\n')
  sb.git(dir, '-c', 'core.hooksPath=/dev/null', 'add', '-A')
  sb.git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--no-verify', '--author', 'Solo <solo@example.com>', '-m', 'one')
  sb.write(join(dir, 'b.txt'), 'b\n')
  sb.git(dir, '-c', 'core.hooksPath=/dev/null', 'add', '-A')
  sb.git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--no-verify', '--author', 'Rita Lane <rita@example.com>', '-m', 'two')
  const r = checkLock(dir)
  assert.equal(r.code, 1, r.output)
  const errors = messages(r)
  assert.equal(errors.length, 1, errors.join('\n'))
  assert.match(errors[0], /GitHub token/)
  const warnings = JSON.stringify(r.json().warnings)
  assert.match(warnings, /a GUID/)
  assert.match(warnings, /one-word git author or committer name: Solo/)
  assert.doesNotMatch(JSON.stringify(r.json()), /Rita Lane/)
})

describe('a path the text cites and git no longer has (PUE-7)', () => {
  const index = '# Service docs\n\nThis folder documents the service; the settings come from [the config](../src/config.ts).\n\n## Where to start\n\nRead the settings.\n'
  const skill = '---\nname: working-in-service\ndescription: Working in service. Use when editing it.\n---\n\n## Verify like CI\n\nRun `npm test`.\n\n## Hand-off\n\nSay what ran.\n'
  const variants = {
    'cited in backticks': [CONFIG, { kind: 'page', type: 'reference' }, clean],
    'linked': ['docs/index.md', { kind: 'page', type: 'overview' }, index],
    'only a source key': ['.claude/skills/working-in-service/SKILL.md', { kind: 'skill', archetype: 'working-in' }, skill],
  }
  for (const [name, [path, meta, text]] of Object.entries(variants)) {
    test(`${name}: ${name === 'only a source key' ? 'drift, not an error' : 'fails naming src/config.ts'}`, () => {
      const dir = lockRepo({ [path]: text }, { [path]: { ...meta, generated: text, sources: { 'src/config.ts': blob(BASE_FILES.service['src/config.ts']) } } })
      rmSync(join(dir, 'src', 'config.ts'))
      sb.commit(dir, 'remove the config module')
      const r = checkLock(dir)
      if (name === 'only a source key') {
        assert.equal(r.code, 0, r.output)
        const d = sb.hub(['drift', '--repo', dir, '--json'])
        assert.equal(d.code, 0, d.output)
        assert.deepEqual(d.json().repos[0].files.find(f => f.path === path).affected, ['src/config.ts'])
      } else {
        assert.equal(r.code, 1, r.output)
        assert.match(messages(r).join('\n'), /src\/config\.ts/)
      }
    })
  }
})

test('a member lock grounds in its workspace, never in other projects of the folder (PUE-7)', () => {
  const at = sb.path('lock-ws')
  const lockText = (settings, files = {}, more = {}) =>
    JSON.stringify(
      { schema: 1, generator: 'hub@0.1.0', documentedCommit: '0'.repeat(40), settings: { language: 'en', docsDir: 'docs', scanAllow: [], ...settings }, files, ...more },
      null,
      2,
    ) + '\n'
  sb.initRepo(join(at, 'service'), { ...BASE_FILES.service, '.claude/hub.lock.json': lockText({}, {}, { workspace: { repos: ['service', 'web_app'] } }) })
  sb.initRepo(join(at, 'infra'), { 'deploy/run.sh': 'export INFRA_ONLY=1\n' })
  const web = sb.initRepo(join(at, 'web_app'), { 'src/client.ts': 'export const client = null\n' })
  const run = line => {
    const text = `# Configuration\n\nThe client reads its settings from the service.\n\n${line}\n`
    sb.write(join(web, CONFIG), text)
    sb.write(join(web, '.claude', 'hub.lock.json'), lockText({ docsHome: 'service' }, { [CONFIG]: { kind: 'page', type: 'reference', sources: {}, hash: blob(text) } }))
    return checkLock(web)
  }
  let r = run('It reads `DB_URL` in `service/src/config.ts`.')
  assert.equal(r.code, 0, r.output)
  // infra shares the folder but not the workspace.
  r = run('The deploy sets `INFRA_ONLY` in `infra/deploy/run.sh`.')
  assert.equal(r.code, 1)
  assert.match(messages(r).join('\n'), /the identifier INFRA_ONLY appears nowhere/)
  assert.match(messages(r).join('\n'), /the path infra\/deploy\/run\.sh does not exist/)
})
