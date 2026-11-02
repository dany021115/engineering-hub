import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { overlayText, pageText } from './gate-fixture.mjs'
import { sandbox } from './helper.mjs'
import { blob, configText } from './run-fixture.mjs'
import { cloneAlone, CONFIG, INTERFACES, lockedWorkspace, SERVICE_SKILL } from './workspace-fixture.mjs'

const sb = sandbox()
after(() => sb.cleanup())

let n = 0
const ws = (opts = {}) => lockedWorkspace(sb, { at: sb.path(`route-${++n}`), ...opts })
const route = (dir, ...flags) => sb.hub(['route', '--repo', dir, ...flags])
const stopsOf = (dir, ...flags) => {
  const r = route(dir, ...flags, '--json')
  assert.equal(r.code, 0, r.output)
  return r.json().stops
}
const warnsOf = (dir, ...flags) => JSON.stringify(route(dir, ...flags, '--json').json().warnings)
const INDEX = 'docs/index.md'
const indexText = list => pageText('Service', [['## Where to start', `Read these first:\n\n${list}`]], 'This page starts the service docs.')
const howTo = title => pageText(title, [['## Before you begin', 'Install it.'], ['## Steps', '1. Run it.'], ['## Verify', 'It passes.']], `This page shows how to ${title}.`)

// Pages added to a repo's lock, with `sources` read as they are now.
function addPages(w, repo, pages) {
  const file = join(w[repo], '.claude', 'hub.lock.json')
  const lock = JSON.parse(readFileSync(file, 'utf8'))
  for (const [path, { text, type, sources = {} }] of Object.entries(pages)) {
    sb.write(join(w[repo], path), text)
    lock.files[path] = { kind: 'page', type, hash: blob(text), sources }
  }
  sb.write(file, JSON.stringify(lock, null, 2) + '\n')
}

describe('a read-only subcommand (RUT-1)', () => {
  test('read only and refusals', () => {
    const w = ws()
    const before = sb.git(w.service, 'status', '--porcelain')
    assert.equal(route(w.service).code, 0)
    assert.equal(sb.git(w.service, 'status', '--porcelain'), before)
    const root = route(w.w)
    assert.equal(root.code, 2)
    assert.match(root.stderr, /holds several repositories \(service, web\)/)
    sb.git(w.web, 'rm', '-q', '.claude/hub.lock.json')
    assert.match(route(w.web).stderr, /run \/hub:init first/)
  })
})

describe('the order is fixed (RUT-2)', () => {
  test('order', () => {
    const w = ws()
    addPages(w, 'service', {
      'docs/explain/caching.md': { text: pageText('Caching', [['## How it works', 'It caches.']], 'This page explains the cache.'), type: 'explanation' },
      'docs/how-to/z-add-route.md': { text: howTo('add a route'), type: 'how-to' },
      'docs/how-to/release.md': { text: howTo('release'), type: 'how-to' },
      'docs/how-to/run-tests.md': { text: howTo('run the tests'), type: 'how-to' },
      'docs/how-to/run-locally.md': { text: howTo('run it'), type: 'how-to' },
      [INDEX]: { text: indexText('- [Configuration](reference/configuration.md) lists the settings.'), type: 'overview' },
    })
    const stops = stopsOf(w.service)
    assert.deepEqual(stops.map(s => [s.stage, s.path]), [
      ['run', 'docs/how-to/run-locally.md'],
      ['run', 'docs/how-to/run-tests.md'],
      ['start', INDEX],
      ['start', CONFIG],
      ['first-change', 'docs/how-to/z-add-route.md'],
      ['concepts', 'docs/explain/caching.md'],
      ['more', INTERFACES],
      ['more', 'docs/how-to/release.md'],
    ])
    assert.deepEqual(stops.map(s => s.n), stops.map((_, i) => i + 1))
  })

  test('run stop', () => {
    const w = ws()
    const [first] = stopsOf(w.service)
    assert.deepEqual([first.stage, first.kind, first.path], ['run', 'skill', SERVICE_SKILL])
    assert.match(first.verify.join('\n'), /Run `npm test` after `npm ci`/)
    const noSkill = ws({ texts: { service: { [SERVICE_SKILL]: overlayText().replace('## Verify like CI', '## Verificar') } } })
    assert.ok(!stopsOf(noSkill.service).some(s => s.stage === 'run'))
    assert.match(warnsOf(noSkill.service), /no page or skill says how to run this repository/)
  })

  test('across lists the pages of a related repository that cite this one', () => {
    const w = ws()
    const last = stopsOf(w.web).at(-1)
    assert.deepEqual([last.stage, last.repo, last.path], ['across', 'service', INTERFACES])
    assert.match(route(w.web).stdout, /across: service\/docs\/workspace\/interfaces\.md/)
  })
})

