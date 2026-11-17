#!/usr/bin/env node
// Builds the static results site from finished runs:
//   index.html          the writeup (docs/pilot-findings.html), with a table of contents
//   runs.html           every run as a card, grouped by task in a model x library grid
//   runs/<id>/          one page per run: the built app in a resizable viewer, metrics, the prompt, screenshots
// Plain static files with relative links: deployable to any static host, or opened from disk. The prompt is
// published (it is built from files in the repo); raw event logs, agent source, Codex rollouts and local
// paths are never copied.
//
//   node scripts/build-gallery.mjs [--config <file>] [--runs <dir>] [--out gallery] [--include-smoke]
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, loadConfig, loadTasks, readJson, writeJson } from '../runner/lib/util.mjs'

const argv = process.argv.slice(2)
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined)
const config = loadConfig(opt('--config') ? path.resolve(opt('--config')) : undefined)
const runsDir = path.resolve(ROOT, opt('--runs') ?? config.runsDir ?? 'runs')
const outDir = path.resolve(ROOT, opt('--out') ?? 'gallery')
const includeSmoke = argv.includes('--include-smoke')
const tasks = Object.fromEntries(loadTasks().map((t) => [t.id, t]))
// The writeup: an HTML fragment kept in the repo, published as the home page.
const findingsFile = path.join(ROOT, 'docs', 'pilot-findings.html')
const findings = fs.existsSync(findingsFile) ? fs.readFileSync(findingsFile, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim() : null

const SITE = 'UI SDK vs shadcn'
const DESCRIPTION = 'Two coding agents built the same four apps with shadcn/ui and with UI SDK. Results, findings and every app to try.'
const ARM_LABEL = { shadcn: 'shadcn/ui', 'ui-sdk': 'UI SDK' }
const AGENT_LABEL = { codex: 'Codex', claude: 'Claude Code' }
const MODEL_LABEL = { 'claude-opus-5-5': 'Opus 5.5' }
const AGENT_ORDER = ['codex', 'claude']
const TASK_BLURB = {
  '01-booking': 'A modal for scheduling a meeting: attendee search with chips, a date picker, time and duration selects, repeat options, validation, discard confirmation and undo.',
  '02-inbox': 'A triage inbox for 200 issues: tabs, search, filters, sorting, bulk actions, row and context menus with submenus, an issue drawer and a command palette.',
  '03-spreadsheet': 'A virtualised 10,000 × 26 grid: keyboard navigation, range selection by keyboard and mouse, editing, copy and paste, and saving.',
  '04-flow-canvas': 'A node editor for agent flows: pan and zoom, dragging and snapping, connecting ports, inserting steps, a properties panel, undo, autosave and a test run.',
}
const armLabel = (a) => ARM_LABEL[a] ?? a
const agentLabel = (r) => `${AGENT_LABEL[r.agent] ?? r.agent} · ${MODEL_LABEL[r.model] ?? r.model}`
const agentRank = (a) => (AGENT_ORDER.includes(a) ? AGENT_ORDER.indexOf(a) : AGENT_ORDER.length)

// Stable ids keep URLs short and unchanged across rebuilds.
const opaque = (runId) => crypto.createHash('sha256').update(`ui-sdk-bench:${runId}`).digest('hex').slice(0, 12)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Failing axe element checks across all audited UI states (the measure used in the writeup). */
function axeNodes(runDir) {
  const dir = path.join(runDir, 'eval', 'acceptance')
  if (!fs.existsSync(dir)) return null
  let n = 0
  for (const f of fs.readdirSync(dir).filter((f) => /^axe-.*\.json$/.test(f))) for (const v of readJson(path.join(dir, f), {}).violations ?? []) n += Number(v.nodes) || 0
  return n
}

/** Public subset of a metrics record. No paths, command lines, credential notes or raw logs. */
function publicRecord(m, oid, hasApp, axe) {
  return {
    id: oid,
    runId: m.runId,
    task: m.task,
    taskTitle: tasks[m.task]?.title ?? m.task,
    category: m.category,
    arm: m.arm,
    agent: m.agent,
    model: m.model,
    effort: m.effort,
    rep: m.rep,
    cliVersion: m.cliVersion,
    libraryVersions: m.libraryVersions ?? null,
    status: m.status,
    startedAt: m.startedAt,
    hasApp,
    cost: m.cost,
    tokens: m.tokens,
    time: m.time,
    process: m.process,
    skills: m.skills,
    outcome: m.outcome && { ...m.outcome, load: m.outcome.load && { ...m.outcome.load, messages: undefined } },
    quality: m.quality && { ...m.quality, axeFailingChecks: axe },
  }
}

const CSS = `:root{--bg:#f4efe4;--surface:#fbf8f1;--surface-2:#ede6d8;--text:#2b2520;--text-2:#4a423a;--muted:#6e6357;--border:#e2d8c6;--border-strong:#cdbfa7;
--accent:#9e4320;--accent-soft:#f2e2d3;--good:#3b6a2c;--good-soft:#e2ead3;--bad:#a3312a;--bad-soft:#f5dfd8;--s-shadcn:#a39684;--s-uisdk:#b9562b;
--radius:12px;--shadow:0 1px 2px rgba(74,52,30,.05),0 6px 18px rgba(74,52,30,.06);--shadow-hover:0 2px 4px rgba(74,52,30,.06),0 14px 32px rgba(74,52,30,.1);--grain-opacity:.5;
--font:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--serif:"Newsreader","Iowan Old Style","Charter",Georgia,serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#1b1814;--surface:#24201b;--surface-2:#2d2822;--text:#efe8dc;--text-2:#d6cdbf;--muted:#a69b8c;--border:#3a342c;--border-strong:#4d463b;
--accent:#e8976f;--accent-soft:#3b2619;--good:#9fcb89;--good-soft:#1f2a19;--bad:#f09a8c;--bad-soft:#3a1e1a;--s-shadcn:#8c8172;--s-uisdk:#e08a5f;
--shadow:0 1px 2px rgba(0,0,0,.35);--shadow-hover:0 2px 4px rgba(0,0,0,.4),0 14px 32px rgba(0,0,0,.35);--grain-opacity:.25;color-scheme:dark}}
body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:var(--grain-opacity);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .35 0 0 0 0 .25 0 0 0 0 .15 0 0 0 .5 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-padding-top:80px}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 var(--font);-webkit-font-smoothing:antialiased;font-feature-settings:"cv11","ss01";isolation:isolate}
a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:3px}a:hover{text-decoration-thickness:2px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.container{max-width:1160px;margin:0 auto;padding:0 20px}@media (max-width:600px){.container{padding:0 16px}}
.nav{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:saturate(1.6) blur(14px);-webkit-backdrop-filter:saturate(1.6) blur(14px);border-bottom:1px solid var(--border)}
.nav .container{display:flex;align-items:center;justify-content:space-between;height:60px;gap:16px}
.brand{display:flex;align-items:center;gap:10px;font-family:var(--serif);font-size:18px;font-weight:600;letter-spacing:-.005em;color:var(--text);text-decoration:none;white-space:nowrap}
.brand-mark{width:22px;height:22px;border-radius:7px;background:linear-gradient(135deg,var(--s-shadcn) 0 50%,var(--s-uisdk) 50% 100%)}
.nav-links{display:flex;gap:4px}.nav-links a{color:var(--muted);text-decoration:none;font-size:14.5px;font-weight:500;padding:6px 12px;border-radius:8px}
.nav-links a:hover{color:var(--text);background:var(--surface-2)}.nav-links a[aria-current=page]{color:var(--text);background:var(--surface-2)}
main{padding-bottom:96px}
.hero{padding:64px 0 8px}@media (max-width:600px){.hero{padding:40px 0 4px}.stat{padding:14px 16px}.stat-label{font-size:13px}}
.eyebrow{margin:0;font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--accent)}
h1,h2,.stat-value,.section-title{font-family:var(--serif);font-optical-sizing:auto}
h1{font-size:clamp(36px,5.4vw,58px);line-height:1.06;letter-spacing:-.02em;font-weight:600;margin:14px 0 18px;max-width:52rem;text-wrap:balance}
.lead{font-size:clamp(17px,2vw,20px);line-height:1.55;color:var(--text-2);max-width:52rem;margin:0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(190px,calc(50% - 6px)),1fr));gap:12px;margin:36px 0 0}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px;box-shadow:var(--shadow)}
.stat-value{display:block;font-size:clamp(24px,5.8vw,34px);font-weight:600;letter-spacing:-.015em;line-height:1.1;font-variant-numeric:tabular-nums}
.stat-label{display:block;margin-top:6px;font-size:14px;color:var(--muted);line-height:1.4}
.doc{display:grid;grid-template-columns:minmax(0,1fr);gap:56px;margin-top:56px}@media (min-width:1080px){.doc{grid-template-columns:200px minmax(0,1fr)}}
.toc{display:none}@media (min-width:1080px){.toc{display:block}}
.toc nav{position:sticky;top:92px}.toc p{margin:0 0 10px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.toc ol{list-style:none;margin:0;padding:0;border-left:1px solid var(--border)}.toc a{display:block;padding:5px 0 5px 14px;margin-left:-1px;border-left:2px solid transparent;color:var(--muted);text-decoration:none;font-size:14px;line-height:1.35}
.toc a:hover{color:var(--text)}.toc a.active{color:var(--text);border-left-color:var(--accent);font-weight:500}
.prose{min-width:0;max-width:760px}.prose>*{max-width:100%}
.prose h2{font-size:32px;line-height:1.15;letter-spacing:-.015em;font-weight:600;margin:72px 0 14px;text-wrap:balance}.prose>h2:first-child,.prose>section:first-child h2{margin-top:0}
.prose h3{font-size:18px;letter-spacing:-.01em;margin:32px 0 8px}.prose p,.prose li{color:var(--text-2)}.prose strong{color:var(--text);font-weight:600}
.prose ul,.prose ol{padding-left:22px}.prose li{margin:6px 0}.prose li::marker{color:var(--muted)}
code{font-family:var(--mono);font-size:.86em;background:var(--surface-2);border:1px solid var(--border);padding:1px 5px;border-radius:6px}
.muted{color:var(--muted)}.small{font-size:14px}
.takeaways{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin:20px 0}
.takeaway{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px;box-shadow:var(--shadow)}
.takeaway h3{margin:0 0 6px;font-size:16px}.takeaway p{margin:0;font-size:15px;line-height:1.55}
.callout{background:var(--accent-soft);border-radius:var(--radius);padding:16px 20px;margin:20px 0}.callout p{margin:0;color:var(--text)}
.table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);margin:20px 0;box-shadow:var(--shadow)}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:14.5px}
th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:top}
thead th{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);background:var(--surface-2);white-space:nowrap}
tbody tr:last-child td{border-bottom:0}td.num,th.num{text-align:right;white-space:nowrap}td{color:var(--text-2)}td:first-child{color:var(--text);font-weight:500}
thead tr.group th{border-bottom:0;padding-bottom:2px;text-align:center}thead tr.sub th{padding-top:2px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;font-size:12.5px;font-weight:500;line-height:1.6;background:var(--surface-2);color:var(--text-2);border:1px solid var(--border);white-space:nowrap}
.pill.good{background:var(--good-soft);color:var(--good);border-color:transparent}.pill.bad{background:var(--bad-soft);color:var(--bad);border-color:transparent}
.dot{display:inline-block;width:10px;height:10px;border-radius:3px;flex:none}.dot.shadcn{background:var(--s-shadcn)}.dot.ui-sdk{background:var(--s-uisdk)}
figure{margin:28px 0}figcaption{font-size:14px;color:var(--muted);margin-top:10px;line-height:1.5}
.bars{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:22px 24px;box-shadow:var(--shadow)}
.bars-title{margin:0 0 4px;font-weight:600;color:var(--text)}.bars-sub{margin:0 0 18px;font-size:14px;color:var(--muted)}
.bar-row{display:grid;grid-template-columns:150px minmax(0,1fr) 48px;align-items:center;gap:12px;margin:10px 0}
.bar-label{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text-2)}.bar-track{height:22px;background:var(--surface-2);border-radius:6px;overflow:hidden}
.bar{display:block;height:100%;width:max(var(--v),3px);border-radius:6px}.bar.shadcn{background:var(--s-shadcn)}.bar.ui-sdk{background:var(--s-uisdk)}
.bar-value{font-size:14px;font-weight:600;text-align:right;font-variant-numeric:tabular-nums}.bar-gap{height:8px}
@media (max-width:600px){.bar-row{grid-template-columns:112px minmax(0,1fr) 40px;gap:8px}.bar-label{font-size:13px}}
.shots-matrix{display:grid;grid-template-columns:auto repeat(2,minmax(0,1fr));gap:12px;align-items:center}
.shots-matrix .col-head{font-size:13px;font-weight:600;color:var(--muted);display:flex;align-items:center;gap:8px}
.shots-matrix .row-head{font-size:13px;font-weight:600;color:var(--muted);writing-mode:vertical-rl;transform:rotate(180deg);text-align:center}
.shot{display:block;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--surface-2);aspect-ratio:16/10;box-shadow:var(--shadow);transition:border-color .15s,transform .15s}
.shot:hover{border-color:var(--border-strong);transform:translateY(-1px)}.shot img{display:block;width:100%;height:100%;object-fit:cover;object-position:top left}
.page-head{padding:48px 0 8px}.page-head h1{font-size:clamp(30px,4.4vw,44px);max-width:none;margin:10px 0 12px}
.task{margin-top:64px}.task-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 16px;margin-bottom:6px}
.task-head h2{margin:0;font-size:28px;font-weight:600;letter-spacing:-.015em}.task-blurb{margin:0 0 20px;color:var(--muted);max-width:80ch}
.matrix{display:grid;grid-template-columns:110px repeat(var(--cols),minmax(0,1fr));gap:16px;align-items:start}
.matrix .col-head{font-size:13px;font-weight:600;color:var(--muted);display:flex;align-items:center;gap:8px;padding:0 2px}
.matrix .row-head{font-size:13.5px;font-weight:600;color:var(--text-2);padding-top:8px;line-height:1.35}.matrix .row-head span{display:block;font-weight:400;color:var(--muted)}
.cell{display:grid;gap:12px}
@media (max-width:760px){.matrix{grid-template-columns:minmax(0,1fr)}.matrix .col-head,.matrix .row-head{display:none}}
.run-card{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;color:inherit;text-decoration:none;box-shadow:var(--shadow);transition:transform .15s ease,border-color .15s ease,box-shadow .15s ease}
.run-card:hover{transform:translateY(-2px);border-color:var(--border-strong);box-shadow:var(--shadow-hover)}
.thumb{aspect-ratio:16/10;background:var(--surface-2);border-bottom:1px solid var(--border);overflow:hidden}.thumb img{display:block;width:100%;height:100%;object-fit:cover;object-position:top left}
.run-body{padding:14px 16px 16px;display:grid;gap:10px}.run-title{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px}.run-title .who{font-weight:400;color:var(--muted)}
.run-stats{display:flex;flex-wrap:wrap;gap:6px}
.crumbs{font-size:14px;color:var(--muted)}.crumbs a{color:var(--muted);text-decoration:none}.crumbs a:hover{color:var(--text)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0}
.viewer{margin:32px 0;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow)}
.viewer-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;padding:10px 14px;border-bottom:1px solid var(--border)}
.viewer-controls{display:flex;flex-wrap:wrap;gap:10px}
.seg{display:inline-flex;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:3px;position:relative}
.seg input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.seg label{padding:4px 12px;border-radius:7px;font-size:13.5px;font-weight:500;color:var(--muted);cursor:pointer;user-select:none}
.seg input:checked+label{background:var(--surface);color:var(--text);box-shadow:0 1px 2px rgba(74,52,30,.12)}.seg input:focus-visible+label{outline:2px solid var(--accent)}
.open-link{font-size:14px;font-weight:500;text-decoration:none}
.stage{background:var(--surface-2);padding:20px;overflow:hidden}@media (max-width:600px){.stage{padding:10px}}
.stage-inner{margin:0 auto;overflow:hidden;border-radius:10px;box-shadow:0 0 0 1px var(--border),var(--shadow)}
.stage iframe{display:block;border:0;background:#fff;transform-origin:0 0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin:16px 0}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px;box-shadow:var(--shadow)}.card h3{margin:0 0 12px;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
dl{margin:0;display:grid;gap:8px}dl div{display:flex;justify-content:space-between;gap:16px;font-size:14.5px}dt{color:var(--muted)}dd{margin:0;font-weight:500;text-align:right;font-variant-numeric:tabular-nums}
.items{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 0}
.section-title{font-size:26px;font-weight:600;letter-spacing:-.015em;margin:56px 0 4px}
.gallery-shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;margin-top:16px}.gallery-shots figure{margin:0}
.gallery-shots img{display:block;width:100%;border:1px solid var(--border);border-radius:10px}.gallery-shots figcaption{margin-top:6px;font-size:13px}
.prompt{margin:16px 0 0;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden}
.prompt summary{cursor:pointer;padding:14px 20px;font-weight:600;font-size:15px;list-style:none;display:flex;align-items:center;gap:10px;user-select:none}
.prompt summary::-webkit-details-marker{display:none}.prompt summary::before{content:"";width:8px;height:8px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(-45deg);transition:transform .15s;flex:none}
.prompt[open] summary::before{transform:rotate(45deg)}.prompt summary:hover{background:var(--surface-2)}.prompt[open] summary{border-bottom:1px solid var(--border)}
.md{padding:8px 28px 24px;max-width:860px;font-size:15px;line-height:1.65;color:var(--text-2)}@media (max-width:600px){.md{padding:4px 16px 18px}}
.md h3,.md h4,.md h5{font-family:var(--serif);color:var(--text);font-weight:600;letter-spacing:-.01em;margin:28px 0 8px;line-height:1.25}.md h3{font-size:24px}.md h4{font-size:19px}.md h5{font-size:16px}
.md p{margin:10px 0}.md ul,.md ol{padding-left:22px;margin:8px 0}.md li{margin:5px 0}.md li>ul,.md li>ol{margin:4px 0}.md li::marker{color:var(--muted)}.md strong{color:var(--text)}
.md .table-wrap{box-shadow:none;margin:14px 0}.md table{font-size:13.5px}
footer{border-top:1px solid var(--border);padding:28px 0;color:var(--muted);font-size:14px}footer .container{display:flex;flex-wrap:wrap;gap:8px 24px;justify-content:space-between}`

function shell(title, body, { prefix = '', active = '', script = '' } = {}) {
  const link = (href, label, key) => `<a href="${prefix}${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="${esc(DESCRIPTION)}"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Newsreader:opsz,wght@6..72,500;6..72,600&display=swap"><link rel="stylesheet" href="${prefix}assets/style.css"></head><body>
<header class="nav"><div class="container"><a class="brand" href="${prefix}index.html"><span class="brand-mark" aria-hidden="true"></span>${esc(SITE)}</a><nav class="nav-links" aria-label="Main">${link('index.html', 'Findings', 'findings')}${link('runs.html', 'Runs', 'runs')}</nav></div></header>
<main>${body}</main>
<footer><div class="container"><span>${esc(SITE)}: a coding-agent UI benchmark, November 2026.</span><span>Run data: <a href="${prefix}data/runs.json">runs.json</a></span></div></footer>${script}</body></html>\n`
}

const picture = (base, light, dark, alt) =>
  `<picture>${dark ? `<source srcset="${base}${esc(dark)}" media="(prefers-color-scheme: dark)">` : ''}<img loading="lazy" src="${base}${esc(light)}" alt="${esc(alt)}"></picture>`

function thumbFiles(r) {
  const shots = r.quality?.screenshots ?? []
  const has = (f) => shots.some((s) => s.file === f)
  return { light: has('1280-light.png') ? '1280-light.png' : shots[0]?.file, dark: has('1280-dark.png') ? '1280-dark.png' : null }
}

/** Groups records by task, then into a grid of agents (rows) x arms (columns). */
function matrixOf(records, task) {
  const rs = records.filter((r) => r.task === task)
  const arms = [...new Set(rs.map((r) => r.arm))].sort()
  const agents = [...new Set(rs.map((r) => r.agent))].sort((a, b) => agentRank(a) - agentRank(b) || a.localeCompare(b))
  return { rs, arms, agents }
}

/** Expands <div data-shots="<task>"></div> placeholders in the writeup into a screenshot grid. */
function expandShots(html, records) {
  return html.replace(/<div data-shots="([^"]+)"(?: data-caption="([^"]*)")?><\/div>/g, (_, task, caption) => {
    const { rs, arms, agents } = matrixOf(records, task)
    if (!rs.length) return ''
    const cells = agents
      .map((g) => {
        const sample = rs.find((r) => r.agent === g)
        return `<div class="row-head">${esc(agentLabel(sample))}</div>${arms
          .map((a) => {
            const r = rs.find((x) => x.agent === g && x.arm === a)
            if (!r) return '<div></div>'
            const t = thumbFiles(r)
            return `<a class="shot" href="runs/${r.id}/index.html" aria-label="${esc(`${r.taskTitle}, ${armLabel(a)}, ${agentLabel(r)}`)}">${t.light ? picture(`runs/${r.id}/screenshots/`, t.light, t.dark, `${r.taskTitle} built by ${agentLabel(r)} with ${armLabel(a)}`) : ''}</a>`
          })
          .join('')}`
      })
      .join('')
    return `<figure><div class="shots-matrix"><div></div>${arms.map((a) => `<div class="col-head"><span class="dot ${a}"></span>${esc(armLabel(a))}</div>`).join('')}${cells}</div>${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`
  })
}

