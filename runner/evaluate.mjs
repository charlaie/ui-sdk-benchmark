#!/usr/bin/env node
// Evaluates one run's output: typecheck, build, bundle size, dependencies and lines added, console
// errors at load, screenshots (3 widths x light/dark) and the hidden acceptance suite.
//
// Usually called by run.mjs right after the agent finishes (the workspace still has node_modules).
// Standalone, to re-evaluate a finished run whose workspace was kept (--keep-workspace):
//   node runner/evaluate.mjs <runDir> [--workspace <dir>] [--config <file>]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { chromium } from '@playwright/test'
import { serveStatic } from './lib/static-server.mjs'
import { ROOT, listFiles, loadConfig, loadTasks, parseRunId, readJson, writeJson } from './lib/util.mjs'
import { dependencyDiff, diffStats, prepareWorkspace, sourceFiles, workRootOf } from './lib/workspace.mjs'

export const SCREEN_WIDTHS = [375, 768, 1280]
export const SCHEMES = ['light', 'dark']

function run(cmd, args, { cwd, env, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

/** Run a shell command in the workspace, inside the agent image when isolation is docker. */
function runInWorkspace(config, workspace, script, timeoutMs) {
  if (config.isolation === 'docker') {
    return run('docker', ['run', '--rm', '-v', `${workspace}:/work`, '-w', '/work', config.docker?.image ?? 'ui-sdk-bench-agent:local', 'sh', '-c', script], { timeoutMs })
  }
  const env = { PATH: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'), HOME: process.env.HOME, LANG: 'C.UTF-8' }
  return run('sh', ['-c', script], { cwd: workspace, env, timeoutMs })
}

const tail = (s, n = 4000) => (s.length > n ? `…${s.slice(-n)}` : s)

function bundleSize(dir) {
  const res = { files: 0, rawBytes: 0, gzipBytes: 0, jsGzipBytes: 0, cssGzipBytes: 0 }
  if (!fs.existsSync(dir)) return null
  for (const f of listFiles(dir, { skip: [] })) {
    const buf = fs.readFileSync(path.join(dir, f))
    const gz = zlib.gzipSync(buf, { level: 9 }).length
    res.files++
    res.rawBytes += buf.length
    if (/\.(js|mjs|css|html|svg|json)$/.test(f)) res.gzipBytes += gz
    if (/\.m?js$/.test(f)) res.jsGzipBytes += gz
    if (/\.css$/.test(f)) res.cssGzipBytes += gz
  }
  return res
}

/** Number of items in the spec's "## Acceptance criteria" list. */
export function acceptanceItemCount(taskId) {
  const spec = fs.readFileSync(path.join(ROOT, 'tasks', taskId, 'spec.md'), 'utf8')
  const section = spec.split(/^## Acceptance criteria/m)[1] ?? ''
  return (section.match(/^\d+\.\s/gm) ?? []).length
}

async function loadCheckAndScreenshots(baseUrl, outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  const browser = await chromium.launch()
  const result = { consoleErrors: [], pageErrors: [], failedRequests: [], screenshots: [], horizontalOverflowAt375: null, rendered: null }
  try {
    for (const scheme of SCHEMES) {
      for (const width of SCREEN_WIDTHS) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, reducedMotion: 'reduce' })
        const page = await context.newPage()
        const record = scheme === 'light' && width === 1280
        if (record) {
          page.on('console', (m) => m.type() === 'error' && result.consoleErrors.push(m.text().slice(0, 500)))
          page.on('pageerror', (e) => result.pageErrors.push(String(e).slice(0, 500)))
          page.on('requestfailed', (r) => result.failedRequests.push(r.url()))
        }
        try {
          await page.goto(baseUrl, { waitUntil: 'load', timeout: 20_000 })
          await page.waitForTimeout(2500)
          if (record) result.rendered = await page.evaluate(() => (document.getElementById('root')?.innerText ?? '').trim().length > 0)
          if (width === 375 && scheme === 'light') {
            result.horizontalOverflowAt375 = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
          }
          const file = `${width}-${scheme}.png`
          await page.screenshot({ path: path.join(outDir, file) })
          result.screenshots.push({ file, width, scheme })
        } catch (e) {
          if (record) result.pageErrors.push(`load failed: ${String(e).slice(0, 300)}`)
        }
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }
  return result
}

function collectTests(report) {
  const tests = []
  const walk = (suite, file) => {
    for (const s of suite.suites ?? []) walk(s, s.file ?? file)
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const results = t.results ?? []
        const last = results.at(-1)
        tests.push({
          title: spec.title,
          file: spec.file ?? file,
          status: last?.status ?? 'skipped',
          ok: spec.ok,
          durationMs: results.reduce((n, r) => n + (r.duration ?? 0), 0),
          error: last?.error?.message ? last.error.message.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 600) : undefined,
        })
      }
    }
  }
  walk(report, undefined)
  return tests
}

