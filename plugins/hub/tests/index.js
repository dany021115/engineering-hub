// `node --test plugins/hub/tests` resolves this folder as a module: load every test file in it.
const { readdirSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

for (const file of readdirSync(__dirname).filter(f => f.endsWith('.test.mjs')).sort()) {
  import(pathToFileURL(join(__dirname, file)).href)
}