function findingsPage(records) {
  let html = expandShots(findings, records)
  const toc = []
  html = html.replace(/<h2(?: id="([^"]+)")?>([\s\S]*?)<\/h2>/g, (_, id, text) => {
    const hid = id || slug(text)
    toc.push([hid, text.replace(/<[^>]+>/g, '')])
    return `<h2 id="${hid}">${text}</h2>`
  })
  // The fragment may open with a <header class="hero">; it spans the full width above the two columns.
  const hero = html.match(/^<header class="hero">[\s\S]*?<\/header>/)?.[0] ?? ''
  const rest = html.slice(hero.length)
  const body = `<div class="container">${hero}<div class="doc"><aside class="toc"><nav aria-label="On this page"><p>On this page</p><ol>${toc.map(([id, t]) => `<li><a href="#${id}">${esc(t)}</a></li>`).join('')}</ol></nav></aside><article class="prose">${rest}</article></div></div>`
  const script = `<script>(()=>{const links=[...document.querySelectorAll('.toc a')];const heads=links.map(a=>document.getElementById(a.hash.slice(1))).filter(Boolean);
if(!('IntersectionObserver'in window)||!heads.length)return;const on=new Set();const set=()=>{const first=heads.find(h=>on.has(h));if(!first)return;links.forEach(a=>a.classList.toggle('active',a.hash==='#'+first.id))};
const io=new IntersectionObserver(es=>{es.forEach(e=>e.isIntersecting?on.add(e.target):on.delete(e.target));set()},{rootMargin:'-80px 0px -65% 0px'});heads.forEach(h=>io.observe(h))})()</script>`
  return shell(`${SITE}: findings`, body, { active: 'findings', script })
}

