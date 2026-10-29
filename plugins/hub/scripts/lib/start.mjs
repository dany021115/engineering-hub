import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { loadCatalog, generatorDir } from './catalog.mjs'
import { HubError, parseOptions, result, usage } from './cli.mjs'
import { probeEnv } from './env.mjs'
import { git, lsFiles, statusZ } from './git.mjs'
import { buildInventory, detectDocs, docsMarkdownCount } from './inventory.mjs'
import { lockPath, runDir } from './paths.mjs'
import { clearRun, inProgress, resumePoint, runState } from './run.mjs'
import { defaultHome, discover, preflight, rootListing } from './workspace.mjs'

export const repoPath = (found, name) => (found.mode === 'repo' ? found.root : join(found.root, name))

function modifiedTracked(dir) {
  return git(dir, ['status', '--porcelain', '--untracked-files=no'])
    .stdout.split('\n')
    .filter(Boolean)
    .map(line => line.slice(3))
}

function survey(found, res) {
  const counts = {}
  const repos = found.repos.map(name => {
    const dir = repoPath(found, name)
    const files = lsFiles(dir)
    const { docsDir } = detectDocs(dir, files)
    counts[name] = docsMarkdownCount(files, docsDir)
    const modified = modifiedTracked(dir)
    if (modified.length) {
      res.warnings.push({
        repo: name,
        message: `tracked files differ from HEAD, and facts are checked against HEAD: ${modified.join(', ')}`,
      })
    }
    return { name, path: dir, docsDir, docsMarkdown: counts[name], reinit: existsSync(lockPath(dir)), modified }
  })
  const state = runState(found.root)
  const { resume, discard } = resumePoint(state)
  res.data = {
    mode: found.mode,
    root: found.root,
    candidates: found.repos,
    repos,
    skipped: found.skipped,
    home: defaultHome(counts),
    resume,
    discard,
    sitePlan: inProgress(state) && state.plan?.mode === 'site',
    generator: generatorName(),
  }
  res.lines.push(`mode: ${found.mode}`, `repositories: ${found.repos.join(', ') || '(none)'}`)
  for (const s of found.skipped) res.lines.push(`skipped ${s.name}: ${s.reason}`)
  res.lines.push(`default docs home: ${res.data.home ?? '(none)'}`)
  if (resume) res.lines.push(`unfinished run: resume from ${resume}, or discard with ${discard}`)
  else if (discard) res.lines.push(`unfinished site run: discard it with ${discard}`)
  return res
}

function discardRun(root, res) {
  const state = runState(root)
  if (state.placed && !state.done) {
    throw new HubError('files are already placed in the repository: discard them with `finish --keep none`')
  }
  clearRun(root)
  res.data = { discarded: state.exists }
  res.lines.push(state.exists ? `removed ${runDir(root)}` : 'nothing to discard')
  return res
}

// Design 15.1.8: one explorer per repo, expected verifiers, a writer, two review rounds and one fix.
function estimate(inventories, workspace, catalog) {
  const batch = catalog.limits.verifierBatchSize
  const perRepo = {}
  for (const inv of inventories) {
    const facts = Math.min(catalog.caps.factsPerRepo, Math.max(10, Math.ceil(inv.tracked / 20)), 50)
    perRepo[inv.repo] = 1 + Math.ceil(facts / batch) + 1 + 2 + 1
  }
  const extra = workspace ? 4 : 0
  const total = Object.values(perRepo).reduce((a, b) => a + b, 0) + extra
  return { perRepo, workspace: extra, total, confirm: total > catalog.caps.confirmAboveRuns }
}

function selectRepos(found, values) {
  const names = []
  for (const value of values) {
    let dir
    try {
      dir = realpathSync(resolve(value))
    } catch {
      throw usage(`--repo ${value}: no such folder`)
    }
    const ok = found.mode === 'repo' ? dir === found.root : dirname(dir) === found.root
    if (!ok) throw usage(`--repo ${value} is not a repository of ${found.root}`)
    const name = basename(dir)
    if (!found.repos.includes(name)) throw usage(`--repo ${value} has no commits or is not a repository`)
    if (!names.includes(name)) names.push(name)
  }
  return names.sort()
}

