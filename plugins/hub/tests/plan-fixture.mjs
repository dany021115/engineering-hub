// Shared set-up for the plan tests: a prepared run with checked facts and a plan builder.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorkspace } from './helper.mjs'

const handler = p => ({ path: p, quote: 'export const handler = () => null' })

export const SERVICE_EXTRA = {
  'src/a.ts': 'export const handler = () => null\n',
  'src/b.ts': 'export const handler = () => null\n',
  'src/c.ts': 'export const handler = () => null\n',
  'src/d.ts': 'export const handler = () => null\n',
  '.eslintrc.json': '{ "rules": { "no-var": "error" } }\n',
}

const fact = (id, kind, evidence) => ({ type: 'fact', id, kind, claim: `claim of ${id}`, evidence })

export const SERVICE_FACTS = [
  fact('F1', 'command', [{ path: '.github/workflows/ci.yml', quote: 'run: npm test' }]),
  fact('F2', 'config', [{ path: 'src/config.ts', quote: 'dbUrl: process.env.DB_URL' }]),
  fact('F3', 'gotcha', [{ path: '.github/workflows/ci.yml', quote: 'run: npm ci' }]),
  fact('F5', 'gotcha', [{ path: 'deploy/app.yaml', quote: 'replicas: 2' }]),
  fact('F6', 'command', [{ path: 'package.json', quote: '"test": "node --test"' }]),
  fact('F8', 'config', [{ path: 'deploy/app.yaml', quote: 'service: api' }]),
  fact('F11', 'convention', [handler('src/a.ts'), handler('src/b.ts'), handler('src/c.ts')]),
  fact('F12', 'convention', [handler('src/b.ts'), handler('src/c.ts'), handler('src/d.ts')]),
  fact('F13', 'convention', [{ path: '.eslintrc.json', quote: '"no-var": "error"' }]),
  fact('F14', 'convention', [handler('src/a.ts'), handler('src/c.ts'), handler('src/d.ts')]),
]

let n = 0

export function prepare(sb, { extra = {}, facts = SERVICE_FACTS, workspace = false, repos, wsFacts, before, env = {} } = {}) {
  const w = makeWorkspace(sb, {
    at: sb.path(`p${++n}`, 'w'),
    extra: { ...extra, service: { ...SERVICE_EXTRA, ...(extra.service ?? {}) } },
    ...(repos ? { repos } : {}),
  })
  const names = repos ?? ['service', 'web', 'infra']
  const root = workspace ? w.w : w.service
  const args = workspace ? names.flatMap(r => ['--repo', w[r]]) : ['--repo', w.service]
  // `before` changes the trees after their commit and before start takes its snapshot.
  if (before) before(w)
  const started = sb.hub(['start', ...args], { cwd: root, env })
  assert.equal(started.code, 0, started.stderr)
  sb.write(join(root, '.hub-run', 'facts', 'service.jsonl'), facts.map(f => JSON.stringify(f) + '\n').join(''))
  assert.equal(sb.hub(['facts', '--repo', 'service'], { cwd: root }).code, 0)
  if (wsFacts) {
    sb.write(join(root, '.hub-run', 'facts', '_workspace.jsonl'), wsFacts.map(f => JSON.stringify(f) + '\n').join(''))
    sb.hub(['facts', '--repo', '_workspace'], { cwd: root })
  }
  const head = name => sb.git(w[name], 'rev-parse', 'HEAD').trim()
  const planFile = join(root, '.hub-run', 'plan.json')
  return {
    ...w,
    root,
    head,
    planFile,
    plan(repos, extraPlan = {}) {
      const body = {
        schema: 1,
        mode: 'init',
        generator: 'hub@0.1.0',
        settings: { language: 'en' },
        workspace: null,
        repos: Object.fromEntries(
          Object.entries(repos).map(([name, r]) => [
            name,
            { head: head(name), docsDir: 'docs', rejected: [], questions: [], ...r },
          ]),
        ),
        estimate: { agentRuns: 7 },
        approved: false,
        ...extraPlan,
      }
      sb.write(planFile, JSON.stringify(body, null, 2) + '\n')
      return body
    },
    run(...args) {
      return sb.hub(['plan', planFile, ...args], { cwd: root })
    },
    readPlan: () => JSON.parse(readFileSync(planFile, 'utf8')),
    appendChecked(name, item) {
      const file = join(root, '.hub-run', 'facts', `${name}.checked.jsonl`)
      sb.write(file, readFileSync(file, 'utf8') + JSON.stringify(item) + '\n')
    },
  }
}

export const skill = (id, name, archetype, facts, extra = {}) => ({
  id,
  path: `.claude/skills/${name}/SKILL.md`,
  action: 'create',
  kind: 'skill',
  archetype,
  why: 'fixture',
  facts,
  ...extra,
})

export const page = (id, path, type, trigger, facts = ['F2'], extra = {}) => ({
  id,
  path,
  action: 'create',
  kind: 'page',
  type,
  ...(trigger ? { trigger } : {}),
  why: 'fixture',
  facts,
  ...extra,
})

export const overlay = (facts = ['F1', 'F3']) => skill('s1', 'working-in-service', 'working-in', facts)

// A guardrail skill with its deny entry and the P2 question that decides both.
export function guardrail({ answer = null, deny = ['Bash(npm run db:migrate)'], facts = ['F5'] } = {}) {
  return {
    files: [
      skill('s2', 'service-db-guardrails', 'guardrail', facts),
      { id: 'g1', path: '.claude/settings.json', action: 'propose', offer: 'guardrail-deny', deny, why: 'pairs with s2' },
    ],
    question: {
      id: 'Q1',
      text: 'Do migrations run against a shared database?',
      decides: ['s2', 'g1'],
      default: 'no',
      answer,
      role: answer === null ? null : 'maintainer',
    },
  }
}
