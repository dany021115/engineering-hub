import { basename, parentOf } from './paths'

// Finds the workspace root and its repos from what the engine reads. Every
// read goes through `Reader`, which register.tsx backs with the engine file calls, so this
// module stays pure and the tests feed it a fake tree.

export type Reader = {
  // Where the path lands when it is a directory, else undefined.
  dirOf: (path: string) => Promise<string | undefined>
  // The names of the directories directly inside `dir`.
  listDirs: (dir: string) => Promise<string[]>
  exists: (path: string) => Promise<boolean>
  // The file's text; rejects when it cannot be read.
  read: (path: string) => Promise<string>
}

export type DiscoverInput = {
  options: { workspaceRoot?: unknown; neverIsolate?: unknown }
  // The session's repository root (the main working tree's), or null outside git.
  repoRoot: string | null
  sessionRoot: string
}

export type Repo = { name: string; path: string; docsDir: string; neverIsolate: boolean }

export type Workspace = {
  root: string
  repos: Repo[]
  skipped: number
  warnings: string[]
  // The repo whose lock lists the workspace: where the pages that span repos live.
  home?: string
}

export const MAX_REPOS = 30
export const LOCK_FILE = '.claude/hub.lock.json'
const DEFAULT_DOCS = 'docs'
const NAME = /^[A-Za-z0-9._-]+$/

export const isRepoName = (value: unknown): value is string =>
  typeof value === 'string' && NAME.test(value) && value !== '.' && value !== '..'

const isDocsDir = (value: unknown): value is string =>
  typeof value === 'string' &&
  value !== '' &&
  !value.startsWith('/') &&
  value.split('/').every(part => part !== '..' && part !== '')

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// What one lock says, each value checked on its own: an invalid one is dropped
// and the rest kept.
export type Lock = { workspace?: string[]; docsHome?: string; docsDir?: string }

export function parseLock(text: string): Lock {
  const raw: unknown = JSON.parse(text)
  if (!isObject(raw)) return {}
  const lock: Lock = {}
  if (isObject(raw.workspace) && Array.isArray(raw.workspace.repos)) {
    lock.workspace = raw.workspace.repos.filter(isRepoName)
  }
  const settings = isObject(raw.settings) ? raw.settings : {}
  if (isRepoName(settings.docsHome)) lock.docsHome = settings.docsHome
  if (isDocsDir(settings.docsDir)) lock.docsDir = settings.docsDir.replace(/\/+$/, '')
  return lock
}

export const neverIsolatedOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []

type LockRead = { lock?: Lock; warning?: string }

async function readLock(reader: Reader, repo: string): Promise<LockRead> {
  const path = `${repo}/${LOCK_FILE}`
  if (!(await reader.exists(path))) return {}
  try {
    return { lock: parseLock(await reader.read(path)) }
  } catch {
    return { warning: `Could not read ${path}; the office goes on without it.` }
  }
}

async function gitChildren(reader: Reader, root: string) {
  const names = (await reader.listDirs(root)).filter(name => !name.startsWith('.')).sort()
  const repos: string[] = []
  for (const name of names) if (await reader.exists(`${root}/${name}/.git`)) repos.push(name)
  return repos
}

async function existing(reader: Reader, root: string, names: string[]) {
  const repos: string[] = []
  for (const name of [...new Set(names)].sort()) if (await reader.exists(`${root}/${name}`)) repos.push(name)
  return repos
}

// `root` is what the office reports; the repos are the `names` under `base`.
type Found = { root: string; base: string; names: string[]; warnings: string[] }

async function fromRepo(reader: Reader, top: string): Promise<Found> {
  // A lone repo is its own root: nothing above it is assumed to be a workspace.
  const alone = (warnings: string[] = []) => ({
    root: top,
    base: parentOf(top),
    names: [basename(top)],
    warnings,
  })
  const among = async (names: string[]) => {
    const base = parentOf(top)
    return { root: base, base, names: await existing(reader, base, names), warnings: [] }
  }
  const own = await readLock(reader, top)
  if (own.warning) return alone([own.warning])
  if (own.lock?.workspace) return among(own.lock.workspace)

  const home = own.lock?.docsHome
  if (!home) return alone()
  const homePath = `${parentOf(top)}/${home}`
  if (!(await reader.exists(homePath))) return alone()
  const theirs = await readLock(reader, homePath)
  if (theirs.warning) return alone([theirs.warning])
  return theirs.lock?.workspace ? among(theirs.lock.workspace) : alone()
}

async function locate(input: DiscoverInput, reader: Reader): Promise<Found> {
  const { workspaceRoot } = input.options
  const configured =
    typeof workspaceRoot === 'string' && workspaceRoot !== '' ? await reader.dirOf(workspaceRoot) : undefined
  const children = async (root: string) => ({
    root,
    base: root,
    names: await gitChildren(reader, root),
    warnings: [],
  })
  if (configured) return children(configured)
  if (input.repoRoot === null) return children(input.sessionRoot)
  return fromRepo(reader, input.repoRoot)
}

// Reads each lock once, however many steps ask for it.
const cached = (reader: Reader): Reader => {
  const texts = new Map<string, Promise<string>>()
  return {
    ...reader,
    read: path => {
      const text = texts.get(path) ?? reader.read(path)
      texts.set(path, text)
      return text
    },
  }
}

export async function discover(input: DiscoverInput, source: Reader): Promise<Workspace> {
  const reader = cached(source)
  const neverIsolated = neverIsolatedOf(input.options.neverIsolate)
  const found = await locate(input, reader)

  const warnings = [...found.warnings]
  const kept = found.names.slice(0, MAX_REPOS)
  const skipped = found.names.length - kept.length
  if (skipped) {
    warnings.push(
      `${found.names.length} repos found in ${found.root}: the office briefs the first ${MAX_REPOS} and skipped ${skipped}.`,
    )
  }

  const repos: Repo[] = []
  const homes: string[] = []
  for (const name of kept) {
    const path = `${found.base}/${name}`
    const { lock, warning } = await readLock(reader, path)
    if (warning && !warnings.includes(warning)) warnings.push(warning)
    if (lock?.workspace) homes.push(name)
    repos.push({
      name,
      path,
      docsDir: lock?.docsDir ?? DEFAULT_DOCS,
      neverIsolate: neverIsolated.includes(name),
    })
  }
  if (homes.length > 1) {
    warnings.push(`Several repos list the workspace (${homes.join(', ')}): the office uses ${homes[0]}.`)
  }
  return { root: found.root, repos, skipped, warnings, home: homes[0] }
}
