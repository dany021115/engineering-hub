import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { runDir } from './paths.mjs'

const MARKETPLACE = 'engineering-hub'

export function findOnPath(cmd) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const file = join(dir, cmd)
    try {
      accessSync(file, constants.X_OK)
      return file
    } catch {}
  }
  return null
}

// Design 15.8.108 and 15.8.140: only a github `repo` or a git `url` is a git source.
export function isGitSource(entry) {
  if (!entry) return false
  if (entry.source === 'github') return typeof entry.repo === 'string' && entry.repo.length > 0
  if (entry.source === 'git') return typeof entry.url === 'string' && entry.url.length > 0
  return false
}

export function probeEnv() {
  const claude = findOnPath('claude')
  if (!claude) return { claude: false, marketplace: null, gitSource: false }
  const r = spawnSync(claude, ['plugin', 'marketplace', 'list', '--json'], { encoding: 'utf8', timeout: 60000 })
  let marketplace = null
  if (!r.error && r.status === 0) {
    try {
      const list = JSON.parse(r.stdout)
      const entries = Array.isArray(list) ? list : (list.marketplaces ?? [])
      marketplace = entries.find(e => e?.name === MARKETPLACE) ?? null
    } catch {}
  }
  return { claude: true, marketplace, gitSource: isGitSource(marketplace) }
}

export function readEnv(root) {
  const file = join(runDir(root), 'env.json')
  if (!existsSync(file)) return { claude: false, marketplace: null, gitSource: false }
  return JSON.parse(readFileSync(file, 'utf8'))
}
