import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './util.mjs'

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').trim()

/** The full agent-facing prompt. Only the "Stack" section differs between arms. */
export function buildPrompt(task, arm) {
  return [read('prompts/header.md'), read('prompts', `stack-${arm}.md`), read('prompts/rules.md'), read('tasks', task.id, 'spec.md')].join('\n\n') + '\n'
}
