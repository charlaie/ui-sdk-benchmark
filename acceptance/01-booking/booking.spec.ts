import { expect, test, type Locator, type Page } from '@playwright/test'
import { DURATIONS, PEOPLE, START_TIMES, TODAY, UNAVAILABLE_DATES, matchPeople } from '../../tasks/01-booking/mock/fixtures'
import {
  axeCheck,
  chooseOption,
  containsFocus,
  displayedValue,
  expectReadableTheme,
  focusedInfo,
  inLiveRegion, liveRegionText,
  isDisabled,
  loose,
  mockCalls,
  noHorizontalScroll,
  open,
  optionLabels,
  tabTo,
  waitForCalls,
  type OpenOptions,
} from '../helpers'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const idOf = (name: string) => PEOPLE.find((p) => p.name === name)!.id
/** Regex source matching a full date like "December 8, 2026" or "December 8th, 2026". */
const label = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return `${MONTHS[m - 1]} ${d}(st|nd|rd|th)?, ${y}`
}
const isUnavailable = (iso: string) => {
  const day = new Date(`${iso}T12:00:00Z`).getUTCDay()
  return iso < TODAY || day === 0 || day === 6 || UNAVAILABLE_DATES.includes(iso)
}
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10)
function parseLabel(text: string): string | null {
  const m = new RegExp(`(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?,\\s+(\\d{4})`).exec(text)
  if (!m) return null
  return `${m[3]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`
}

async function openDialog(page: Page, opts: OpenOptions = {}) {
  await open(page, opts)
  await page.getByRole('button', { name: 'New meeting' }).click()
  const dialog = page.getByRole('dialog', { name: 'New meeting' })
  await expect(dialog).toBeVisible()
  // Let the dialog's initial focus land first, or it can steal focus from a test's first action under
  // load. Not an assertion here (A1 checks initial focus): a dialog that never takes focus moves on.
  await expect.poll(() => containsFocus(dialog), { timeout: 2000 }).toBe(true).catch(() => {})
  return dialog
}
const titleField = (d: Locator) => d.getByRole('textbox', { name: /^Title/ })
const attendees = (d: Locator) => d.getByRole('combobox', { name: /Attendees/i })
/** The open calendar: the innermost element holding the "Previous month" button and a "<Month> <year>" heading.
 * Scoped so month text elsewhere on the page (a meetings list grouped by month) doesn't count. */
const calendar = (page: Page) =>
  page
    .locator('*')
    .filter({ has: page.getByRole('button', { name: 'Previous month' }) })
    .filter({ hasText: new RegExp(`(${MONTHS.join('|')}) \\d{4}`) })
    .last()
const calendarOpen = (page: Page) => page.getByRole('button', { name: 'Previous month' })
const dateControl = (d: Locator) => d.getByRole('button', { name: /^Date/ }).or(d.getByRole('combobox', { name: /^Date/ })).or(d.getByRole('textbox', { name: /^Date/ })).first()
const startTime = (d: Locator) => d.getByRole('combobox', { name: /Start time/i }).or(d.getByRole('button', { name: /Start time/i })).first()
const duration = (d: Locator) => d.getByRole('combobox', { name: /Duration/i }).or(d.getByRole('button', { name: /Duration/i })).first()
const repeat = (d: Locator) => d.getByRole('radiogroup', { name: /Repeat/i })

/** Type into the attendee combobox like a user: focus, clear, then key presses. fill() focuses and sets the
 * value in one step, which races comboboxes that reset their input when they open on focus. */
async function typeQuery(input: Locator, text: string) {
  await input.click()
  await input.clear()
  await input.pressSequentially(text, { delay: 20 })
}

async function addAttendee(page: Page, d: Locator, query: string, name: string) {
  await typeQuery(attendees(d), query)
  await page.getByRole('option', { name: new RegExp(name) }).first().click()
  await expect(d.getByRole('button', { name: `Remove ${name}` })).toBeVisible()
}

async function day(page: Page, iso: string) {
  const name = new RegExp(label(iso))
  const btn = page.getByRole('button', { name })
  if (await btn.count()) return btn.first()
  return page.getByRole('gridcell', { name }).first()
}

