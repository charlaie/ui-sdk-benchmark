#!/usr/bin/env node
// Copies templates/_shared into every arm template, regenerates AGENTS.md and CLAUDE.md from
// templates/_instructions, and checks that the arms differ only where they are allowed to.
// Usage: node scripts/sync-templates.mjs [--check]
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, ARMS, listFiles, sha } from '../runner/lib/util.mjs'

const check = process.argv.includes('--check')
const T = path.join(ROOT, 'templates')
const shared = listFiles(path.join(T, '_shared'))
const common = fs.readFileSync(path.join(T, '_instructions/common.md'), 'utf8')
let problems = 0

for (const arm of ARMS) {
  const dir = path.join(T, arm)
  for (const rel of shared) {
    const src = path.join(T, '_shared', rel)
    const dst = path.join(dir, rel)
    if (check) {
      if (!fs.existsSync(dst) || sha(fs.readFileSync(src)) !== sha(fs.readFileSync(dst))) {
        console.error(`[${arm}] shared file differs: ${rel}`)
        problems++
      }
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(src, dst)
    }
  }
  const instructions = `${common}\n${fs.readFileSync(path.join(T, '_instructions', `${arm}.md`), 'utf8')}`
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const dst = path.join(dir, name)
    if (check) {
      if (!fs.existsSync(dst) || fs.readFileSync(dst, 'utf8') !== instructions) {
        console.error(`[${arm}] ${name} is out of date`)
        problems++
      }
    } else fs.writeFileSync(dst, instructions)
  }
}

// package.json: scripts and the shared base dependencies must match exactly across arms.
const pkgs = Object.fromEntries(ARMS.map((a) => [a, JSON.parse(fs.readFileSync(path.join(T, a, 'package.json'), 'utf8'))]))
const [a0, ...rest] = ARMS
for (const a of rest) {
  if (JSON.stringify(pkgs[a].scripts) !== JSON.stringify(pkgs[a0].scripts)) {
    console.error(`package.json scripts differ between ${a0} and ${a}`)
    problems++
  }
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [dep, v] of Object.entries(pkgs[a0][field] ?? {})) {
      const other = pkgs[a][field]?.[dep]
      if (other !== undefined && other !== v) {
        console.error(`${dep}: ${a0}=${v} ${a}=${other}`)
        problems++
      }
    }
  }
}
if (check) {
  for (const a of ARMS) {
    const own = Object.keys({ ...pkgs[a].dependencies, ...pkgs[a].devDependencies }).filter(
      (d) => !ARMS.filter((b) => b !== a).every((b) => d in { ...pkgs[b].dependencies, ...pkgs[b].devDependencies }),
    )
    console.log(`[${a}] arm-only dependencies: ${own.join(', ') || '(none)'}`)
  }
}
if (problems) {
  console.error(`${problems} problem(s)`)
  process.exit(1)
}
console.log(check ? 'templates are in sync' : 'templates synced')
