import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generatorDir } from './catalog.mjs'
import { defaultBranch } from './git.mjs'
import { skillSlug } from './plan.mjs'

const MARKETPLACE = 'engineering-hub'
const SETTINGS = '.claude/settings.json'

// Design 15.8.108: the patch names the git source only, never installLocation or a local path.
export function marketplaceSource(entry) {
  if (entry?.source === 'github' && entry.repo) return { source: 'github', repo: entry.repo }
  if (entry?.source === 'git' && entry.url) return { source: 'git', url: entry.url }
  return null
}

const json = value => JSON.stringify(value, null, 2) + '\n'

// The path an instructions line points at: the overlay if the line cites it, else the docs index.
export function lineTarget(f, repo, docsDir) {
  const name = `working-in-${skillSlug(repo)}`
  if (typeof f.text === 'string' && f.text.includes(name)) return `.claude/skills/${name}/SKILL.md`
  return `${docsDir === '.' ? '' : `${docsDir}/`}index.md`
}

const yamlQuoted = s => s.replaceAll("'", "''")

// The `.proposed` text `place` writes for an offer, or null with the reason it cannot; `note` is
// what P3 shows with it.
export function offerProposal(f, { dir, env, docsDir = 'docs' }) {
  if (f.offer === 'instructions-line') {
    const target = join(dir, f.path)
    const base = existsSync(target) ? readFileSync(target, 'utf8') : ''
    const sep = base && !base.endsWith('\n') ? '\n' : ''
    return { text: `${base}${sep}${f.text.trim()}\n` }
  }
  if (f.offer === 'guardrail-deny') return { text: json({ permissions: { deny: f.deny } }) }
  if (f.offer === 'team-settings') {
    const source = marketplaceSource(env.marketplace)
    if (!source) return { error: 'env.json has no git source for engineering-hub' }
    return {
      text: json({ enabledPlugins: { [`hub@${MARKETPLACE}`]: true }, extraKnownMarketplaces: { [MARKETPLACE]: { source } } }),
    }
  }
  if (f.offer === 'hub-check' || f.offer === 'docs-site') {
    // The workflows come from templates/ci/ (D5, D14); until a template exists there is nothing to write.
    const template = join(generatorDir(), '..', 'templates', 'ci', `${f.offer}.yml`)
    if (!existsSync(template)) return { error: `no workflow template for ${f.offer} in templates/ci/` }
    const text = readFileSync(template, 'utf8')
    if (f.offer === 'docs-site') {
      // Design 15.7.91, 15.8.105: the docs folder and the default branch the site builds from.
      const branch = defaultBranch(dir)
      const docs = docsDir === '.' ? '**' : `${docsDir}/**`
      return {
        text: text.replaceAll('__DOCS_DIR__/**', yamlQuoted(docs)).replaceAll('__DEFAULT_BRANCH__', yamlQuoted(branch)),
        note: `builds on pull requests and on pushes to ${branch}`,
      }
    }
    // Design 15.8.151: the clone URL comes from the git source; never a version (15.8.111).
    const source = marketplaceSource(env.marketplace)
    if (!source) return { error: 'env.json has no git source for engineering-hub' }
    const url = source.source === 'github' ? `https://github.com/${source.repo}` : source.url
    return { text: text.replaceAll('__HUB_TEMPLATE_URL__', url) }
  }
  return { error: `unknown offer ${f.offer}` }
}

export const isSettingsPatch = f => f.path === SETTINGS && ['guardrail-deny', 'team-settings'].includes(f.offer)

// Keys a patch adds; arrays gain the items they lack, in order; existing keys stay.
export function mergePatch(base, patch) {
  if (Array.isArray(base) && Array.isArray(patch)) {
    const out = [...base]
    for (const item of patch) if (!out.some(x => JSON.stringify(x) === JSON.stringify(item))) out.push(item)
    return out
  }
  if (base && patch && typeof base === 'object' && typeof patch === 'object' && !Array.isArray(base) && !Array.isArray(patch)) {
    const out = { ...base }
    for (const [k, v] of Object.entries(patch)) out[k] = k in base ? mergePatch(base[k], v) : v
    return out
  }
  return patch
}

export const settingsText = value => json(value)
