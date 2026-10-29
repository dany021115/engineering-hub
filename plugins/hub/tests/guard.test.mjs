import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { PLUGIN, sandbox } from './helper.mjs'

const sb = sandbox()
after(() => sb.cleanup())

const HUB = join(PLUGIN, 'scripts', 'hub.mjs')
const hook = (cwd, command, extra = {}) => {
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command }, ...extra }
  const r = spawnSync(process.execPath, [join(PLUGIN, 'scripts', 'guard.mjs')], { input: JSON.stringify(event), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : null
}

test('during a run the session may call hub.mjs alone and the two P3 git reads; agents may only read (GEN-2, GEN-7)', () => {
  const dir = sb.path('guard-run')
  sb.write(join(dir, '.hub-run', '.gitignore'), '*\n')
  assert.equal(hook(dir, `node ${HUB} check .hub-run/plan.json --round 1 --json`), 'allow')
  assert.equal(hook(dir, `git -C ${dir} status --short`), 'allow')
  assert.equal(hook(dir, `git -C ${dir} diff --stat`), 'allow')
  for (const extra of [' | cat', ' > out.json', ' && rm -rf x', '; ls', ' $(id)', ' `id`', '\nls']) {
    assert.equal(hook(dir, `node ${HUB} plan .hub-run/plan.json --json${extra}`), null, extra)
    assert.equal(hook(dir, `git -C ${dir} status --short${extra}`), null, extra)
  }
  assert.equal(hook(dir, `cd x && node ${HUB} start --json`), null)
  assert.equal(hook(dir, `node ${join(dir, 'hub.mjs')} start --json`), null)
  assert.equal(hook(dir, `git -C ${dir} push`), null)
  const agent = command => hook(dir, command, { agent_id: 'a1', agent_type: 'Explore' })
  for (const command of [
    'cat README.md',
    'cd /w/service; ls -la; grep -rn "process.env" --exclude-dir=.git . | head -20',
    "R=/w/service; cd $R; for f in a.md b.md; do echo \"=== $f\"; cat -n $f; done",
    "find server -type f -not -path '*/migrations/*' | sort | head -100",
    'git ls-files | grep -v "^.hub-run" | wc -l',
    'git -C /w/service log --oneline -5 && git show HEAD:package.json',
    'rg -n "API_BASE|isConfigured" src 2>/dev/null',
    "grep -n 'a > b' src/x.ts",
    'sed -n 60,200p README.md; cat docs/backend-architecture.md',
    "cd /w/app; sed -n '1,$p' lib/a.dart; sed -n '/[Cc]orrect/,$p' brief.md | head -80",
    'git grep -c "flutter analyze" -- .github/ ; echo "--"',
    'grep -n "kSchemaVersion\\|kSchema\\b" app/lib/schema.dart | head -5',
  ]) assert.equal(agent(command), 'allow', command)
  for (const command of [
    'cat a > b',
    'echo x >> notes.md',
    'rm -rf .hub-run',
    'npm test',
    'flutter test',
    'find . -name "*.tmp" -delete',
    'find . -exec rm {} ;',
    'cat $(ls)',
    'ls `pwd`',
    'sleep 9 & ls',
    'tee out.txt < a',
    "sed -n 'w out' a",
    "sed -n '1e rm x' a",
    'sed -i s/a/b/ x',
    "sed 's/a/b/' x",
    'rg --pre ./x pat',
    'git -c core.pager=x log',
    'git checkout -- .',
    'git log --output=out.txt',
    'PAGER=x git log',
    'xargs rm',
  ]) assert.equal(agent(command), 'deny', command)
})

test('outside a run, or once it is finished, the hook decides nothing', () => {
  const none = sb.path('guard-none')
  assert.equal(hook(none, `node ${HUB} start --json`), null)
  assert.equal(hook(none, 'cat README.md', { agent_id: 'a1' }), null)
  const done = sb.path('guard-done')
  sb.write(join(done, '.hub-run', 'done.json'), '{}\n')
  assert.equal(hook(done, `node ${HUB} start --json`), null)
})

test('during a run an agent never reads outside the session folder; the session itself still may (GEN-7)', () => {
  const dir = sb.path('guard-read')
  sb.write(join(dir, '.hub-run', '.gitignore'), '*\n')
  const read = (tool_name, tool_input, extra = { agent_id: 'a1', agent_type: 'general-purpose' }) => hook(dir, '', { tool_name, tool_input, ...extra })
  assert.equal(read('Read', { file_path: join(dir, 'service', 'README.md') }), null)
  assert.equal(read('Read', { file_path: join(dir, '.hub-run', 'generator', 'briefs', 'write.md') }), null)
  assert.equal(read('Read', { file_path: sb.path('elsewhere', 'grounding.mjs') }), 'deny')
  assert.equal(read('Read', { file_path: join(dir, '..', 'elsewhere.md') }), 'deny')
  assert.equal(read('Grep', { pattern: 'x' }), null)
  assert.equal(read('Grep', { pattern: 'x', path: 'service/src' }), null)
  assert.equal(read('Grep', { pattern: 'x', path: sb.path('elsewhere') }), 'deny')
  assert.equal(read('Glob', { pattern: '**/*.mjs', path: '/' }), 'deny')
  // A long tool result that Claude Code saved for this session stays readable; another session's is not.
  const saved = sid => sb.path('home', '.claude', 'projects', 'p', sid, 'tool-results', 'b1.txt')
  const session = { agent_id: 'a1', agent_type: 'general-purpose', session_id: 's1' }
  assert.equal(read('Read', { file_path: saved('s1') }, session), null)
  assert.equal(read('Read', { file_path: saved('s2') }, session), 'deny')
  assert.equal(read('Read', { file_path: sb.path('elsewhere', 'grounding.mjs') }, {}), null)
  const none = sb.path('guard-read-none')
  assert.equal(hook(none, '', { tool_name: 'Read', tool_input: { file_path: sb.path('elsewhere', 'a.md') }, agent_id: 'a1' }), null)
})
