#!/usr/bin/env node
// Aggregates per-run metrics by task, arm and agent, reporting the two task categories
// (composition, new-behavior) separately. Writes summary.json and summary.md into the runs dir.
//
//   node scripts/summary.mjs [--config <file>] [--runs <dir>] [--include-smoke]
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, loadConfig, readJson, writeJson } from '../runner/lib/util.mjs'

const argv = process.argv.slice(2)
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined)
const config = loadConfig(opt('--config') ? path.resolve(opt('--config')) : undefined)
const runsDir = path.resolve(ROOT, opt('--runs') ?? config.runsDir ?? 'runs')
const includeSmoke = argv.includes('--include-smoke')

export function loadRuns(dir, { smoke = false } = {}) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .map((d) => readJson(path.join(dir, d, 'metrics.json'), null))
    .filter((m) => m && (smoke || m.category !== 'smoke'))
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const vals = (runs, f) => runs.map(f).map(num).filter((v) => v !== null)
const rate = (runs, f, has = () => true) => {
  const xs = runs.filter(has)
  return xs.length ? xs.filter(f).length / xs.length : null
}

export function aggregate(runs) {
  return {
    n: runs.length,
    completed: runs.filter((r) => r.status === 'completed').length,
    stopped: { budget: runs.filter((r) => r.status === 'budget').length, timeout: runs.filter((r) => r.status === 'timeout').length, error: runs.filter((r) => r.status === 'agent-error').length },
    costUsd: { mean: mean(vals(runs, (r) => r.cost?.usd)), median: median(vals(runs, (r) => r.cost?.usd)), missing: runs.filter((r) => num(r.cost?.usd) === null).length },
    wallMin: { mean: mean(vals(runs, (r) => r.time?.wallMs / 60000)), median: median(vals(runs, (r) => r.time?.wallMs / 60000)) },
    modelShare: mean(vals(runs, (r) => (r.time?.modelMs ?? NaN) / (r.time?.agentWallMs || NaN))),
    tokens: { totalMean: mean(vals(runs, (r) => r.tokens?.total)), outputMean: mean(vals(runs, (r) => r.tokens?.output)), cacheReadMean: mean(vals(runs, (r) => r.tokens?.cacheRead)) },
    process: {
      turnsMean: mean(vals(runs, (r) => r.process?.turns)),
      toolCallsMean: mean(vals(runs, (r) => r.process?.toolCalls)),
      docsCallsMean: mean(vals(runs, (r) => r.process?.docs?.calls)),
      docsCharsMean: mean(vals(runs, (r) => r.process?.docs?.outputChars)),
      librarySourceCallsMean: mean(vals(runs, (r) => r.process?.docs?.librarySourceCalls)),
      buildRunsMean: mean(vals(runs, (r) => r.process?.builds?.runs)),
      buildFailuresMean: mean(vals(runs, (r) => r.process?.builds?.failures)),
      skillUsedRate: rate(runs, (r) => r.skills?.benchmarkSkillUsed, (r) => !!r.skills),
    },
    outcome: {
      buildOkRate: rate(runs, (r) => r.outcome?.build?.ok),
      typecheckOkRate: rate(runs, (r) => r.outcome?.typecheck?.ok),
      consoleErrorsMean: mean(vals(runs, (r) => (r.outcome?.load ? r.outcome.load.consoleErrors + r.outcome.load.pageErrors : null))),
      codeLinesAddedMean: mean(vals(runs, (r) => r.outcome?.diff?.codeLinesAdded)),
      depsAddedMean: mean(vals(runs, (r) => r.outcome?.dependencies?.added?.length)),
      bannedDependencyRuns: runs.filter((r) => r.outcome?.dependencies?.banned?.length).length,
      bundleGzipKbMean: mean(vals(runs, (r) => (r.outcome?.bundle ? r.outcome.bundle.gzipBytes / 1024 : null))),
    },
    quality: {
      acceptanceMean: mean(vals(runs, (r) => (r.quality?.acceptance?.itemsTotal ? r.quality.acceptance.itemsPassed / r.quality.acceptance.itemsTotal : null))),
      acceptanceMedian: median(vals(runs, (r) => (r.quality?.acceptance?.itemsTotal ? r.quality.acceptance.itemsPassed / r.quality.acceptance.itemsTotal : null))),
      axeViolationsMean: mean(vals(runs, (r) => r.quality?.axe?.violations)),
      keyboardOkRate: rate(runs, (r) => r.quality?.keyboard?.ok, (r) => !!r.quality?.keyboard),
    },
  }
}

function groupBy(runs, keyFn) {
  const m = new Map()
  for (const r of runs) {
    const k = keyFn(r)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(r)
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
}

const f = (v, d = 2) => (v === null || v === undefined ? '–' : v.toFixed(d))
const pct = (v) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`)

function table(rows) {
  const head = ['group', 'n', 'done', 'cost $ (median)', 'wall min (median)', 'acceptance (mean)', 'build ok', 'axe viol.', 'kbd ok', 'out tokens', 'tool calls', 'docs calls', 'build fails', 'code lines', 'gzip KB']
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`]
  for (const [k, a] of rows) {
    lines.push(
      `| ${k} | ${a.n} | ${a.completed} | ${f(a.costUsd.median)} | ${f(a.wallMin.median, 1)} | ${pct(a.quality.acceptanceMean)} | ${pct(a.outcome.buildOkRate)} | ${f(a.quality.axeViolationsMean, 1)} | ${pct(a.quality.keyboardOkRate)} | ${f(a.tokens.outputMean, 0)} | ${f(a.process.toolCallsMean, 0)} | ${f(a.process.docsCallsMean, 1)} | ${f(a.process.buildFailuresMean, 1)} | ${f(a.outcome.codeLinesAddedMean, 0)} | ${f(a.outcome.bundleGzipKbMean, 0)} |`,
    )
  }
  return lines.join('\n')
}

function main() {
  const runs = loadRuns(runsDir, { smoke: includeSmoke })
  if (!runs.length) {
    console.log(`No evaluated runs in ${runsDir}`)
    return
  }
  const categories = [...new Set(runs.map((r) => r.category))].sort()
  const out = { generatedAt: new Date().toISOString(), runsDir, runCount: runs.length, byCategory: {} }
  const md = [`# Benchmark summary`, '', `${runs.length} runs from \`${path.relative(ROOT, runsDir)}\`, generated ${out.generatedAt}.`, '']
  for (const cat of categories) {
    const inCat = runs.filter((r) => r.category === cat)
    const byArmAgent = groupBy(inCat, (r) => `${r.arm} / ${r.agent}`).map(([k, rs]) => [k, aggregate(rs)])
    const byTask = groupBy(inCat, (r) => `${r.task} / ${r.arm} / ${r.agent}`).map(([k, rs]) => [k, aggregate(rs)])
    const byArm = groupBy(inCat, (r) => r.arm).map(([k, rs]) => [k, aggregate(rs)])
    out.byCategory[cat] = { byArm: Object.fromEntries(byArm), byArmAgent: Object.fromEntries(byArmAgent), byTaskArmAgent: Object.fromEntries(byTask) }
    md.push(`## ${cat}`, '', '### By arm', '', table(byArm), '', '### By arm and agent', '', table(byArmAgent), '', '### By task, arm and agent', '', table(byTask), '')
  }
  writeJson(path.join(runsDir, 'summary.json'), out)
  fs.writeFileSync(path.join(runsDir, 'summary.md'), md.join('\n') + '\n')
  console.log(md.join('\n'))
  console.log(`\nWrote ${path.relative(ROOT, path.join(runsDir, 'summary.md'))} and summary.json`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