describe('Where to start in its two forms (RUT-3)', () => {
  test('both forms', () => {
    const w = ws()
    addPages(w, 'service', { [INDEX]: { text: indexText('- `src/config.ts` holds the settings, as the next page says.\n- [Configuration](reference/configuration.md) lists them.\n- `web/src/client.ts` and `src/nope.ts` are not here, and `package.json` is.\n- [Out](https://example.com/x) is elsewhere.'), type: 'overview' } })
    const start = stopsOf(w.service).filter(s => s.stage === 'start').map(s => [s.kind, s.path])
    assert.deepEqual(start, [['page', INDEX], ['file', 'src/config.ts'], ['page', CONFIG], ['file', 'package.json']])
  })

  test('translated', () => {
    const w = ws()
    const text = pageText('Servicio', [['## Por dónde empezar', '- [Configuración](reference/configuration.md).']], 'Esta página abre la documentación.')
    addPages(w, 'service', { [INDEX]: { text, type: 'overview' } })
    assert.match(warnsOf(w.service), /no \\"Where to start\\" section, so the pages are ordered by type/)
    const stops = stopsOf(w.service)
    assert.deepEqual(stops.filter(s => s.stage === 'more').map(s => s.path), [CONFIG, INTERFACES])
    assert.equal(stops.find(s => s.path === INDEX).stage, 'start')
  })

  test('without an index, the same warning', () => {
    assert.match(warnsOf(ws().service), /no \\"Where to start\\" section/)
  })
})

describe('what each stop carries (RUT-4)', () => {
  test('freshness', () => {
    const w = ws()
    const stopOf = path => stopsOf(w.service).find(s => s.path === path)
    assert.deepEqual([stopOf(CONFIG).freshness, stopOf(CONFIG).type, stopOf(CONFIG).headings, stopOf(CONFIG).cites], ['unchanged', 'reference', ['Settings'], ['DB_URL', 'src/config.ts']])
    sb.write(join(w.service, 'src/config.ts'), 'export const config = {}\n')
    sb.commit(w.service, 'change the config')
    assert.deepEqual([stopOf(CONFIG).freshness, stopOf(CONFIG).changed], ['sources changed', ['src/config.ts']])
    sb.write(join(w.service, CONFIG), `${configText}\nBy hand.\n`)
    assert.equal(stopOf(CONFIG).freshness, 'edited by hand')
    sb.git(w.service, 'rm', '-qf', CONFIG)
    assert.equal(stopOf(CONFIG).freshness, 'missing')
  })

  test('nothing is written into a page', () => {
    const w = ws()
    const before = readFileSync(join(w.service, CONFIG), 'utf8')
    route(w.service)
    assert.equal(readFileSync(join(w.service, CONFIG), 'utf8'), before)
  })
})