export async function runAcceptance(taskId, baseUrl, outDir) {
  const suiteDir = path.join(ROOT, 'acceptance', taskId)
  if (!fs.existsSync(suiteDir)) return null
  fs.mkdirSync(outDir, { recursive: true })
  const reportFile = path.join(outDir, 'report.json')
  const env = { ...process.env, BASE_URL: baseUrl, RESULTS_DIR: outDir, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile, FORCE_COLOR: '0' }
  const res = await run('npx', ['playwright', 'test', '--config', path.join(ROOT, 'acceptance/playwright.config.ts'), '--reporter=json', `acceptance/${taskId}/`], { cwd: ROOT, env, timeoutMs: 30 * 60_000 })
  fs.writeFileSync(path.join(outDir, 'playwright-output.log'), res.out)
  const report = readJson(reportFile, null)
  if (!report) return { error: `no report (exit ${res.code})`, log: tail(res.out) }
  const tests = collectTests(report)
  const itemsTotal = acceptanceItemCount(taskId)
  const items = {}
  for (let i = 1; i <= itemsTotal; i++) {
    const mine = tests.filter((t) => new RegExp(`^A${i}\\b`).test(t.title))
    items[`A${i}`] = { tests: mine.length, passed: mine.filter((t) => t.status === 'passed').length, ok: mine.length > 0 && mine.every((t) => t.status === 'passed') }
  }
  const axeTests = tests.filter((t) => /^axe\b/.test(t.title))
  const kbdTests = tests.filter((t) => /^kbd\b/.test(t.title))
  const axeFiles = fs.readdirSync(outDir).filter((f) => /^axe-.*\.json$/.test(f))
  const violations = axeFiles.flatMap((f) => readJson(path.join(outDir, f), { violations: [] }).violations.map((v) => ({ ...v, state: f.replace(/^axe-|\.json$/g, '') })))
  const byImpact = {}
  for (const v of violations) byImpact[v.impact ?? 'unknown'] = (byImpact[v.impact ?? 'unknown'] ?? 0) + 1
  return {
    exitCode: res.code,
    stats: report.stats,
    testsTotal: tests.length,
    testsPassed: tests.filter((t) => t.status === 'passed').length,
    itemsTotal,
    itemsPassed: Object.values(items).filter((x) => x.ok).length,
    items,
    axe: { tests: axeTests.length, passed: axeTests.filter((t) => t.status === 'passed').length, statesChecked: axeFiles.length, violations: violations.length, byImpact, rules: [...new Set(violations.map((v) => v.id))] },
    keyboard: { tests: kbdTests.length, passed: kbdTests.filter((t) => t.status === 'passed').length, ok: kbdTests.length > 0 && kbdTests.every((t) => t.status === 'passed') },
    tests,
  }
}

