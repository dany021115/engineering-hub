import { parseArgs } from 'node:util'

// Exit codes (design 15.1.2): 0 no errors, 1 a gate error, 2 usage, environment or internal failure.
export class HubError extends Error {
  constructor(message, code = 2) {
    super(message)
    this.code = code
  }
}

export const usage = message => new HubError(message, 2)

export function parseOptions(argv, options, { positionals = false } = {}) {
  try {
    return parseArgs({
      args: argv,
      options: { json: { type: 'boolean' }, ...options },
      allowPositionals: positionals,
      strict: true,
    })
  } catch (err) {
    throw usage(err.message)
  }
}

export function result() {
  return { data: {}, lines: [], errors: [], warnings: [] }
}

const where = f => [f.repo, f.id, f.path].filter(Boolean).join(' ')

export function formatFinding(level, f) {
  const at = where(f)
  return `${level}: ${at ? at + ': ' : ''}${f.message}`
}

export function emit(res, json) {
  const code = res.errors.length ? 1 : 0
  if (json) {
    const body = { ok: code === 0, ...res.data, errors: res.errors, warnings: res.warnings }
    process.stdout.write(JSON.stringify(body, null, 2) + '\n')
  } else {
    for (const line of res.lines) process.stdout.write(line + '\n')
    for (const f of res.errors) process.stderr.write(formatFinding('error', f) + '\n')
    for (const f of res.warnings) process.stderr.write(formatFinding('warning', f) + '\n')
  }
  return code
}

export function emitFailure(err, json) {
  const internal = !(err instanceof HubError)
  const message = internal ? `internal error: ${err.stack || err.message}` : err.message
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n')
  process.stderr.write(message + '\n')
  return 2
}
