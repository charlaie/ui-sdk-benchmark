// Codex CLI adapter: command line, JSONL event parsing and rollout-based cost accounting.
import fs from 'node:fs'
import path from 'node:path'
import { expandHome } from '../lib/isolation.mjs'
import { processMetrics } from '../lib/classify.mjs'

export const kind = 'codex'

export function command(cfg, config, paths) {
  const docker = config.isolation === 'docker'
  const release = expandHome(cfg.releaseDir)
  const args = ['exec', '--json', '-m', cfg.model, '-c', `model_reasoning_effort="${cfg.effort}"`]
  for (const f of cfg.disableFeatures ?? []) args.push('--disable', f)
  args.push('-C', paths.work, '--skip-git-repo-check', '--ignore-user-config')
  if (docker) {
    // The container is the sandbox; Codex's own sandbox would block network access.
    args.push('--dangerously-bypass-approvals-and-sandbox')
  } else {
    args.push('-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '-c', 'approval_policy="never"')
  }
  // Not --ephemeral: the rollout file in the isolated CODEX_HOME holds per-request token records,
  // which the runner uses for live budget enforcement and long-context pricing.
  args.push('-o', path.posix.join(paths.home, 'last-message.txt'), '-')
  return {
    bin: docker ? '/opt/codex/bin/codex' : path.join(release, 'bin/codex'),
    mounts: docker ? [{ host: release, container: '/opt/codex' }] : [],
    env: { CODEX_HOME: path.posix.join(paths.home, '.codex') },
    args,
  }
}

export function findRollout(home) {
  const dir = path.join(home, '.codex/sessions')
  if (!fs.existsSync(dir)) return null
  const found = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name))
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) found.push(path.join(d, e.name))
    }
  }
  walk(dir)
  return found.sort().at(-1) ?? null
}

/** Per-response usage records from a rollout file. */
export function rolloutUsage(file) {
  const records = []
  if (!file || !fs.existsSync(file)) return records
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('token_usage_record')) continue
    try {
      const e = JSON.parse(line)
      if (e.type === 'token_usage_record' && e.payload?.usage) records.push({ ...e.payload.usage, ts: e.timestamp, model: e.payload.model })
    } catch {}
  }
  return records
}

/** Cost of a list of per-response usage records. Returns null when no price is configured. */
export function priceOf(records, price) {
  if (!price || [price.input, price.cachedInput, price.output].some((v) => typeof v !== 'number')) return null
  let usd = 0
  for (const r of records) {
    const long = price.longContextThreshold && r.input_tokens > price.longContextThreshold
    const pin = long ? price.longInput ?? price.input : price.input
    const pc = long ? price.longCachedInput ?? price.cachedInput : price.cachedInput
    const pout = long ? price.longOutput ?? price.output : price.output
    const cached = r.cached_input_tokens ?? 0
    usd += ((r.input_tokens - cached) * pin + cached * pc + (r.output_tokens ?? 0) * pout) / 1e6
  }
  return usd
}

function kindOfItem(item) {
  switch (item.type) {
    case 'command_execution':
      return 'shell'
    case 'file_change':
      return 'edit'
    case 'web_search':
      return 'web'
    case 'mcp_tool_call':
      return 'mcp'
    case 'collab_tool_call':
    case 'collaboration':
      return 'subagent'
    default:
      return 'other'
  }
}

const NON_TOOL = new Set(['agent_message', 'reasoning', 'error', 'todo_list', 'user_message'])

