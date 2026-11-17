#!/usr/bin/env node
// Runs a batch to completion across subscription usage limits: starts runner/run.mjs with the given
// cell arguments (plus --yes), and whenever the batch stops because a run hit a usage limit, waits and
// starts it again. Finished runs are skipped by the runner, so each pass resumes where the last stopped.
//
//   node scripts/run-resume.mjs [--wait-minutes 20] [--max-other-failures 2] -- --agent claude
//
// Meant to be started detached (setsid nohup ... &) so it outlives the shell. Stops when nothing is
// left to run, or after --max-other-failures passes that left runs failed for reasons other than a limit.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { ROOT, loadConfig, readJson } from '../runner/lib/util.mjs'

const argv = process.argv.slice(2)
const sep = argv.indexOf('--')
const own = sep < 0 ? [] : argv.slice(0, sep)
const runnerArgs = sep < 0 ? argv : argv.slice(sep + 1)
const opt = (name, dflt) => {
  const i = own.indexOf(`--${name}`)
  return i >= 0 ? Number(own[i + 1]) : dflt
}
const waitMinutes = opt('wait-minutes', 20)
const maxOtherFailures = opt('max-other-failures', 2)
const config = loadConfig()
const runsDir = path.resolve(ROOT, config.runsDir ?? 'runs')
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`)
const runner = (extra) => spawnSync(process.execPath, [path.join(ROOT, 'runner/run.mjs'), ...runnerArgs, ...extra], { cwd: ROOT, encoding: 'utf8', stdio: extra.includes('--dry-run') ? 'pipe' : 'inherit' })

function pending() {
  const out = runner(['--dry-run']).stdout ?? ''
  const ids = [...out.matchAll(/^ {2}(\S+__\S+__\S+__r\d+)$/gm)].map((m) => m[1])
  return ids
}

let otherFailures = 0
for (let pass = 1; ; pass++) {
  const todo = pending()
  if (!todo.length) {
    log('all selected runs are done')
    break
  }
  log(`pass ${pass}: ${todo.length} run(s) to do`)
  runner(['--yes'])
  const left = pending()
  if (!left.length) {
    log('all selected runs are done')
    break
  }
  const limited = left.some((id) => readJson(path.join(runsDir, id, 'status.json'), {})?.reason === 'usage-limit')
  if (limited) {
    log(`usage limit hit; waiting ${waitMinutes} min before resuming`)
    await new Promise((r) => setTimeout(r, waitMinutes * 60_000))
    continue
  }
  if (++otherFailures > maxOtherFailures) {
    log(`stopping: ${left.length} run(s) still not done after ${otherFailures} pass(es) without a usage limit: ${left.join(', ')}`)
    process.exitCode = 1
    break
  }
  log(`${left.length} run(s) failed for reasons other than a usage limit; retrying`)
}
log('finished; refresh the summary with node scripts/summary.mjs')
