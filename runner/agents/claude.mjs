// Claude Code adapter: command line and stream-json parsing.
import path from 'node:path'
import { expandHome } from '../lib/isolation.mjs'
import { processMetrics } from '../lib/classify.mjs'

export const kind = 'claude-code'

export function command(cfg, config, paths, { budgetUsd }) {
  const docker = config.isolation === 'docker'
  const hostBin = expandHome(cfg.binary)
  return {
    bin: docker ? '/opt/agent-cli/claude' : hostBin,
    mounts: docker ? [{ host: hostBin, container: '/opt/agent-cli/claude' }] : [],
    env: {
      CLAUDE_CONFIG_DIR: path.posix.join(paths.home, '.claude'),
      ...(docker ? {} : { IS_SANDBOX: '1' }),
      DISABLE_AUTOUPDATER: '1',
      DISABLE_ERROR_REPORTING: '1',
    },
    args: [
      '-p',
      '--model', cfg.model,
      '--effort', cfg.effort,
      '--output-format', 'stream-json',
      '--verbose',
      // Only project settings: picks up the workspace's CLAUDE.md and .claude/skills, nothing user-level.
      '--setting-sources', 'project',
      // No MCP servers at all (also keeps account-level claude.ai connectors out).
      '--strict-mcp-config',
      ...(budgetUsd ? ['--max-budget-usd', String(budgetUsd)] : []),
      '--dangerously-skip-permissions',
      '--no-session-persistence',
    ],
  }
}

const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).join('\n') : ''

function kindOf(name) {
  if (name === 'Bash') return 'shell'
  if (name === 'Read' || name === 'NotebookRead') return 'read'
  if (name === 'Write') return 'write'
  if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return 'edit'
  if (name === 'Glob' || name === 'Grep') return 'search'
  if (name === 'WebFetch' || name === 'WebSearch') return 'web'
  if (name === 'Skill') return 'skill'
  if (name === 'Task' || name === 'Agent') return 'subagent'
  return 'other'
}

/**
 * @param lines array of { t, line } (t = ms since the process started, as received by the runner)
 * @param ctx { benchmarkSkill } name of the arm's vendor skill
 */
export function parse(lines, ctx) {
  const events = []
  for (const { t, line } of lines) {
    try {
      events.push({ t, e: JSON.parse(line) })
    } catch {}
  }
  const init = events.find((x) => x.e.type === 'system' && x.e.subtype === 'init')?.e
  const result = [...events].reverse().find((x) => x.e.type === 'result')?.e
  const calls = new Map()
  const messages = new Map()
  let subagentMessages = 0
  for (const { t, e } of events) {
    if (e.type === 'assistant' && e.message) {
      const id = e.message.id
      if (!messages.has(id)) {
        messages.set(id, { usage: e.message.usage, sub: !!e.parent_tool_use_id })
        if (e.parent_tool_use_id) subagentMessages++
      } else messages.get(id).usage = e.message.usage
      for (const b of e.message.content ?? []) {
        if (b.type !== 'tool_use') continue
        const input = b.input ?? {}
        calls.set(b.id, {
          tool: b.name,
          kind: kindOf(b.name),
          command: input.command,
          path: input.file_path ?? input.path ?? input.notebook_path ?? (b.name === 'Skill' ? input.skill ?? input.command : undefined),
          url: input.url ?? input.query,
          skill: b.name === 'Skill' ? input.skill ?? input.command ?? input.name : undefined,
          start: t,
          end: t,
          outputChars: 0,
          isError: false,
          exitCode: null,
          subagent: !!e.parent_tool_use_id,
        })
      }
    }
    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b.type !== 'tool_result' || !calls.has(b.tool_use_id)) continue
        const c = calls.get(b.tool_use_id)
        const text = textOf(b.content)
        c.end = t
        c.outputChars = text.length
        c.isError = !!b.is_error
        const m = /^Exit code (\d+)/m.exec(text)
        if (c.kind === 'shell') c.exitCode = m ? Number(m[1]) : b.is_error ? 1 : 0
      }
    }
  }
  const callList = [...calls.values()]
  // Token totals: prefer the CLI's result event; fall back to summing per-message usage.
  let usage = result?.usage
  if (!usage) {
    usage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }
    for (const m of messages.values()) for (const k of Object.keys(usage)) usage[k] += m.usage?.[k] ?? 0
  }
  const tokens = {
    input: usage.input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    reasoning: usage.output_tokens_details?.thinking_tokens ?? null,
  }
  tokens.total = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
  const proc = processMetrics(callList)
  const skills = init?.skills ?? []
  const skillCalls = callList.filter((c) => c.kind === 'skill').map((c) => c.skill)
  const skillRead = callList.some((c) => (c.path ?? c.command ?? '').includes(`skills/${ctx.benchmarkSkill}/SKILL.md`))
  const wallMs = result?.duration_ms ?? (events.length ? events[events.length - 1].t : 0)
  return {
    cliVersion: init?.claude_code_version ?? null,
    modelReported: init?.model ?? null,
    endReason: result ? (result.is_error ? result.subtype : 'completed') : 'no-result-event',
    terminalReason: result?.terminal_reason ?? null,
    finalMessage: result?.result ?? null,
    cost: result ? { usd: result.total_cost_usd ?? null, source: 'claude-code total_cost_usd' } : { usd: null, source: 'missing (no result event)' },
    tokens,
    time: {
      agentWallMs: wallMs,
      modelMs: result?.duration_api_ms ?? null,
      toolMs: proc.toolTimeMs,
      modelTimeSource: 'claude-code duration_api_ms',
    },
    process: {
      turns: result?.num_turns ?? null,
      assistantMessages: [...messages.values()].filter((m) => !m.sub).length,
      subagentMessages,
      subagentsSpawned: result?.subagent_stats?.spawned ?? callList.filter((c) => c.kind === 'subagent').length,
      ...proc,
    },
    isolation: {
      skillsAvailable: skills,
      // init.skills omits skills marked user-invocable: false (the shadcn skill is), although the
      // model is still offered them, so absence here means "unknown", not "unavailable".
      benchmarkSkillAvailable: skills.includes(ctx.benchmarkSkill) ? true : null,
      benchmarkSkillListedInInit: skills.includes(ctx.benchmarkSkill),
      benchmarkSkillUsed: skillCalls.includes(ctx.benchmarkSkill) || skillRead,
      mcpServers: init?.mcp_servers ?? null,
      plugins: (init?.plugins ?? []).map((p) => p.source ?? p.name),
      permissionMode: init?.permissionMode ?? null,
    },
  }
}
