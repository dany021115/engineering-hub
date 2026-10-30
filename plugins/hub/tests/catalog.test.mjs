import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { PLUGIN } from './helper.mjs'

const catalog = JSON.parse(readFileSync(join(PLUGIN, 'generator', 'catalog.json'), 'utf8'))
const bySkeleton = Object.fromEntries(Object.values(catalog.skills).map(s => [s.skeleton, s]))

test('caps hold the design values and no area explorers', () => {
  assert.deepEqual(catalog.caps, {
    skillsPerRepo: 3,
    proceduresPerRepo: 2,
    agentsAtOnce: 4,
    factsPerRepo: 150,
    confirmAboveRuns: 12,
  })
  assert.equal('areaExplorersAbove' in catalog.caps, false)
})

test('the gates cut a shown quote at 120 characters and sample 5 sentences (EVI-7)', () => {
  assert.equal(catalog.limits.gateQuoteChars, 120)
  assert.equal(catalog.limits.spotSentences, 5)
})

test('every skill archetype has its skeleton, budget, minFacts and required sections', () => {
  const expect = {
    'skeletons/skill-working-in.md': [2, ['## Verify like CI', '## Hand-off']],
    'skeletons/skill-procedure.md': [2, ['## Steps', '## Verify']],
    'skeletons/skill-style.md': [3, ['## Conventions']],
    'skeletons/skill-guardrails.md': [1, ['## Rules', '## Safe path']],
  }
  assert.deepEqual(Object.keys(bySkeleton).sort(), Object.keys(expect).sort())
  for (const [skeleton, [minFacts, required]] of Object.entries(expect)) {
    const s = bySkeleton[skeleton]
    assert.equal(s.minFacts, minFacts, skeleton)
    assert.deepEqual(s.required, required, skeleton)
    assert.equal(typeof s.name, 'string')
    assert.ok(Number.isInteger(s.maxLines) && s.maxLines > 0)
    assert.ok(Number.isInteger(s.priority))
  }
  const priorities = Object.entries(catalog.skills).sort((a, b) => a[1].priority - b[1].priority)
  assert.deepEqual(
    priorities.map(([k]) => k),
    ['working-in', 'guardrail', 'procedure', 'style'],
  )
})

test('every page has path, type, when, budgets and the minimum sections of its type', () => {
  const minimum = {
    'how-to': ['## Before you begin', '## Steps', '## Verify'],
    overview: ['## Where to start'],
    reference: [],
    explanation: [],
  }
  for (const [key, p] of Object.entries(catalog.pages)) {
    assert.equal(typeof p.path, 'string', key)
    assert.ok(p.path.endsWith('.md'), key)
    assert.ok(Object.keys(minimum).includes(p.type), key)
    assert.ok(Array.isArray(p.when) && p.when.length, key)
    assert.ok('maxWords' in p && 'maxSteps' in p, key)
    for (const section of minimum[p.type]) assert.ok(p.required.includes(section), `${key} ${section}`)
  }
  assert.deepEqual(catalog.pages['run-tests'].when, ['tests-need-setup'])
  assert.ok(catalog.pages.configuration.when.includes('reads-env-vars'))
})

test('the catalog holds the lists the scripts read', () => {
  for (const key of [
    'bundledSkillNames',
    'timelessWords',
    'groundingAllow',
    'configFiles',
    'sensitiveFiles',
    'factKinds',
    'verifiedKinds',
    'rejectReasons',
  ]) {
    assert.ok(Array.isArray(catalog[key]) && catalog[key].length, key)
  }
  assert.ok(catalog.frontmatterKeys.generated && catalog.frontmatterKeys.authoring)
  assert.deepEqual(Object.keys(catalog.offers).sort(), [
    'docs-site',
    'guardrail-deny',
    'hub-check',
    'instructions-line',
    'team-settings',
  ])
  assert.ok(catalog.configFiles.includes('.editorconfig'))
})
