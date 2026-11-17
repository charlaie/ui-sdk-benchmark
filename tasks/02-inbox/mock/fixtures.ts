// Fixture data for the issue triage task. Self-contained (no imports) so it can be shared.

export type IssueStatus = 'Open' | 'In progress' | 'Blocked' | 'Done'
export type IssuePriority = 'Urgent' | 'High' | 'Medium' | 'Low'

export const STATUSES: IssueStatus[] = ['Open', 'In progress', 'Blocked', 'Done']
export const PRIORITIES: IssuePriority[] = ['Urgent', 'High', 'Medium', 'Low']
/** Lower rank = more important. Used when sorting by priority. */
export const PRIORITY_RANK: Record<IssuePriority, number> = { Urgent: 0, High: 1, Medium: 2, Low: 3 }

export interface Person {
  id: string
  name: string
}

export interface Issue {
  /** e.g. "ISS-1001" */
  id: string
  title: string
  description: string
  status: IssueStatus
  priority: IssuePriority
  assigneeId: string | null
  labels: string[]
  createdAt: string
  updatedAt: string
  commentCount: number
}

export interface IssueComment {
  id: string
  issueId: string
  authorId: string
  body: string
  createdAt: string
}

export type IssuePatch = Partial<Pick<Issue, 'status' | 'priority' | 'assigneeId'>>

export const PEOPLE: Person[] = [
  { id: 'u1', name: 'Ana Ruiz' },
  { id: 'u2', name: 'Ben Okafor' },
  { id: 'u3', name: 'Chloe Martin' },
  { id: 'u4', name: 'Dmitri Ivanov' },
  { id: 'u5', name: 'Elena Rossi' },
  { id: 'u6', name: 'Farid Haddad' },
]

/** The signed-in user. */
export const CURRENT_USER_ID = 'u1'

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const AREAS = ['Checkout', 'Search', 'Login', 'Dashboard', 'Billing', 'Notifications', 'Settings', 'Onboarding', 'Export', 'Profile']
const PROBLEMS = [
  'button does nothing on Safari',
  'shows stale data after refresh',
  'times out for large accounts',
  'layout breaks at narrow widths',
  'loses focus after saving',
  'sends duplicate emails',
  'ignores the time zone setting',
  'crashes when the list is empty',
  'is slow on first load',
  'has unreadable contrast in dark mode',
  'drops unsaved changes on navigation',
  'shows the wrong currency',
  'fails silently when offline',
  'misses keyboard focus styles',
  'returns results in the wrong order',
  'double-counts archived items',
  'logs users out unexpectedly',
  'renders an empty tooltip',
  'rejects valid input',
  'uploads stall at 99%',
]
const LABELS = ['bug', 'regression', 'accessibility', 'performance', 'design', 'backend', 'mobile']

function buildIssues(): Issue[] {
  const r = rng(20261207)
  const base = Date.parse('2026-12-07T09:00:00.000Z')
  const issues: Issue[] = []
  for (let i = 0; i < 200; i++) {
    const area = AREAS[i % AREAS.length]
    const problem = PROBLEMS[Math.floor(i / AREAS.length) % PROBLEMS.length]
    // 50 Done (every 4th), the rest spread over Open / In progress / Blocked.
    const status: IssueStatus = i % 4 === 3 ? 'Done' : (['Open', 'In progress', 'Blocked'] as const)[i % 3]
    const priority = PRIORITIES[Math.floor(r() * 4)]
    const assigneeRoll = Math.floor(r() * (PEOPLE.length + 2))
    const assigneeId = assigneeRoll < PEOPLE.length ? PEOPLE[assigneeRoll].id : null
    const labels = LABELS.filter(() => r() < 0.22).slice(0, 3)
    const createdAt = new Date(base - (200 - i) * 6 * 3600_000 - Math.floor(r() * 3600_000)).toISOString()
    // Distinct update times, not in id order, so sorting is observable.
    const updatedAt = new Date(base - ((i * 7919) % 200) * 47 * 60_000).toISOString()
    issues.push({
      id: `ISS-${1001 + i}`,
      title: `${area} ${problem}`,
      description: `Steps to reproduce:\n1. Open ${area}.\n2. Observe that it ${problem}.\n\nExpected: it works.`,
      status,
      priority,
      assigneeId,
      labels,
      createdAt,
      updatedAt,
      commentCount: 0,
    })
  }
  return issues
}

export const INITIAL_ISSUES: Issue[] = buildIssues()

export const INITIAL_COMMENTS: IssueComment[] = INITIAL_ISSUES.slice(0, 40).flatMap((issue, i) =>
  Array.from({ length: (i % 3) + 1 }, (_, k) => ({
    id: `c-${issue.id}-${k}`,
    issueId: issue.id,
    authorId: PEOPLE[(i + k) % PEOPLE.length].id,
    body: k === 0 ? 'I can reproduce this.' : k === 1 ? 'Looking into it.' : 'Fix is in review.',
    createdAt: new Date(Date.parse(issue.createdAt) + (k + 1) * 3600_000).toISOString(),
  })),
)
for (const c of INITIAL_COMMENTS) {
  const issue = INITIAL_ISSUES.find((x) => x.id === c.issueId)
  if (issue) issue.commentCount++
}