export async function evaluateRun({ config, runDir, workspace, task, arm }) {
  const evalDir = path.join(runDir, 'eval')
  fs.rmSync(evalDir, { recursive: true, force: true })
  fs.mkdirSync(evalDir, { recursive: true })

  // Keep the agent's source (without node_modules) with the run.
  const srcOut = path.join(runDir, 'output-src')
  fs.rmSync(srcOut, { recursive: true, force: true })
  for (const f of sourceFiles(workspace)) {
    fs.mkdirSync(path.dirname(path.join(srcOut, f)), { recursive: true })
    fs.copyFileSync(path.join(workspace, f), path.join(srcOut, f))
  }

  const baseline = path.join(path.dirname(workspace), 'baseline')
  prepareWorkspace({ task, arm, dest: baseline, nodeModules: 'none' })
  const diff = diffStats(baseline, workspace)
  fs.rmSync(baseline, { recursive: true, force: true })
  const deps = dependencyDiff(readJson(path.join(ROOT, 'templates', arm, 'package.json')), readJson(path.join(workspace, 'package.json'), {}))
  // Ready-made versions of the widget being built are against the rules; flag them (globs with *).
  const bannedRe = (task.bannedDependencies ?? []).map((g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`))
  deps.banned = deps.added.map((d) => d.name).filter((n) => bannedRe.some((re) => re.test(n)))

  const typecheck = await runInWorkspace(config, workspace, 'npx tsc -b', 300_000)
  const build = await runInWorkspace(config, workspace, 'rm -rf .bench-dist && npx vite build --outDir .bench-dist --emptyOutDir', 300_000)
  fs.writeFileSync(path.join(evalDir, 'typecheck.log'), typecheck.out)
  fs.writeFileSync(path.join(evalDir, 'build.log'), build.out)
  const distDir = path.join(runDir, 'dist')
  fs.rmSync(distDir, { recursive: true, force: true })
  const built = path.join(workspace, '.bench-dist')
  const buildOk = build.code === 0 && fs.existsSync(path.join(built, 'index.html'))
  if (buildOk) fs.cpSync(built, distDir, { recursive: true })
  fs.rmSync(built, { recursive: true, force: true })

  const outcome = {
    typecheck: { ok: typecheck.code === 0, exitCode: typecheck.code, errors: (typecheck.out.match(/error TS\d+/g) ?? []).length },
    build: { ok: buildOk, exitCode: build.code },
    bundle: buildOk ? bundleSize(distDir) : null,
    dependencies: deps,
    diff: { filesChanged: diff.filesChanged, linesAdded: diff.linesAdded, linesRemoved: diff.linesRemoved, codeLinesAdded: diff.codeLinesAdded },
    load: null,
  }
  writeJson(path.join(evalDir, 'diff.json'), diff)

  const quality = { acceptance: { itemsPassed: 0, itemsTotal: acceptanceItemCount(task.id) }, axe: null, keyboard: null, screenshots: [] }
  if (buildOk) {
    const server = await serveStatic(distDir)
    try {
      const load = await loadCheckAndScreenshots(server.url, path.join(runDir, 'screenshots'))
      outcome.load = { consoleErrors: load.consoleErrors.length, pageErrors: load.pageErrors.length, rendered: load.rendered, horizontalOverflowAt375: load.horizontalOverflowAt375, messages: [...load.pageErrors, ...load.consoleErrors].slice(0, 20) }
      quality.screenshots = load.screenshots
      const acc = await runAcceptance(task.id, server.url, path.join(evalDir, 'acceptance'))
      if (acc && !acc.error) {
        writeJson(path.join(evalDir, 'acceptance.json'), acc)
        quality.acceptance = { itemsPassed: acc.itemsPassed, itemsTotal: acc.itemsTotal, testsPassed: acc.testsPassed, testsTotal: acc.testsTotal, items: Object.fromEntries(Object.entries(acc.items).map(([k, v]) => [k, v.ok])) }
        quality.axe = acc.axe
        quality.keyboard = acc.keyboard
      } else if (acc) quality.acceptance.error = acc.error
    } finally {
      await server.close()
    }
  }
  const evaluation = { evaluatedAt: new Date().toISOString(), outcome, quality }
  writeJson(path.join(runDir, 'eval.json'), evaluation)
  writeJson(path.join(runDir, 'metrics.json'), buildMetricsRecord(runDir))
  return evaluation
}

/** Flat per-run record used by the summary and the gallery. */
export function buildMetricsRecord(runDir) {
  const a = readJson(path.join(runDir, 'agent-metrics.json'), {})
  const e = readJson(path.join(runDir, 'eval.json'), {})
  return {
    runId: a.runId,
    task: a.task,
    category: a.category,
    arm: a.arm,
    agent: a.agent,
    agentKind: a.agentKind,
    model: a.model,
    effort: a.effort,
    rep: a.rep,
    cliVersion: a.cliVersion,
    libraryVersions: a.libraryVersions ?? null,
    isolation: a.isolation,
    status: a.status,
    endReason: a.endReason,
    startedAt: a.startedAt,
    cost: a.cost,
    tokens: a.tokens,
    time: { wallMs: a.wallMs, ...a.time },
    process: a.process,
    skills: a.isolation && { available: a.isolation.skillsAvailable, benchmarkSkillAvailable: a.isolation.benchmarkSkillAvailable, benchmarkSkillUsed: a.isolation.benchmarkSkillUsed },
    outcome: e.outcome ?? null,
    quality: e.quality ?? null,
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const runDir = path.resolve(argv[0] ?? '')
  const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined)
  const config = loadConfig(opt('--config') ? path.resolve(opt('--config')) : undefined)
  const meta = readJson(path.join(runDir, 'meta.json'))
  const cell = parseRunId(meta.runId)
  const task = loadTasks().find((t) => t.id === cell.task)
  const workspace = path.resolve(opt('--workspace') ?? path.join(workRootOf(config), meta.runId, 'workspace'))
  if (!fs.existsSync(path.join(workspace, 'node_modules'))) throw new Error(`Workspace with node_modules not found at ${workspace} (run with --keep-workspace to keep it)`)
  const ev = await evaluateRun({ config, runDir, workspace, task, arm: cell.arm })
  console.log(JSON.stringify({ outcome: ev.outcome, acceptance: ev.quality.acceptance }, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message ?? e)
    process.exit(1)
  })
}
