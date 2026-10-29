// Where the pages live and which top-level folders become navbar sections.
// A section is a top-level folder with pages; its label comes from its index page, else from
// site.json's labels, else from the folder's name.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const siteDir = path.dirname(fileURLToPath(import.meta.url))
export const site = JSON.parse(fs.readFileSync(path.join(siteDir, 'site.json'), 'utf8'))
export const docsDir = path.resolve(siteDir, process.env.DOCS_DIR || site.docsDir || '../docs')

// "Last updated" dates are read from the git history of the site's own repository: the build fails
// when the site is outside a git worktree or the repository has no commit, and finds no dates for
// docs kept in another repository.
const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
const top = dir => (git(dir, 'rev-parse', '--show-toplevel').stdout ?? '').trim() || null
export const hasHistory = top(siteDir) !== null && top(siteDir) === top(docsDir) && git(siteDir, 'rev-parse', '--verify', '--quiet', 'HEAD').status === 0

const INDEXES = ['index.md', 'README.md']
const isPage = name => /\.mdx?$/.test(name)
const frontmatter = text => /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text)
const field = (block, key) => new RegExp(`^${key}:[ \\t]*(\\S.*?)[ \\t]*\\r?$`, 'm').exec(block ?? '')?.[1].replace(/^(['"])(.*)\1$/, '$2')
// `how-to` reads "How to".
const fromName = id => id.charAt(0).toUpperCase() + id.slice(1).replaceAll('-', ' ')

function describe(id) {
  const index = INDEXES.find(name => fs.existsSync(path.join(docsDir, id, name)))
  if (!index) return { id, label: site.labels?.[id] ?? fromName(id), position: Infinity }
  const text = fs.readFileSync(path.join(docsDir, id, index), 'utf8')
  const front = frontmatter(text)
  // As in Docusaurus, an H1 is the title only when it opens the page.
  const h1 = /^\s*#[ \t]+([^\n]*?)[ \t#]*(?:\n|$)/.exec(text.slice(front?.[0].length ?? 0))?.[1]
  const label = field(front?.[1], 'title') ?? h1 ?? id
  return { id, label, position: Number(field(front?.[1], 'sidebar_position') ?? Infinity) }
}

const hasPages = dir => fs.readdirSync(dir, { recursive: true }).some(name => isPage(String(name)))

// Ordered by the index's sidebar_position, then by label; '_' and '.' folders are not content.
export function sections() {
  if (!fs.existsSync(docsDir)) return []
  return fs
    .readdirSync(docsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !/^[._]/.test(e.name) && hasPages(path.join(docsDir, e.name)))
    .map(e => describe(e.name))
    .sort((a, b) => a.position - b.position || a.label.localeCompare(b.label))
}

// A navbar section opens the first page of its sidebar, so the section's index goes first
// whatever its file name or sidebar_position (which only orders the navbar).
export async function indexFirst({ defaultSidebarItemsGenerator, ...args }) {
  const items = await defaultSidebarItemsGenerator(args)
  const ids = INDEXES.map(name => `${args.item.dirName}/${name.replace(/\.md$/, '')}`)
  const isIndex = item => item.type === 'doc' && ids.includes(item.id)
  return [...items.filter(isIndex), ...items.filter(item => !isIndex(item))]
}
