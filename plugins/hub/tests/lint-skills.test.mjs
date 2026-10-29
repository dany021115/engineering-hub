import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { sandbox } from './helper.mjs'
import { check, errorsOf, frontmatter, messages, overlayText, skillText, stage, writeSkill } from './gate-fixture.mjs'
import { guardrail, overlay, prepare, skill } from './plan-fixture.mjs'

const sb = sandbox()
after(() => sb.cleanup())

const x = n => 'x'.repeat(n)
let n = 0

// The broken SKILL.md cases c1-c12 of exp-skills 6c, written at run time.
const CASES = {
  c0: ['valid-skill', frontmatter('valid-skill', 'A valid control skill. Use when asked about the control.') + '\nBody.\n'],
  c1: ['no-desc', '---\nname: no-desc\n---\n\nBody.\n'],
  c2: ['name-mismatch', frontmatter('other-name', 'Name differs from its folder. Use when probing.') + '\nBody.\n'],
  c3: ['long-desc', frontmatter('long-desc', `Probe description. ${x(1081)}`) + '\nBody.\n'],
  c4: ['Bad_Chars', frontmatter('Bad_Chars', 'Uppercase and underscore in the name. Use when probing.') + '\nBody.\n'],
  c5: ['claude-helper', frontmatter('claude-helper', 'Name uses a reserved word. Use when probing.') + '\nBody.\n'],
  c6: [`a${'-b'.repeat(34)}c`, frontmatter(`a${'-b'.repeat(34)}c`, 'Name over 64 characters. Use when probing.') + '\nBody.\n'],
  c7: ['no-fm', 'Just a body with no frontmatter.\n'],
  c8: ['unknown-key', frontmatter('unknown-key', 'Has an unknown frontmatter key. Use when probing.', 'colour: blue\n') + '\nBody.\n'],
  c9: ['empty-desc', '---\nname: empty-desc\ndescription: ""\n---\n\nBody.\n'],
  c10: ['combined', frontmatter('combined', `Probe description. ${x(981)}`, `when_to_use: ${x(600)}\n`) + '\nBody.\n'],
  c11: ['bad-yaml', '---\nname: bad-yaml\ndescription: "unclosed quote\n---\n\nBody.\n'],
  c12: ['bad-type', frontmatter('bad-type', 'Wrong type for a boolean key. Use when probing.', 'disable-model-invocation: maybe\n') + '\nBody.\n'],
}

function fixture(skills) {
  const base = sb.path(`skills-${++n}`, '.claude', 'skills')
  for (const [folder, text] of skills) writeSkill(sb, base, folder, text)
  return base
}

const lint = (dir, ...flags) => sb.hub(['check', '--skills', ...[dir].flat(), ...flags, '--json'])

describe('c1-c12 in both modes (PUE-2, PUE-3)', () => {
  for (const [id, [folder, text]] of Object.entries(CASES)) {
    test(`${id} ${id === 'c0' ? 'passes' : 'fails'} with and without --authoring`, () => {
      const dir = fixture([[folder, text]])
      const expected = id === 'c0' ? 0 : 1
      for (const flags of [[], ['--authoring']]) {
        const r = lint(dir, ...flags)
        assert.equal(r.code, expected, `${id} ${flags}: ${r.output}`)
      }
    })
  }

  test('c12 fails by type with --authoring and by key without it', () => {
    const dir = fixture([CASES.c12])
    assert.match(messages(lint(dir, '--authoring')).join('\n'), /disable-model-invocation must be a boolean/)
    assert.match(messages(lint(dir)).join('\n'), /disable-model-invocation is not allowed in a generated skill/)
  })

  test('c10 fails with --authoring for passing 1536 with when_to_use', () => {
    assert.match(messages(lint(fixture([CASES.c10]), '--authoring')).join('\n'), /over 1536/)
  })

  test('a valid description of 600 characters passes with a warning', () => {
    const dir = fixture([['long-ok', frontmatter('long-ok', `Probe. ${x(593)}`) + '\nBody.\n']])
    const r = lint(dir)
    assert.equal(r.code, 0, r.output)
    assert.match(JSON.stringify(r.json().warnings), /over 500/)
  })
})

