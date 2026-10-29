// Test sandbox (design 15.7.98, 15.8.122): hub.mjs runs with a temporary HOME and a minimal PATH
// (links to node and git, plus fake claude, npm or vale only when a test asks), and git runs isolated
// from the person's config with a fixed synthetic identity. No test ever calls the real claude.
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PLUGIN = fileURLToPath(new URL('../', import.meta.url))
export const HUB = join(PLUGIN, 'scripts', 'hub.mjs')

export const IDENTITY = { name: 'Hub Fixture', email: 'fixture@example.com' }

function which(cmd) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const file = join(dir, cmd)
    if (dir && existsSync(file)) return realpathSync(file)
  }
  throw new Error(`${cmd} is not on the PATH of the test runner`)
}

const GIT = which('git')

export function gitEnv(extra = {}) {
  return {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  }
}

const ISOLATION = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false']

export function sandbox({ withGit = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hub-test-')))
  const home = join(base, 'home')
  const bin = join(base, 'bin')
  mkdirSync(home)
  mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, 'node'))
  if (withGit) symlinkSync(GIT, join(bin, 'git'))
  const env = { HOME: home, PATH: bin, TZ: 'UTC', ...gitEnv() }

  const sb = {
    base,
    home,
    bin,
    env,
    path: (...parts) => join(base, ...parts),
    write(file, content) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content)
      return file
    },
    read: file => readFileSync(file, 'utf8'),
    git(cwd, ...args) {
      const r = spawnSync(GIT, args, { cwd, env: { ...env, PATH: bin }, encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
      return r.stdout
    },
    // The only way a test commits in a fixture.
    commit(cwd, message = 'fixture') {
      sb.git(cwd, ...ISOLATION, 'add', '-A')
      sb.git(cwd, ...ISOLATION, 'commit', '-q', '--no-verify', '-m', message)
      return sb.git(cwd, 'rev-parse', 'HEAD').trim()
    },
    initRepo(dir, files = {}, { commit = true } = {}) {
      mkdirSync(dir, { recursive: true })
      sb.git(dir, 'init', '-q', '-b', 'main')
      for (const [p, content] of Object.entries(files)) sb.write(join(dir, p), content)
      if (commit) sb.commit(dir)
      return dir
    },
    // A fake executable written at run time; its interpreter is the test's own node.
    fake(name, source) {
      const file = join(bin, name)
      writeFileSync(file, `#!${process.execPath}\n${source}\n`)
      chmodSync(file, 0o755)
      return file
    },
    fakeClaude(marketplaces) {
      return sb.fake(
        'claude',
        `const a = process.argv.slice(2).join(' ')
if (a === 'plugin marketplace list --json') { process.stdout.write(${JSON.stringify(JSON.stringify(marketplaces))}); process.exit(0) }
process.stderr.write('fake claude: unexpected ' + a + '\\n'); process.exit(3)`,
      )
    },
    hub(args, { cwd = base, env: extra = {} } = {}) {
      const r = spawnSync(process.execPath, [HUB, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' })
      const out = {
        code: r.status,
        stdout: r.stdout,
        stderr: r.stderr,
        output: r.stdout + r.stderr,
        json() {
          return JSON.parse(r.stdout)
        },
      }
      return out
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
  return sb
}

export const BASE_FILES = {
  service: {
    'README.md': '# Service\n\nThe service answers API calls.\n',
    'CLAUDE.md': '# Service rules\n\nRun the tests before you push.\n',
    'package.json': '{\n  "name": "service",\n  "scripts": { "test": "node --test", "build": "tsc -p ." }\n}\n',
    'src/app.ts': "import { config } from './config'\n\nexport function start() {\n  return config.dbUrl\n}\n",
    'src/config.ts': 'export const config = {\n  dbUrl: process.env.DB_URL,\n}\n',
    '.github/workflows/ci.yml':
      'name: ci\non: [pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm test\n',
    'deploy/app.yaml': 'service: api\nreplicas: 2\n',
  },
  web: {
    'README.md': '# Web\n\nThe web client.\n',
    'package.json': '{\n  "name": "web",\n  "scripts": { "test": "node --test" }\n}\n',
    'src/app.ts': "import { API_BASE } from './client'\n\nexport const home = API_BASE + '/home'\n",
    'src/client.ts': "export const API_BASE = '/api/v1'\n",
  },
  infra: {
    'README.md': '# Infra\n\nInfrastructure as code.\n',
    'main.tf': 'resource "null_resource" "cluster" {}\n',
  },
}

// The `/w` workspace of the specs: `service`, `web` and `infra`, each with one commit.
export function makeWorkspace(sb, { extra = {}, repos = Object.keys(BASE_FILES), at = sb.path('w') } = {}) {
  mkdirSync(at, { recursive: true })
  const dirs = { w: at }
  for (const name of repos) {
    dirs[name] = sb.initRepo(join(at, name), { ...BASE_FILES[name], ...(extra[name] ?? {}) })
  }
  return dirs
}

export function copyTree(from, to) {
  cpSync(from, to, { recursive: true })
}

// Manual use for rehearsals: `node helper.mjs workspace <dir>` builds `/w` there and prints the
// git environment to export; `node helper.mjs commit <repo> [message]` commits with that identity.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, target, message] = process.argv.slice(2)
  const sb = sandbox()
  if (cmd === 'workspace' && target) {
    makeWorkspace(sb, { at: target })
    for (const [k, v] of Object.entries(gitEnv())) process.stdout.write(`export ${k}='${v}'\n`)
  } else if (cmd === 'commit' && target) {
    process.stdout.write(sb.commit(target, message) + '\n')
  } else {
    process.stderr.write('usage: helper.mjs workspace <dir> | commit <repo> [message]\n')
    process.exitCode = 2
  }
  sb.cleanup()
}
