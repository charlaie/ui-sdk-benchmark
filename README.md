# UI SDK vs shadcn: coding-agent UI benchmark

A harness for measuring whether coding agents build better or cheaper UI with
[ui-sdk](https://ui-sdk.dev/docs) (`@ui-sdk/react` + `@ui-sdk/core`) than with shadcn/ui, both
on Tailwind v4. A coding agent (Claude Code or Codex) builds the same task in each stack, headless
and single-shot. The harness records cost, time, process and output quality, runs hidden
acceptance tests, and publishes the built apps and a writeup as a static site.

## Status

Two pilots have been run, one repetition per cell: Codex (`gpt-6.1-sol`, high effort) and Claude Code
(Opus 5.5, high effort), each building the four tasks in both stacks. The writeup is in
[`docs/pilot-findings.html`](docs/pilot-findings.html) and is the home page of the
gallery. In short, the component library barely changed the outcome, the model set the visual style,
and UI SDK runs had fewer accessibility failures with both models.

The built gallery (`gallery/`: the writeup, the playable apps, screenshots and metrics) is committed
so it can be deployed from the repo. The raw run outputs (`runs/`) are not: they are large and the
Codex logs contain account ids. See [Publishing the gallery](#publishing-the-gallery).

## Layout

```
config/benchmark.config.json   main config (models, effort, budget, timeout, prices, isolation)
config/smoke.config.json       cheap config for harness smoke tests (tasks/00-smoke only)
templates/_shared/             files identical in both arms (vite config, tsconfig, main.tsx, mock runtime)
templates/_instructions/       single source for AGENTS.md and CLAUDE.md (common + one section per arm)
templates/shadcn/              arm 1: shadcn/ui initialised (base-nova preset), shadcn skill
templates/ui-sdk/              arm 2: @ui-sdk/react + @ui-sdk/core 0.1.0-beta.5, ui-sdk skill
tasks/<id>/spec.md             agent-facing task spec with numbered acceptance criteria
tasks/<id>/mock/               the task's typed mock API + fixtures, copied into src/mock/ of a run
prompts/                       prompt pieces: header, rules, and the one per-arm "Stack" section
acceptance/                    HIDDEN Playwright suites (never copied into a run workspace)
runner/run.mjs                 matrix runner (one cell, a subset, or everything; resumable)
runner/evaluate.mjs            build/typecheck/bundle/diff/screenshots/acceptance for one run
scripts/rescore.mjs            re-runs only the acceptance suite against finished runs' saved builds
scripts/run-resume.mjs         runs a batch to completion, waiting out usage limits (start it detached)
runner/agents/{claude,codex}.mjs  CLI command lines and event-log parsers
docker/Dockerfile              image the agents run in
scripts/                       template sync/verify, acceptance-vs-template check, summary, gallery
```

Tasks:

| id | task | category |
|---|---|---|
| 01-booking | Meeting booking dialog | composition |
| 02-inbox | Issue triage inbox | composition |
| 03-spreadsheet | Spreadsheet grid (10,000 × 26) | new-behavior |
| 04-flow-canvas | Agent flow canvas | new-behavior |
| 00-smoke | Harness smoke test (not part of the benchmark) | smoke |

## Setup

Requirements: Node 26, npm, Docker (rootless works), and the `claude` and `codex` CLIs logged in on
this machine.

```sh
npm install                                    # harness deps (Playwright, axe)
npx playwright install chromium
(cd templates/shadcn && npm ci) && (cd templates/ui-sdk && npm ci)
docker build -t ui-sdk-bench-agent:local docker
npm run templates:check                        # arms in sync; each template + each task mock typechecks and builds
```

The CLIs are not installed in the image. The runner bind-mounts the host's binaries read-only (the
paths are in the config), so every run uses exactly the CLI versions recorded in the config.

## Configure before a real run

Edit `config/benchmark.config.json`. The runner refuses to start while any of these is `null`:

- `agents.claude.effort`: passed as `--effort`.
- `agents.codex.model`: for example `gpt-6.1-sol` or `gpt-6.1-terra`.
- `agents.codex.effort`: passed as `-c model_reasoning_effort=…`.
- `limits.budgetUsd`: the per-run cost cap, or `null` for no cap (on subscription auth the cost is only
  notional; it is still computed and recorded).
- `limits.timeoutMinutes`: the per-run wall-clock cap.

Also review:

- `repetitions` (1 for the pilots; the runner defaults to 3 if unset).
- `pricing`: Codex cost is computed from tokens with these prices. They were copied from the
  official OpenAI pricing page on 2026-11-15 (standard tier, with long-context rates above 272K input
  tokens per request); re-check them before a real run. Claude cost comes from Claude Code's own
  `total_cost_usd`.
- `isolation`: `docker` (default) or `host`.
- `auth.mode`: `copy-credentials` (default) or `env` (see Isolation).

## Running

```sh
# Plan only: list the cells and prompt sizes, run nothing
node runner/run.mjs --all --dry-run

# One cell
node runner/run.mjs --task 01-booking --arm ui-sdk --agent claude --rep 1

# A subset (comma-separated lists; omitted dimensions mean "all")
node runner/run.mjs --task 03-spreadsheet,04-flow-canvas --agent codex --reps 2

# The whole matrix: tasks × arms × agents × repetitions
node runner/run.mjs --all
```

- **Order**: `--order interleave` (default) shuffles each repetition with a seeded RNG and alternates
  arm and agent between consecutive runs, so time-of-day and rate-limit effects spread evenly.
  `--order sequential` runs the cells in nested-loop order.
- **Resume**: a run counts as finished once `runs/<id>/status.json` says `done`. Rerunning the same
  command skips finished runs and redoes interrupted or failed ones. `--force` reruns finished runs
  too. Ctrl+C stops after the current run; press it twice to abort immediately.
- **Usage limits**: if the agent stops on an account usage or rate limit (subscription caps, HTTP 429),
  the run is marked `failed` with `reason: "usage-limit"`, not evaluated, and the batch stops. Rerun
  the same command after the limit resets to pick up from that run.
  To do that unattended: `setsid nohup node scripts/run-resume.mjs -- --agent claude >> runs/batch.log 2>&1 &`
  retries every 20 minutes until every selected run is done. It dies with its host, so restart it after a reboot.
- The runner asks for confirmation and shows the maximum spend (`runs × budget`). Pass `--yes` to skip that.
- `--no-eval` skips evaluation. `--keep-workspace` keeps the agent's workspace (with node_modules)
  so `node runner/evaluate.mjs runs/<id>` can re-evaluate it later.
- After changing the acceptance tests, `node scripts/rescore.mjs [run-id ...]` re-scores finished runs
  against their saved `dist/` (no workspace needed). Only acceptance, axe and keyboard results are
  replaced; the previous score is kept under `rescores` in `eval.json`.
- Use `--config config/smoke.config.json` for a cheap harness check (the `00-smoke` task, low effort,
  $0.50 cap, written to `runs-smoke/`).

### What one run does

1. Copies `templates/<arm>` (with its pre-installed node_modules) to a workspace outside the repo
   (`<tmpdir>/ui-sdk-bench-work/<id>/workspace`), and copies the task's mock API into `src/mock/`.
2. Builds the prompt: `prompts/header.md` + `prompts/stack-<arm>.md` + `prompts/rules.md` +
   `tasks/<id>/spec.md`. Only the stack section differs between arms.
3. Starts the agent in Docker, with only the workspace (`/work`) and a fresh isolated home mounted,
   and feeds the prompt on stdin. Enforces the wall-clock timeout, and the budget cap (see Isolation).
4. Evaluates the result (below) and writes `metrics.json`.

Each run directory `runs/<task>__<arm>__<agent>__r<rep>/` holds:

| file | contents |
|---|---|
| `prompt.md` | the exact prompt sent |
| `meta.json` | cell, model, effort, isolation, installed library versions, the command line |
| `events.jsonl` | raw event log from the CLI (stream-json / exec --json), unmodified |
| `event-times.jsonl` | receive time in ms for each line of `events.jsonl` |
| `codex-rollout.jsonl` | Codex only: its session rollout (per-request token records). Contains account ids; never published |
| `stderr.log` | CLI stderr |
| `agent-metrics.json` | parsed agent metrics |
| `eval.json`, `eval/` | evaluation results, build/typecheck logs, diff, acceptance report, axe results |
| `output-src/` | the agent's project source (without node_modules) |
| `dist/` | static build of the agent's app |
| `screenshots/` | 375 / 768 / 1280 px × light / dark |
| `metrics.json` | the flat record used by the summary and the gallery |

## Metrics

| group | metric | how |
|---|---|---|
| tokens | input (uncached), cache read, cache write, output, reasoning | Claude: `result.usage`. Codex: sum of per-request `token_usage_record`s in the rollout (`input_tokens` includes cached; output includes reasoning) |
| cost | USD | Claude: `total_cost_usd` from the CLI. Codex: per request, priced with `config.pricing` (long-context rates when that request's input > 272K) |
| time | wall clock; model vs tool | Claude: `duration_api_ms` is model time. Codex has no API timing, so model time = wall − tool time. Tool time = union of tool-call intervals from receive timestamps |
| process | turns, assistant messages, tool calls by kind, failed tool calls, subagents | from the event log |
| process | docs reading | calls that read the vendor docs or skills (`node_modules/@ui-sdk/*/docs`, `skills/`, `llms.txt`, `shadcn docs/view/search/info`, doc sites, web fetch/search, Skill tool), their output size and time; library-source reads (`@ui-sdk/*/dist`, `@base-ui`) counted separately |
| process | builds during the run | shell commands running `tsc` / `vite build` / `npm run build|typecheck|lint`, and how many failed |
| process | installs, test runs, vendor skill used | from shell commands / Skill tool / reads of the skill's `SKILL.md` |
| outcome | typecheck, build | `npx tsc -b` and `npx vite build` in the workspace (inside the agent image) |
| outcome | console errors at load | Playwright load of the built app at 1280 px, light mode, 2.5 s |
| outcome | lines written | `git diff --no-index --numstat` against a freshly prepared baseline, excluding node_modules, dist and lockfiles; `codeLinesAdded` counts .ts/.tsx/.js/.css only |
| outcome | dependencies added | package.json diff against the template |
| outcome | bundle size | gzip -9 of the built js/css/html/svg/json |
| quality | acceptance items passed | hidden Playwright suite; an item passes when all its tests pass |
| quality | axe violations | axe-core (WCAG 2.0/2.1/2.2 A and AA tags) on several UI states, light and dark; the axe test fails on serious or critical violations, and every violation is recorded |
| quality | keyboard-only pass | one test per task that completes the core flow using only the keyboard |
| quality | screenshots | 3 widths × light/dark |

## Acceptance tests

`acceptance/<task>/` holds the hidden Playwright suite for each task. Test titles start with the
acceptance item they check (`A3: …`), or with `axe:` or `kbd:`. Tests use only roles, accessible
names, the accessibility contract stated in the task spec, and the mock API call log
(`window.__mock.calls`). They never rely on library markup. The mock API can be forced into slow and
failure paths with URL parameters (`mock-latency`, `mock-fail`, `mock-fail-once`; see
`templates/_shared/src/mock/runtime.ts`).

```sh
# Check that every suite loads and fails cleanly against the untouched templates
npm run test:acceptance                      # = node scripts/test-template.mjs [--task …] [--arm …]

# Unit-check the shared test helpers on hand-written pages
npm run test:helpers

# Run one suite against any built app served from a subpath
node scripts/serve.mjs runs/<id>/dist 4173 &
BASE_URL=http://127.0.0.1:4173/app/ npx playwright test --config acceptance/playwright.config.ts acceptance/01-booking
```

Each task's `task.json` also lists banned dependencies (ready-made versions of the widget, such as
data grids or flow-canvas libraries). Evaluation records any that the agent added in
`outcome.dependencies.banned`, but it does not fail the run for them.

**Validation.** No reference implementation exists. The suites were instead checked against the 16
pilot outputs: every failing test was investigated, and tests that rejected behaviour the spec allows
(mostly timing races) were fixed for both arms. Each suite still fails cleanly against the untouched
templates. The fixes were made while looking at those outputs, so fresh runs are cleaner evidence. Poll
for focus and state after key presses rather than reading them once.

## Summary

```sh
node scripts/summary.mjs                     # reads runs/, writes runs/summary.md and runs/summary.json
```

The summary groups results by arm, by arm and agent, and by task, arm and agent. Composition tasks
(01, 02) and new-behavior tasks (03, 04) are reported in separate sections. Medians are given for
cost and time, and means for the rest.

## Gallery

```sh
node scripts/build-gallery.mjs               # reads runs/, writes gallery/
node scripts/build-gallery.mjs --config config/smoke.config.json --include-smoke --out gallery-smoke
```

The output is a static site with only relative links, so it works on any static host or opened from
disk:

- `index.html`: the writeup, built from the HTML fragment `docs/pilot-findings.html`, with a table of
  contents generated from its `<h2>` headings. In the fragment, `<div data-shots="<task id>"></div>`
  expands into that task's screenshot grid (models × libraries). Edit the fragment and rebuild.
- `runs.html`: every run as a card with a screenshot and headline metrics, grouped by task in a
  model × library grid.
- `runs/<id>/index.html`: the run's app in a viewer with width and theme switches, plus metrics, the
  acceptance items, the full prompt the agent received and screenshots. The app itself is at
  `runs/<id>/app/` and the raw prompt at `runs/<id>/prompt.md`.
- `data/runs.json`: the public metrics for every run.

Raw event logs, Codex rollouts, agent source and local paths are never copied into the gallery; it
holds only the built apps, screenshots, metrics and prompts (which are assembled from files already in
the repo).

### Publishing the gallery

The gallery is a plain static folder, committed to the repo. To host it on Cloudflare Pages, connect
the GitHub repo with **no build command** and **`gallery`** as the build output directory. Pages then
serves the committed files as they are. It can't rebuild them, because `runs/` isn't in the repo, so
after new runs rebuild locally and commit:

```sh
node scripts/build-gallery.mjs     # rebuild gallery/ from runs/, then commit it
```

Direct upload also works: `npx wrangler pages deploy gallery --project-name <project-name>`.
Run directories use stable ids (a hash of the run id), so a rebuild only changes what changed.

All links are relative, so it also works under a subpath or opened from disk.

## Isolation

- **Docker (default)**: the agent runs in `ui-sdk-bench-agent:local` (Node 26.13.1, git, ripgrep,
  curl, python3) as container root, which rootless Docker maps to your user. Only the workspace and a
  per-run home are mounted, so the agent cannot see `acceptance/` or anything else on the host.
  The network is open, because the shadcn CLI needs it. Codex runs with
  `--dangerously-bypass-approvals-and-sandbox` (its own sandbox would block the network) and Claude Code
  with `--dangerously-skip-permissions` plus `IS_SANDBOX=1`. The container is the sandbox.
- **Host mode** (`"isolation": "host"`): same isolated home and env, but the agent can read the rest of
  the filesystem, including the hidden tests. Codex then uses `-s workspace-write` with network access
  enabled. Use this only if Docker is unavailable.
- **Claude Code**: `CLAUDE_CONFIG_DIR` is a fresh per-run directory, `--setting-sources project` (the
  workspace's CLAUDE.md and `.claude/skills` only), `--strict-mcp-config` with no servers (also keeps
  account-level claude.ai connectors out), `--no-session-persistence`, and `--max-budget-usd` when a cap is set. Verified in
  the smoke runs: the init event lists no MCP servers, and the project skill is offered.
- **Codex**: `CODEX_HOME` is a fresh per-run directory, `--ignore-user-config`, and
  `--disable apps, plugins, remote_plugin, plugin_sharing, browser_use, browser_use_external, computer_use,
  in_app_browser, memories`. Without these flags the account's ChatGPT apps and remote plugins
  (including Gmail) were loaded. Codex has no budget flag, so the runner reads the per-request token
  records from the live rollout every 5 s and kills the run once the computed cost exceeds the cap.
  Overshoot is therefore at most one request plus 5 s.
- **Credentials**: with `copy-credentials`, `~/.claude/.credentials.json` and `~/.codex/auth.json` are
  copied into the run's home. If a token is refreshed during the run and your original file is
  unchanged, the refreshed file is copied back, so token rotation can't log you out. With `env`, set
  `auth.passEnv` (for example `["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]`) instead.
- **Skills**: both arms install their vendor skill the documented way (`npx skills add …`), which writes
  `.agents/skills/<name>` (read by Codex) and a `.claude/skills/<name>` symlink (read by Claude Code).
  The CLIs' own built-in skills (Claude Code's bundled skills, Codex's `.system` skills) are present in
  both arms and can't be removed without also disabling project skills.

## Templates

Both templates are Vite 8 + React 19.3 + TypeScript 7 + Tailwind 4.3, with exact versions and
`base: './'`. Everything except the component library and its agent setup is identical (enforced by
`npm run templates:check`):

- **shadcn**: `shadcn init -b base --preset nova` (components.json, `src/lib/utils.ts`, theme tokens
  with light and dark in `index.css`, lucide) plus the `shadcn` skill from
  `npx skills add shadcn/ui --skill shadcn`. The Geist font that `init` adds was removed, so both arms
  use Tailwind's default system font stack: the font comes from the preset, not the component library,
  and would make the arms look different for reasons unrelated to the library. The instruction file points at the skill, the shadcn CLI and
  `https://ui.shadcn.com/llms.txt`. The shadcn MCP server (also documented) is not set up, to match the
  UI SDK arm, which has no MCP server.
- **ui-sdk**: `@ui-sdk/react` and `@ui-sdk/core` pinned to 0.1.0-beta.5 (latest on 2026-11-15; keep one version for a whole matrix), the `ui-sdk` skill from
  `npx skills add vercel-labs/ui --skill ui-sdk` (identical to the copy shipped in
  `@ui-sdk/core/skills/`), and the AGENTS.md note from the vendor's Quick Start. `index.css` declares
  `@layer ui-sdk;` and imports the optional default look `@ui-sdk/core/web.css` into
  `layer(components)`, as the installation guide shows for Tailwind. Delete that one line for a fully
  unstyled arm.

To change shared files, edit `templates/_shared` or `templates/_instructions` and run
`npm run templates:sync`.

## License

MIT, see [LICENSE](LICENSE). The vendor skills copied into the templates (`templates/shadcn/.agents/skills/shadcn`
from shadcn/ui, `templates/ui-sdk/.agents/skills/ui-sdk` from vercel-labs/ui) and the third-party
code bundled into the built apps in `gallery/` remain under their own licenses.
