import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { currentBranch, git, headCommit, lsStage, remoteUrl } from './git.mjs'
import { nameMatcher } from './glob.mjs'

const MARKDOWN = new Set(['.md', '.mdx', '.markdown'])
export const isMarkdown = p => MARKDOWN.has(extname(p).toLowerCase())

const CODE_EXT = new Set(
  'ts tsx js jsx mjs cjs py rb go rs java kt kts scala swift m mm c h cc cpp hpp cs fs php ex exs erl clj dart lua r jl sh bash zsh ps1 sql tf hcl vue svelte elm hs ml'.split(
    ' ',
  ),
)

const by = re => p => re.test(p)
const CLASSES = {
  instructions: by(
    /(^|\/)(CLAUDE|AGENTS|GEMINI)\.md$|^\.claude\/rules\/|^\.cursor\/rules\/|^\.cursorrules$|^\.github\/copilot-instructions\.md$/,
  ),
  skills: by(/^\.claude\/skills\/[^/]+\/SKILL\.md$/),
  manifests: by(
    /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|Pipfile|setup\.py|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|mix\.exs|[^/]+\.csproj|deno\.jsonc?)$/,
  ),
  tasks: by(/(^|\/)(Makefile|makefile|GNUmakefile|justfile|Justfile|Taskfile\.ya?ml|Rakefile|noxfile\.py|tox\.ini)$/),
  ci: by(
    /^\.github\/workflows\/[^/]+\.ya?ml$|^\.gitlab-ci\.yml$|^\.circleci\/config\.yml$|^azure-pipelines\.yml$|(^|\/)Jenkinsfile$|^\.buildkite\/|^bitbucket-pipelines\.yml$/,
  ),
  deploy: by(
    /(^|\/)(Dockerfile[^/]*|[^/]*compose[^/]*\.ya?ml|[^/]+\.tf|Chart\.yaml|Procfile|fly\.toml|serverless\.ya?ml|app\.yaml|vercel\.json|netlify\.toml)$/,
  ),
  contracts: by(/(^|\/)(openapi[^/]*\.(ya?ml|json)|swagger[^/]*\.(ya?ml|json)|asyncapi[^/]*\.(ya?ml|json)|[^/]+\.(proto|graphql|gql|avsc))$/),
}

const DATA = /(^|\/)(migrations|migrate)\/|(^|\/)(schema\.prisma|schema\.sql)$/

// The class `drift` reports a new path under: CI, manifest, contract, data or deploy (design 8).
export function evidenceClass(path) {
  if (DATA.test(path)) return 'data'
  return ['ci', 'manifests', 'contracts', 'deploy'].find(k => CLASSES[k](path)) ?? null
}

const SITE_CONFIG = /^docusaurus\.config\.[cm]?[jt]s$/

