import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { mermaidNodes } from '../scripts/lib/lint-docs.mjs'
import { anchors, slugger } from '../scripts/lib/markdown.mjs'
import { sandbox } from './helper.mjs'
import { check, messages, stage } from './gate-fixture.mjs'
import { page, prepare } from './plan-fixture.mjs'

const sb = sandbox()
after(() => sb.cleanup())

const REF = ['docs/reference/configuration.md', 'reference', 'reads-env-vars']
const HOWTO = ['docs/how-to/run-tests.md', 'how-to', 'tests-need-setup']
const INDEX = ['docs/index.md', 'overview', 'always']

const reference = (extra = '') => `# Configuration\n\nThe service reads \`DB_URL\` from the environment in \`src/config.ts\`.\n${extra}`
const fence = (lang, ...lines) => `\`\`\`${lang}\n${lines.join('\n')}\n\`\`\`\n`

function howTo({ before = true, steps = 2, verify = 'The suite ends without failures.', words = '' } = {}) {
  const list = Array.from({ length: steps }, (_, i) => `${i + 1}. Do step ${i + 1} of the run.`).join('\n')
  return [
    '# Run the tests',
    '',
    `This page shows how to run the service tests on your machine.${words}`,
    '',
    ...(before ? ['## Before you begin', '', 'Install the packages the tests need.', ''] : []),
    '## Steps',
    '',
    list,
    '',
    fence('sh', 'npm ci', 'npm test'),
    ...(verify === null ? [] : ['## Verify', '', verify, '']),
  ].join('\n')
}

const overview = (start = true) =>
  `# Service docs\n\nThis folder documents the service and its settings.\n\n## Responsibilities\n\nThe service answers API calls.\n${start ? '\n## Where to start\n\nRead the configuration page first.\n' : ''}`

function runner(language = 'en', extra = {}) {
  const ctx = prepare(sb, { extra })
  return (where, text) => {
    const [path, type, trigger] = where
    ctx.plan({ service: { files: [page('p1', path, type, trigger)] } }, { settings: { language } })
    stage(sb, ctx, path, text)
    return check(sb, ctx)
  }
}