export function parse(lines, ctx) {
  const events = []
  for (const { t, line } of lines) {
    try {
      events.push({ t, e: JSON.parse(line) })
    } catch {}
  }
  const items = new Map()
  let turnUsage = null
  let failed = null
  let agentMessages = 0
  const errors = []
  for (const { t, e } of events) {
    if (e.type === 'turn.completed') turnUsage = e.usage
    if (e.type === 'turn.failed') failed = e.error?.message ?? 'turn.failed'
    if (e.type === 'error') errors.push(e.message)
    if (!e.item) continue
    const it = e.item
    if (it.type === 'agent_message' && e.type === 'item.completed') agentMessages++
    if (it.type === 'error' && e.type === 'item.completed') errors.push(it.message)
    if (NON_TOOL.has(it.type)) continue
    const prev = items.get(it.id)
    if (!prev) items.set(it.id, { item: it, start: t, end: t })
    else Object.assign(prev, { item: it, end: t })
  }
  const calls = [...items.values()].map(({ item, start, end }) => {
    const k = kindOfItem(item)
    const firstPath = item.changes?.[0]?.path
    return {
      tool: item.type,
      kind: k,
      command: item.command,
      path: firstPath ?? (item.type === 'mcp_tool_call' ? `${item.server}/${item.tool}` : undefined),
      url: item.query,
      start,
      end,
      outputChars: (item.aggregated_output ?? '').length,
      isError: item.status === 'failed' || item.status === 'declined',
      exitCode: item.exit_code ?? null,
    }
  })
  const rolloutFile = findRollout(ctx.home)
  const records = rolloutUsage(rolloutFile)
  const sum = (k) => records.reduce((n, r) => n + (r[k] ?? 0), 0)
  const u = records.length
    ? { input_tokens: sum('input_tokens'), cached_input_tokens: sum('cached_input_tokens'), cache_write_input_tokens: sum('cache_write_input_tokens'), output_tokens: sum('output_tokens'), reasoning_output_tokens: sum('reasoning_output_tokens') }
    : turnUsage ?? {}
  const cached = u.cached_input_tokens ?? 0
  const tokens = {
    input: (u.input_tokens ?? 0) - cached - (u.cache_write_input_tokens ?? 0),
    cacheRead: cached,
    cacheWrite: u.cache_write_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    reasoning: u.reasoning_output_tokens ?? null,
  }
  tokens.total = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
  const usd = priceOf(records.length ? records : turnUsage ? [turnUsage] : [], ctx.price)
  const proc = processMetrics(calls)
  const wallMs = events.length ? events[events.length - 1].t : 0
  // Skills offered to the model are listed in a developer message in the rollout.
  let skillsAvailable = []
  let cliVersion = null
  let effortReported = null
  let modelReported = null
  if (rolloutFile) {
    for (const line of fs.readFileSync(rolloutFile, 'utf8').split('\n')) {
      if (line.includes('"session_meta"')) cliVersion = /"cli_version":"([^"]+)"/.exec(line)?.[1] ?? cliVersion
      if (line.includes('"turn_context"')) {
        modelReported = /"model":"([^"]+)"/.exec(line)?.[1] ?? modelReported
        effortReported = /"effort":"([^"]+)"/.exec(line)?.[1] ?? effortReported
      }
      if (line.includes('<skills_instructions>') && !skillsAvailable.length) {
        try {
          const text = JSON.parse(line).payload.content.map((c) => c.text).join('\n')
          skillsAvailable = [...new Set([...text.matchAll(/^- ([\w.-]+):/gm)].map((m) => m[1]))]
        } catch {}
      }
    }
  }
  let finalMessage = null
  try {
    finalMessage = fs.readFileSync(path.join(ctx.home, 'last-message.txt'), 'utf8')
  } catch {}
  const skillUsed = calls.some((c) => (c.command ?? '').includes(`skills/${ctx.benchmarkSkill}/SKILL.md`))
  return {
    cliVersion,
    modelReported,
    effortReported,
    endReason: failed ? 'turn.failed' : turnUsage ? 'completed' : 'no-turn-completed-event',
    errors,
    finalMessage,
    cost: { usd, source: usd === null ? 'missing (no price configured)' : 'computed from rollout token records and config pricing' },
    tokens,
    responses: records.length,
    time: {
      agentWallMs: wallMs,
      modelMs: Math.max(0, wallMs - proc.toolTimeMs),
      toolMs: proc.toolTimeMs,
      modelTimeSource: 'wall clock minus tool time (codex reports no API duration)',
    },
    process: {
      turns: records.length || null,
      assistantMessages: agentMessages,
      subagentsSpawned: calls.filter((c) => c.kind === 'subagent').length,
      ...proc,
    },
    isolation: {
      skillsAvailable,
      benchmarkSkillAvailable: skillsAvailable.includes(ctx.benchmarkSkill),
      benchmarkSkillUsed: skillUsed,
      rolloutFile: rolloutFile ? path.basename(rolloutFile) : null,
    },
  }
}