describe('keys by mode (PUE-2)', () => {
  const authored = frontmatter(
    'tools-skill',
    'Uses the authoring keys. Use when probing.',
    "allowed-tools: Bash(node x.mjs *)\nargument-hint: '[repo]'\ndisable-model-invocation: true\nwhen_to_use: When probing.\n",
  )
  const withModel = frontmatter('model-skill', 'Picks a model. Use when probing.', 'model: haiku\n') + '\nBody.\n'

  test('the authoring keys pass with --authoring and fail without it, naming each key', () => {
    const dir = fixture([['tools-skill', authored + '\nBody.\n']])
    assert.equal(lint(dir, '--authoring').code, 0)
    const r = lint(dir)
    assert.equal(r.code, 1)
    const all = messages(r).join('\n')
    for (const key of ['allowed-tools', 'argument-hint', 'disable-model-invocation', 'when_to_use']) assert.match(all, new RegExp(key))
  })

  test('model fails in both modes', () => {
    const dir = fixture([['model-skill', withModel]])
    for (const flags of [[], ['--authoring']]) {
      const r = lint(dir, ...flags)
      assert.equal(r.code, 1)
      assert.match(messages(r).join('\n'), /model/)
    }
  })

  test('the authoring keys fail in a planned skill', () => {
    const ctx = prepare(sb)
    ctx.plan({ service: { files: [overlay()] } })
    const fm = "allowed-tools: Bash(npm test)\nargument-hint: '[x]'\ndisable-model-invocation: true\nwhen_to_use: Always.\n"
    stage(sb, ctx, overlay().path, overlayText('', fm))
    const r = check(sb, ctx)
    assert.equal(r.code, 1)
    assert.match(messages(r).join('\n'), /allowed-tools[\s\S]*argument-hint[\s\S]*disable-model-invocation[\s\S]*when_to_use/)
  })
})

describe('names (PUE-3)', () => {
  test('a planned skill whose name a human skill of another repo has fails, naming both paths', () => {
    const human = frontmatter('web-testing', 'Testing the web client by hand. Use when testing web.') + '\nBody.\n'
    const ctx = prepare(sb, { workspace: true, extra: { service: { '.claude/skills/web-testing/SKILL.md': human } } })
    const files = [skill('w1', 'web-testing', 'procedure', [])]
    ctx.plan({ web: { files } }, { workspace: { home: 'web', repos: ['web'] } })
    stage(sb, ctx, files[0].path, skillText('web-testing', ['## Steps', '## Verify']), 'web')
    const r = check(sb, ctx)
    assert.equal(r.code, 1, r.output)
    const all = messages(r).join('\n')
    assert.match(all, /\.claude\/skills\/web-testing\/SKILL\.md: skill name web-testing is also used by .*service\/\.claude\/skills\/web-testing\/SKILL\.md/)
  })

  test('a planned skill named like a bundled skill fails', () => {
    const ctx = prepare(sb)
    const files = [skill('s9', 'code-review', 'procedure', ['F1', 'F6'])]
    ctx.plan({ service: { files } })
    stage(sb, ctx, files[0].path, skillText('code-review', ['## Steps', '## Verify']))
    const r = check(sb, ctx)
    assert.equal(r.code, 1)
    assert.match(messages(r).join('\n'), /code-review hides a skill bundled with Claude Code/)
  })

  test('the same name by hand in two folders is fine with --authoring', () => {
    const text = frontmatter('shared-notes', 'Shared notes. Use when taking notes.') + '\nBody.\n'
    const a = fixture([['shared-notes', text]])
    const b = fixture([['shared-notes', text]])
    assert.equal(lint([a, b], '--authoring').code, 0)
    assert.equal(lint([a, b]).code, 1)
  })

  test("a plugin's init command passes with --authoring and fails without it on the bundled name only", () => {
    const base = sb.path(`plugin-${++n}`, 'skills')
    writeSkill(sb, base, 'init', frontmatter('init', 'Generate the docs and skills of a project. Use when asked to set it up.') + '\nRun the steps in order.\n')
    assert.equal(lint(base, '--authoring').code, 0)
    const r = lint(base)
    assert.equal(r.code, 1)
    assert.equal(errorsOf(r).length, 1, r.output)
    assert.match(errorsOf(r)[0].message, /init hides a skill bundled/)
  })
})

