// Pure helpers over absolute POSIX paths. Membership always checks the
// separator, so a sibling that shares a prefix (`/x/work-old`) is not inside.

export const isInside = (dir: string, root: string) =>
  root !== '' && (dir === root || dir.startsWith(`${root}/`))

export const relativeTo = (root: string, path: string) =>
  root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path

export const parentOf = (path: string) => {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : '/'
}

export const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path
