import type { AgentStatus, On } from 'claude-code'
import type { Reader } from '../hooks/workspace/discover'

// A fake file tree: file paths with their text; folders are implied by them.
// It backs both the pure reader of discover.ts and the kit's fs hooks.
export type Files = Record<string, string>

export const repoFiles = (...paths: string[]): Files =>
  Object.fromEntries(paths.map(path => [`${path}/.git/HEAD`, 'ref: refs/heads/main\n']))

export const lockOf = (lock: unknown) => JSON.stringify(lock)

export function fakeTree(files: Files) {
  const reads: string[] = []
  const isFile = (path: string) => Object.hasOwn(files, path)
  const isDir = (path: string) => Object.keys(files).some(file => file.startsWith(`${path}/`))
  const children = (dir: string) => {
    const names = new Map<string, 'file' | 'dir'>()
    for (const file of Object.keys(files)) {
      if (!file.startsWith(`${dir}/`)) continue
      const [name, ...rest] = file.slice(dir.length + 1).split('/')
      if (name) names.set(name, rest.length ? 'dir' : 'file')
    }
    return [...names].map(([name, kind]) => ({ name, kind }))
  }
  const read = (path: string) => {
    reads.push(path)
    if (!isFile(path)) throw new Error(`ENOENT: ${path}`)
    return files[path] as string
  }
  const reader: Reader = {
    dirOf: async path => (isDir(path) ? path : undefined),
    listDirs: async dir =>
      children(dir)
        .filter(one => one.kind === 'dir')
        .map(one => one.name),
    exists: async path => isFile(path) || isDir(path),
    read: async path => read(path),
  }
  return { files, reads, reader, isFile, isDir, children, read }
}

export type Session = { cwd: string; repo?: string }

// The kit's side of the fake tree: the fs, session and git calls the office
// makes, answered from `files`, with what it wrote, toasted, ran and spawned.
export function serveTree(on: On, files: Files, session: Session) {
  const tree = fakeTree(files)
  const toasts: string[] = []
  const ran: { argv: string[]; stdin?: string }[] = []
  const spawns: { name?: string; cwd?: string; prompt: string; description: string }[] = []
  // What git answers beyond the defaults: a worktree's diff and the exit of `apply --check`.
  const git = { diff: '', checkExit: 0 }
  // Each spawned agent is running unless a test says otherwise.
  const statuses: Record<string, AgentStatus> = {}
  const repoOf = (dir: string) => {
    for (let at = dir; at && at !== '/'; at = at.slice(0, at.lastIndexOf('/'))) {
      if (tree.isDir(`${at}/.git`)) return at
    }
    return undefined
  }
  const done = (stdout = '', exitCode = 0, stderr = '') => ({
    value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('fs.stat', (_$, e) => {
    if (!tree.isDir(e.path) && !tree.isFile(e.path)) throw new Error(`ENOENT: ${e.path}`)
    const kind = tree.isDir(e.path) ? ('dir' as const) : ('file' as const)
    return { value: { kind, size: 0, mtimeMs: 0, isLink: false, realPath: e.resolve ? e.path : undefined } }
  })
  on('fs.list', (_$, e) => ({
    value: tree
      .children(e.path)
      .map(({ name, kind }) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.exists', (_$, e) => ({ value: tree.isFile(e.path) || tree.isDir(e.path) }))
  on('fs.read', (_$, e) => ({ value: tree.read(e.path) }))
  on('fs.write', (_$, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: session.cwd }))
  on('session.root', () => ({ value: session.cwd }))
  on('session.repo', () => ({
    value: session.repo ? { root: session.repo, remote: null, internal: false, name: null } : null,
  }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('agent.list', () => ({
    value: spawns.map((spawn, index) => ({
      id: `agent${index + 1}`,
      name: spawn.name,
      description: spawn.description,
      type: 'general-purpose',
      status: statuses[`agent${index + 1}`] ?? ('running' as const),
    })),
  }))
  on('agent.spawn', (_$, e) => {
    spawns.push({ name: e.name, cwd: e.cwd, prompt: e.prompt, description: e.description })
    // The kit reads a plugin's spawn back as the Agent tool's record too.
    const agentId = `agent${spawns.length}`
    return { model: 'claude-opus-5-5', agentId, result: { agentId } } as never
  })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    ran.push({ argv, stdin: e.init?.stdin })
    const dir = argv[2] ?? ''
    if (argv.includes('rev-parse')) {
      const repo = repoOf(dir)
      return repo ? done(`${repo}\n`) : done('', 128, 'not a git repository')
    }
    if (argv.includes('diff')) return done(git.diff)
    if (argv.includes('--check')) return done('', git.checkExit, git.checkExit ? 'error: patch failed\n' : '')
    if (argv.includes('worktree') && argv.includes('add')) {
      files[`${argv[argv.length - 2]}/.git`] = 'gitdir: x'
      return done()
    }
    return done()
  })
  return { ...tree, toasts, ran, spawns, git, statuses }
}
