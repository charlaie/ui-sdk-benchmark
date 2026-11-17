// Mock API for the issue triage task. Simulated latency; failures can be forced with URL
// parameters (see ./runtime.ts), e.g. `?mock-fail=updateIssues` or `?mock-latency=listIssues:3000`.
import { mockCall } from './runtime'
import { INITIAL_COMMENTS, INITIAL_ISSUES, PEOPLE, CURRENT_USER_ID, type Issue, type IssueComment, type IssuePatch, type Person } from './fixtures'

export * from './fixtures'
export { MockApiError } from './runtime'

let issues: Issue[] = structuredClone(INITIAL_ISSUES)
let comments: IssueComment[] = structuredClone(INITIAL_COMMENTS)
let clock = Date.parse('2026-12-07T09:00:00.000Z')
const tick = () => new Date((clock += 60_000)).toISOString()

/** All 200 issues (filter, sort and paginate on the client). Default latency 600 ms. */
export function listIssues(): Promise<Issue[]> {
  return mockCall('listIssues', [], 600, () => issues)
}

/** One issue with its comments, oldest first. Default latency 300 ms. */
export function getIssue(id: string): Promise<{ issue: Issue; comments: IssueComment[] }> {
  return mockCall('getIssue', [id], 300, () => {
    const issue = issues.find((i) => i.id === id)
    if (!issue) throw new Error(`No issue ${id}`)
    return { issue, comments: comments.filter((c) => c.issueId === id) }
  })
}

/** Apply the same patch to one or more issues; returns the updated issues. Default latency 500 ms. */
export function updateIssues(ids: string[], patch: IssuePatch): Promise<Issue[]> {
  return mockCall('updateIssues', [ids, patch], 500, () => {
    const now = tick()
    issues = issues.map((i) => (ids.includes(i.id) ? { ...i, ...patch, updatedAt: now } : i))
    return issues.filter((i) => ids.includes(i.id))
  })
}

/** Add a comment as the current user. Default latency 400 ms. */
export function addComment(issueId: string, body: string): Promise<IssueComment> {
  return mockCall('addComment', [issueId, body], 400, () => {
    const comment: IssueComment = { id: `c-${Date.now()}-${comments.length}`, issueId, authorId: CURRENT_USER_ID, body, createdAt: tick() }
    comments = [...comments, comment]
    issues = issues.map((i) => (i.id === issueId ? { ...i, commentCount: i.commentCount + 1 } : i))
    return comment
  })
}

/** People who can be assigned. Default latency 200 ms. */
export function listPeople(): Promise<Person[]> {
  return mockCall('listPeople', [], 200, () => PEOPLE)
}
