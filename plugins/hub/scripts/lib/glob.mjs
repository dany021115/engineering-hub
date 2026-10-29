import { basename } from 'node:path'

const escape = s => s.replace(/[.+^$()|[\]\\{}]/g, '\\$&')

// Catalog globs only use `*` and `?` and match a file's base name.
export function globToRegExp(glob) {
  const body = glob
    .split('')
    .map(c => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : escape(c)))
    .join('')
  return new RegExp(`^${body}$`)
}

export function nameMatcher(globs) {
  const res = globs.map(globToRegExp)
  return path => {
    const name = basename(path)
    return res.some(re => re.test(name))
  }
}