const fmtMin = (ms) => (ms == null ? '–' : `${Math.round(ms / 60000)} min`)
const fmtUsd = (v) => (v == null ? '–' : `$${v.toFixed(2)}`)
function scorePill(a) {
  if (!a?.itemsTotal) return '<span class="pill">not scored</span>'
  return `<span class="pill ${a.itemsPassed === a.itemsTotal ? 'good' : 'bad'}">${a.itemsPassed}/${a.itemsTotal} items</span>`
}

function runCard(r) {
  const t = thumbFiles(r)
  const axe = r.quality?.axeFailingChecks
  return `<a class="run-card" href="runs/${r.id}/index.html"><div class="thumb">${t.light ? picture(`runs/${r.id}/screenshots/`, t.light, t.dark, '') : ''}</div>
<div class="run-body"><div class="run-title"><span class="dot ${r.arm}"></span>${esc(armLabel(r.arm))}<span class="who">${esc(agentLabel(r))}${r.rep > 1 ? ` · rep ${r.rep}` : ''}</span></div>
<div class="run-stats">${r.outcome?.build?.ok ? '' : '<span class="pill bad">build failed</span>'}${scorePill(r.quality?.acceptance)}<span class="pill">${fmtMin(r.time?.wallMs)}</span><span class="pill">${fmtUsd(r.cost?.usd)}</span>${axe == null ? '' : `<span class="pill${axe === 0 ? ' good' : ''}">${axe} axe fails</span>`}</div></div></a>`
}

