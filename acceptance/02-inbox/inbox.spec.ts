import { expect, test, type Locator, type Page } from '@playwright/test'
import { INITIAL_ISSUES, PRIORITY_RANK, type Issue } from '../../tasks/02-inbox/mock/fixtures'
import {
  axeCheck,
  chooseOption,
  containsFocus,
  expectReadableTheme,
  focusedInfo,
  liveRegionText,
  loose,
  mockCalls,
  noHorizontalScroll,
  open,
  waitForCalls,
  type OpenOptions,
} from '../helpers'

const byUpdatedDesc = (a: Issue, b: Issue) => b.updatedAt.localeCompare(a.updatedAt)
const openIssues = INITIAL_ISSUES.filter((i) => i.status !== 'Done').sort(byUpdatedDesc)
const closedIssues = INITIAL_ISSUES.filter((i) => i.status === 'Done').sort(byUpdatedDesc)
const pages = (n: number) => Math.ceil(n / 25)

const table = (page: Page) => page.getByRole('table', { name: 'Issues' }).or(page.getByRole('grid', { name: 'Issues' })).first()
const rows = (page: Page) => table(page).getByRole('row').filter({ has: page.getByRole('checkbox', { name: /^Select ISS-\d+/ }) })
const row = (page: Page, id: string) => rows(page).filter({ has: page.getByRole('checkbox', { name: `Select ${id}`, exact: true }) })
const tab = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) })

async function rowIds(page: Page) {
  return rows(page).evaluateAll((els) => els.map((e) => /ISS-\d+/.exec((e as HTMLElement).innerText)?.[0] ?? ''))
}

async function ready(page: Page, opts: OpenOptions = {}) {
  await open(page, opts)
  await expect(rows(page)).toHaveCount(25, { timeout: 10_000 })
}

async function pressUntilFocused(page: Page, key: string, text: RegExp, max = 12) {
  for (let i = 0; i < max; i++) {
    if (text.test((await focusedInfo(page)).label)) return
    await page.keyboard.press(key)
  }
  throw new Error(`no focused item matching ${text}`)
}

const firstNot = (status: string, list = openIssues) => list.slice(0, 25).find((i) => i.status !== status)!

