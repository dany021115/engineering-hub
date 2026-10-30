import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fixedSentences } from '../scripts/lib/sample.mjs'
import { pageText } from './gate-fixture.mjs'
import { sandbox } from './helper.mjs'
import { CONFIG, approvedRun, configText, lockedExtra, p1, p2, s1 } from './run-fixture.mjs'

const sb = sandbox()
after(() => sb.cleanup())

const sample = (run, ...args) => sb.hub(['sample', run.ctx.planFile, ...args, '--json'], { cwd: run.ctx.root })
const LOCK_LINE =
  '- **The lock is the reverse index.** `.claude/hub.lock.json` lists, for each generated page and skill, the source files it was written from; a change to one of those sources means the page needs a look.'
const itemsOf = r => r.json().items

describe('a stable sample of placed sentences (EVI-4)', () => {
  test('stable', () => {
    const run = approvedRun(sb, [s1(), p1(), p2()])
    assert.equal(run.place().code, 0)
    const before = run.status()
    const first = sample(run)
    assert.equal(first.code, 0, first.output)
    const items = itemsOf(first)
    assert.ok(items.length > 0 && items.length <= 5, first.output)
    assert.deepEqual(items.map(i => i.n), items.map((_, i) => i + 1))
    for (const i of items) assert.deepEqual(Object.keys(i).sort(), ['line', 'n', 'open', 'path', 'repo', 'text'])
    assert.ok(existsSync(join(run.ctx.root, '.hub-run', 'sample.json')))
    assert.deepEqual(itemsOf(sample(run)), items)
    assert.deepEqual(run.status(), before)
    // The seed follows HEAD, whose hash changes with the fixture's commit time: look in every sentence.
    const all = itemsOf(sample(run, '--n', '30'))
    const config = all.find(i => i.text.includes('`src/config.ts`'))
    assert.ok(config, JSON.stringify(all))
    assert.deepEqual(config.open, ['src/config.ts'])
  })

  test('exclusions', () => {
    const text = pageText('Configuration', [
      ['## Settings', 'The service reads `DB_URL` in `src/config.ts`.'],
      ['## Table', '| Setting name here | Read where here |\n|---|---|\n| the database url value | in the config file |'],
      ['## Commands', '```bash\nnpm run lint --fix everything now\n```'],
      ['## Notes', `- A list item with enough words.\n${LOCK_LINE}`],
    ])
    const run = approvedRun(sb, [s1(), p1()], { texts: { [CONFIG]: text } })
    assert.equal(run.place().code, 0)
    const r = sample(run, '--n', '30')
    assert.equal(r.code, 0, r.output)
    const texts = itemsOf(r).map(i => i.text)
    assert.ok(texts.includes('A list item with enough words.'), r.output)
    for (const t of texts) {
      assert.doesNotMatch(t, /^#|^\||^- |npm run lint|Setting name here|database url value|^name:|^description:|Use before editing, testing or committing|The lock is the reverse index/)
    }
  })

  test('the sentences every skeleton writes are left out', () => {
    const isFixed = fixedSentences()
    assert.equal(isFixed("The repo's `CLAUDE.md` is the authority and wins over this skill; this skill only adds what it does not say."), true)
    assert.equal(isFixed(LOCK_LINE.replace(/^- /, '')), true)
    assert.equal(isFixed('The service reads `DB_URL` in `src/config.ts`.'), false)
    assert.equal(isFixed('**Run `npm test` before a push.** The workflow runs it on every pull request.'), false)
  })

  test('refresh', () => {
    const added = 'The service also reads its port number here.'
    const run = approvedRun(sb, [p1({ action: 'update' })], { extra: lockedExtra(), texts: { [CONFIG]: `${configText}\n${added}\n` } })
    assert.equal(run.place().code, 0)
    const r = sample(run)
    assert.equal(r.code, 0, r.output)
    assert.deepEqual(itemsOf(r).map(i => i.text), [added])
  })

  test('out of order', () => {
    const run = approvedRun(sb, [s1(), p1()])
    let r = sample(run)
    assert.equal(r.code, 2)
    assert.match(r.stderr, /run place first/)
    assert.equal(run.place().code, 0)
    assert.equal(run.finish('--keep', 'all').code, 0)
    r = sample(run)
    assert.equal(r.code, 2)
    assert.match(r.stderr, /this run is finished/)
    assert.equal(JSON.parse(readFileSync(join(run.ctx.root, '.hub-run', 'done.json'), 'utf8')).spot, undefined)
  })
})
