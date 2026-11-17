#!/usr/bin/env node
// Benchmark runner: expands the matrix (tasks x arms x agents x repetitions), runs each cell's agent
// headless and single-shot in an isolated environment, then evaluates the output.
//
//   node runner/run.mjs --task 01-booking --arm ui-sdk --agent claude --rep 1   # one cell
//   node runner/run.mjs --task 01-booking,02-inbox --agent codex                 # a subset
//   node runner/run.mjs --all                                                    # whole matrix
//
// Options: --config <file>, --reps <n>, --order interleave|sequential, --force (redo finished runs),
// --no-eval, --dry-run (print the plan and the prompt sizes, run nothing), --yes (skip confirmation).
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import * as claude from './agents/claude.mjs'
import * as codex from './agents/codex.mjs'
import { evaluateRun } from './evaluate.mjs'
import { agentPaths, expandHome, prepareAgentHome, spawnIsolated, syncBackCredentials } from './lib/isolation.mjs'
import { buildPrompt } from './lib/prompt.mjs'
import { ARMS, ROOT, loadConfig, loadTasks, readJson, runIdOf, writeJson } from './lib/util.mjs'
import { prepareWorkspace, workRootOf } from './lib/workspace.mjs'

// Library packages whose installed versions are recorded with every run, so results from different
// releases are never mixed up silently.
const LIBRARY_PACKAGES = {
  shadcn: ['shadcn', '@base-ui/react', 'lucide-react'],
  'ui-sdk': ['@ui-sdk/core', '@ui-sdk/react'],
}
function installedVersions(workspace, names) {
  return Object.fromEntries(names.map((n) => [n, readJson(path.join(workspace, 'node_modules', n, 'package.json'), {}).version ?? null]))
}

const ADAPTERS = { 'claude-code': claude, codex }
const BENCHMARK_SKILL = { shadcn: 'shadcn', 'ui-sdk': 'ui-sdk' }

function parseArgs(argv) {
  const out = { flags: new Set() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      i++
    } else out.flags.add(key)
  }
  return out
}

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : null)

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * interleave: repetition-major, and within each repetition a seeded shuffle that is then reordered so
 * consecutive runs alternate arms and agents. This spreads time-of-day and rate-limit effects evenly.
 */
export function planCells({ tasks, arms, agents, reps, order, seed }) {
  const cells = []
  for (let rep = 1; rep <= reps; rep++) {
    const round = []
    for (const task of tasks) for (const arm of arms) for (const agent of agents) round.push({ task, arm, agent, rep })
    if (order === 'interleave') {
      const r = rng(seed + rep)
      for (let i = round.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1))
        ;[round[i], round[j]] = [round[j], round[i]]
      }
      const out = []
      while (round.length) {
        const last = out.at(-1)
        let idx = round.findIndex((c) => !last || (c.arm !== last.arm && c.agent !== last.agent))
        if (idx < 0) idx = round.findIndex((c) => c.arm !== last.arm)
        if (idx < 0) idx = 0
        out.push(...round.splice(idx, 1))
      }
      cells.push(...out)
    } else cells.push(...round)
  }
  return cells
}

function validateConfig(config, agents) {
  const missing = []
  for (const name of agents) {
    const a = config.agents[name]
    if (!a) missing.push(`agents.${name} (unknown agent)`)
    else {
      if (!a.model) missing.push(`agents.${name}.model`)
      if (!a.effort) missing.push(`agents.${name}.effort`)
    }
  }
  // budgetUsd null means no cap (subscription auth: cost is still computed and recorded).
  const budget = config.limits?.budgetUsd
  if (budget !== null && budget !== undefined && !(budget > 0)) missing.push('limits.budgetUsd (a positive number, or null for no cap)')
  if (!(config.limits?.timeoutMinutes > 0)) missing.push('limits.timeoutMinutes')
  if (missing.length) throw new Error(`Config values must be set explicitly before running:\n  - ${missing.join('\n  - ')}`)
}

