import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { PLUGIN } from './helper.mjs'

const generator = join(PLUGIN, 'generator')
const catalog = JSON.parse(readFileSync(join(generator, 'catalog.json'), 'utf8'))
const read = rel => readFileSync(join(generator, rel), 'utf8')
const headings = text => text.split('\n').filter(l => /^#{1,6} /.test(l))

function assertSections(skeleton, required) {
  assert.ok(existsSync(join(generator, skeleton)), `${skeleton} is missing`)
  const lines = new Set(headings(read(skeleton)))
  for (const section of required) assert.ok(lines.has(section), `${skeleton} lacks ${section}`)
}

test('the eight skeletons of the design exist and nothing else', () => {
  assert.deepEqual(readdirSync(join(generator, 'skeletons')).sort(), [
    'page-explanation.md',
    'page-how-to.md',
    'page-overview.md',
    'page-reference.md',
    'skill-guardrails.md',
    'skill-procedure.md',
    'skill-style.md',
    'skill-working-in.md',
  ])
})

test('every skill archetype has its skeleton with its required sections', () => {
  for (const [key, s] of Object.entries(catalog.skills)) {
    assert.ok(s.skeleton, key)
    assertSections(s.skeleton, s.required)
    assert.ok(read(s.skeleton).startsWith('---\n'), `${s.skeleton} opens with frontmatter`)
  }
})

test('every page entry has the skeleton of its type with its required sections', () => {
  for (const p of Object.values(catalog.pages)) assertSections(`skeletons/page-${p.type}.md`, p.required)
})

test('page skeletons have no frontmatter and the H1 on line 1', () => {
  for (const type of ['overview', 'how-to', 'reference', 'explanation']) {
    const first = read(`skeletons/page-${type}.md`).split('\n')[0]
    assert.match(first, /^# \S/, `page-${type}.md`)
  }
})

test('the working-in skeleton states the authority and keeps the overlay order', () => {
  const text = read('skeletons/skill-working-in.md')
  assert.match(text, /CLAUDE\.md|AGENTS\.md|instructions-file/)
  assert.match(text, /is the authority/)
  assert.deepEqual(
    headings(text).filter(h => h.startsWith('## ')),
    ['## Guardrails', '## Verify like CI', '## Gotchas', '## Docs', '## Changes that cross repos', '## Hand-off'],
  )
})
