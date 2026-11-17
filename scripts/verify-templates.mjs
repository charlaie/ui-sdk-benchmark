#!/usr/bin/env node
// Typechecks and builds each starter template, alone and with every task's mock API copied in,
// exactly as a run workspace is prepared (node_modules symlinked to save time).
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { ARMS, loadTasks } from '../runner/lib/util.mjs'
import { prepareWorkspace } from '../runner/lib/workspace.mjs'

const scratch = path.join(os.tmpdir(), 'ui-sdk-bench-verify')
let failed = 0
for (const arm of ARMS) {
  for (const task of loadTasks()) {
    const dir = path.join(scratch, `${task.id}__${arm}`)
    prepareWorkspace({ task, arm, dest: dir, nodeModules: 'symlink' })
    for (const [label, args] of [['typecheck', ['tsc', '-b']], ['build', ['vite', 'build', '--logLevel', 'error']]]) {
      try {
        execFileSync('npx', args, { cwd: dir, stdio: 'pipe' })
        console.log(`ok    ${arm} + ${task.id}: ${label}`)
      } catch (e) {
        failed++
        console.log(`FAIL  ${arm} + ${task.id}: ${label}\n${e.stdout}${e.stderr}`)
      }
    }
  }
}
process.exit(failed ? 1 : 0)