/**
 * Did the agent stop because of an account usage or rate limit (subscription caps, HTTP 429)? Only error
 * signals are checked, never the agent's own output, since task apps may mention rate limits in UI text.
 */
export function usageLimitHit(runDir, agentMetrics) {
  if (agentMetrics.status === 'completed') return false
  const texts = [...(agentMetrics.errors ?? [])]
  const lines = (fs.existsSync(path.join(runDir, 'events.jsonl')) ? fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8') : '').trim().split('\n').slice(-30)
  for (const line of lines) {
    try {
      const e = JSON.parse(line)
      if ((e.type === 'result' && e.is_error) || e.type === 'turn.failed' || e.type === 'error') texts.push(JSON.stringify(e))
    } catch {}
  }
  const stderr = path.join(runDir, 'stderr.log')
  if (fs.existsSync(stderr)) texts.push(fs.readFileSync(stderr, 'utf8').slice(-4000))
  // Claude Code subscription caps read e.g. "You've hit your limit · resets 7pm" or "5-hour limit reached".
  return /usage limit|hit your limit|limit reached|rate[ _-]?limit|\b429\b|quota|too many requests/i.test(texts.join('\n'))
}

function runDirOf(config, id) {
  return path.resolve(ROOT, config.runsDir ?? 'runs', id)
}

function statusOf(runDir) {
  return readJson(path.join(runDir, 'status.json'), null)
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((r) => rl.question(question, r))
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

/** Run one cell's agent. Writes everything into runDir. */
export async function runAgent({ config, cell, task, runDir }) {
  const agentCfg = config.agents[cell.agent]
  const adapter = ADAPTERS[agentCfg.kind]
  if (!adapter) throw new Error(`Unknown agent kind ${agentCfg.kind}`)
  const id = runIdOf(cell)
  const workRoot = workRootOf(config)
  const workspace = path.join(workRoot, id, 'workspace')
  const home = path.join(workRoot, id, 'home')
  fs.rmSync(runDir, { recursive: true, force: true })
  fs.mkdirSync(runDir, { recursive: true })
  writeJson(path.join(runDir, 'status.json'), { state: 'running', startedAt: new Date().toISOString() })

  prepareWorkspace({ task, arm: cell.arm, dest: workspace })
  const libraryVersions = installedVersions(workspace, LIBRARY_PACKAGES[cell.arm] ?? [])
  const credState = prepareAgentHome(agentCfg.kind, home, config)
  const prompt = buildPrompt(task, cell.arm)
  fs.writeFileSync(path.join(runDir, 'prompt.md'), prompt)

  const paths = agentPaths(config, { workspace, home })
  const budgetUsd = config.limits.budgetUsd
  const cmd = adapter.command(agentCfg, config, paths, { budgetUsd })
  const containerName = `uisdk-bench-${id.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${Date.now()}`
  const meta = {
    runId: id,
    ...cell,
    category: task.category,
    agentKind: agentCfg.kind,
    model: agentCfg.model,
    effort: agentCfg.effort,
    isolation: config.isolation,
    budgetUsd,
    timeoutMinutes: config.limits.timeoutMinutes,
    libraryVersions,
    workspace,
    startedAt: new Date().toISOString(),
  }
  const { child, kill, command } = spawnIsolated(config, { workspace, home, bin: cmd.bin, args: cmd.args, mounts: cmd.mounts, env: cmd.env, containerName })
  meta.command = command.map((a) => (a.length > 200 ? `${a.slice(0, 200)}…` : a))
  writeJson(path.join(runDir, 'meta.json'), meta)

  const t0 = Date.now()
  const eventsOut = fs.createWriteStream(path.join(runDir, 'events.jsonl'))
  const timesOut = fs.createWriteStream(path.join(runDir, 'event-times.jsonl'))
  const stderrOut = fs.createWriteStream(path.join(runDir, 'stderr.log'))
  const lines = []
  let buf = ''
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      const t = Date.now() - t0
      lines.push({ t, line })
      eventsOut.write(line + '\n')
      timesOut.write(`${t}\n`)
    }
  })
  child.stderr.pipe(stderrOut)
  child.stdin.end(prompt)

  let stopReason = null
  const timeoutMs = config.limits.timeoutMinutes * 60_000
  const timer = setTimeout(() => {
    stopReason = 'timeout'
    kill()
  }, timeoutMs)
  // Codex has no budget flag: watch the per-request token records in its rollout file.
  let budgetTimer = null
  if (agentCfg.kind === 'codex' && budgetUsd) {
    budgetTimer = setInterval(() => {
      const usd = codex.priceOf(codex.rolloutUsage(codex.findRollout(home)), config.pricing?.[agentCfg.model])
      if (usd !== null && usd > budgetUsd && !stopReason) {
        stopReason = 'budget'
        kill()
      }
    }, 5000)
  }
  const exitCode = await new Promise((resolve) => child.on('close', (code) => resolve(code)))
  clearTimeout(timer)
  if (budgetTimer) clearInterval(budgetTimer)
  if (buf.trim()) {
    lines.push({ t: Date.now() - t0, line: buf })
    eventsOut.write(buf + '\n')
  }
  await Promise.all([eventsOut, timesOut, stderrOut].map((s) => new Promise((r) => s.end(r))))
  const wallMs = Date.now() - t0

  const credNotes = syncBackCredentials(credState)
  const parsed = adapter.parse(lines, { benchmarkSkill: BENCHMARK_SKILL[cell.arm], home, price: config.pricing?.[agentCfg.model] })
  // Keep Codex's rollout (raw per-request log) next to the event log. It contains account ids, so
  // the gallery never publishes it.
  if (agentCfg.kind === 'codex') {
    const rollout = codex.findRollout(home)
    if (rollout) fs.copyFileSync(rollout, path.join(runDir, 'codex-rollout.jsonl'))
  }
  let status = 'completed'
  if (stopReason) status = stopReason
  else if (agentCfg.kind === 'claude-code' && parsed.endReason === 'error_max_budget_usd') status = 'budget'
  else if (exitCode !== 0 || parsed.endReason !== 'completed') status = 'agent-error'
  const agentMetrics = { ...meta, finishedAt: new Date().toISOString(), exitCode, status, wallMs, credentialNotes: credNotes, ...parsed }
  writeJson(path.join(runDir, 'agent-metrics.json'), agentMetrics)
  return { workspace, agentMetrics }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const config = loadConfig(args.config ? path.resolve(args.config) : undefined)
  const allTasks = loadTasks()
  const tasks = list(args.task) ?? config.tasks
  const arms = list(args.arm) ?? config.arms ?? ARMS
  const agents = list(args.agent) ?? Object.keys(config.agents)
  const reps = args.rep ? null : Number(args.reps ?? config.repetitions ?? 3)
  if (!args.flags.has('all') && !args.task && !args.arm && !args.agent && !args.rep) {
    console.error('Choose cells with --task/--arm/--agent/--rep, or pass --all for the whole matrix.')
    process.exit(2)
  }
  for (const t of tasks) if (!allTasks.find((x) => x.id === t)) throw new Error(`Unknown task ${t}`)
  for (const a of arms) if (!ARMS.includes(a)) throw new Error(`Unknown arm ${a}`)
  let cells = planCells({ tasks, arms, agents, reps: reps ?? Math.max(...list(args.rep).map(Number)), order: args.order ?? 'interleave', seed: config.seed ?? 1 })
  if (args.rep) {
    const wanted = new Set(list(args.rep).map(Number))
    cells = cells.filter((c) => wanted.has(c.rep))
  }
  const force = args.flags.has('force')
  const todo = cells.filter((c) => force || statusOf(runDirOf(config, runIdOf(c)))?.state !== 'done')
  console.log(`${cells.length} cell(s) selected, ${cells.length - todo.length} already done, ${todo.length} to run.`)
  for (const c of todo) console.log(`  ${runIdOf(c)}`)
  if (args.flags.has('dry-run')) {
    for (const t of tasks) for (const a of arms) console.log(`prompt ${t}/${a}: ${buildPrompt(allTasks.find((x) => x.id === t), a).length} chars`)
    return
  }
  if (!todo.length) return
  validateConfig(config, [...new Set(todo.map((c) => c.agent))])
  if (config.isolation === 'docker') {
    const { execFileSync } = await import('node:child_process')
    try {
      execFileSync('docker', ['image', 'inspect', config.docker?.image ?? 'ui-sdk-bench-agent:local'], { stdio: 'ignore' })
    } catch {
      throw new Error(`Docker image missing. Build it: docker build -t ${config.docker?.image ?? 'ui-sdk-bench-agent:local'} docker`)
    }
  }
  for (const name of new Set(todo.map((c) => c.agent))) {
    const a = config.agents[name]
    const p = expandHome(a.kind === 'codex' ? path.join(a.releaseDir, 'bin/codex') : a.binary)
    if (!fs.existsSync(p)) throw new Error(`Agent ${name}: CLI not found at ${p}`)
  }
  const cap = config.limits.budgetUsd
  const spendNote = cap ? `up to $${(todo.length * cap).toFixed(2)} at the per-run cap` : 'with no budget cap'
  if (!args.flags.has('yes') && !(await confirm(`This starts ${todo.length} real agent run(s), ${spendNote}. Continue? [y/N] `))) {
    console.log('Aborted.')
    return
  }

  let stopping = false
  process.on('SIGINT', () => {
    if (stopping) process.exit(130)
    stopping = true
    console.log('\nStopping after the current run (Ctrl+C again to abort now; the interrupted run will be redone next time).')
  })

  for (const [i, cell] of todo.entries()) {
    if (stopping) break
    const id = runIdOf(cell)
    const task = allTasks.find((t) => t.id === cell.task)
    const runDir = runDirOf(config, id)
    console.log(`\n[${i + 1}/${todo.length}] ${id}`)
    try {
      const { workspace, agentMetrics } = await runAgent({ config, cell, task, runDir })
      console.log(`  agent: ${agentMetrics.status}, ${(agentMetrics.wallMs / 1000).toFixed(0)}s, $${agentMetrics.cost.usd?.toFixed(3) ?? '?'}`)
      if (usageLimitHit(runDir, agentMetrics)) {
        // Not a result: leave it unfinished so the next invocation redoes it, and stop, since every
        // following run would hit the same limit.
        writeJson(path.join(runDir, 'status.json'), { state: 'failed', reason: 'usage-limit', at: new Date().toISOString() })
        console.log('  usage limit reached: run marked failed and the batch stopped. Re-run the same command once the limit resets to resume.')
        break
      }
      if (!args.flags.has('no-eval')) {
        const ev = await evaluateRun({ config, runDir, workspace, task, arm: cell.arm })
        console.log(`  eval: build ${ev.outcome.build.ok ? 'ok' : 'FAILED'}, acceptance ${ev.quality.acceptance.itemsPassed}/${ev.quality.acceptance.itemsTotal}`)
      }
      writeJson(path.join(runDir, 'status.json'), { state: 'done', finishedAt: new Date().toISOString(), evaluated: !args.flags.has('no-eval') })
      if (!args.flags.has('keep-workspace')) fs.rmSync(path.join(workRootOf(config), id), { recursive: true, force: true })
    } catch (e) {
      console.error(`  run failed: ${e.stack ?? e}`)
      writeJson(path.join(runDir, 'status.json'), { state: 'failed', error: String(e.stack ?? e), at: new Date().toISOString() })
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message ?? e)
    process.exit(1)
  })
}