async function setStatusViaRowMenu(page: Page, id: string, status: string) {
  await page.getByRole('button', { name: `Actions for ${id}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Set status' }).click()
  await page.getByRole('menuitem', { name: status, exact: true }).or(page.getByRole('menuitemradio', { name: status, exact: true })).or(page.getByRole('menuitemcheckbox', { name: status, exact: true })).first().click()
}

async function openPalette(page: Page) {
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  return palette
}

async function runCommand(page: Page, query: string, name: string | RegExp) {
  const palette = await openPalette(page)
  await palette.getByRole('combobox', { name: 'Search commands' }).or(palette.getByRole('textbox', { name: 'Search commands' })).or(palette.getByRole('searchbox', { name: 'Search commands' })).first().fill(query)
  const option = palette.getByRole('option', { name })
  await expect(option.first()).toBeVisible()
  await option.first().click()
  await expect(palette).toBeHidden()
}

const statusCell = (page: Page, id: string, status: string) => row(page, id).getByText(status, { exact: true })

test.describe('issue triage inbox', () => {
  test('A1: loading state, 25 rows, load failure with Retry', async ({ page }) => {
    await open(page, { opLatency: { listIssues: 1500 } })
    await expect(page.getByText(loose('Loading issues…')).first()).toBeVisible()
    await expect(rows(page)).toHaveCount(25, { timeout: 10_000 })
    await open(page, { failOnce: ['listIssues'] })
    await expect(page.getByText(loose("Couldn't load issues")).first()).toBeVisible()
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(rows(page)).toHaveCount(25)
  })

  test('A2: Open, Closed and All tabs show the right issues and follow the tabs keyboard pattern', async ({ page }) => {
    await ready(page)
    await expect(tab(page, 'Open')).toHaveAttribute('aria-selected', 'true')
    expect(await rowIds(page)).toEqual(openIssues.slice(0, 25).map((i) => i.id))
    await tab(page, 'Closed').click()
    await expect(page.getByText(`Page 1 of ${pages(closedIssues.length)}`)).toBeVisible()
    expect(await rowIds(page)).toEqual(closedIssues.slice(0, 25).map((i) => i.id))
    await tab(page, 'All').click()
    await expect(page.getByText(`Page 1 of ${pages(200)}`)).toBeVisible()
    await tab(page, 'All').focus()
    await page.keyboard.press('ArrowLeft')
    await expect(tab(page, 'Closed')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(tab(page, 'Closed')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { selected: true })).toHaveCount(1)
  })

  test('A3: pagination pages through results and disables at the ends', async ({ page }) => {
    await ready(page)
    const total = pages(openIssues.length)
    await expect(page.getByText(`Page 1 of ${total}`)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    await page.getByRole('button', { name: 'Next page' }).click()
    await expect(page.getByText(`Page 2 of ${total}`)).toBeVisible()
    expect(await rowIds(page)).toEqual(openIssues.slice(25, 50).map((i) => i.id))
    for (let p = 2; p < total; p++) await page.getByRole('button', { name: 'Next page' }).click()
    await expect(page.getByText(`Page ${total} of ${total}`)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled()
    await page.getByRole('button', { name: 'Previous page' }).click()
    await expect(page.getByText(`Page ${total - 1} of ${total}`)).toBeVisible()
  })

  test('A4: search filters by title or ID; "/" focuses search', async ({ page }) => {
    await ready(page)
    const search = page.getByRole('searchbox', { name: 'Search issues' }).or(page.getByRole('textbox', { name: 'Search issues' })).first()
    await search.fill('safari')
    const expected = openIssues.filter((i) => i.title.toLowerCase().includes('safari')).slice(0, 25).map((i) => i.id)
    await expect.poll(() => rowIds(page)).toEqual(expected)
    const target = openIssues[30]
    await search.fill(target.id.toLowerCase())
    await expect.poll(() => rowIds(page)).toEqual([target.id])
    await search.fill('no such issue zzz')
    await expect(page.getByText('No issues match')).toBeVisible()
    await search.fill('')
    await page.getByRole('heading', { name: 'Inbox' }).click()
    await page.keyboard.press('/')
    await expect(search).toBeFocused()
  })

  test('A5: the Filters popover filters, shows the count, closes with Escape and clears', async ({ page }) => {
    await ready(page)
    await page.getByRole('button', { name: /^Filter/ }).click()
    const pop = page.getByRole('dialog', { name: 'Filters' })
    await expect(pop).toBeVisible()
    await pop.getByRole('checkbox', { name: 'Blocked', exact: true }).check()
    let expected = openIssues.filter((i) => i.status === 'Blocked')
    await expect.poll(() => rowIds(page)).toEqual(expected.slice(0, 25).map((i) => i.id))
    await expect(page.getByRole('button', { name: /^Filter.*\b1\b/ })).toBeVisible()
    await pop.getByRole('checkbox', { name: 'Urgent', exact: true }).check()
    expected = expected.filter((i) => i.priority === 'Urgent')
    await expect.poll(() => rowIds(page)).toEqual(expected.slice(0, 25).map((i) => i.id))
    await expect(page.getByRole('button', { name: /^Filter.*\b2\b/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(pop).toBeHidden()
    await expect(page.getByRole('button', { name: /^Filter/ })).toBeFocused()
    await page.getByRole('button', { name: /^Filter/ }).click()
    await page.getByRole('dialog', { name: 'Filters' }).getByRole('button', { name: 'Clear filters' }).click()
    await expect.poll(() => rowIds(page)).toEqual(openIssues.slice(0, 25).map((i) => i.id))
    await expect(page.getByRole('button', { name: /^Filter/ })).not.toHaveAccessibleName(/\d/)
  })

  test('A6: the Sort menu uses checked radio items, works from the keyboard and sorts', async ({ page }) => {
    await ready(page)
    await page.getByRole('button', { name: 'Sort' }).click()
    await expect(page.getByRole('menuitemradio', { name: 'Updated (newest first)' })).toHaveAttribute('aria-checked', 'true')
    await pressUntilFocused(page, 'ArrowDown', /Title \(A.Z\)/)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Sort' })).toBeFocused()
    const byTitle = [...openIssues].sort((a, b) => a.title.localeCompare(b.title))
    await expect.poll(() => rowIds(page)).toEqual(byTitle.slice(0, 25).map((i) => i.id))
    await page.getByRole('button', { name: 'Sort' }).click()
    await expect(page.getByRole('menuitemradio', { name: /Title \(A.Z\)/ })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('menuitemradio', { name: 'Priority (highest first)' }).click()
    const byPriority = [...openIssues].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id.localeCompare(b.id))
    await expect.poll(() => rowIds(page)).toEqual(byPriority.slice(0, 25).map((i) => i.id))
  })

  test('A7: row checkboxes, select-all with mixed state, and bulk status in one call', async ({ page }) => {
    await ready(page)
    const ids = await rowIds(page)
    await page.getByRole('checkbox', { name: `Select ${ids[0]}`, exact: true }).check()
    await page.getByRole('checkbox', { name: `Select ${ids[1]}`, exact: true }).check()
    const bulk = page.getByRole('toolbar', { name: 'Bulk actions' })
    await expect(bulk).toContainText('2 selected')
    const all = page.getByRole('checkbox', { name: 'Select all on this page' })
    expect(await all.evaluate((el) => (el as HTMLInputElement).indeterminate === true || el.getAttribute('aria-checked') === 'mixed')).toBe(true)
    await all.click()
    await expect(bulk).toContainText('25 selected')
    await expect(all).toBeChecked()
    await bulk.getByRole('button', { name: 'Set status' }).click()
    await page.getByRole('menuitem', { name: 'Blocked', exact: true }).or(page.getByRole('menuitemradio', { name: 'Blocked', exact: true })).first().click()
    const [call] = await waitForCalls(page, 'updateIssues')
    expect((call.args[0] as string[]).sort()).toEqual([...ids].sort())
    expect(call.args[1]).toEqual({ status: 'Blocked' })
    expect(await mockCalls(page, 'updateIssues')).toHaveLength(1)
  })

  test('A8: the row actions menu, submenus with ArrowRight/ArrowLeft, and focus return', async ({ page }) => {
    await ready(page)
    const issue = firstNot('Blocked')
    const trigger = page.getByRole('button', { name: `Actions for ${issue.id}`, exact: true })
    await trigger.click()
    for (const name of ['Open details', 'Set status', 'Set priority', 'Assign']) await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible()
    await pressUntilFocused(page, 'ArrowDown', /Set status/)
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('menu')).toHaveCount(2)
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByRole('menu')).toHaveCount(1)
    expect((await focusedInfo(page)).label).toMatch(/Set status/)
    await page.keyboard.press('ArrowRight')
    await pressUntilFocused(page, 'ArrowDown', /Blocked/)
    await page.keyboard.press('Enter')
    const [call] = await waitForCalls(page, 'updateIssues')
    expect(call.args).toEqual([[issue.id], { status: 'Blocked' }])
    await expect(statusCell(page, issue.id, 'Blocked')).toBeVisible()
    await trigger.click()
    // Wait for the menu to open (and take focus) before Escape, as a person would.
    await expect(page.getByRole('menu')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test('A9: right-click and Shift+F10 open the same context menu; Escape returns focus to the row', async ({ page }) => {
    await ready(page)
    const [id] = await rowIds(page)
    await row(page, id).click({ button: 'right', position: { x: 300, y: 10 } })
    for (const name of ['Open details', 'Set status', 'Set priority', 'Assign']) await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    expect(await containsFocus(row(page, id))).toBe(true)
    await page.getByRole('heading', { name: 'Inbox' }).click()
    await page.keyboard.press('j')
    expect(await containsFocus(row(page, id))).toBe(true)
    await page.keyboard.press('Shift+F10')
    await expect(page.getByRole('menuitem', { name: 'Set status', exact: true })).toBeVisible()
  })

  test('A10: Ctrl+K opens the command palette, filters, runs, and Escape restores focus', async ({ page }) => {
    await ready(page)
    await runCommand(page, 'go to clo', 'Go to Closed')
    await expect(tab(page, 'Closed')).toHaveAttribute('aria-selected', 'true')
    const search = page.getByRole('searchbox', { name: 'Search issues' }).or(page.getByRole('textbox', { name: 'Search issues' })).first()
    await search.focus()
    const palette = await openPalette(page)
    const input = palette.getByRole('combobox', { name: 'Search commands' }).or(palette.getByRole('textbox', { name: 'Search commands' })).first()
    await expect(input).toBeFocused()
    await input.fill('go to')
    await expect(palette.getByRole('option')).toHaveCount(3)
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
    await expect(search).toBeFocused()
  })

  test('A11: row menu, context menu and palette make the same update', async ({ page }) => {
    await ready(page)
    const targets = openIssues.slice(0, 25).filter((i) => i.status !== 'Blocked').slice(0, 3)
    await setStatusViaRowMenu(page, targets[0].id, 'Blocked')
    await row(page, targets[1].id).click({ button: 'right', position: { x: 300, y: 10 } })
    await page.getByRole('menuitem', { name: 'Set status' }).click()
    await page.getByRole('menuitem', { name: 'Blocked', exact: true }).or(page.getByRole('menuitemradio', { name: 'Blocked', exact: true })).first().click()
    await page.getByRole('checkbox', { name: `Select ${targets[2].id}`, exact: true }).check()
    await runCommand(page, 'set status: blo', 'Set status: Blocked')
    const calls = await waitForCalls(page, 'updateIssues', 3)
    expect(calls.map((c) => c.args)).toEqual(targets.map((t) => [[t.id], { status: 'Blocked' }]))
    for (const t of targets) await expect(statusCell(page, t.id, 'Blocked')).toBeVisible()
  })

  test('A12: the drawer opens from the title and Open details, edits, comments, and restores focus', async ({ page }) => {
    await ready(page)
    const issue = firstNot('Blocked')
    const title = row(page, issue.id).getByRole('button', { name: issue.title }).or(row(page, issue.id).getByRole('link', { name: issue.title })).first()
    await title.click()
    const drawer = page.getByRole('dialog', { name: issue.title })
    await expect(drawer).toBeVisible()
    await expect(drawer).toContainText(issue.id)
    await waitForCalls(page, 'getIssue')
    await chooseOption(page, drawer.getByRole('combobox', { name: 'Status' }).or(drawer.getByRole('button', { name: /^Status/ })).first(), 'Blocked')
    const [upd] = await waitForCalls(page, 'updateIssues')
    expect(upd.args).toEqual([[issue.id], { status: 'Blocked' }])
    await drawer.getByRole('textbox', { name: 'Add a comment' }).fill('Triaged by test')
    await drawer.getByRole('button', { name: 'Comment', exact: true }).click()
    const [c] = await waitForCalls(page, 'addComment')
    expect(c.args).toEqual([issue.id, 'Triaged by test'])
    await expect(drawer.getByText('Triaged by test')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(title).toBeFocused()
    const trigger = page.getByRole('button', { name: `Actions for ${issue.id}`, exact: true })
    await trigger.click()
    await page.getByRole('menuitem', { name: 'Open details' }).click()
    await expect(drawer).toBeVisible()
    await drawer.getByRole('button', { name: 'Close' }).first().click()
    await expect(drawer).toBeHidden()
    await expect(trigger).toBeFocused()
  })

  test('A13: menus and the palette stack over the drawer and Escape closes one layer at a time', async ({ page }) => {
    await ready(page)
    const issue = openIssues[0]
    await row(page, issue.id).getByRole('button', { name: issue.title }).or(row(page, issue.id).getByRole('link', { name: issue.title })).first().click()
    const drawer = page.getByRole('dialog', { name: issue.title })
    await expect(drawer).toBeVisible()
    const more = drawer.getByRole('button', { name: 'More actions' })
    await more.click()
    await expect(page.getByRole('menuitem', { name: 'Set status' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(drawer).toBeVisible()
    await expect(more).toBeFocused()
    const palette = await openPalette(page)
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
    await expect(drawer).toBeVisible()
    await expect(more).toBeFocused()
    await runCommand(page, 'set priority: low', 'Set priority: Low')
    const [call] = await waitForCalls(page, 'updateIssues')
    expect(call.args).toEqual([[issue.id], { priority: 'Low' }])
    await expect(drawer).toBeVisible()
    expect(await containsFocus(drawer)).toBe(true)
  })

  test('A14: single-key shortcuts are ignored while typing; Ctrl+K works; j/k/x/Enter work on rows', async ({ page }) => {
    await ready(page)
    const ids = await rowIds(page)
    const search = page.getByRole('searchbox', { name: 'Search issues' }).or(page.getByRole('textbox', { name: 'Search issues' })).first()
    await search.focus()
    await page.keyboard.type('jkx/')
    await expect(search).toHaveValue('jkx/')
    await expect(search).toBeFocused()
    await expect(page.getByRole('toolbar', { name: 'Bulk actions' })).toHaveCount(0)
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
    await page.keyboard.press('Escape')
    await search.fill('')
    await expect(rows(page)).toHaveCount(25)
    await page.getByRole('heading', { name: 'Inbox' }).click()
    await page.keyboard.press('j')
    expect(await containsFocus(row(page, ids[0]))).toBe(true)
    await page.keyboard.press('j')
    expect(await containsFocus(row(page, ids[1]))).toBe(true)
    await page.keyboard.press('k')
    expect(await containsFocus(row(page, ids[0]))).toBe(true)
    await page.keyboard.press('x')
    await expect(page.getByRole('checkbox', { name: `Select ${ids[0]}`, exact: true })).toBeChecked()
    // Enter must open the drawer even if x moved focus onto the checkbox; re-focus the row first.
    await page.keyboard.press('j')
    await page.keyboard.press('k')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: openIssues[0].title })).toBeVisible()
  })

  test('A15: failed updates revert with an alert; successful ones are announced', async ({ page }) => {
    await ready(page, { fail: ['updateIssues'] })
    const issue = firstNot('Blocked')
    await setStatusViaRowMenu(page, issue.id, 'Blocked')
    await expect(page.getByRole('alert').filter({ hasText: loose("Couldn't update issues") })).toBeVisible()
    await expect(statusCell(page, issue.id, issue.status)).toBeVisible()
    await ready(page)
    await setStatusViaRowMenu(page, issue.id, 'Blocked')
    await expect.poll(() => liveRegionText(page)).toMatch(/Updated 1 issue\b/)
  })

  test.describe('mobile', () => {
    test.use({ viewport: { width: 375, height: 740 } })
    test('A16: at 375 px the drawer covers the viewport and the page does not scroll horizontally', async ({ page }) => {
      await ready(page)
      expect(await noHorizontalScroll(page)).toBe(true)
      const issue = openIssues[0]
      await row(page, issue.id).getByRole('button', { name: issue.title }).or(row(page, issue.id).getByRole('link', { name: issue.title })).first().click()
      const box = (await page.getByRole('dialog', { name: issue.title }).boundingBox())!
      expect(box.x).toBeLessThanOrEqual(1)
      expect(box.y).toBeLessThanOrEqual(1)
      expect(box.width).toBeGreaterThanOrEqual(373)
      expect(box.height).toBeGreaterThanOrEqual(738)
    })
  })

  test('A16: on desktop the drawer is a right-hand panel between 360 px and 50% wide', async ({ page }) => {
    await ready(page)
    const issue = openIssues[0]
    await row(page, issue.id).getByRole('button', { name: issue.title }).or(row(page, issue.id).getByRole('link', { name: issue.title })).first().click()
    const box = (await page.getByRole('dialog', { name: issue.title }).boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(359)
    expect(box.width).toBeLessThanOrEqual(641)
    expect(box.x + box.width).toBeGreaterThanOrEqual(1278)
  })

  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${scheme} mode`, () => {
      test.use({ colorScheme: scheme })
      test(`A16: ${scheme} mode renders readable content`, async ({ page }) => {
        await ready(page)
        await expectReadableTheme(page.getByRole('heading', { name: 'Inbox' }), scheme)
        await expectReadableTheme(rows(page).first().getByText(/ISS-\d+/).first(), scheme)
      })
    })
  }

  test('axe: table, filter popover, row menu, drawer and palette', async ({ page }) => {
    const problems: string[] = []
    await ready(page)
    problems.push(...(await axeCheck(page, 'inbox-table')))
    await page.getByRole('button', { name: /^Filter/ }).click()
    problems.push(...(await axeCheck(page, 'inbox-filters')))
    await page.keyboard.press('Escape')
    const [id] = await rowIds(page)
    await page.getByRole('button', { name: `Actions for ${id}`, exact: true }).click()
    problems.push(...(await axeCheck(page, 'inbox-row-menu')))
    await page.getByRole('menuitem', { name: 'Open details' }).click()
    await expect(page.getByRole('dialog').first()).toBeVisible()
    problems.push(...(await axeCheck(page, 'inbox-drawer')))
    await page.keyboard.press('Control+k')
    problems.push(...(await axeCheck(page, 'inbox-palette')))
    expect(problems).toEqual([])
  })

  test.describe('axe dark', () => {
    test.use({ colorScheme: 'dark' })
    test('axe: table in dark mode', async ({ page }) => {
      await ready(page)
      expect(await axeCheck(page, 'inbox-table-dark')).toEqual([])
    })
  })

  test('kbd: triage with the keyboard only', async ({ page }) => {
    await ready(page)
    const [first] = await rowIds(page)
    const issue = INITIAL_ISSUES.find((i) => i.id === first)!
    const target = issue.status === 'Blocked' ? 'In progress' : 'Blocked'
    await page.keyboard.press('j')
    await page.keyboard.press('Shift+F10')
    await pressUntilFocused(page, 'ArrowDown', /Set status/)
    await page.keyboard.press('ArrowRight')
    await pressUntilFocused(page, 'ArrowDown', new RegExp(target))
    await page.keyboard.press('Enter')
    const [call] = await waitForCalls(page, 'updateIssues')
    expect(call.args).toEqual([[first], { status: target }])
    await page.keyboard.press('Control+k')
    await page.keyboard.type('go to all')
    await page.keyboard.press('Enter')
    await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true')
    // Let the palette close and give focus back before the next shortcut (where focus returns to is
    // checked in A10, not here).
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden()
    await expect.poll(() => page.evaluate(() => !document.activeElement?.closest('[role="dialog"]'))).toBe(true)
    await page.waitForTimeout(100)
    await page.keyboard.press('/')
    await page.keyboard.type(first)
    await expect.poll(() => rowIds(page)).toEqual([first])
    // Leave the text field with Tab so single-key shortcuts apply again.
    await page.keyboard.press('Tab')
    await page.keyboard.press('j')
    await page.keyboard.press('Enter')
    const drawer = page.getByRole('dialog', { name: issue.title })
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
  })
})
