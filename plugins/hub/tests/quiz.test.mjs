import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { pageText } from './gate-fixture.mjs'
import { sandbox } from './helper.mjs'
import { cloneAlone, CONFIG, INTERFACES, lockedWorkspace } from './workspace-fixture.mjs'

const sb = sandbox()
after(() => sb.cleanup())

let n = 0
const ws = (opts = {}) => lockedWorkspace(sb, { at: sb.path(`quiz-${++n}`), ...opts })
const quiz = (dir, ...flags) => sb.hub(['quiz', '--repo', dir, ...flags])
const json = (dir, ...flags) => {
  const r = quiz(dir, ...flags, '--json')
  assert.equal(r.code, 0, r.output)
  return r.json()
}
const REF_TABLE = '| Name | Where it is read | What it controls |\n|---|---|---|\n| `DB_URL` | `src/config.ts` | The database URL. |\n| `<name>` | `src/config.ts` | A placeholder row. |\n| `service` | `deploy/app.yaml` | A plain key that the file sets. |'
const page = text => ({ texts: { service: { [CONFIG]: text } } })

describe('a read-only subcommand (QUI-1)', () => {
  test('read only', () => {
    const w = ws()
    const before = sb.git(w.service, 'status', '--porcelain')
    json(w.service)
    assert.equal(sb.git(w.service, 'status', '--porcelain'), before)
  })

  test('refusals', () => {
    const w = ws()
    const none = quiz(w.w)
    assert.equal(none.code, 2)
    assert.match(none.stderr, /holds several repositories \(service, web\)/)
    assert.equal(quiz(w.service, '--n', '0').code, 2)
    sb.git(w.web, 'rm', '-q', '.claude/hub.lock.json')
    const r = quiz(w.web)
    assert.equal(r.code, 2)
    assert.match(r.stderr, /run \/hub:init first/)
  })
})

describe('only pages that still hold (QUI-2)', () => {
  test('intact only', () => {
    const w = ws()
    sb.write(join(w.service, CONFIG), readFileSync(join(w.service, CONFIG), 'utf8') + '\nBy hand.\n')
    sb.write(join(w.web, 'src/client.ts'), "export const API_BASE = '/api/v2'\n")
    sb.commit(w.web, 'move the API')
    const out = json(w.service, '--n', '30', '--answers')
    assert.ok(!out.questions.some(q => [CONFIG, INTERFACES].includes(q.page)), JSON.stringify(out))
    assert.deepEqual(out.skipped.map(s => [s.path, s.reason]).sort(), [[CONFIG, 'edited'], [INTERFACES, 'sources changed']])
  })
})

describe('questions with a blank (QUI-3)', () => {
  test('cloze', () => {
    const text = pageText('Configuration', [
      ['## Settings', [
        'The service reads the database address from `src/config.ts` when it starts.',
        'The value of `DB_URL` comes from `src/config.ts` on every start.',
        '`README.md`, which describes the repository for every reader here.',
        'Run the whole suite with `npm test` before you push your work.',
        'Short `src/app.ts` line.',
      ].join('\n\n')],
    ])
    const out = json(ws(page(text)).service, '--n', '30', '--answers')
    const mine = out.questions.filter(q => q.page === CONFIG)
    assert.deepEqual(mine.map(q => q.text), ['The service reads the database address from ____ when it starts.'], JSON.stringify(out))
    assert.deepEqual([mine[0].kind, mine[0].answer, mine[0].section], ['cloze', 'src/config.ts', 'Settings'])
  })
})

describe('questions from a table (QUI-4)', () => {
  test('table', () => {
    const w = ws(page(pageText('Configuration', [['## Settings', `This table lists every setting.\n\n${REF_TABLE}`]])))
    const q = json(w.service, '--n', '30', '--answers').questions.filter(x => x.kind === 'where')
    assert.deepEqual(q.map(x => [x.text, x.answer, x.page]), [['Which file reads `DB_URL`?', 'src/config.ts', CONFIG]])
  })

  test('another header gives none', () => {
    const table = REF_TABLE.replace('Where it is read', 'Dónde se lee')
    const w = ws(page(pageText('Configuration', [['## Settings', `This table lists every setting.\n\n${table}`]])))
    assert.equal(json(w.service, '--n', '30').questions.filter(x => x.kind === 'where').length, 0)
  })
})

