// PreToolUse hook on Bash, Read, Grep and Glob, active only while a /hub:init run is open in the
// session's folder.
// The session itself may run a lone call to this plugin's hub.mjs, or P3's two read-only git commands,
// without a prompt: the command's own grant lasts only its first turn, and the harness may end that
// turn early (an agent run in the background, a resumed run). The run's agents may only read: some
// Claude Code builds give them no Grep or Glob, so read-only search commands are allowed, and anything
// that writes or runs the project is refused, and so is a read outside the session's folder: the
// prompt it would raise stalls the run until the person answers.
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runState } from './lib/run.mjs'

const hub = `node ${fileURLToPath(new URL('./hub.mjs', import.meta.url))} `
const gitRead = /^git -C \S+ (status --short|diff --stat)$/

const READERS = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'sort', 'uniq', 'cut', 'tr', 'echo', 'printf', 'cd', 'pwd', 'basename', 'dirname', 'stat', 'file', 'test', 'true', 'sed', 'git'])
const GIT_READS = new Set(['ls-files', 'grep', 'log', 'show', 'status', 'diff', 'rev-parse', 'blame', 'cat-file'])
const SED_PRINT = /^((\d+|\$)(,(\d+|\$))?|\/[^/]*\/(,(\d+|\$|\/[^/]*\/))?)p$/
const LOOP_WORDS = /^(for \w+ in .*|do|done|then|fi|else)$/
export const AGENT_HINT = 'During a /hub:init run an agent may only read: cat, head, tail, wc, ls, grep, rg, find (no -exec or -delete), sed -n with a print range such as 1,80p, sort, uniq, cut, tr, echo and git ls-files/grep/log/show/diff, joined by pipes, ; or &&. Nothing that writes a file or runs the project.'

// True when every simple command is a reader, with no write, substitution or background job.
export function readOnly(command) {
  // Quoted text is data: set it aside before looking for operators.
  const quoted = []
  const bare = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, q => `Q${quoted.push(q.slice(1, -1)) - 1}Q`).replace(/\s2>\s*\/dev\/null|\s2>&1/g, '')
  if (/[`<>]|\$\(|(^|[^&])&($|[^&])/.test(bare)) return false
  const parts = bare.split(/\|\|?|&&|;|\n/).map(s => s.trim()).filter(Boolean)
  return parts.length > 0 && parts.every(part => {
    const words = part.replace(/^(do|then|else)\s+/, '').split(/\s+/)
    const [name] = words
    if (LOOP_WORDS.test(part) || /^\w+=\S*$/.test(part)) return true
    if (!READERS.has(name)) return false
    if (name === 'find') return !words.some(w => /^-(exec|execdir|ok|okdir|delete|fprint\w*|fls)$/.test(w))
    // Only print ranges: sed's w and e commands would write or run.
    if (name === 'sed') {
      const script = words.filter(w => !w.startsWith('-'))[1]?.replace(/^Q(\d+)Q$/, (_, i) => quoted[i])
      return words.includes('-n') && !words.some(w => w.startsWith('-i')) && SED_PRINT.test(script ?? '')
    }
    // rg --pre and git's pager or config options would run a program.
    if (name === 'rg') return !words.some(w => w.startsWith('--pre'))
    if (name === 'git') {
      const at = words.findIndex((w, i) => i > 0 && !w.startsWith('-') && words[i - 1] !== '-C')
      if (words.slice(1, at).some(w => w !== '-C' && words[words.indexOf(w) - 1] !== '-C')) return false
      return GIT_READS.has(words[at]) && !words.some(w => /^(-O.*|--open-files-in-pager.*|--output.*|--ext-diff|--textconv)$/.test(w))
    }
    return true
  })
}

export const READ_HINT = "During a /hub:init run an agent reads only inside the session's folder: the repositories, and the briefs and catalog in .hub-run/generator/."

// The real path of `p`, through its deepest existing folder when `p` itself does not exist.
function real(p) {
  let rest = ''
  for (let at = p; ; at = dirname(at)) {
    try {
      return join(realpathSync(at), rest)
    } catch {
      if (dirname(at) === at) return p
      rest = join(basename(at), rest)
    }
  }
}

// Design 15.8.165: true when `target` resolves outside `root`.
export function outside(root, target) {
  const base = real(root)
  const at = real(resolve(root, target))
  return at !== base && !at.startsWith(base + sep)
}

// Claude Code saves a long tool result in the session's own `tool-results` folder and asks the agent
// to read it there: that read stays allowed.
const ownResult = (event, target) =>
  Boolean(event.session_id) && real(resolve(event.cwd, target)).includes(`${sep}${event.session_id}${sep}tool-results${sep}`)

const decide = (permissionDecision, permissionDecisionReason) =>
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } }))

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = ''
  process.stdin.on('data', d => (input += d)).on('end', () => {
    const event = JSON.parse(input)
    const state = runState(event.cwd)
    if (!state.exists || state.done) return
    if (event.tool_name !== 'Bash') {
      const target = event.tool_input?.file_path ?? event.tool_input?.path
      if (event.agent_id && target && outside(event.cwd, target) && !ownResult(event, target)) decide('deny', READ_HINT)
      return
    }
    const command = event.tool_input?.command ?? ''
    if (event.agent_id) return readOnly(command) ? decide('allow', 'a read-only command during a /hub:init run') : decide('deny', AGENT_HINT)
    // Never a pipe, redirect, chain, substitution or second line.
    if (/[|&;<>`$()\\\n]/.test(command)) return
    if (command.startsWith(hub) || gitRead.test(command)) decide('allow', 'a /hub:init step while its run is open')
  })
}