function runsPage(records) {
  const taskIds = [...new Set(records.map((r) => r.task))].sort()
  const sections = taskIds
    .map((task) => {
      const { rs, arms, agents } = matrixOf(records, task)
      const rows = agents
        .map((g) => {
          const sample = rs.find((r) => r.agent === g)
          return `<div class="row-head">${esc(AGENT_LABEL[g] ?? g)}<span>${esc(MODEL_LABEL[sample.model] ?? sample.model)}</span></div>${arms
            .map((a) => `<div class="cell">${rs.filter((r) => r.agent === g && r.arm === a).sort((x, y) => x.rep - y.rep).map(runCard).join('')}</div>`)
            .join('')}`
        })
        .join('')
      return `<section class="task" id="${esc(task)}"><div class="task-head"><h2>${esc(tasks[task]?.title ?? task)}</h2><span class="pill">${esc(tasks[task]?.category ?? '')}</span></div>
<p class="task-blurb">${esc(TASK_BLURB[task] ?? '')}</p><div class="matrix" style="--cols:${arms.length}"><div></div>${arms.map((a) => `<div class="col-head"><span class="dot ${a}"></span>${esc(armLabel(a))}</div>`).join('')}${rows}</div></section>`
    })
    .join('')
  const agents = new Set(records.map((r) => r.agent)).size
  const arms = new Set(records.map((r) => r.arm)).size
  const body = `<div class="container"><div class="page-head"><p class="eyebrow">Runs</p><h1>Every app the agents built</h1>
<p class="lead">${records.length} runs: ${taskIds.length} tasks × ${arms} libraries × ${agents} models, each built single-shot from the same prompt. Open one to use the app it produced.</p></div>${sections}</div>`
  return shell(`${SITE}: runs`, body, { active: 'runs' })
}