// The plan's `generator`, so the session never reads the plugin's own folder, a resumed run included.
export const generatorName = () => `hub@${JSON.parse(readFileSync(join(generatorDir(), '..', '.claude-plugin', 'plugin.json'), 'utf8')).version}`

// A fresh `.hub-run/` (design 15.8.102, 15.8.136): a finished run or one without a resume point is
// removed; then its .gitignore, env.json and the git status of each repository, plus, in a
// workspace, the listing of the root's own files.
export function openRun(found, names) {
  const root = found.root
  const state = runState(root)
  if (inProgress(state)) {
    const { resume, discard } = resumePoint(state)
    const how = resume ? `resume it from ${resume}, or discard it with ${discard}` : `discard it with ${discard}`
    throw new HubError(`${runDir(root)} holds an unfinished run: ${how}`)
  }
  clearRun(root)
  const run = runDir(root)
  mkdirSync(join(run, 'status'), { recursive: true })
  writeFileSync(join(run, '.gitignore'), '*\n')
  const env = probeEnv()
  writeFileSync(join(run, 'env.json'), JSON.stringify(env, null, 2) + '\n')
  for (const name of names) writeFileSync(join(run, 'status', `${name}.txt`), statusZ(repoPath(found, name)))
  if (found.mode === 'workspace') {
    const lines = rootListing(root)
    writeFileSync(join(run, 'status', '.root.txt'), lines.map(l => l + '\n').join(''))
  }
  return { run, env }
}

function prepareRun(found, values, catalog, res) {
  const names = selectRepos(found, values)
  const root = found.root
  const { run, env } = openRun(found, names)
  mkdirSync(join(run, 'inventory'), { recursive: true })
  cpSync(generatorDir(), join(run, 'generator'), { recursive: true })

  const inventories = names.map(name => {
    const dir = repoPath(found, name)
    const inv = buildInventory(dir, catalog)
    writeFileSync(join(run, 'inventory', `${name}.json`), JSON.stringify(inv, null, 2) + '\n')
    return inv
  })
  const counts = Object.fromEntries(inventories.map(i => [i.repo, i.docsMarkdown]))
  const est = estimate(inventories, found.mode === 'workspace' && names.length > 1, catalog)
  res.data = {
    mode: found.mode,
    root,
    run,
    repos: inventories.map(i => ({
      name: i.repo,
      docsDir: i.docsDir,
      docsSite: i.docsSite,
      docsHasHtml: i.docsHasHtml,
      reinit: existsSync(lockPath(repoPath(found, i.repo))),
      runs: est.perRepo[i.repo],
    })),
    estimate: est,
    home: defaultHome(counts),
    env,
    generator: generatorName(),
  }
  res.lines.push(`prepared ${run}`)
  for (const i of inventories) res.lines.push(`${i.repo}: docs in ${i.docsDir}, about ${est.perRepo[i.repo]} agent runs`)
  res.lines.push(`estimated agent runs: ${est.total}${est.confirm ? ' (above the confirmation threshold)' : ''}`)
  res.lines.push(`default docs home: ${res.data.home}`)
  if (!env.gitSource) res.lines.push('no git source for engineering-hub: no team settings or hub-check offer')
  return res
}

export default function start(argv) {
  const { values } = parseOptions(argv, { repo: { type: 'string', multiple: true }, discard: { type: 'boolean' } })
  if (values.discard && values.repo) throw usage('--discard does not take --repo')
  const catalog = loadCatalog()
  const found = discover(preflight(process.cwd()), catalog.limits.maxRepos)
  const res = result()
  res.warnings.push(...found.warnings)
  if (values.discard) return discardRun(found.root, res)
  if (values.repo) return prepareRun(found, values.repo, catalog, res)
  return survey(found, res)
}
