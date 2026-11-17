#!/usr/bin/env node
// Runs the hidden acceptance suites against the untouched starter templates (no agent involved).
// Every test is expected to FAIL there; the point is to check that each suite loads and runs, and
// that failures are assertion/locator failures rather than bugs in the test code.
//
//   node scripts/test-template.mjs [--task 01-booking] [--arm ui-sdk]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runAcceptance } from '../runner/evaluate.mjs'
import { serveStatic } from '../runner/lib/static-server.mjs'
import { ARMS, ROOT, loadTasks, writeJson } from '../runner/lib/util.mjs'
import { prepareWorkspace } from '../runner/lib/workspace.mjs'

const argv = process.argv.slice(2)
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined)
const tasks = loadTasks().filter((t) => fs.existsSync(path.join(ROOT, 'acceptance', t.id)) && (!opt('--task') || opt('--task').split(',').includes(t.id)))
const arms = opt('--arm') ? opt('--arm').split(',') : ARMS
const scratch = path.join(os.tmpdir(), 'ui-sdk-bench-template-check')
const HARNESS_BUG = /\b(TypeError|ReferenceError|SyntaxError|is not a function|Cannot read properties|is not defined)\b/
const summary = []

for (const task of tasks) {
  for (const arm of arms) {
    const dir = path.join(scratch, `${task.id}__${arm}`)
    prepareWorkspace({ task, arm, dest: dir, nodeModules: 'symlink' })
    execFileSync('npx', ['tsc', '-b'], { cwd: dir, stdio: 'inherit' })
    execFileSync('npx', ['vite', 'build', '--outDir', 'dist', '--emptyOutDir', '--logLevel', 'warn'], { cwd: dir, stdio: 'inherit' })
    const server = await serveStatic(path.join(dir, 'dist'))
    const out = path.join(scratch, 'results', `${task.id}__${arm}`)
    fs.rmSync(out, { recursive: true, force: true })
    let acc
    try {
      acc = await runAcceptance(task.id, server.url, out)
    } finally {
      await server.close()
    }
    if (!acc || acc.error) {
      console.log(`${task.id} / ${arm}: SUITE ERROR ${acc?.error ?? 'no suite'}\n${acc?.log ?? ''}`)
      summary.push({ task: task.id, arm, error: acc?.error ?? 'no suite' })
      continue
    }
    const byStatus = {}
    for (const t of acc.tests) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
    const bugs = acc.tests.filter((t) => t.error && HARNESS_BUG.test(t.error))
    const untested = Object.entries(acc.items).filter(([, v]) => v.tests === 0).map(([k]) => k)
    console.log(`${task.id} / ${arm}: ${acc.testsTotal} tests ${JSON.stringify(byStatus)}, items passed ${acc.itemsPassed}/${acc.itemsTotal}${untested.length ? `, items without tests: ${untested.join(',')}` : ''}`)
    for (const b of bugs) console.log(`  possible test bug in "${b.title}": ${b.error.split('\n')[0]}`)
    summary.push({ task: task.id, arm, testsTotal: acc.testsTotal, byStatus, itemsPassed: acc.itemsPassed, itemsTotal: acc.itemsTotal, untested, possibleTestBugs: bugs.map((b) => ({ title: b.title, error: b.error.split('\n')[0] })) })
  }
}
writeJson(path.join(scratch, 'summary.json'), summary)
const clean = summary.every((s) => !s.error && s.possibleTestBugs.length === 0 && !s.untested.length && (s.byStatus.passed ?? 0) === 0 && !s.byStatus.interrupted)
console.log(clean ? '\nAll suites ran and failed cleanly against the untouched templates.' : '\nSome suites did not fail cleanly (see above).')
console.log(`Details: ${scratch}`)
process.exit(clean ? 0 : 1)