function mdInline(text) {
  return text.split(/(`[^`]+`)/).map((part, i) => (i % 2 ? `<code>${esc(part.slice(1, -1))}</code>` : esc(part).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'))).join('')
}
function mdList(items) {
  let i = 0
  const level = (indent) => {
    const first = items[i]
    const tag = first.ordered ? 'ol' : 'ul'
    let html = `<${tag}${first.ordered && first.start !== 1 ? ` start="${first.start}"` : ''}>`
    while (i < items.length && items[i].indent >= indent) {
      if (items[i].indent > indent) html = html.replace(/<\/li>$/, '') + level(items[i].indent) + '</li>'
      else html += `<li>${mdInline(items[i++].text)}</li>`
    }
    return html + `</${tag}>`
  }
  return level(items[0].indent)
}
function markdown(src) {
  const lines = src.replace(/\r/g, '').split('\n')
  const out = []
  let para = []
  const flush = () => { if (para.length) out.push(`<p>${mdInline(para.join(' '))}</p>`); para = [] }
  const listRe = /^(\s*)([-*]|(\d+)\.)\s+(.*)$/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m
    if (!line.trim()) { flush(); continue }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flush(); const h = Math.min(m[1].length + 2, 6); out.push(`<h${h}>${mdInline(m[2])}</h${h}>`); continue }
    if (line.trimStart().startsWith('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      flush()
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const head = cells(line)
      const rows = []
      for (i += 2; i < lines.length && lines[i].trimStart().startsWith('|'); i++) rows.push(cells(lines[i]))
      i--
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
      continue
    }
    if (listRe.test(line)) {
      flush()
      const items = []
      for (; i < lines.length && lines[i].trim(); i++) {
        const lm = lines[i].match(listRe)
        if (lm) items.push({ indent: lm[1].length, ordered: !!lm[3], start: lm[3] ? Number(lm[3]) : 1, text: lm[4] })
        else items[items.length - 1].text += ' ' + lines[i].trim()
      }
      i--
      out.push(mdList(items))
      continue
    }
    para.push(line.trim())
  }
  flush()
  return out.join('\n')
}

function runPage(r, screenshots, prompt) {
  const a = r.quality?.acceptance
  const n = (v) => (v == null ? '–' : Math.round(v).toLocaleString('en-US'))
  const min = (ms) => (ms == null ? '–' : `${(ms / 60000).toFixed(1)} min`)
  const dl = (rows) => `<dl>${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`
  const yes = (ok) => (ok ? '<span class="pill good">yes</span>' : '<span class="pill bad">no</span>')
  const deps = r.outcome?.dependencies?.added?.map((d) => `${esc(d.name)}@${esc(d.version)}`).join(', ') || 'none'
  const axe = r.quality?.axeFailingChecks
  const libs = r.libraryVersions ? Object.entries(r.libraryVersions).map(([k, v]) => `${esc(k)} ${esc(v ?? '?')}`).join(', ') : '–'
  const items = a?.items ? Object.entries(a.items).map(([k, ok]) => `<span class="pill ${ok ? 'good' : 'bad'}">${esc(k)}</span>`).join('') : '<span class="muted">not run</span>'
  const seg = (name, opts) => `<div class="seg" role="radiogroup" aria-label="${name}">${opts.map(([v, label], i) => `<input type="radio" name="${name}" id="${name}-${v}" value="${v}"${i === 0 ? ' checked' : ''}><label for="${name}-${v}">${label}</label>`).join('')}</div>`
  const viewer = r.hasApp
    ? `<section class="viewer" aria-label="The built app"><div class="viewer-bar"><div class="viewer-controls">${seg('Width', [['1280', 'Desktop'], ['768', 'Tablet'], ['375', 'Phone']])}${seg('Theme', [['light', 'Light'], ['dark', 'Dark']])}</div><a class="open-link" href="app/index.html" target="_blank" rel="noopener">Open full screen ↗</a></div>
<div class="stage"><div class="stage-inner" id="stage"><iframe id="app" title="${esc(r.taskTitle)} app" src="app/index.html"></iframe></div></div></section>`
    : '<div class="callout"><p>This run produced no working build, so there is no app to show.</p></div>'
  const shots = screenshots.length
    ? `<h2 class="section-title">Screenshots</h2><p class="muted small">Taken by the evaluator at three widths in light and dark mode.</p><div class="gallery-shots">${screenshots.map((s) => `<figure><img loading="lazy" src="screenshots/${esc(s.file)}" alt="${s.width}px wide, ${s.scheme} mode"><figcaption class="muted">${s.width}px · ${s.scheme}</figcaption></figure>`).join('')}</div>`
    : ''
  const promptSection = prompt
    ? `<h2 class="section-title">Prompt</h2><p class="muted small">The complete prompt the agent received, verbatim (${prompt.trim().split(/\s+/).length.toLocaleString('en-US')} words). Both models got exactly the same text for this task; the shadcn/ui and UI SDK versions differ only in the Stack paragraph. <a href="prompt.md">Raw markdown</a></p>
<details class="prompt"><summary>Show the full prompt</summary><div class="md">${markdown(prompt)}</div></details>`
    : ''
  const body = `<div class="container"><div class="page-head"><div class="crumbs"><a href="../../runs.html">Runs</a> / <a href="../../runs.html#${esc(r.task)}">${esc(r.taskTitle)}</a></div>
<h1>${esc(r.taskTitle)}</h1><div class="chips"><span class="pill"><span class="dot ${r.arm}"></span>${esc(armLabel(r.arm))}</span><span class="pill">${esc(agentLabel(r))}</span>${r.effort ? `<span class="pill">effort ${esc(r.effort)}</span>` : ''}${r.rep > 1 ? `<span class="pill">rep ${r.rep}</span>` : ''}</div></div>
<div class="stats"><div class="stat"><span class="stat-value">${a?.itemsTotal ? `${a.itemsPassed}/${a.itemsTotal}` : '–'}</span><span class="stat-label">acceptance items passed</span></div>
<div class="stat"><span class="stat-value">${fmtMin(r.time?.wallMs)}</span><span class="stat-label">agent wall-clock time</span></div>
<div class="stat"><span class="stat-value">${fmtUsd(r.cost?.usd)}</span><span class="stat-label">cost at API prices</span></div>
<div class="stat"><span class="stat-value">${axe ?? '–'}</span><span class="stat-label">failing axe checks</span></div></div>
${viewer}
<div class="cards"><div class="card"><h3>Quality</h3>${dl([
    ['Build', yes(r.outcome?.build?.ok)],
    ['Typecheck', yes(r.outcome?.typecheck?.ok)],
    ['Keyboard-only flow', r.quality?.keyboard ? yes(r.quality.keyboard.ok) : '–'],
    ['Axe rules violated', n(r.quality?.axe?.violations)],
    ['Console errors at load', n(r.outcome?.load ? r.outcome.load.consoleErrors + r.outcome.load.pageErrors : null)],
  ])}<div class="items">${items}</div></div>
<div class="card"><h3>Time and process</h3>${dl([
    ['Wall clock', min(r.time?.wallMs)],
    ['Model time', min(r.time?.modelMs)],
    ['Tool time', min(r.time?.toolMs)],
    ['Turns', n(r.process?.turns)],
    ['Tool calls', n(r.process?.toolCalls)],
    ['Builds (failed)', `${n(r.process?.builds?.runs)} (${n(r.process?.builds?.failures)})`],
    ['Vendor skill used', r.skills?.benchmarkSkillUsed ? 'yes' : 'no'],
  ])}</div>
<div class="card"><h3>Tokens and cost</h3>${dl([
    ['Cost', r.cost?.usd == null ? '–' : `$${r.cost.usd.toFixed(3)}`],
    ['Input (uncached)', n(r.tokens?.input)],
    ['Cache read', n(r.tokens?.cacheRead)],
    ['Cache write', n(r.tokens?.cacheWrite)],
    ['Output', n(r.tokens?.output)],
  ])}<p class="muted small" style="margin:12px 0 0">${esc(r.cost?.source ?? '')}</p></div>
<div class="card"><h3>Output</h3>${dl([
    ['Code lines added', n(r.outcome?.diff?.codeLinesAdded)],
    ['Bundle (gzip)', r.outcome?.bundle ? `${(r.outcome.bundle.gzipBytes / 1024).toFixed(1)} KB` : '–'],
    ['Dependencies added', esc(deps)],
  ])}<p class="muted small" style="margin:12px 0 0">${esc(r.model)}, CLI ${esc(r.cliVersion)}; ${libs}.</p></div></div>
${promptSection}
${shots}</div>`
  const script = r.hasApp
    ? `<script>(()=>{const f=document.getElementById('app'),st=document.getElementById('stage'),H=820;let w=1280;
function fit(){const avail=st.parentElement.clientWidth-parseFloat(getComputedStyle(st.parentElement).paddingLeft)*2;const s=Math.min(1,avail/w);f.style.width=w+'px';f.style.height=H+'px';f.style.transform='scale('+s+')';st.style.width=(w*s)+'px';st.style.height=(H*s)+'px'}
document.querySelectorAll('input[name=Width]').forEach(i=>i.addEventListener('change',()=>{w=+i.value;fit()}));
document.querySelectorAll('input[name=Theme]').forEach(i=>i.addEventListener('change',()=>{f.src='app/index.html?theme='+i.value}));
if(innerWidth<700){const p=document.getElementById('Width-375');p.checked=true;w=375}addEventListener('resize',fit);fit()})()</script>`
    : ''
  return shell(`${r.taskTitle} · ${armLabel(r.arm)} · ${agentLabel(r)}`, body, { prefix: '../../', script })
}

function main() {
  if (!fs.existsSync(runsDir)) throw new Error(`No runs directory at ${runsDir}`)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(outDir, 'data'), { recursive: true })
  const records = []
  const pages = []
  for (const d of fs.readdirSync(runsDir).sort()) {
    const runDir = path.join(runsDir, d)
    const m = readJson(path.join(runDir, 'metrics.json'), null)
    if (!m || (!includeSmoke && m.category === 'smoke')) continue
    const oid = opaque(m.runId)
    const dest = path.join(outDir, 'runs', oid)
    const hasApp = fs.existsSync(path.join(runDir, 'dist', 'index.html'))
    fs.mkdirSync(dest, { recursive: true })
    if (hasApp) fs.cpSync(path.join(runDir, 'dist'), path.join(dest, 'app'), { recursive: true })
    const shots = (m.quality?.screenshots ?? []).filter((s) => fs.existsSync(path.join(runDir, 'screenshots', s.file)))
    if (shots.length) {
      fs.mkdirSync(path.join(dest, 'screenshots'), { recursive: true })
      for (const s of shots) fs.copyFileSync(path.join(runDir, 'screenshots', s.file), path.join(dest, 'screenshots', s.file))
    }
    const rec = publicRecord(m, oid, hasApp, axeNodes(runDir))
    rec.quality = rec.quality && { ...rec.quality, screenshots: shots }
    const promptFile = path.join(runDir, 'prompt.md')
    const prompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : null
    if (prompt) fs.writeFileSync(path.join(dest, 'prompt.md'), prompt)
    pages.push([dest, rec, shots, prompt])
    records.push(rec)
  }
  for (const [dest, rec, shots, prompt] of pages) fs.writeFileSync(path.join(dest, 'index.html'), runPage(rec, shots, prompt))
  records.sort((a, b) => a.task.localeCompare(b.task) || agentRank(a.agent) - agentRank(b.agent) || a.arm.localeCompare(b.arm) || a.rep - b.rep)
  writeJson(path.join(outDir, 'data/runs.json'), records)
  fs.writeFileSync(path.join(outDir, 'assets/style.css'), CSS)
  fs.writeFileSync(path.join(outDir, 'runs.html'), runsPage(records))
  fs.writeFileSync(path.join(outDir, 'index.html'), findings ? findingsPage(records) : runsPage(records))
  console.log(`Site with ${records.length} run(s) written to ${path.relative(ROOT, outDir)}/ (open index.html, or serve the folder from any static host)`)
}

main()
