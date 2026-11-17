// Mock API for the meeting booking task. Simulated latency; failures can be forced with URL
// parameters (see ./runtime.ts), e.g. `?mock-fail=searchPeople` or `?mock-latency=searchPeople:3000`.
import { mockCall } from './runtime'
import {
  INITIAL_MEETINGS,
  PEOPLE,
  TODAY,
  UNAVAILABLE_DATES,
  matchPeople,
  type Meeting,
  type MeetingInput,
  type Person,
} from './fixtures'

export * from './fixtures'
export { MockApiError } from './runtime'

let meetings: Meeting[] = structuredClone(INITIAL_MEETINGS)
let nextId = 100

/** The app's current date (YYYY-MM-DD). Do not use the real clock. */
export function getToday(): string {
  return TODAY
}

/** Search people by name or email. Default latency 800 ms. Pass a signal to cancel stale searches. */
export function searchPeople(query: string, options: { signal?: AbortSignal } = {}): Promise<Person[]> {
  return mockCall('searchPeople', [query], 800, () => matchPeople(query), options.signal)
}

/** Look up people by id (for rendering chips). Default latency 150 ms. */
export function getPeople(ids: string[]): Promise<Person[]> {
  return mockCall('getPeople', [ids], 150, () => PEOPLE.filter((p) => ids.includes(p.id)))
}

/** Fully booked dates (YYYY-MM-DD). Weekends and past dates are unavailable too. Default latency 300 ms. */
export function getUnavailableDates(): Promise<string[]> {
  return mockCall('getUnavailableDates', [], 300, () => UNAVAILABLE_DATES)
}

/** Upcoming meetings, sorted by date then start time. Default latency 400 ms. */
export function listMeetings(): Promise<Meeting[]> {
  return mockCall('listMeetings', [], 400, () =>
    [...meetings].sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime)),
  )
}

/** Create a meeting. Default latency 700 ms. */
export function createMeeting(input: MeetingInput): Promise<Meeting> {
  return mockCall('createMeeting', [input], 700, () => {
    if (!input.title.trim()) throw new Error('Title is required')
    if (input.attendeeIds.length === 0) throw new Error('At least one attendee is required')
    const meeting: Meeting = { ...structuredClone(input), id: `m${nextId++}`, createdAt: new Date().toISOString() }
    meetings = [...meetings, meeting]
    return meeting
  })
}

/** Delete a meeting (used by undo). Default latency 400 ms. */
export function deleteMeeting(id: string): Promise<void> {
  return mockCall('deleteMeeting', [id], 400, () => {
    meetings = meetings.filter((m) => m.id !== id)
  })
}
