import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { generatorDir, loadCatalog } from './catalog.mjs'
import { HubError, parseOptions, result, usage } from './cli.mjs'
import { findOnPath } from './env.mjs'
import { headCommit, lsFiles, remoteUrl } from './git.mjs'
import { detectDocs, docsMarkdownCount } from './inventory.mjs'
import { readLock } from './lock.mjs'
import { isSafeRelative, runDir } from './paths.mjs'
import { placedFile } from './place.mjs'
import { readJson, resumePoint, runState } from './run.mjs'
import { generatorName, openRun, repoPath } from './start.mjs'
import { defaultHome, discover, preflight, walkFiles } from './workspace.mjs'

const MIN_NODE = [22, 12]
const INDEXES = ['index.md', 'README.md']
const SITE_CONFIG = /^docusaurus\.config\.[cm]?[jt]s$/

// Tests simulate an older Node with HUB_NODE_VERSION; nothing else sets it.
const nodeVersion = () => (process.env.HUB_NODE_VERSION ?? process.versions.node).split('.').map(Number)
const nodeOk = ([major, minor]) => major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])

// Every folder of the docs folder, itself included, that holds both index files.
function doubleIndexes(dir, rel) {
  const found = INDEXES.every(n => existsSync(join(dir, n))) ? [rel] : []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') found.push(...doubleIndexes(join(dir, e.name), `${rel}/${e.name}`))
  }
  return found
}