async function pickDate(page: Page, d: Locator, iso: string) {
  await dateControl(d).click()
  await expect(calendarOpen(page)).toBeVisible()
  const [y, m] = iso.split('-').map(Number)
  const heading = `${MONTHS[m - 1]} ${y}`
  for (let i = 0; i < 3 && !(await calendar(page).getByText(heading).isVisible()); i++) {
    await page.getByRole('button', { name: /Next month/i }).click()
  }
  await (await day(page, iso)).click()
}

async function fillValid(page: Page, d: Locator) {
  await titleField(d).fill('Sprint review')
  await addAttendee(page, d, 'ana r', 'Ana Ruiz')
  await addAttendee(page, d, 'ben t', 'Ben Tanaka')
  await pickDate(page, d, '2026-12-10')
  await chooseOption(page, startTime(d), '10:00')
  await chooseOption(page, duration(d), '45 min')
  await repeat(d).getByRole('radio', { name: 'Weekly' }).check()
}

async function meetingListTexts(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('li, [role="listitem"]')]
      .filter((el) => !el.closest('[role="dialog"], [role="alertdialog"], dialog, [role="status"], [role="alert"], [aria-live]'))
      .map((el) => (el as HTMLElement).innerText.trim()),
  )
}

test.describe('meeting booking dialog', () => {
  test('A1: New meeting opens a modal dialog, focuses Title, and makes the page inert', async ({ page }) => {
    const d = await openDialog(page)
    await expect(titleField(d)).toBeFocused()
    const modal = await d.evaluate((el) => el.getAttribute('aria-modal') === 'true' || el.matches(':modal'))
    const inert = await page.getByRole('button', { name: 'New meeting', includeHidden: true }).evaluate((el) => !!el.closest('[inert], [aria-hidden="true"]'))
    expect(modal || inert, 'dialog is modal (aria-modal/showModal) or the background is inert').toBe(true)
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab')
      // Polled: focus traps may pass through a guard element at the wrap point before landing back inside.
      await expect.poll(() => containsFocus(d), { message: `focus stays in the dialog after ${i + 1} Tab presses` }).toBe(true)
    }
  })

  test('A2: typing in Attendees shows "Searching…" in a live region, then matching options', async ({ page }) => {
    const d = await openDialog(page, { opLatency: { searchPeople: 1500 } })
    await typeQuery(attendees(d), 'an')
    const searching = page.getByText(loose('Searching…')).first()
    await expect(searching).toBeVisible()
    expect(await inLiveRegion(searching), '"Searching…" is in a live region').toBe(true)
    const expected = matchPeople('an').map((p) => p.name)
    for (const name of expected) await expect(page.getByRole('option', { name: new RegExp(name) })).toBeVisible({ timeout: 6000 })
    await expect(page.getByRole('option')).toHaveCount(expected.length)
  })

  test('A3: choosing adds chips, Remove buttons work, Backspace removes the last chip', async ({ page }) => {
    const d = await openDialog(page)
    await addAttendee(page, d, 'ana r', 'Ana Ruiz')
    await expect(attendees(d)).toHaveValue('')
    await addAttendee(page, d, 'ben t', 'Ben Tanaka')
    await d.getByRole('button', { name: 'Remove Ana Ruiz' }).click()
    await expect(d.getByRole('button', { name: 'Remove Ana Ruiz' })).toHaveCount(0)
    await attendees(d).focus()
    await page.keyboard.press('Backspace')
    await expect(d.getByRole('button', { name: 'Remove Ben Tanaka' })).toHaveCount(0)
  })

  test('A4: a search with no results shows "No people found"', async ({ page }) => {
    const d = await openDialog(page)
    await typeQuery(attendees(d), 'zzzz')
    const empty = page.getByText(loose('No people found')).first()
    await expect(empty).toBeVisible()
    expect(await inLiveRegion(empty)).toBe(true)
  })

  test('A5: a failed search shows the error and Retry searches again', async ({ page }) => {
    const d = await openDialog(page, { failOnce: ['searchPeople'] })
    await typeQuery(attendees(d), 'ana')
    const err = page.getByText(loose("Couldn't load people")).first()
    await expect(err).toBeVisible()
    expect(await inLiveRegion(err)).toBe(true)
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByRole('option', { name: /Ana Ruiz/ })).toBeVisible()
    expect((await mockCalls(page, 'searchPeople')).length).toBeGreaterThanOrEqual(2)
  })

  test('A6: arrow keys and Enter choose attendees; Escape closes only the popup', async ({ page }) => {
    const d = await openDialog(page)
    await attendees(d).focus()
    await page.keyboard.type('an')
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('ArrowDown')
    const first = await focusedInfo(page)
    await page.keyboard.press('ArrowDown')
    const second = await focusedInfo(page)
    expect(second.label, 'ArrowDown moves the active option').not.toEqual(first.label)
    await page.keyboard.press('ArrowUp')
    const back = await focusedInfo(page)
    expect(back.label, 'ArrowUp moves back').toEqual(first.label)
    const chosen = matchPeople('an').find((p) => back.label.includes(p.name))
    expect(chosen, 'the active option is identifiable by name').toBeTruthy()
    await page.keyboard.press('Enter')
    await expect(d.getByRole('button', { name: `Remove ${chosen!.name}` })).toBeVisible()
    await page.keyboard.type('be')
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await expect(d).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    expect(await containsFocus(d)).toBe(true)
  })

  test('A7: the date picker disables past, weekend and unavailable dates; choosing returns focus', async ({ page }) => {
    const d = await openDialog(page)
    await dateControl(d).click()
    await expect(calendar(page).getByText('December 2026')).toBeVisible()
    for (const iso of ['2026-12-04', '2026-12-12', '2026-12-13', '2026-12-09']) {
      expect(await isDisabled(await day(page, iso)), `${iso} is disabled`).toBe(true)
    }
    expect(await isDisabled(await day(page, '2026-12-08'))).toBe(false)
    await (await day(page, '2026-12-09')).click({ force: true, timeout: 2000 }).catch(() => {})
    await expect(dateControl(d)).not.toContainText(new RegExp(label('2026-12-09')))
    if (!(await calendarOpen(page).isVisible())) await dateControl(d).click()
    await (await day(page, '2026-12-08')).click()
    await expect(calendarOpen(page), 'choosing a date closes the calendar').toBeHidden()
    const shown = await dateControl(d).evaluate((el) => `${(el as HTMLInputElement).value ?? ''} ${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`)
    expect(shown).toMatch(new RegExp(label('2026-12-08')))
    expect(await containsFocus(dateControl(d)) || (await dateControl(d).evaluate((el) => el === document.activeElement))).toBe(true)
  })

  test('A8: the calendar works with arrow keys, PageUp/PageDown and Enter', async ({ page }) => {
    const d = await openDialog(page)
    await dateControl(d).focus()
    await page.keyboard.press('Enter')
    await expect(calendar(page).getByText('December 2026')).toBeVisible()
    // Focus may move a frame after the calendar renders or a key is handled, so every read is polled.
    const focusedDate = async () => parseLabel((await focusedInfo(page)).label)
    await expect.poll(focusedDate, { message: 'focus moves to a day in the calendar, named with its full date' }).toBeTruthy()
    const start = (await focusedDate())!
    await page.keyboard.press('ArrowDown')
    await expect.poll(focusedDate).toBe(addDays(start, 7))
    await page.keyboard.press('ArrowRight')
    await expect.poll(focusedDate).toBe(addDays(start, 8))
    await page.keyboard.press('PageDown')
    await expect(calendar(page).getByText('January 2027')).toBeVisible()
    await page.keyboard.press('PageUp')
    await expect(calendar(page).getByText('December 2026')).toBeVisible()
    await expect.poll(focusedDate).toMatch(/^2026-12-/)
    let cur = (await focusedDate())!
    for (let i = 0; i < 10 && isUnavailable(cur); i++) {
      const prev = cur
      await page.keyboard.press('ArrowRight')
      await expect.poll(focusedDate).not.toBe(prev)
      cur = (await focusedDate())!
    }
    await page.keyboard.press('Enter')
    await expect(dateControl(d)).toContainText(new RegExp(label(cur))).catch(async () => {
      expect(await dateControl(d).inputValue()).toMatch(new RegExp(label(cur)))
    })
    await expect.poll(() => dateControl(d).evaluate((el) => el === document.activeElement || el.contains(document.activeElement)), { message: 'focus returns to the date control' }).toBe(true)
  })

  test('A9: Start time and Duration offer the listed options; end time is computed', async ({ page }) => {
    const d = await openDialog(page)
    expect(await optionLabels(page, startTime(d))).toEqual(START_TIMES)
    expect(await optionLabels(page, duration(d))).toEqual(DURATIONS.map((x) => x.label))
    expect(await displayedValue(duration(d))).toContain('30 min')
    await chooseOption(page, startTime(d), '09:30')
    await chooseOption(page, duration(d), '1 hour')
    await expect(d.getByText('Ends at 10:30')).toBeVisible()
    await chooseOption(page, duration(d), '1.5 hours')
    await expect(d.getByText('Ends at 11:00')).toBeVisible()
  })

  test('A10: Repeat is a radio group defaulting to "Does not repeat"; arrow keys change it', async ({ page }) => {
    const d = await openDialog(page)
    const group = repeat(d)
    await expect(group.getByRole('radio', { name: 'Does not repeat' })).toBeChecked()
    await group.getByRole('radio', { name: 'Does not repeat' }).focus()
    await expect(group.getByRole('radio', { name: 'Does not repeat' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(group.getByRole('radio', { name: 'Daily' })).toBeChecked()
    await page.keyboard.press('ArrowDown')
    await expect(group.getByRole('radio', { name: 'Weekly' })).toBeChecked()
  })

  test('A11: validation shows messages, marks fields invalid and focuses the first invalid field', async ({ page }) => {
    const d = await openDialog(page)
    await d.getByRole('button', { name: 'Create meeting' }).click()
    for (const msg of ['Enter a title', 'Add at least one attendee', 'Choose a date', 'Choose a start time']) await expect(d.getByText(msg).and(d.locator('xpath=.//*[not(ancestor-or-self::button) and not(ancestor-or-self::*[@role="combobox"])]')).first(), `error message "${msg}"`).toBeVisible()
    await expect(titleField(d)).toBeFocused()
    await expect(titleField(d)).toHaveAttribute('aria-invalid', 'true')
    await expect(titleField(d)).toHaveAccessibleDescription(/Enter a title/)
    await titleField(d).fill('Planning')
    await expect(d.getByText('Enter a title')).toHaveCount(0)
    await d.getByRole('button', { name: 'Create meeting' }).click()
    await expect(attendees(d)).toBeFocused()
    await expect(attendees(d)).toHaveAttribute('aria-invalid', 'true')
    await expect(attendees(d)).toHaveAccessibleDescription(/Add at least one attendee/)
    expect(await mockCalls(page, 'createMeeting')).toHaveLength(0)
  })

  test('A12: a valid submit creates the meeting, closes, restores focus, and shows the toast', async ({ page }) => {
    const d = await openDialog(page, { opLatency: { createMeeting: 1200 } })
    await fillValid(page, d)
    await d.getByRole('button', { name: 'Create meeting' }).click()
    const pending = d.getByRole('button', { name: loose('Creating…') })
    await expect(pending).toBeVisible()
    await expect(pending).toBeDisabled()
    await expect(d).toBeHidden({ timeout: 8000 })
    await expect(page.getByRole('button', { name: 'New meeting' })).toBeFocused()
    const [call] = await waitForCalls(page, 'createMeeting')
    expect(call.args[0]).toEqual({ title: 'Sprint review', attendeeIds: [idOf('Ana Ruiz'), idOf('Ben Tanaka')], date: '2026-12-10', startTime: '10:00', durationMinutes: 45, recurrence: 'weekly' })
    await expect.poll(async () => (await meetingListTexts(page)).some((t) => t.includes('Sprint review'))).toBe(true)
    const toast = page.getByText('Meeting created').first()
    await expect(toast).toBeVisible()
    // "Announced to screen readers": the toast sits in a live region, or a live region repeats its text.
    expect((await inLiveRegion(toast)) || (await liveRegionText(page)).includes('Meeting created'), 'the toast is announced').toBe(true)
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()
    await page.mouse.move(0, 0)
    await page.waitForTimeout(7000)
    await expect(page.getByText('Meeting created').first()).toBeVisible()
  })

  test('A13: a failed create keeps the dialog open with values and shows an alert', async ({ page }) => {
    const d = await openDialog(page, { fail: ['createMeeting'] })
    await fillValid(page, d)
    await d.getByRole('button', { name: 'Create meeting' }).click()
    await expect(d.getByRole('alert').filter({ hasText: loose("Couldn't create meeting") })).toBeVisible()
    await expect(d).toBeVisible()
    await expect(titleField(d)).toHaveValue('Sprint review')
    await expect(d.getByRole('button', { name: 'Remove Ben Tanaka' })).toBeVisible()
    await expect(d.getByRole('button', { name: 'Create meeting' })).toBeEnabled()
  })

  test('A14: Escape with no changes closes and returns focus to New meeting', async ({ page }) => {
    const d = await openDialog(page)
    await page.keyboard.press('Escape')
    await expect(d).toBeHidden()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'New meeting' })).toBeFocused()
  })

  test('A15: Escape with changes asks to discard; Keep editing and Discard behave', async ({ page }) => {
    const d = await openDialog(page)
    await titleField(d).fill('Draft')
    await page.keyboard.press('Escape')
    const alert = page.getByRole('alertdialog', { name: 'Discard changes?' })
    await expect(alert).toBeVisible()
    await expect(d).toBeAttached()
    await alert.getByRole('button', { name: 'Keep editing' }).click()
    await expect(alert).toBeHidden()
    await expect(d).toBeVisible()
    await expect(titleField(d)).toHaveValue('Draft')
    await expect(titleField(d)).toBeFocused()
    await d.getByRole('button', { name: 'Cancel' }).click()
    await expect(alert).toBeVisible()
    await alert.getByRole('button', { name: 'Discard' }).click()
    await expect(alert).toBeHidden()
    await expect(d).toBeHidden()
    await expect(page.getByRole('button', { name: 'New meeting' })).toBeFocused()
    await page.getByRole('button', { name: 'New meeting' }).click()
    await expect(titleField(page.getByRole('dialog', { name: 'New meeting' }))).toHaveValue('')
  })

  test('A16: Undo deletes the meeting, restores the list and reopens with the submitted values', async ({ page }) => {
    await open(page)
    await expect.poll(async () => (await meetingListTexts(page)).some((t) => t.includes('Weekly planning'))).toBe(true)
    const before = await meetingListTexts(page)
    await page.getByRole('button', { name: 'New meeting' }).click()
    const d = page.getByRole('dialog', { name: 'New meeting' })
    await fillValid(page, d)
    await d.getByRole('button', { name: 'Create meeting' }).click()
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()
    await page.getByRole('button', { name: 'Undo' }).click()
    const [del] = await waitForCalls(page, 'deleteMeeting')
    expect(typeof del.args[0]).toBe('string')
    await expect(d).toBeVisible()
    await expect.poll(() => meetingListTexts(page)).toEqual(before)
    await expect(titleField(d)).toHaveValue('Sprint review')
    const chips = await d.getByRole('button', { name: /^Remove / }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent))
    expect(chips.map((c) => c?.replace(/^Remove /, '').trim())).toEqual(['Ana Ruiz', 'Ben Tanaka'])
    const shown = await dateControl(d).evaluate((el) => `${(el as HTMLInputElement).value ?? ''} ${el.textContent ?? ''}`)
    expect(shown).toMatch(new RegExp(label('2026-12-10')))
    expect(await displayedValue(startTime(d))).toContain('10:00')
    expect(await displayedValue(duration(d))).toContain('45 min')
    await expect(repeat(d).getByRole('radio', { name: 'Weekly' })).toBeChecked()
  })

  test.describe('mobile', () => {
    test.use({ viewport: { width: 375, height: 740 } })
    test('A17: at 375 px the dialog fits without horizontal page scrolling', async ({ page }) => {
      const d = await openDialog(page)
      expect(await noHorizontalScroll(page)).toBe(true)
      const box = (await d.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(-1)
      expect(box.x + box.width).toBeLessThanOrEqual(376)
    })
  })

  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${scheme} mode`, () => {
      test.use({ colorScheme: scheme })
      test(`A17: ${scheme} mode renders readable content`, async ({ page }) => {
        await open(page)
        await expectReadableTheme(page.getByRole('heading', { name: 'Meetings', exact: true }), scheme)
        const d = await (async () => {
          await page.getByRole('button', { name: 'New meeting' }).click()
          return page.getByRole('dialog', { name: 'New meeting' })
        })()
        await expectReadableTheme(d.getByText('Duration').first(), scheme)
      })
    })
  }

  test('axe: page, dialog, validation errors and attendee popup', async ({ page }) => {
    const problems: string[] = []
    await open(page)
    await expect(page.getByRole('button', { name: 'New meeting' })).toBeVisible()
    problems.push(...(await axeCheck(page, 'booking-page')))
    await page.getByRole('button', { name: 'New meeting' }).click()
    const d = page.getByRole('dialog', { name: 'New meeting' })
    problems.push(...(await axeCheck(page, 'booking-dialog')))
    await d.getByRole('button', { name: 'Create meeting' }).click()
    problems.push(...(await axeCheck(page, 'booking-validation')))
    await typeQuery(attendees(d), 'an')
    await expect(page.getByRole('option').first()).toBeVisible()
    problems.push(...(await axeCheck(page, 'booking-attendee-popup')))
    await page.keyboard.press('Escape')
    await dateControl(d).click()
    problems.push(...(await axeCheck(page, 'booking-calendar')))
    expect(problems).toEqual([])
  })

  test.describe('axe dark', () => {
    test.use({ colorScheme: 'dark' })
    test('axe: dialog in dark mode', async ({ page }) => {
      await open(page)
      await page.getByRole('button', { name: 'New meeting' }).click()
      await expect(page.getByRole('dialog', { name: 'New meeting' })).toBeVisible()
      expect(await axeCheck(page, 'booking-dialog-dark')).toEqual([])
    })
  })

  test('kbd: book a meeting with the keyboard only', async ({ page }) => {
    await open(page)
    await tabTo(page, page.getByRole('button', { name: 'New meeting' }))
    await page.keyboard.press('Enter')
    const d = page.getByRole('dialog', { name: 'New meeting' })
    await expect(titleField(d)).toBeFocused()
    await page.keyboard.type('Keyboard sync')
    await tabTo(page, attendees(d))
    await page.keyboard.type('ana r')
    await expect(page.getByRole('option', { name: /Ana Ruiz/ })).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(d.getByRole('button', { name: 'Remove Ana Ruiz' })).toBeVisible()
    await tabTo(page, dateControl(d))
    await page.keyboard.press('Enter')
    const focusedDate = async () => parseLabel((await focusedInfo(page)).label)
    await expect.poll(focusedDate, { message: 'focus moves to a day in the calendar' }).toBeTruthy()
    let cur = await focusedDate()
    for (let i = 0; i < 10 && cur && isUnavailable(cur); i++) {
      const prev = cur
      await page.keyboard.press('ArrowRight')
      await expect.poll(focusedDate).not.toBe(prev)
      cur = await focusedDate()
    }
    await page.keyboard.press('Enter')
    await tabTo(page, startTime(d))
    const isNative = await startTime(d).evaluate((el) => el.tagName === 'SELECT')
    await page.keyboard.press('ArrowDown')
    // Custom selects may open on ArrowDown; give the popup a moment to appear before deciding.
    if (!isNative && (await page.getByRole('listbox').first().waitFor({ timeout: 1000 }).then(() => true, () => false))) {
      // Human-speed keys: some select popups ignore input in their first frames, and an instant Enter
      // can leave focus on the closing option.
      await page.waitForTimeout(150)
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(100)
      await page.keyboard.press('Enter')
      await expect(page.getByRole('listbox')).toHaveCount(0)
    }
    expect(await displayedValue(startTime(d))).toMatch(/\d\d:\d\d/)
    await tabTo(page, d.getByRole('button', { name: 'Create meeting' }))
    await page.keyboard.press('Enter')
    await waitForCalls(page, 'createMeeting')
    await expect(page.getByText('Meeting created').first()).toBeVisible()
    const [call] = await mockCalls(page, 'createMeeting')
    expect((call.args[0] as { title: string }).title).toBe('Keyboard sync')
  })
})