describe('body, sections and cap (PUE-4)', () => {
  const home = ['', 'Users', 'someone', 'notes.txt'].join('/')
  const bad = {
    'a path inside a personal folder': `Read ${home} first.\n`,
    'a date': 'Changed on 2026-01-01.\n',
    'a version': 'Needs v1.2.3 of the tool.\n',
    'a line number': 'See src/app.ts:42 for the start.\n',
    'the path scripts/missing.sh does not exist': 'Run `scripts/missing.sh` first.\n',
  }

  test('budget and content of planned skills fail, naming what was found', () => {
    const ctx = prepare(sb)
    ctx.plan({ service: { files: [overlay()] } })
    const long = '\n' + Array.from({ length: 121 }, (_, i) => `Rule ${i + 1} holds.`).join('\n') + '\n'
    stage(sb, ctx, overlay().path, frontmatter('working-in-service', 'Working in service. Use when editing it.') + long)
    let r = check(sb, ctx)
    assert.equal(r.code, 1)
    assert.match(messages(r).join('\n'), /121 lines, over 120/)
    for (const [what, line] of Object.entries(bad)) {
      stage(sb, ctx, overlay().path, overlayText(line))
      r = check(sb, ctx)
      assert.equal(r.code, 1, what)
      assert.ok(messages(r).some(m => m.includes(what)), `${what}: ${r.output}`)
    }
    stage(sb, ctx, overlay().path, overlayText())
    assert.equal(check(sb, ctx).code, 0)
  })

  test('a hand-written SKILL.md of 501 lines fails with --authoring', () => {
    const body = '\n' + Array.from({ length: 501 }, () => 'A line.').join('\n') + '\n'
    const dir = fixture([['long-skill', frontmatter('long-skill', 'Long. Use when probing.') + body]])
    const r = lint(dir, '--authoring')
    assert.equal(r.code, 1)
    assert.match(messages(r).join('\n'), /501 lines, over 500/)
  })

  test('missing sections fail in en and not in es; the fourth skill fails in both', () => {
    const ctx = prepare(sb)
    const g = guardrail({ answer: 'yes' })
    const cases = [
      ['## Verify like CI', overlayText().replace('## Verify like CI\n', '')],
      ['## Hand-off', overlayText().replace('## Hand-off\n', '')],
    ]
    for (const language of ['en', 'es']) {
      for (const [section, text] of cases) {
        ctx.plan({ service: { files: [overlay()] } }, { settings: { language } })
        stage(sb, ctx, overlay().path, text)
        const r = check(sb, ctx)
        assert.equal(r.code, language === 'en' ? 1 : 0, `${section} ${language}: ${r.output}`)
        if (language === 'en') assert.match(messages(r).join('\n'), new RegExp(section))
      }
      ctx.plan({ service: { files: [overlay()] } }, { settings: { language } })
      stage(sb, ctx, overlay().path, overlayText())
      assert.equal(check(sb, ctx).code, 0, `clean overlay ${language}`)

      ctx.plan({ service: { files: [g.files[0]], questions: [g.question] } }, { settings: { language } })
      stage(sb, ctx, g.files[0].path, skillText('service-db-guardrails', ['## Rules']))
      const r = check(sb, ctx)
      assert.equal(r.code, language === 'en' ? 1 : 0, `guardrail ${language}: ${r.output}`)
      if (language === 'en') assert.match(messages(r).join('\n'), /## Safe path/)
    }
    const four = [
      overlay(),
      g.files[0],
      skill('s3', 'service-run-tests', 'procedure', ['F1', 'F6']),
      skill('s4', 'service-typescript-style', 'style', ['F11', 'F12', 'F14']),
    ]
    const texts = [
      overlayText(),
      skillText('service-db-guardrails', ['## Rules', '## Safe path']),
      skillText('service-run-tests', ['## Steps', '## Verify']),
      frontmatter('service-typescript-style', 'TypeScript style of service. Use when editing ts files.', "paths: 'src/**'\n") + '\n## Conventions\n\nExport handlers as constants.\n',
    ]
    for (const language of ['en', 'es']) {
      ctx.plan({ service: { files: four, questions: [g.question] } }, { settings: { language } })
      four.forEach((f, i) => stage(sb, ctx, f.path, texts[i]))
      const r = check(sb, ctx)
      assert.equal(r.code, 1)
      const capped = errorsOf(r).filter(e => /over caps.skillsPerRepo/.test(e.message))
      assert.deepEqual(capped.map(e => e.id), ['s4'], language)
    }
  })

  test('a procedure without ## Verify and a style skill without ## Conventions name their section (CON-7)', () => {
    const ctx = prepare(sb)
    const files = [skill('s3', 'service-run-tests', 'procedure', ['F1', 'F6']), skill('s4', 'service-typescript-style', 'style', ['F11', 'F12', 'F14'])]
    ctx.plan({ service: { files } })
    stage(sb, ctx, files[0].path, skillText('service-run-tests', ['## Steps']))
    stage(sb, ctx, files[1].path, frontmatter('service-typescript-style', 'Style. Use when editing ts.', "paths: 'src/**'\n") + '\n## Rules\n\nKeep it.\n')
    const r = check(sb, ctx)
    assert.equal(r.code, 1)
    const all = messages(r).join('\n')
    assert.match(all, /service-run-tests\/SKILL\.md: the procedure skill needs the section ## Verify/)
    assert.match(all, /service-typescript-style\/SKILL\.md: the style skill needs the section ## Conventions/)
  })

  test('check --skills without a plan skips archetype sections but not the keys', () => {
    const text = frontmatter('working-in-service', 'Working in service. Use when editing it.') + '\nNo sections here.\n'
    const dir = fixture([['working-in-service', text]])
    assert.equal(lint(dir).code, 0, lint(dir).output)
    const withTools = fixture([['working-in-service', text.replace('---\n\n', 'allowed-tools: Bash\n---\n\n')]])
    const r = lint(withTools)
    assert.equal(r.code, 1)
    assert.match(messages(r).join('\n'), /allowed-tools/)
  })

  test('four hand-written skills without archetype sections pass with --authoring', () => {
    const skills = ['one', 'two', 'three', 'four'].map(s => [`notes-${s}`, frontmatter(`notes-${s}`, `Notes ${s}. Use when needed.`) + '\nBody.\n'])
    assert.equal(lint(fixture(skills), '--authoring').code, 0)
  })

  test('paths of the destination project pass with --authoring; without it only real paths fail', () => {
    const base = sb.path(`plugin-${++n}`, 'skills')
    const body = [
      '',
      'Look up `.claude/hub.lock.json` before you change a page.',
      'The tool lives in `/opt/tool/bin/run`.',
      'Each repo has `<repo>/AGENTS.md`.',
      'Run `${CLAUDE_PLUGIN_ROOT}/scripts/hub.mjs` for the gates.',
      '',
    ].join('\n')
    writeSkill(sb, base, 'docs-with-code', frontmatter('docs-with-code', 'Keep docs with the code. Use when code changes.') + body)
    assert.equal(lint(base, '--authoring').code, 0)
    const r = lint(base)
    assert.equal(r.code, 1)
    const errs = errorsOf(r).map(e => e.message)
    assert.equal(errs.length, 2, r.output)
    assert.ok(errs.some(m => m.includes('the path .claude/hub.lock.json does not exist')))
    assert.ok(errs.some(m => m.includes('the path /opt/tool/bin/run does not exist')))
    assert.ok(!errs.some(m => /personal folder|absolute/.test(m)))
  })
})

test('lint-skills works on folders given as several arguments', () => {
  const a = fixture([['alpha-notes', frontmatter('alpha-notes', 'Alpha. Use when needed.') + '\nBody.\n']])
  const r = sb.hub(['check', '--skills', a, join(a, '..'), '--authoring', '--json'])
  assert.equal(r.code, 0, r.output)
})
