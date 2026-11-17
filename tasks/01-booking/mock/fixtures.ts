// Fixture data for the meeting booking task. Self-contained (no imports) so it can be shared.

export interface Person {
  id: string
  name: string
  email: string
  title: string
}

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly'

export interface MeetingInput {
  title: string
  attendeeIds: string[]
  /** ISO date, YYYY-MM-DD */
  date: string
  /** 24h time, HH:MM */
  startTime: string
  durationMinutes: number
  recurrence: Recurrence
}

export interface Meeting extends MeetingInput {
  id: string
  createdAt: string
}

/** The app's notion of "today". Use this instead of the real clock. A Monday. */
export const TODAY = '2026-12-07'

/** Start time options, 08:00 to 18:00 every 30 minutes. */
export const START_TIMES: string[] = Array.from({ length: 21 }, (_, i) => {
  const minutes = 8 * 60 + i * 30
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
})

export const DURATIONS: { minutes: number; label: string }[] = [
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 45, label: '45 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 90, label: '1.5 hours' },
  { minutes: 120, label: '2 hours' },
]

export const DEFAULT_DURATION_MINUTES = 30

export const RECURRENCE_OPTIONS: { value: Recurrence; label: string }[] = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
]

/** Dates that are fully booked (in addition to weekends and past dates, which are also unavailable). */
export const UNAVAILABLE_DATES = ['2026-12-09', '2026-12-17', '2026-12-24', '2026-12-25', '2026-12-31', '2027-01-01']

const FIRST = ['Ana', 'Ben', 'Chloe', 'Dmitri', 'Elena', 'Farid', 'Grace', 'Hiro', 'Ines', 'Jonas', 'Keiko', 'Liam', 'Maya', 'Nikhil', 'Olga', 'Pablo', 'Quinn', 'Rosa', 'Sven', 'Tara']
const LAST = ['Ruiz', 'Okafor', 'Martin', 'Ivanov', 'Rossi', 'Haddad', 'Kim', 'Tanaka', 'Silva', 'Berg', 'Sato', 'Murphy', 'Cohen', 'Patel', 'Novak', 'Garcia', 'Lee', 'Costa', 'Lund', 'Shah']
const TITLES = ['Product Manager', 'Engineer', 'Designer', 'Researcher', 'Engineering Manager', 'Data Scientist', 'Support Lead', 'Marketing Lead']

export const PEOPLE: Person[] = Array.from({ length: 40 }, (_, i) => {
  const first = FIRST[i % FIRST.length]
  const last = LAST[(i * 7 + Math.floor(i / FIRST.length) * 3) % LAST.length]
  return {
    id: `p${String(i + 1).padStart(2, '0')}`,
    name: `${first} ${last}`,
    email: `${first}.${last}@example.com`.toLowerCase(),
    title: TITLES[i % TITLES.length],
  }
})

export const INITIAL_MEETINGS: Meeting[] = [
  { id: 'm1', title: 'Weekly planning', attendeeIds: ['p01', 'p02', 'p03'], date: '2026-12-08', startTime: '09:00', durationMinutes: 60, recurrence: 'weekly', createdAt: '2026-11-30T10:00:00.000Z' },
  { id: 'm2', title: 'Design review', attendeeIds: ['p03', 'p07'], date: '2026-12-10', startTime: '14:00', durationMinutes: 45, recurrence: 'none', createdAt: '2026-12-01T10:00:00.000Z' },
  { id: 'm3', title: 'Customer interview', attendeeIds: ['p05'], date: '2026-12-11', startTime: '11:30', durationMinutes: 30, recurrence: 'none', createdAt: '2026-12-02T10:00:00.000Z' },
]

/** Case-insensitive substring match on name or email, at most 8 results, sorted by name. */
export function matchPeople(query: string): Person[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return PEOPLE.filter((p) => p.name.toLowerCase().includes(q) || p.email.includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 8)
}
