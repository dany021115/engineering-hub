#!/usr/bin/env node
// The hub's deterministic CLI (design §4). Data goes to stdout, diagnostics to stderr;
// exit 0 without errors, 1 with a gate error, 2 on usage, environment or internal failure.
import { emit, emitFailure, usage } from './lib/cli.mjs'
import check from './lib/check.mjs'
import drift from './lib/drift.mjs'
import facts from './lib/facts.mjs'
import finish from './lib/finish.mjs'
import impact from './lib/impact.mjs'
import place from './lib/place.mjs'
import plan from './lib/plan.mjs'
import review from './lib/review.mjs'
import sample from './lib/sample.mjs'
import scan from './lib/scan.mjs'
import site from './lib/site.mjs'
import start from './lib/start.mjs'
import verdicts from './lib/verdicts.mjs'

const COMMANDS = { start, facts, verdicts, plan, check, review, place, finish, sample, scan, drift, impact, site }

const USAGE = `usage: hub.mjs <command> [options] [--json]
commands: ${Object.keys(COMMANDS).join(', ')}`

async function main(argv) {
  const [name, ...rest] = argv
  const json = rest.includes('--json')
  try {
    const command = COMMANDS[name]
    if (!command) throw usage(name ? `unknown command: ${name}\n${USAGE}` : USAGE)
    const res = await command(rest)
    return emit(res, json)
  } catch (err) {
    return emitFailure(err, json)
  }
}

process.exitCode = await main(process.argv.slice(2))
