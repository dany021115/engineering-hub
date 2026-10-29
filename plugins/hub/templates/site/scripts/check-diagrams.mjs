// Parses every ```mermaid block in the docs folder and reports each broken one as <file>:<line>,
// because the build renders diagrams in the browser and never fails on them.
import fs from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { docsDir } from '../sections.js'

// Mermaid's sanitizer (DOMPurify) needs a DOM; without one, valid flowcharts fail to parse.
const { window } = new JSDOM('')
globalThis.window = window
globalThis.document = window.document
const { default: mermaid } = await import('mermaid')

const files = fs.existsSync(docsDir) ? fs.readdirSync(docsDir, { recursive: true }).filter(f => /\.mdx?$/.test(f)) : []
let errors = 0
for (const rel of files) {
  const text = fs.readFileSync(path.join(docsDir, rel), 'utf8')
  for (const m of text.matchAll(/^(`{3,})mermaid[^\n]*\n([\s\S]*?)^\1/gm)) {
    const line = text.slice(0, m.index).split('\n').length
    try {
      await mermaid.parse(m[2])
    } catch (e) {
      errors++
      console.log(`${rel.split(path.sep).join('/')}:${line}: ${String(e.message ?? e).split('\n')[0]}`)
    }
  }
}
console.log(`${errors} mermaid error(s) in ${files.length} file(s)`)
process.exit(errors ? 1 : 0)
