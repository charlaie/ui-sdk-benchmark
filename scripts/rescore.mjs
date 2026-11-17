#!/usr/bin/env node
// Re-runs the hidden acceptance suite against each finished run's saved build (runs/<id>/dist), for
// when the acceptance tests change after runs were evaluated. Only the acceptance, axe and keyboard
// results are replaced; typecheck, build, bundle, diff and screenshots are kept from the original
// evaluation (the agent's workspace is gone, and rebuilding would need a fresh npm install). The
// previous acceptance summary is kept in eval.json under `rescores` so the change is traceable.
//
//   node scripts/rescore.mjs [--runs <dir>] [run-id ...]     (default: every run with a dist/)
import fs from 'node:fs'
import path from 'node:path'
import { acceptanceItemCount, buildMetricsRecord, runAcceptance } from '../runner/evaluate.mjs'
import { serveStatic } from '../runner/lib/static-server.mjs'
import { ROOT, parseRunId, readJson, writeJson } from '../runner/lib/util.mjs'

const argv = process.argv.slice(2)
const runsOpt = argv.includes('--runs') ? argv[argv.indexOf('--runs') + 1] : 'runs'
const runsDir = path.resolve(ROOT, runsOpt)
const wanted = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--runs')
const ids = (wanted.length ? wanted : fs.readdirSync(runsDir)).filter((id) => fs.existsSync(path.join(runsDir, id, 'dist', 'index.html'))).sort()

const summary = []
for (const id of ids) {
  const runDir = path.join(runsDir, id)
  const evaluation = readJson(path.join(runDir, 'eval.json'), null)
  if (!evaluation) {
    console.log(`${id}: no eval.json, skipped`)
    continue
  }
  const { task } = parseRunId(id)
  const evalDir = path.join(runDir, 'eval')
  const before = evaluation.quality?.acceptance ?? {}
  const server = await serveStatic(path.join(runDir, 'dist'))
  let acc
  try {
    fs.rmSync(path.join(evalDir, 'acceptance'), { recursive: true, force: true })
    acc = await runAcceptance(task, server.url, path.join(evalDir, 'acceptance'))
  } finally {
    await server.close()
  }
  if (!acc || acc.error) {
    console.log(`${id}: acceptance failed to run (${acc?.error ?? 'no suite'}); eval.json left unchanged`)
    continue
  }
  writeJson(path.join(evalDir, 'acceptance.json'), acc)
  evaluation.rescores = [...(evaluation.rescores ?? []), { at: new Date().toISOString(), previous: { itemsPassed: before.itemsPassed, itemsTotal: before.itemsTotal, testsPassed: before.testsPassed, testsTotal: before.testsTotal } }]
  evaluation.quality = {
    ...evaluation.quality,
    acceptance: { itemsPassed: acc.itemsPassed, itemsTotal: acc.itemsTotal ?? acceptanceItemCount(task), testsPassed: acc.testsPassed, testsTotal: acc.testsTotal, items: Object.fromEntries(Object.entries(acc.items).map(([k, v]) => [k, v.ok])) },
    axe: acc.axe,
    keyboard: acc.keyboard,
  }
  writeJson(path.join(runDir, 'eval.json'), evaluation)
  writeJson(path.join(runDir, 'metrics.json'), buildMetricsRecord(runDir))
  const failed = Object.entries(acc.items).filter(([, v]) => !v.ok).map(([k]) => k)
  const line = `${id}: items ${before.itemsPassed}/${before.itemsTotal} -> ${acc.itemsPassed}/${acc.itemsTotal}, tests ${acc.testsPassed}/${acc.testsTotal}, keyboard ${acc.keyboard.ok ? 'ok' : 'FAIL'}, axe ${acc.axe.passed}/${acc.axe.tests}${failed.length ? `, failing ${failed.join(' ')}` : ''}`
  console.log(line)
  summary.push(line)
}
if (!summary.length) console.log('Nothing rescored.')