describe('the same questions for the same seed (QUI-5)', () => {
  const many = pageText('Configuration', [['## Settings', ['a', 'b', 'c', 'd', 'e', 'f'].map(x => `The value ${x} of the service is read from \`src/config.ts\` here.`).join('\n\n')]])

  test('stable', () => {
    const w = ws(page(many))
    const texts = (...f) => json(w.service, ...f).questions.map(q => q.text)
    assert.deepEqual(texts('--n', '30', '--seed', 'a'), texts('--n', '30', '--seed', 'a'))
    assert.deepEqual(texts('--n', '30', '--seed', 'a').sort(), texts('--n', '30', '--seed', 'b').sort())
    assert.notDeepEqual(texts('--n', '30', '--seed', 'a'), texts('--n', '30', '--seed', 'b'))
    assert.equal(texts('--n', '2').length, 2)
  })

  test('few', () => {
    const out = json(ws(page(many)).service, '--n', '30')
    assert.ok(out.questions.length >= 6 && out.questions.length < 30)
    assert.match(JSON.stringify(out.warnings), new RegExp(`only ${out.questions.length} questions from these pages`))
    assert.deepEqual(out.questions.map(q => q.n), out.questions.map((_, i) => i + 1))
  })

  test('the default comes from the catalog', () => {
    const w = ws(page(pageText('Configuration', [['## Settings', Array.from({ length: 12 }, (_, i) => `The value number ${i} of the service is read from \`src/config.ts\` here.`).join('\n\n')]])))
    assert.equal(json(w.service).questions.length, 8)
  })
})

describe('the answers only when asked (QUI-6)', () => {
  test('answers', () => {
    const w = ws(page(pageText('Configuration', [['## Settings', `This table lists every setting.\n\n${REF_TABLE}`]])))
    const hidden = quiz(w.service, '--n', '30', '--json')
    for (const q of hidden.json().questions) assert.deepEqual(Object.keys(q).sort(), ['kind', 'n', 'text'])
    assert.ok(!hidden.stdout.includes(CONFIG))
    const open = json(w.service, '--n', '30', '--answers').questions
    for (const q of open) assert.ok(q.answer && q.page && q.section, JSON.stringify(q))
    const text = quiz(w.service, '--n', '30', '--answers')
    assert.match(text.stdout, /answer: src\/config\.ts \(docs\/reference\/configuration\.md, Settings\)/)
    assert.doesNotMatch(quiz(w.service, '--n', '30').stdout, /answer:/)
  })
})

describe('by area (QUI-7)', () => {
  test('area', () => {
    const both = `The service reads the database address from \`src/config.ts\` when it starts.`
    const w = ws({ texts: { service: { [CONFIG]: pageText('Configuration', [['## Settings', both]]), [INTERFACES]: pageText('Interfaces', [['## Web', 'The whole client talks to the service started in `src/app.ts` today.']], 'This page lists the contracts.') } } })
    const pages = (...f) => [...new Set(json(w.service, '--n', '30', '--answers', ...f).questions.map(q => q.page))]
    assert.deepEqual(pages('--area', 'src/config.ts'), [CONFIG])
    assert.deepEqual(pages('--area', 'src/app.ts'), [INTERFACES])
    assert.deepEqual(pages('--area', 'src/client.ts'), [])
  })
})

