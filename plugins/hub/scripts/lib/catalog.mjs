import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The plugin's own generator folder; a copy of the plugin obeys its own catalog.
export const generatorDir = () => fileURLToPath(new URL('../../generator/', import.meta.url))

export const pluginManifest = () => fileURLToPath(new URL('../../.claude-plugin/plugin.json', import.meta.url))

let cached
export function loadCatalog() {
  cached ??= JSON.parse(readFileSync(generatorDir() + 'catalog.json', 'utf8'))
  return cached
}

export function generatorVersion() {
  const { version } = JSON.parse(readFileSync(pluginManifest(), 'utf8'))
  return `hub@${version}`
}