describe('one fault per page (PUE-5)', () => {
  const run = runner()
  const clean = {
    'a reference without ## sections': [REF, reference()],
    'frontmatter before the H1': [REF, `---\ntitle: Configuration\n---\n${reference()}`],
    'a how-to with its sections': [HOWTO, howTo()],
  }
  for (const [name, [where, text]] of Object.entries(clean)) {
    test(`clean: ${name} passes`, () => {
      const r = run(where, text)
      assert.equal(r.code, 0, r.output)
    })
  }

  const faults = {
    'no H1': [REF, 'Configuration\n\nThe service reads `DB_URL` from the environment.\n', /must open with an H1/],
    'frontmatter followed by a paragraph': [REF, '---\ntitle: Configuration\n---\nThe service reads `DB_URL`.\n', /open with an H1 right after its frontmatter/],
    'an H1 without intro': [REF, '# Configuration\n\n## Settings\n\nThe service reads `DB_URL`.\n', /needs an intro/],
    '## followed by ####': [REF, reference('\n## Settings\n\nOne setting.\n\n#### Deep\n\nIts value.\n'), /skips a level/],
    'an empty ## Verify': [HOWTO, howTo({ verify: '' }), /section "Verify" is empty/],
    'a fence without language': [REF, reference(`\nRun the suite:\n\n${fence('', 'npm test')}`), /needs a language/],
    'a $ prompt': [REF, reference(`\nRun the suite:\n\n${fence('sh', '$ npm test')}`), /\$ prompt/],
    '11 steps': [HOWTO, howTo({ steps: 11 }), /11 steps, over 10/],
    'a line number': [REF, reference('\nThe entry point is src/app.ts:42 in the repo.\n'), /line number: src\/app\.ts:42/],
    TODO: [REF, reference('\nTODO list the ports.\n'), /carries TODO/],
    TBD: [REF, reference('\nThe port is TBD.\n'), /carries TBD/],
    currently: [REF, reference('\nThe service currently reads one file.\n'), /"currently" dates the page/],
    'a how-to without ## Before you begin': [HOWTO, howTo({ before: false }), /needs the section ## Before you begin/],
    'a how-to without ## Verify': [HOWTO, howTo({ verify: null }), /needs the section ## Verify/],
    'an overview without ## Where to start': [INDEX, overview(false), /needs the section ## Where to start/],
  }
  for (const [name, [where, text, expected]] of Object.entries(faults)) {
    test(`fault: ${name} fails naming it`, () => {
      const r = run(where, text)
      assert.equal(r.code, 1, r.output)
      assert.match(messages(r).join('\n'), expected)
    })
  }

  test('a clean how-to of 1300 words and a dated page pass with a warning', () => {
    const long = ' The suite checks the handlers and the settings of the service.'.repeat(130)
    let r = run(HOWTO, howTo({ words: long }))
    assert.equal(r.code, 0, r.output)
    assert.match(JSON.stringify(r.json().warnings), /words, over 1200/)
    r = run(REF, reference('\nThe settings moved on 2026-01-01.\n'))
    assert.equal(r.code, 0, r.output)
    assert.match(JSON.stringify(r.json().warnings), /a date: 2026-01-01/)
  })
})

describe('another language (PUE-5)', () => {
  const run = runner('es')
  test('TODO and TBD fail in any language; English words and sections only in en', () => {
    assert.equal(run(REF, reference('\nTODO list the ports.\n')).code, 1)
    assert.equal(run(REF, reference('\nThe port is TBD.\n')).code, 1)
    assert.equal(run(REF, reference('\nThe service currently reads one file.\n')).code, 0)
    assert.equal(run(HOWTO, howTo({ before: false })).code, 0)
  })
})

test('a page with the frontmatter of its sisters and the H1 right after passes (CON-10)', () => {
  const fm = t => `---\ntitle: ${t}\n---\n# ${t}\n\nA page about ${t.toLowerCase()}.\n`
  const run = runner('en', {
    service: { 'docs/a.md': fm('Alpha'), 'docs/b.md': fm('Beta'), 'docs/c.md': fm('Gamma'), 'docs/d.md': '# Delta\n\nA page.\n' },
  })
  const r = run(REF, `---\ntitle: Configuration\n---\n${reference()}`)
  assert.equal(r.code, 0, r.output)
})

describe('links and Mermaid (PUE-5, CON-17)', () => {
  const index = `# Service docs\n\nThis folder documents the service.\n\n## Where to start\n\nRead the settings.\n\n## Configuración rápida: ¿qué?\n\nSet the variables first.\n`
  const run = runner('en', { service: { 'docs/index.md': index, 'docs/reference/diagram.png': 'not really a picture\n' } })
  const flow = n => fence('mermaid', 'flowchart LR', ...Array.from({ length: n - 1 }, (_, i) => `  N${i} -->|next| N${i + 1}`))
  const broken = {
    'an anchor that does not resolve': ['\nSee [the index](../index.md#no-such-heading).\n', /anchor that does not resolve/],
    'a relative link to code': ['\nSee [the app](../../src/app.ts).\n', /leaves the docs folder/],
    'a link to a file that is not a doc': ['\nSee [the diagram](diagram.png).\n', /not a doc/],
    'a link whose text is here': ['\nThe settings are listed [here](../index.md).\n', /text is "here"/],
    'a link to lines of the default branch': ['\nSee [the start](https://github.com/org/service/blob/main/src/app.ts#L10).\n', /lines of a branch/],
    'a classDiagram': [`\nThe classes:\n\n${fence('mermaid', 'classDiagram', '  A <|-- B')}`, /classDiagram/],
    'a flowchart of 16 nodes': [`\nThe flow:\n\n${flow(16)}`, /16 nodes, over 15/],
  }
  for (const [name, [extra, expected]] of Object.entries(broken)) {
    test(`${name} fails`, () => {
      const r = run(REF, reference(extra))
      assert.equal(r.code, 1, r.output)
      assert.match(messages(r).join('\n'), expected)
    })
  }

  test('an anchor to a heading with accents and signs resolves; an unlabelled edge passes', () => {
    let r = run(REF, reference('\nSee [the quick setup](../index.md#configuración-rápida-qué).\n'))
    assert.equal(r.code, 0, r.output)
    r = run(REF, reference(`\nThe flow:\n\n${fence('mermaid', 'flowchart LR', '  A --> B')}`))
    assert.equal(r.code, 0, r.output)
  })

  test('links to planned pages resolve; a link to a dropped entry does not', () => {
    const ctx = prepare(sb, { extra: { service: { 'docs/index.md': index } } })
    const text = reference(
      '\nStart at [the docs index](../index.md), then [run the tests](../how-to/run-tests.md#verify) and [release](../how-to/release.md).\n',
    )
    ctx.plan({
      service: {
        files: [
          page('p1', ...REF),
          page('p2', ...HOWTO),
          page('p3', 'docs/how-to/release.md', 'how-to', 'ci-publishes', ['F2'], { action: 'dropped', reason: 'review' }),
        ],
      },
    })
    stage(sb, ctx, REF[0], text)
    stage(sb, ctx, HOWTO[0], howTo())
    const r = check(sb, ctx)
    assert.equal(r.code, 1)
    const all = messages(r)
    assert.equal(all.length, 1, all.join('\n'))
    assert.match(all[0], /configuration\.md: line \d+: a link to a page that does not exist: \.\.\/how-to\/release\.md/)
  })

  test('a relative link to another repo fails (CON-17)', () => {
    const ctx = prepare(sb, { workspace: true })
    const path = 'docs/workspace/interfaces.md'
    ctx.plan({ service: { files: [page('p1', path, 'reference', 'two-sided-seam')] } }, { workspace: { home: 'service', repos: ['service'] } })
    stage(sb, ctx, path, '# Interfaces\n\nThe web client calls the service.\n\nSee [client](../../../web/src/client.ts).\n')
    const r = check(sb, ctx)
    assert.equal(r.code, 1)
    assert.match(messages(r).join('\n'), /leaves the docs folder: \.\.\/\.\.\/\.\.\/web\/src\/client\.ts/)
  })
})

test('the slugger follows github-slugger and repeats get a suffix', () => {
  const slug = slugger()
  assert.equal(slug('Configuración rápida: ¿qué?'), 'configuración-rápida-qué')
  assert.equal(slug('Run `npm test` (CI)'), 'run-npm-test-ci')
  assert.equal(slug('Verify'), 'verify')
  assert.equal(slug('Verify'), 'verify-1')
  assert.ok(anchors('# T\n\n## Verify\n\n## Verify\n').has('verify-1'))
})

test('Mermaid nodes are counted per diagram kind', () => {
  assert.deepEqual(mermaidNodes(['flowchart LR', 'A[Start] --> B{Ok?}', 'B -- yes --> C', 'B -->|no| D']), { kind: 'flowchart', nodes: 4 })
  assert.deepEqual(mermaidNodes(['sequenceDiagram', 'participant W as Web', 'W->>S: GET /api', 'S-->>W: 200']), {
    kind: 'sequenceDiagram',
    nodes: 2,
  })
})