// One rule, with its neighbours passing, so a test fails only for that rule.
describe('each rule of a question, on its own', () => {
  const GOOD = 'The service reads the database address from `src/config.ts` when it starts.'
  const cloze = lines => {
    const w = ws(page(pageText('Configuration', [['## Settings', [GOOD, ...lines].join('\n\n')]])))
    return json(w.service, '--n', '30', '--answers').questions.filter(q => q.page === CONFIG)
  }
  const texts = lines => cloze(lines).map(q => q.text)

  test('QUI-3 comma rule: a path that opens a sentence and a comma', () => {
    assert.deepEqual(texts(['`src/app.ts`, which holds the entry function of the whole service.']), ['The service reads the database address from ____ when it starts.'])
  })

  test('QUI-3 a path that opens a sentence without a comma stays', () => {
    assert.ok(texts(['`src/app.ts` holds the entry function of the whole service.']).includes('____ holds the entry function of the whole service.'))
  })

  test('QUI-3 five words, and punctuation is not a word', () => {
    const got = texts(['Data comes right from `src/app.ts`.', 'Data comes from here in `src/app.ts`.'])
    assert.ok(!got.some(t => t.startsWith('Data comes right')), got.join('|'))
    assert.ok(got.includes('Data comes from here in ____.'), got.join('|'))
  })

  test('QUI-3 the answer elsewhere in the sentence', () => {
    assert.ok(!texts(['The file src/app.ts is also named `src/app.ts` by the whole team.']).some(t => t.includes('src/app.ts')))
  })

  test('QUI-3 links and bold are reduced, and bold marks inside a span do not make it a path', () => {
    const got = cloze(['**Always** read [the guide](../how-to/x.md) next to `src/app.ts` before a change.', 'The whole loader covers the `src/**/a.ts` files on every start.'])
    assert.ok(got.some(q => q.text === 'Always read the guide next to ____ before a change.'), JSON.stringify(got))
    assert.ok(!got.some(q => q.answer.includes('a.ts')), JSON.stringify(got))
  })

  test('QUI-3 a sentence every skeleton writes is left out', () => {
    assert.equal(texts(['- **The lock is the reverse index.** `.claude/hub.lock.json` lists, for each generated page and skill, the source files it was written from; a change to one of those sources means the page needs a look.']).length, 1)
  })

  test('QUI-3 the same question from two pages comes once', () => {
    const w = ws({ texts: { service: { [CONFIG]: pageText('Configuration', [['## Settings', GOOD]]), [INTERFACES]: pageText('Interfaces', [['## Web', GOOD]], 'This page lists the contracts.') } } })
    assert.equal(json(w.service, '--n', '30').questions.length, 1)
  })

  test('QUI-4 only a reference page, and no placeholder or self answer', () => {
    const table = `This table lists every setting.\n\n${REF_TABLE}`
    const notRef = ws({ texts: { service: { [INTERFACES]: pageText('Interfaces', [['## Web', table]], 'This page lists the contracts.'), [CONFIG]: pageText('Configuration', [['## Settings', GOOD]]) } } })
    const lockFile = join(notRef.service, '.claude', 'hub.lock.json')
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
    lock.files[INTERFACES].type = 'overview'
    sb.write(lockFile, JSON.stringify(lock, null, 2) + '\n')
    const asked = json(notRef.service, '--n', '30', '--answers').questions.filter(q => q.page === INTERFACES)
    assert.deepEqual(asked.filter(q => q.kind === 'where'), [])
    const odd = '| Name | Where it is read | What it controls |\n|---|---|---|\n| `MY_NAME` | `<dir>/config.ts` | A placeholder path. |\n| `src/config.ts` | `src/config.ts` | Its own answer. |'
    const w = ws(page(pageText('Configuration', [['## Settings', `This table lists every setting.\n\n${odd}`]])))
    assert.deepEqual(json(w.service, '--n', '30').questions.filter(q => q.kind === 'where'), [])
  })

  test('QUI-6 no giveaway', () => {
    const body = `The value of \`DB_URL\` controls the pool size of the service.\n\n${REF_TABLE}`
    const w = ws(page(pageText('Configuration', [['## Settings', body]])))
    for (const seed of ['1', '2', '3', '4', '5', '6']) {
      const q = json(w.service, '--n', '30', '--seed', seed, '--answers').questions
      for (const a of q) for (const b of q) assert.ok(!a.text.includes(b.answer), JSON.stringify(q))
      assert.equal(q.filter(x => x.page === CONFIG).length, 1, JSON.stringify(q))
    }
  })

  test('QUI-7 the whole repository, and a folder that holds the area', () => {
    const w = ws(page(pageText('Configuration', [['## Settings', GOOD]])))
    const all = json(w.service, '--n', '30').questions.length
    assert.ok(all > 0)
    for (const area of ['.', './']) assert.equal(json(w.service, '--n', '30', '--area', area).questions.length, all, area)
    assert.equal(json(w.service, '--n', '30', '--area', './src/config.ts/').questions.length > 0, true)
  })

  test('QUI-2 sources in a repository that is not here are left out', () => {
    const w = ws()
    const alone = cloneAlone(sb, w.service, 'service')
    assert.deepEqual(json(alone, '--n', '30').skipped, [{ path: INTERFACES, reason: 'sources not checked' }])
  })
})
