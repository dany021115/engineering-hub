import { spawnSync } from 'node:child_process'
import { HubError } from './cli.mjs'

const MAX_BUFFER = 512 * 1024 * 1024

// Every git call goes through here: an argument array, never a shell.
export function git(cwd, args, { input, allowFail = false, raw = false } = {}) {
  const r = spawnSync('git', args, { cwd, input, maxBuffer: MAX_BUFFER, encoding: raw ? 'buffer' : 'utf8' })
  if (r.error) {
    if (r.error.code === 'ENOENT') throw new HubError('git is not installed or not on the PATH')
    throw r.error
  }
  if (r.status !== 0 && !allowFail) {
    const err = raw ? r.stderr.toString() : r.stderr
    throw new HubError(`git ${args[0]} failed in ${cwd}: ${err.trim()}`)
  }
  return r
}

export function gitAvailable() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' })
  return !r.error && r.status === 0
}

export function topLevel(cwd) {
  const r = git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true })
  return r.status === 0 ? r.stdout.trim() : null
}

export function revParse(dir, spec) {
  const r = git(dir, ['rev-parse', '--verify', '--quiet', spec], { allowFail: true })
  return r.status === 0 ? r.stdout.trim() : null
}

export const headCommit = dir => revParse(dir, 'HEAD^{commit}')

export function lsFiles(dir, extra = []) {
  const out = git(dir, ['ls-files', '-z', ...extra]).stdout
  return out.split('\0').filter(Boolean)
}

export function lsStage(dir) {
  const out = git(dir, ['ls-files', '-s', '-z']).stdout
  return out
    .split('\0')
    .filter(Boolean)
    .map(line => {
      const [meta, path] = line.split('\t')
      const [mode, object] = meta.split(' ')
      return { mode, object, path }
    })
}

export function showHead(dir, path) {
  const r = git(dir, ['show', `HEAD:${path}`], { allowFail: true, raw: true })
  return r.status === 0 ? r.stdout.toString('utf8') : null
}

// True when `needle` occurs nowhere in HEAD under the pathspec.
export function absentInHead(dir, needle, pathspec) {
  const args = ['grep', '-F', '-q', '-e', needle, 'HEAD']
  if (pathspec) args.push('--', pathspec)
  const r = git(dir, args, { allowFail: true })
  if (r.status === 1) return true
  if (r.status === 0) return false
  throw new HubError(`git grep failed in ${dir}: ${r.stderr.trim()}`)
}

export function hashObject(dir, file, { write = false } = {}) {
  const args = ['hash-object', ...(write ? ['-w'] : []), '--', file]
  return git(dir, args).stdout.trim()
}

export function statusZ(dir) {
  return git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { raw: true }).stdout
}

export function remoteUrl(dir, name = 'origin') {
  const r = git(dir, ['remote', 'get-url', name], { allowFail: true })
  return r.status === 0 ? r.stdout.trim() : null
}

// The default branch: the one origin/HEAD points at, else the branch checked out, else main.
export function defaultBranch(dir) {
  const r = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true })
  if (r.status === 0 && r.stdout.trim().startsWith('origin/')) return r.stdout.trim().slice('origin/'.length)
  const current = currentBranch(dir)
  return current && current !== 'HEAD' ? current : 'main'
}

export function currentBranch(dir) {
  const r = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })
  return r.status === 0 ? r.stdout.trim() : null
}