// Design 15.5.44: a Docusaurus, MkDocs or Sphinx site at the root, in a direct child folder of it,
// or in the docs folder; the hub's own site, registered in the lock, is reported apart.
function otherSites(repoDir, docsDir, hubPaths) {
  const places = new Set(['.', docsDir])
  for (const e of readdirSync(repoDir, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) places.add(e.name)
  const sites = []
  for (const place of places) {
    const dir = join(repoDir, place)
    if (!existsSync(dir)) continue
    const at = name => (place === '.' ? name : `${place}/${name}`)
    for (const name of readdirSync(dir)) {
      const isSite = SITE_CONFIG.test(name) || name === 'mkdocs.yml' || (name === 'conf.py' && existsSync(join(dir, 'index.rst')))
      if (isSite && !hubPaths.has(at(name))) sites.push(at(name))
    }
  }
  return [...new Set(sites)].sort()
}

// The checks `site --into` runs before writing anything (SIT-12, SIT-16): each failure, by name.
export function sitePreflight(root, repoDir, docs) {
  const failures = []
  const lock = readLock(repoDir)
  const docsDir = lock?.settings?.docsDir ?? docs ?? detectDocs(repoDir, lsFiles(repoDir)).docsDir
  const docsPath = join(repoDir, docsDir)
  if (!existsSync(docsPath)) failures.push(`the docs folder ${docsDir}/ does not exist`)
  else {
    if (!INDEXES.some(n => existsSync(join(docsPath, n)))) failures.push(`${docsDir}/index.md (or ${docsDir}/README.md) is missing: the site needs an index`)
    for (const d of doubleIndexes(docsPath, docsDir)) failures.push(`${d} has both index.md and README.md: keep one`)
  }
  const hubSite = Object.entries(lock?.files ?? {}).filter(([, e]) => e.kind === 'site').map(([p]) => p)
  if (hubSite.length) failures.push(`the lock already has a hub site (${hubSite[0].split('/')[0]}/): updating an installed site is out of scope`)
  for (const s of otherSites(repoDir, docsDir, new Set(hubSite))) failures.push(`another site is already here: ${s}`)
  if (!nodeOk(nodeVersion())) failures.push(`Node 22.12 or later is required; this is ${nodeVersion().join('.')}`)
  if (!findOnPath('npm')) failures.push('npm is required and is not on the PATH')
  const state = runState(root)
  if (resumePoint(state).discard) failures.push('.hub-run/ holds an unfinished run: finish or discard it with /hub:init first')
  return { failures, docsDir, lock }
}

const TEMPLATE = () => join(generatorDir(), '..', 'templates', 'site')
const onGitHub = dir => /(^|[/@])github\.com[/:]/.test(remoteUrl(dir) ?? '')
const SITE_WORKFLOW = '.github/workflows/docs-site.yml'
const npmVersion = () => {
  const npm = findOnPath('npm')
  if (!npm) return null
  const r = spawnSync(npm, ['--version'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

// The docs home: the repository whose lock lists the workspace, else the default of GEN-6.
function docsHome(found) {
  if (found.mode === 'repo') return found.repos[0] ?? null
  for (const name of found.repos) if (readLock(repoPath(found, name))?.workspace) return name
  const counts = Object.fromEntries(found.repos.map(n => {
    const dir = repoPath(found, n)
    const files = lsFiles(dir)
    return [n, docsMarkdownCount(files, detectDocs(dir, files).docsDir)]
  }))
  return defaultHome(counts)
}

// Design 11 step 2: the template, with a site.json holding only the title, noIndex and the docs folder.
function stage(run, repo, title, docsDir) {
  const out = join(run, 'out', repo, 'docs-site')
  const skip = (p, d) => ['node_modules', 'build', '.docusaurus'].includes(d.name)
  mkdirSync(out, { recursive: true })
  for (const rel of walkFiles(TEMPLATE(), skip)) {
    mkdirSync(join(out, rel, '..'), { recursive: true })
    cpSync(join(TEMPLATE(), rel), join(out, rel))
  }
  const json = { title, noIndex: true }
  if (docsDir !== 'docs') json.docsDir = `../${docsDir}`
  writeFileSync(join(out, 'site.json'), JSON.stringify(json, null, 2) + '\n')
  return walkFiles(out, () => false).map(rel => `docs-site/${rel}`).sort()
}

const BUILD_DIRS = ['node_modules', 'build', '.docusaurus']
const LINK_ERROR = /Markdown (link|image) with URL `([^`]+)` in source file "([^"]+)" \((\d+):\d+\) couldn't be resolved/g
// One block per page: its header, then one "-> linking to" line per broken target.
const PAGE_BLOCK = /- Broken (anchor|link) on source page path = (\S+?):[ \t]*\n((?:[ \t]*-> linking to [^\n]*\n?)+)/g
const TARGET = /-> linking to (\S+)(?: \(resolved as: ([^)]+)\))?/g
const DIAGRAM_ERROR = /^(\S[^:\n]*):(\d+): (.+)$/gm
const ANSI = /\x1b\[[0-9;]*m/g
const tail = text => text.trim().split('\n').slice(-15).join('\n')

function npmRun(npm, cwd, args) {
  const r = spawnSync(npm, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(ANSI, '') }
}

// The docs page a route comes from (routeBasePath is '/'), and the line where a target is written.
function pageSource(docsAbs, page) {
  const base = process.env.DOCS_BASE_PATH?.replace(/\/+$/, '')
  const route = (base && page.startsWith(`${base}/`) ? page.slice(base.length) : page).replace(/^\/+|\/+$/g, '')
  const stems = route ? [route, `${route}/index`, `${route}/README`] : ['index', 'README']
  for (const stem of stems) for (const ext of ['.md', '.mdx']) if (existsSync(join(docsAbs, stem + ext))) return join(docsAbs, stem + ext)
  return null
}
function lineOf(file, needles) {
  const lines = readFileSync(file, 'utf8').split('\n')
  for (const needle of needles) {
    const i = lines.findIndex(l => l.includes(needle))
    if (i >= 0) return i + 1
  }
  return null
}

// Each broken link, image or anchor that Docusaurus printed: links and images by file and line,
// anchors by their page (with the file and line too when the page's source and the anchor are found).
function buildErrors(out, siteDir, docsAbs, repoDir, folder) {
  const found = new Map()
  for (const m of out.matchAll(LINK_ERROR)) {
    found.set(`${m[3]}:${m[4]}:${m[2]}`, { path: relative(repoDir, resolve(siteDir, m[3])), message: `line ${m[4]}: the ${m[1]} ${m[2]} cannot be resolved` })
  }
  for (const m of out.matchAll(PAGE_BLOCK)) {
    const [, kind, page, targets] = m
    const source = pageSource(docsAbs, page)
    for (const [, target, resolvedAs] of targets.matchAll(TARGET)) {
      const fragment = target.includes('#') ? target.slice(target.indexOf('#')) : null
      const needles = kind === 'link' ? [`](${target}`, `](<${target}>`, `"${target}"`, target] : fragment ? [fragment] : []
      const line = source && needles.length ? lineOf(source, needles) : null
      const what = `a broken ${kind}: ${target}${resolvedAs ? ` (resolved as ${resolvedAs})` : ''}`
      found.set(`${page}:${kind}:${target}`, {
        path: source ? relative(repoDir, source) : folder,
        message: `${line ? `line ${line}: ` : ''}the page ${page} has ${what}`,
      })
    }
  }
  return [...found.values()]
}

// Design 11 step 5 and 15.8.107 (SIT-17): install, check the diagrams and build. Each broken link or
// diagram is named by file and line, each broken anchor by its page; a failed npm ci is the
// environment (exit 2) and nothing runs after it. The build folders that are not there yet are
// recorded in placed.json before npm starts, so that a discard removes them even after a build
// that was cut off; a folder that was already there is never recorded.
function buildSite(root, name, repoDir, folder, res) {
  const siteDir = join(repoDir, folder)
  if (!isSafeRelative(folder) || !existsSync(join(siteDir, 'package.json'))) throw usage(`${name} has no site to build in ${folder}/ (no package.json)`)
  const npm = findOnPath('npm')
  if (!npm) throw new HubError('npm is required and is not on the PATH')
  const absent = BUILD_DIRS.filter(d => !existsSync(join(siteDir, d))).map(d => `${folder}/${d}`)
  const file = placedFile(runDir(root))
  if (absent.length && existsSync(file)) {
    const placed = readJson(file)
    const rec = (placed.repos[name] ??= { files: {}, proposals: {} })
    rec.build = [...new Set([...(rec.build ?? []), ...absent])].sort()
    writeFileSync(file, JSON.stringify(placed, null, 2) + '\n')
  } else if (absent.length) res.warnings.push({ repo: name, message: `no placed.json: ${absent.join(', ')} are not recorded for a discard` })

  const ci = npmRun(npm, siteDir, ['ci', '--ignore-scripts'])
  if (!ci.ok) throw new HubError(`npm ci --ignore-scripts failed in ${name}/${folder}; nothing was checked or built:\n${tail(ci.out)}`)
  let docs = '../docs'
  try {
    docs = readJson(join(siteDir, 'site.json')).docsDir ?? docs
  } catch {}
  const docsAbs = resolve(siteDir, docs)
  const errors = []
  const diagrams = npmRun(npm, siteDir, ['run', '--silent', 'check:diagrams'])
  if (!diagrams.ok) {
    for (const m of diagrams.out.matchAll(DIAGRAM_ERROR)) errors.push({ path: relative(repoDir, join(docsAbs, m[1])), message: `line ${m[2]}: a broken mermaid diagram: ${m[3]}` })
    if (!errors.length) errors.push({ path: folder, message: `check:diagrams failed:\n${tail(diagrams.out)}` })
  }
  const build = npmRun(npm, siteDir, ['run', 'build'])
  if (!build.ok) {
    const found = buildErrors(build.out, siteDir, docsAbs, repoDir, folder)
    errors.push(...(found.length ? found : [{ path: folder, message: `the build failed:\n${tail(build.out)}` }]))
  }
  for (const e of errors) res.errors.push({ repo: name, gate: 'site', ...e })
  res.data = { repo: name, folder, built: !errors.length }
  res.lines.push(errors.length ? `the site in ${name}/${folder} did not build` : `built the site in ${name}/${folder}`)
  return res
}

// `site [--repo <dir>] --json` reports and writes nothing; `site --repo <dir> --into docs-site
// [--title <t>] [--docs <dir>] [--workflow]` runs the preflight, then prepares .hub-run/, the
// staging and an unapproved plan, never touching the repository (design 11, SIT-12 to SIT-15);
// `site [--repo <dir>] --build docs-site` builds the placed site (SIT-17).
export default function site(argv) {
  const { values } = parseOptions(argv, {
    repo: { type: 'string' },
    into: { type: 'string' },
    title: { type: 'string' },
    docs: { type: 'string' },
    workflow: { type: 'boolean' },
    build: { type: 'string' },
  })
  if (values.into !== undefined && values.into !== 'docs-site') throw usage('the site always goes in docs-site: --into docs-site')
  if (values.into !== undefined && values.build !== undefined) throw usage('--into and --build are separate steps')
  const found = discover(preflight(process.cwd()), loadCatalog().limits.maxRepos)
  const root = found.root
  const home = docsHome(found)
  let name = home
  if (values.repo && found.repos.includes(values.repo)) name = values.repo
  else if (values.repo) {
    // A folder (`.` in a single repository) or, above, a repository's name.
    let dir
    try {
      dir = realpathSync(resolve(values.repo))
    } catch {
      throw usage(`--repo ${values.repo}: no such folder or repository`)
    }
    name = found.repos.find(n => repoPath(found, n) === dir)
    if (!name) throw usage(`--repo ${values.repo} is not a repository of ${root}`)
  }
  if (!name) throw usage(`no repository with commits in ${root}`)
  const repoDir = repoPath(found, name)
  const res = result()
  if (values.build !== undefined) return buildSite(root, name, repoDir, values.build, res)

  if (!values.into) {
    const lock = readLock(repoDir)
    const docsDir = lock?.settings?.docsDir ?? detectDocs(repoDir, lsFiles(repoDir)).docsDir
    // Only whether origin is on GitHub: the URL itself may carry credentials.
    res.data = {
      mode: found.mode,
      root,
      repo: name,
      home,
      lock: Boolean(lock),
      hubSite: Object.values(lock?.files ?? {}).some(e => e.kind === 'site'),
      github: onGitHub(repoDir),
      docsDir,
      node: process.versions.node,
      npm: npmVersion(),
    }
    res.lines.push(`${name}: docs in ${docsDir}/, ${res.data.lock ? 'with' : 'without'} a lock${res.data.hubSite ? ' that has a hub site' : ''}, ${res.data.github ? 'GitHub' : 'no GitHub'} remote`)
    return res
  }

  const { failures, docsDir } = sitePreflight(root, repoDir, values.docs)
  if (failures.length) throw new HubError(`site: cannot install the site in ${name}:\n- ${failures.join('\n- ')}`)
  const { run } = openRun(found, [name])
  const paths = stage(run, name, values.title ?? name, docsDir)
  const files = paths.map((path, i) => ({ id: `s${i + 1}`, path, action: 'create', kind: 'site', why: 'the docs site' }))
  // SIT-21: the workflow runs on GitHub, so without a GitHub origin it is neither asked nor offered.
  if (values.workflow && onGitHub(repoDir)) files.push({ id: 'w1', path: SITE_WORKFLOW, action: 'propose', offer: 'docs-site', why: 'builds the site on pull requests' })
  else if (values.workflow) res.warnings.push({ repo: name, message: 'origin is not on GitHub: no docs-site.yml offer' })
  const plan = {
    schema: 1,
    mode: 'site',
    generator: generatorName(),
    settings: { language: 'en' },
    workspace: null,
    repos: { [name]: { head: headCommit(repoDir), docsDir, files, rejected: [], questions: [] } },
    approved: false,
  }
  writeFileSync(join(run, 'plan.json'), JSON.stringify(plan, null, 2) + '\n')
  res.data = { repo: name, docsDir, plan: join(run, 'plan.json'), files: files.map(f => ({ id: f.id, path: f.path, action: f.action })) }
  res.lines.push(`staged ${paths.length} site files for ${name} in ${relative(root, join(run, 'out', name, 'docs-site'))}/`, `plan: ${join(run, 'plan.json')} (not approved)`)
  return res
}
