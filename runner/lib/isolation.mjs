// Runs an agent CLI either inside the benchmark Docker image or directly on the host, in both cases
// with an isolated home directory (no user settings, memory, global skills, plugins or MCP servers).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sha } from './util.mjs'

export const expandHome = (p) => (p?.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)

const CREDENTIALS = {
  'claude-code': { original: '~/.claude/.credentials.json', inHome: '.claude/.credentials.json' },
  codex: { original: '~/.codex/auth.json', inHome: '.codex/auth.json' },
}

/** Create the isolated home for one run and copy credentials into it (auth.mode = copy-credentials). */
export function prepareAgentHome(kind, homeDir, config) {
  fs.rmSync(homeDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(homeDir, kind === 'codex' ? '.codex' : '.claude'), { recursive: true })
  const state = { creds: [] }
  if (config.auth?.mode === 'copy-credentials') {
    const c = CREDENTIALS[kind]
    const original = expandHome(c.original)
    if (!fs.existsSync(original)) throw new Error(`No credentials at ${original}; log in with the CLI or use auth.mode = "env"`)
    const copy = path.join(homeDir, c.inHome)
    const content = fs.readFileSync(original)
    fs.writeFileSync(copy, content, { mode: 0o600 })
    state.creds.push({ original, copy, hash: sha(content) })
  }
  return state
}

/**
 * OAuth tokens can be refreshed (and rotated) during a run. If the run's copy changed and the user's
 * original is still what we copied, write the refreshed copy back so the user's login stays valid.
 */
export function syncBackCredentials(state) {
  const notes = []
  for (const c of state.creds) {
    if (!fs.existsSync(c.copy)) continue
    const now = fs.readFileSync(c.copy)
    if (sha(now) === c.hash) continue
    const orig = fs.readFileSync(c.original)
    if (sha(orig) !== c.hash) {
      notes.push(`credentials changed both in the run and in ${c.original}; left the original alone`)
      continue
    }
    const tmp = `${c.original}.bench-tmp`
    fs.writeFileSync(tmp, now, { mode: 0o600 })
    fs.renameSync(tmp, c.original)
    notes.push(`refreshed credentials copied back to ${c.original}`)
  }
  return notes
}

/** Paths as the agent sees them. */
export function agentPaths(config, { workspace, home }) {
  return config.isolation === 'docker' ? { work: '/work', home: '/home/agent' } : { work: workspace, home }
}

/**
 * Spawn `bin args` for the agent. In docker mode `bin` is a path inside the container and `mounts`
 * adds read-only host paths (the CLI). Returns the ChildProcess plus a kill() that also stops the container.
 */
export function spawnIsolated(config, { workspace, home, bin, args, mounts = [], env = {}, containerName }) {
  const passEnv = Object.fromEntries((config.auth?.passEnv ?? []).filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
  if (config.isolation === 'docker') {
    const d = config.docker ?? {}
    const dockerArgs = ['run', '--rm', '-i', '--init', '--name', containerName, '-v', `${workspace}:/work`, '-v', `${home}:/home/agent`, '-w', '/work']
    for (const m of mounts) dockerArgs.push('-v', `${m.host}:${m.container}:ro`)
    if (d.cpus) dockerArgs.push('--cpus', String(d.cpus))
    if (d.memory) dockerArgs.push('--memory', d.memory)
    for (const [k, v] of Object.entries({ HOME: '/home/agent', ...env, ...passEnv })) dockerArgs.push('-e', `${k}=${v}`)
    dockerArgs.push(d.image ?? 'ui-sdk-bench-agent:local', bin, ...args)
    const child = spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
    const kill = () => {
      spawn('docker', ['kill', containerName], { stdio: 'ignore' })
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
    }
    return { child, kill, command: ['docker', ...dockerArgs] }
  }
  // Host mode: build the environment from scratch so nothing from the calling shell (or a parent
  // agent session) leaks in.
  const cleanEnv = {
    PATH: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: home,
    USER: os.userInfo().username,
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: 'dumb',
    TMPDIR: path.join(home, 'tmp'),
    DISABLE_AUTOUPDATER: '1',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_FUND: 'false',
    ...env,
    ...passEnv,
  }
  fs.mkdirSync(cleanEnv.TMPDIR, { recursive: true })
  const child = spawn(bin, args, { cwd: workspace, env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  const kill = () => {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, 10_000).unref()
  }
  return { child, kill, command: [bin, ...args] }
}
