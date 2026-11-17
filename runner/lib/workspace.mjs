import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, listFiles } from './util.mjs'

export function workRootOf(config) {
  return path.resolve(config.workRoot ?? path.join(os.tmpdir(), 'ui-sdk-bench-work'))
}

/**
 * Create the agent's starting project: the arm template (with its pre-installed node_modules)
 * plus the task's mock API in src/mock/. Nothing from acceptance/ or the task specs is copied.
 */
export function prepareWorkspace({ task, arm, dest, nodeModules = 'copy' }) {
  const template = path.join(ROOT, 'templates', arm)
  if (!fs.existsSync(path.join(template, 'node_modules'))) {
    throw new Error(`templates/${arm}/node_modules is missing: run npm install in templates/${arm}`)
  }
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(template)) {
    if (entry === 'dist') continue
    if (entry === 'node_modules' && nodeModules !== 'copy') continue
    // cp -a keeps the relative symlinks in node_modules/.bin and the .claude/skills -> .agents/skills link.
    execFileSync('cp', ['-a', '--reflink=auto', path.join(template, entry), dest])
  }
  if (nodeModules === 'symlink') fs.symlinkSync(path.join(template, 'node_modules'), path.join(dest, 'node_modules'))
  fs.rmSync(path.join(dest, 'node_modules/.tmp'), { recursive: true, force: true })
  if (task.mock) {
    const src = path.join(task.dir, task.mock)
    for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dest, 'src/mock', f))
  }
  return dest
}

/** Files that count as the agent's work when diffing against the baseline. */
export function sourceFiles(dir) {
  return listFiles(dir, { skip: ['node_modules', 'dist', '.git', '.vite'] }).filter(
    (f) => !/(^|\/)package-lock\.json$/.test(f) && !f.endsWith('.tsbuildinfo'),
  )
}

/** Lines added/removed per file versus a baseline directory, using git diff --no-index --numstat. */
export function diffStats(baseDir, workDir) {
  const base = new Set(sourceFiles(baseDir))
  const work = new Set(sourceFiles(workDir))
  const files = []
  for (const f of new Set([...base, ...work])) {
    const a = base.has(f) ? path.join(baseDir, f) : '/dev/null'
    const b = work.has(f) ? path.join(workDir, f) : '/dev/null'
    if (a !== '/dev/null' && b !== '/dev/null' && fs.readFileSync(a).equals(fs.readFileSync(b))) continue
    let out = ''
    try {
      out = execFileSync('git', ['diff', '--no-index', '--numstat', '--', a, b], { encoding: 'utf8' })
    } catch (e) {
      out = e.stdout?.toString() ?? '' // exit code 1 means "differences found"
    }
    const [added, removed] = out.trim().split(/\s+/)
    files.push({
      file: f,
      status: !base.has(f) ? 'added' : !work.has(f) ? 'deleted' : 'modified',
      added: added === '-' ? 0 : Number(added) || 0,
      removed: removed === '-' ? 0 : Number(removed) || 0,
      binary: added === '-',
    })
  }
  files.sort((x, y) => x.file.localeCompare(y.file))
  const sum = (k) => files.reduce((n, f) => n + f[k], 0)
  const code = files.filter((f) => /\.(tsx?|jsx?|css)$/.test(f.file) && !f.file.startsWith('.agents/') && !f.file.startsWith('.claude/'))
  return {
    filesChanged: files.length,
    linesAdded: sum('added'),
    linesRemoved: sum('removed'),
    codeLinesAdded: code.reduce((n, f) => n + f.added, 0),
    files,
  }
}

export function dependencyDiff(templatePkg, workPkg) {
  const all = (p) => ({ ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}) })
  const before = all(templatePkg)
  const after = all(workPkg)
  const added = Object.entries(after).filter(([d]) => !(d in before)).map(([name, version]) => ({ name, version, dev: !!workPkg.devDependencies?.[name] }))
  const removed = Object.keys(before).filter((d) => !(d in after))
  const changed = Object.entries(after).filter(([d, v]) => d in before && before[d] !== v).map(([name, version]) => ({ name, from: before[name], to: version }))
  return { added, removed, changed }
}