describe('by area (RUT-5)', () => {
  test('area', () => {
    const w = ws()
    addPages(w, 'service', { [INDEX]: { text: indexText('- `src/config.ts` holds the settings.\n- `src/app.ts` starts it.'), type: 'overview' } })
    assert.deepEqual(stopsOf(w.service, '--area', 'src/config.ts').map(s => s.path), ['src/config.ts', CONFIG])
    assert.deepEqual(stopsOf(w.web, '--area', 'src/client.ts').map(s => s.path), [INTERFACES])
    assert.match(warnsOf(w.service, '--area', 'nope/'), /no stop under nope\//)
  })
})

describe('what route warns about (RUT-6)', () => {
  test('warnings', () => {
    const w = ws()
    sb.write(join(w.w, '.hub-run', 'plan.json'), '{}\n')
    assert.match(warnsOf(w.service), /a run is not finished here, so the pages may change/)
    const alone = cloneAlone(sb, w.web, 'web')
    assert.equal(route(alone).code, 0)
    assert.match(warnsOf(alone), /service is not next to this repository, so its pages were not listed/)
  })
})

describe('what verify found (RUT-2, RUT-3, RUT-4, RUT-5, RUT-6)', () => {
  test('a stop comes once, whatever the form of its path', () => {
    const w = ws()
    addPages(w, 'service', { [INDEX]: { text: indexText(`- \`src/\` and \`src\` and \`./src/\` are one folder.\n- \`${SERVICE_SKILL}\` is the skill.`), type: 'overview' } })
    const stops = stopsOf(w.service)
    assert.equal(stops.filter(s => s.path.replace(/\/$/, '') === 'src').length, 1, JSON.stringify(stops))
    assert.ok(!stops.some(s => s.path.startsWith('./')), JSON.stringify(stops))
    assert.equal(stops.filter(s => s.path === SERVICE_SKILL).length, 1)
  })

  test('a link to a file of the repository is a file stop, and one deleted from the tree is none', () => {
    const w = ws()
    addPages(w, 'service', { [INDEX]: { text: indexText('- [`src/config.ts`](../src/config.ts) holds it.\n- `src/app.ts` starts it.\n- [Section](reference/configuration.md#settings) lists it.'), type: 'overview' } })
    rmSync(join(w.service, 'src/app.ts'))
    assert.deepEqual(stopsOf(w.service).filter(s => s.stage === 'start').map(s => s.path), [INDEX, 'src/config.ts', CONFIG])
  })

  test('sources in a repository that is not here are not checked', () => {
    const alone = cloneAlone(sb, ws().service, 'service')
    assert.equal(stopsOf(alone).find(s => s.path === INTERFACES).freshness, 'sources not checked')
  })

  test('an area keeps its path limit, and . is the whole repository', () => {
    const w = ws()
    addPages(w, 'service', { [INDEX]: { text: indexText('- `src/` holds the code.'), type: 'overview' } })
    const all = stopsOf(w.service).map(s => s.path)
    for (const area of ['.', './']) assert.deepEqual(stopsOf(w.service, '--area', area).map(s => s.path), all, area)
    assert.deepEqual(stopsOf(w.service, '--area', 'srcfoo'), [])
    assert.ok(stopsOf(w.service, '--area', 'src/config.ts').some(s => s.path === 'src/'))
  })

  test('a folder that holds the area keeps its page, and keys of other repositories do not count', () => {
    const w = ws()
    addPages(w, 'service', { 'docs/explain/a.md': { text: pageText('A', [['## How it works', 'It works.']], 'This page explains it.'), type: 'explanation', sources: { 'deploy/': 'x', 'web:src/': 'y' } } })
    assert.ok(stopsOf(w.service, '--area', 'deploy/app.yaml').some(s => s.path === 'docs/explain/a.md'))
    assert.ok(!stopsOf(w.service, '--area', 'src/client.ts').some(s => s.path === 'docs/explain/a.md'))
  })

  test('a finished run is no warning, and a broken lock next door is one, with exit 0', () => {
    const w = ws()
    sb.write(join(w.w, '.hub-run', 'plan.json'), '{}\n')
    sb.write(join(w.w, '.hub-run', 'done.json'), '{}\n')
    assert.doesNotMatch(warnsOf(w.service), /a run is not finished/)
    sb.write(join(w.service, '.claude', 'hub.lock.json'), '{ broken')
    assert.equal(route(w.web).code, 0)
    assert.match(warnsOf(w.web), /not valid JSON/)
  })

  test('an index or a skill that is gone or a folder does not stop the route', () => {
    const w = ws()
    addPages(w, 'service', { [INDEX]: { text: indexText('- `src/app.ts` starts it.'), type: 'overview' } })
    rmSync(join(w.service, INDEX))
    sb.write(join(w.service, INDEX, 'x.md'), 'x\n')
    rmSync(join(w.service, SERVICE_SKILL))
    const r = route(w.service, '--json')
    assert.equal(r.code, 0, r.output)
    assert.equal(r.json().stops.find(s => s.path === INDEX).freshness, 'missing')
    assert.match(warnsOf(w.service), /no page or skill says how to run/)
  })
})