// Design 15.5.44 and 15.3.30: an existing site's folder wins; a docs/ with HTML moves to documentation/.
export function detectDocs(repoDir, files) {
  const has = p => files.includes(p)
  if (has('mkdocs.yml')) {
    const m = readText(join(repoDir, 'mkdocs.yml'))?.match(/^docs_dir:\s*['"]?([^'"\s#]+)/m)
    return { docsDir: stripSlash(m ? m[1] : 'docs'), site: 'mkdocs' }
  }
  const top = p => p.split('/').length <= 2
  const docusaurus = files.find(p => top(p) && SITE_CONFIG.test(basename(p)))
  if (docusaurus) {
    const base = dirname(docusaurus)
    const m = readText(join(repoDir, docusaurus))?.match(/\bpath:\s*['"]([^'"]+)['"]/)
    const rel = m ? join(base, m[1]) : join(base, 'docs')
    return { docsDir: stripSlash(rel.replace(/^\.\//, '')), site: 'docusaurus' }
  }
  const sphinx = files.find(
    p => basename(p) === 'conf.py' && (top(p) || p.startsWith('docs/')) && has(join(dirname(p), 'index.rst')),
  )
  if (sphinx) return { docsDir: dirname(sphinx) === '.' ? '.' : dirname(sphinx), site: 'sphinx' }
  const html = files.some(p => p.startsWith('docs/') && /\.html?$/i.test(p))
  return { docsDir: html ? 'documentation' : 'docs', site: null }
}

const stripSlash = s => s.replace(/\/+$/, '')

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function docsMarkdownCount(files, docsDir) {
  return files.filter(p => p.startsWith(docsDir + '/') && isMarkdown(p)).length
}

// `https://host/owner/repo` without credentials, from https, ssh or scp-like URLs.
export function normalizeRemote(url) {
  if (!url) return null
  let host, path
  const scp = url.match(/^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/)
  if (scp && !/^[a-z]+:\/\//i.test(url)) [, host, path] = scp
  else {
    try {
      const u = new URL(url)
      if (u.protocol === 'file:') return null
      host = u.hostname + (u.port && !/^ssh/.test(u.protocol) ? `:${u.port}` : '')
      path = u.pathname
    } catch {
      return null
    }
  }
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '')
  return `https://${host}/${path}`
}

const ENV_PATTERNS = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /os\.environ\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /os\.environ\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /os\.Getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  /env::var\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  /System\.getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  /ENV\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /ENV\.fetch\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /Environment\.GetEnvironmentVariable\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  /\bgetenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
]
const YAML_ENV = /\$\{([A-Z_][A-Z0-9_]*)/g
const DOCKER_ENV = /^\s*ENV\s+([A-Za-z_][A-Za-z0-9_]*)/gm
const MAX_SCAN_BYTES = 1024 * 1024

export function envNames(path, text) {
  const names = new Set()
  const take = re => {
    for (const m of text.matchAll(re)) names.add(m[1])
  }
  ENV_PATTERNS.forEach(take)
  if (/\.ya?ml$/.test(path)) take(YAML_ENV)
  if (/(^|\/)Dockerfile[^/]*$/.test(path)) take(DOCKER_ENV)
  return names
}

// Design 15.8.173: what GitHub Linguist treats as vendored without any attribute.
// ponytail: the common folders and minified bundles of Linguist's vendor list, not all of it.
const VENDORED = /(^|\/)(vendors?|third[-_]?party|node_modules|bower_components|Pods|Carthage)\/|\.min\.(js|css)$/

function linguistExcluded(repoDir, files) {
  if (!files.length) return new Set()
  const out = git(repoDir, ['check-attr', '-z', '--stdin', 'linguist-vendored', 'linguist-generated'], {
    input: files.join('\0') + '\0',
  }).stdout.split('\0')
  const excluded = new Set()
  for (let i = 0; i + 2 < out.length; i += 3) {
    const [file, attr, value] = out.slice(i, i + 3)
    if (value === 'set' || value === 'true') excluded.add(file)
    // An explicit `linguist-vendored=false` (or `-linguist-vendored`) keeps a default path in.
    else if (attr === 'linguist-vendored' && value === 'unspecified' && VENDORED.test(file)) excluded.add(file)
  }
  return excluded
}

// Collapse excluded files to the widest folder whose tracked files are all excluded.
function collapse(files, excluded) {
  const total = new Map()
  const hit = new Map()
  for (const f of files) {
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/')
      total.set(d, (total.get(d) ?? 0) + 1)
      if (excluded.has(f)) hit.set(d, (hit.get(d) ?? 0) + 1)
    }
  }
  const out = new Set()
  for (const f of excluded) {
    const parts = f.split('/')
    let item = f
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/')
      if (hit.get(d) === total.get(d)) {
        item = d + '/'
        break
      }
    }
    out.add(item)
  }
  return [...out].sort()
}

export function buildInventory(repoDir, catalog) {
  const stage = lsStage(repoDir)
  const submodules = stage.filter(e => e.mode === '160000').map(e => e.path)
  const all = [...new Set(stage.filter(e => e.mode !== '160000').map(e => e.path))]
  const excludedFiles = linguistExcluded(repoDir, all)
  const files = all.filter(p => !excludedFiles.has(p))
  const isSensitive = nameMatcher(catalog.sensitiveFiles)
  const sensitive = files.filter(isSensitive)
  const { docsDir, site } = detectDocs(repoDir, all)

  const languages = {}
  for (const p of files) {
    const ext = extname(p).slice(1).toLowerCase()
    if (CODE_EXT.has(ext)) languages[ext] = (languages[ext] ?? 0) + 1
  }
  const classes = Object.fromEntries(Object.entries(CLASSES).map(([k, test]) => [k, files.filter(test)]))
  const data = [
    ...new Set(
      files.flatMap(p => {
        const m = p.match(/^(.*?(?:^|\/)(?:migrations|migrate))\//)
        if (m) return [m[1] + '/']
        return /(^|\/)(schema\.prisma|schema\.sql)$/.test(p) ? [p] : []
      }),
    ),
  ].sort()
  const docs = files.filter(
    p =>
      p === 'README.md' ||
      (p.startsWith(docsDir + '/') && isMarkdown(p)) ||
      p === 'mkdocs.yml' ||
      SITE_CONFIG.test(basename(p)),
  )

  const envVars = {}
  for (const p of files) {
    if (isSensitive(p) || isMarkdown(p) || p.startsWith(docsDir + '/')) continue
    const abs = join(repoDir, p)
    let text
    try {
      if (statSync(abs).size > MAX_SCAN_BYTES) continue
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    for (const name of envNames(p, text)) (envVars[name] ??= []).push(p)
  }

  const dirty = git(repoDir, ['status', '--porcelain', '--untracked-files=no']).stdout.split('\n').filter(Boolean)
  const codeowners = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'].find(p => files.includes(p)) ?? null

  return {
    repo: basename(repoDir),
    root: repoDir,
    head: headCommit(repoDir),
    branch: currentBranch(repoDir),
    remote: normalizeRemote(remoteUrl(repoDir)),
    dirty,
    tracked: files.length,
    languages,
    areas: [...new Set(files.filter(p => p.includes('/') && !p.startsWith('.')).map(p => p.split('/')[0]))].sort(),
    ...classes,
    data,
    docs,
    docsDir,
    docsSite: site,
    docsHasHtml: all.some(p => p.startsWith('docs/') && /\.html?$/i.test(p)),
    docsMarkdown: docsMarkdownCount(files, docsDir),
    codeowners,
    sensitive,
    envVars: Object.fromEntries(Object.keys(envVars).sort().map(k => [k, envVars[k]])),
    submodules,
    excluded: collapse(all, excludedFiles),
  }
}

export function readInventory(runDir, name) {
  const file = join(runDir, 'inventory', `${name}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}
