import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readJsonl(file) {
  const items = []
  const bad = []
  if (!existsSync(file)) return { items, bad }
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (!line.trim()) return
      try {
        const value = JSON.parse(line)
        if (value && typeof value === 'object' && !Array.isArray(value)) items.push(value)
        else bad.push({ line: i + 1, message: 'a line must be a JSON object' })
      } catch (err) {
        bad.push({ line: i + 1, message: `invalid JSON: ${err.message}` })
      }
    })
  return { items, bad }
}

export function writeJsonl(file, items) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, items.map(i => JSON.stringify(i) + '\n').join(''))
}
