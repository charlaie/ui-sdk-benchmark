import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const ARMS = ['shadcn', 'ui-sdk']

export const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** Recursively list files (relative paths), skipping the given directory names and symlinks. */
export function listFiles(dir, { skip = ['node_modules', 'dist', '.git'] } = {}) {
  const out = []
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.includes(e.name) || e.isSymbolicLink()) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), r)
      else out.push(r)
    }
  }
  walk(dir, '')
  return out.sort()
}

export function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    if (fallback !== undefined) return fallback
    throw e
  }
}

export function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n')
}

export function loadConfig(file = process.env.BENCH_CONFIG || path.join(ROOT, 'config/benchmark.config.json')) {
  return readJson(file)
}

export function loadTasks() {
  const dir = path.join(ROOT, 'tasks')
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, 'task.json')))
    .sort()
    .map((d) => ({ ...readJson(path.join(dir, d, 'task.json')), dir: path.join(dir, d) }))
}

export function runIdOf({ task, arm, agent, rep }) {
  return `${task}__${arm}__${agent}__r${rep}`
}

export function parseRunId(id) {
  const m = /^(.+)__(.+)__(.+)__r(\d+)$/.exec(id)
  return m ? { task: m[1], arm: m[2], agent: m[3], rep: Number(m[4]) } : null
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
