// Classifies normalized tool calls into process metrics. A normalized call looks like
// { tool, kind, command?, path?, url?, outputChars, isError, exitCode, start, end } with start/end
// in ms since the agent process started (receive time).

const DOC_PATH = /(node_modules\/@ui-sdk\/[^/\s]+\/(docs|skills)\/|\.agents\/skills\/|\.claude\/skills\/|llms\.txt|SKILL\.md|node_modules\/shadcn\/(dist\/)?(registry|docs))/
const DOC_CMD = /\bshadcn(@[\w.-]+)?\s+(docs|view|search|info|list)\b|ui\.shadcn\.com|ui-sdk\.dev|base-ui\.com|registry\.npmjs\.org/
const READ_CMD = /(^|[\s;&|('"])(cat|sed|head|tail|less|more|rg|grep|ls|find|awk|nl|wc|bat|tree|jq)\s/
const LIB_SOURCE = /node_modules\/(@ui-sdk\/[^/\s]+\/dist|@base-ui\/react|@base-ui-components)/
const BUILD = /\b(tsc\b|vite build|npm run (build|typecheck|lint)|npx (tsc|vite build)|oxlint|eslint)/
const INSTALL = /\b(npm (i|install|add)\b|pnpm (add|install)\b|yarn add\b|npx( -y)? shadcn(@\S+)? add\b|npx( -y)? skills\b)/
const TEST = /\b(vitest|playwright|jest|npm (run )?test)\b/

export function isDocsCall(c) {
  if (c.kind === 'web' || c.kind === 'skill') return true
  if (c.kind === 'read' || c.kind === 'search') return DOC_PATH.test(c.path ?? '')
  if (c.kind === 'shell') return (DOC_PATH.test(c.command) && READ_CMD.test(` ${c.command}`)) || DOC_CMD.test(c.command)
  return false
}

export function isLibrarySourceCall(c) {
  const target = c.kind === 'shell' ? c.command : c.path ?? ''
  return (c.kind === 'shell' || c.kind === 'read' || c.kind === 'search') && LIB_SOURCE.test(target)
}

export function unionMs(intervals) {
  const xs = intervals.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0])
  let total = 0
  let cur = null
  for (const [a, b] of xs) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0]
      cur = [a, b]
    } else cur[1] = Math.max(cur[1], b)
  }
  if (cur) total += cur[1] - cur[0]
  return total
}

export function processMetrics(calls) {
  const byKind = {}
  for (const c of calls) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1
  const shell = calls.filter((c) => c.kind === 'shell')
  const docs = calls.filter(isDocsCall)
  const lib = calls.filter(isLibrarySourceCall)
  const builds = shell.filter((c) => BUILD.test(c.command))
  const failed = (c) => c.isError || (c.exitCode !== null && c.exitCode !== undefined && c.exitCode !== 0)
  return {
    toolCalls: calls.length,
    toolCallsByKind: byKind,
    docs: {
      calls: docs.length,
      outputChars: docs.reduce((n, c) => n + (c.outputChars ?? 0), 0),
      timeMs: unionMs(docs.map((c) => [c.start, c.end])),
      librarySourceCalls: lib.length,
    },
    builds: { runs: builds.length, failures: builds.filter(failed).length },
    installs: shell.filter((c) => INSTALL.test(c.command)).length,
    testRuns: shell.filter((c) => TEST.test(c.command)).length,
    failedToolCalls: calls.filter(failed).length,
    toolTimeMs: unionMs(calls.map((c) => [c.start, c.end])),
  }
}
