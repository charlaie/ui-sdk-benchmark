import { expect, test, type Page } from '@playwright/test'
import { buildInitialCells } from '../../tasks/03-spreadsheet/mock/fixtures'
import { axeCheck, expectReadableTheme, loose, mockCalls, noHorizontalScroll, open, waitForCalls, type OpenOptions } from '../helpers'

const INIT = buildInitialCells()
const colIndex = (letter: string) => letter.charCodeAt(0) - 63 // A -> 2
const grid = (page: Page) => page.getByRole('grid', { name: 'Spreadsheet' })
const nameBox = (page: Page) => page.getByRole('textbox', { name: 'Cell reference' })
const contents = (page: Page) => page.getByRole('textbox', { name: 'Cell contents' })
function cell(page: Page, address: string) {
  const m = /^([A-Z])(\d+)$/.exec(address)!
  return grid(page).locator(`[role="row"][aria-rowindex="${Number(m[2]) + 1}"] [role="gridcell"][aria-colindex="${colIndex(m[1])}"]`)
}

async function ready(page: Page, opts: OpenOptions = {}) {
  await open(page, opts)
  await expect(cell(page, 'A1')).toHaveText('Item 1', { timeout: 10_000 })
}

/** Put focus into the grid with the keyboard, landing on the active cell. */
async function focusGrid(page: Page) {
  await contents(page).focus()
  for (let i = 0; i < 5 && !(await grid(page).evaluate((el) => el.contains(document.activeElement))); i++) await page.keyboard.press('Tab')
  expect(await grid(page).evaluate((el) => el.contains(document.activeElement)), 'Tab from "Cell contents" reaches the grid').toBe(true)
}

async function goTo(page: Page, address: string) {
  await nameBox(page).fill(address)
  await nameBox(page).press('Enter')
  await expect(nameBox(page)).toHaveValue(address)
}

async function activeAddress(page: Page) {
  return nameBox(page).inputValue()
}

async function gridHasFocus(page: Page) {
  return grid(page).evaluate((el) => el.contains(document.activeElement) && document.activeElement !== document.body)
}

async function isInGridView(page: Page, address: string) {
  const g = (await grid(page).boundingBox())!
  const c = await cell(page, address).boundingBox()
  if (!c) return false
  return c.y >= g.y - 1 && c.y + c.height <= g.y + g.height + 1 && c.x >= g.x - 1 && c.x + c.width <= g.x + g.width + 1
}

/** True if the cell isn't in the DOM, or is mounted but outside its scroll container's visible area. */
async function isOutOfView(page: Page, address: string) {
  return cell(page, address).evaluateAll((els) => {
    const el = els[0]
    if (!el) return true
    const r = el.getBoundingClientRect()
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.scrollHeight > p.clientHeight + 10 && /(auto|scroll|hidden)/.test(getComputedStyle(p).overflowY)) {
        const pr = p.getBoundingClientRect()
        return r.bottom <= pr.top || r.top >= pr.bottom
      }
    }
    return r.bottom <= 0 || r.top >= innerHeight
  })
}

/** Scroll the grid's scroll container (the grid itself, a descendant or an ancestor). */
async function scrollGrid(page: Page, top: number | null, left: number | null) {
  await grid(page).evaluate(
    (el, [t, l]) => {
      const scrollable = (e: Element) => e.scrollHeight > e.clientHeight + 10 || e.scrollWidth > e.clientWidth + 10
      let target: Element | null = scrollable(el) ? el : [...el.querySelectorAll('*')].find(scrollable) ?? null
      for (let p = el.parentElement; !target && p; p = p.parentElement) if (scrollable(p) && p !== document.documentElement && p !== document.body) target = p
      if (!target) throw new Error('no scroll container found for the grid')
      if (t !== null) target.scrollTop = t
      if (l !== null) target.scrollLeft = l
      target.dispatchEvent(new Event('scroll'))
    },
    [top, left] as const,
  )
  await page.waitForTimeout(300)
}

async function renderedDataRows(page: Page) {
  return grid(page).locator('[role="row"][aria-rowindex]').evaluateAll((els) => els.filter((e) => Number(e.getAttribute('aria-rowindex')) > 1).length)
}

const selected = async (page: Page, address: string) => (await cell(page, address).getAttribute('aria-selected')) === 'true'

test.describe('spreadsheet grid', () => {
  test('A1: the grid follows the accessibility contract', async ({ page }) => {
    await ready(page)
    const g = grid(page)
    await expect(g).toHaveAttribute('aria-rowcount', '10001')
    await expect(g).toHaveAttribute('aria-colcount', '27')
    await expect(g).toHaveAttribute('aria-multiselectable', 'true')
    const header = g.locator('[role="row"][aria-rowindex="1"]')
    await expect(header.getByRole('columnheader')).toHaveCount(27)
    await expect(header.locator('[role="columnheader"][aria-colindex="1"]')).toHaveCount(1)
    for (const letter of ['A', 'B', 'M', 'Z']) {
      await expect(header.locator(`[role="columnheader"][aria-colindex="${colIndex(letter)}"]`)).toHaveText(letter)
    }
    const r1 = g.locator('[role="row"][aria-rowindex="2"]')
    await expect(r1.locator('[role="rowheader"][aria-colindex="1"]')).toHaveText('1')
    await expect(r1.getByRole('gridcell')).toHaveCount(26)
    await expect(cell(page, 'B1')).toHaveText(INIT.B1)
    await expect(cell(page, 'D3')).toHaveText(INIT.D3)
  })

  test('A2: rows are virtualized and headers stay visible while scrolling', async ({ page }) => {
    await ready(page)
    expect(await renderedDataRows(page)).toBeLessThanOrEqual(200)
    await scrollGrid(page, 150_000, null)
    expect(await renderedDataRows(page)).toBeLessThanOrEqual(200)
    const g = (await grid(page).boundingBox())!
    const colA = (await grid(page).locator('[role="columnheader"][aria-colindex="2"]').boundingBox())!
    expect(colA.y, 'column header row stays at the top').toBeLessThan(g.y + 60)
    expect(colA.y).toBeGreaterThanOrEqual(g.y - 1)
    // A row far from the viewport that isn't the active cell: an aria-activedescendant grid may keep
    // the active row (A1 here) mounted, which the spec allows.
    await expect(cell(page, 'A10')).toHaveCount(0)
    await scrollGrid(page, null, 5000)
    const rowHeader = (await grid(page).locator('[role="rowheader"]').first().boundingBox())!
    expect(rowHeader.x, 'row numbers stay at the left').toBeLessThan(g.x + 80)
    expect(rowHeader.x).toBeGreaterThanOrEqual(g.x - 1)
  })

  test('A3: the grid is one Tab stop, A1 is active first, Tab leaves the grid', async ({ page }) => {
    await ready(page)
    await focusGrid(page)
    await expect(nameBox(page)).toHaveValue('A1')
    await page.keyboard.press('Tab')
    expect(await grid(page).evaluate((el) => el.contains(document.activeElement))).toBe(false)
  })

  test('A4: arrow keys move the active cell and stop at edges; the bars follow', async ({ page }) => {
    await ready(page)
    await focusGrid(page)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(nameBox(page)).toHaveValue('C1')
    await expect(contents(page)).toHaveValue(INIT.C1)
    await page.keyboard.press('ArrowDown')
    await expect(nameBox(page)).toHaveValue('C2')
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowUp')
    await expect(nameBox(page)).toHaveValue('C1')
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft')
    await expect(nameBox(page)).toHaveValue('A1')
    expect(await gridHasFocus(page)).toBe(true)
  })

  test('A5: Home/End and Ctrl+Home/Ctrl+End reach row ends and corners', async ({ page }) => {
    await ready(page)
    await focusGrid(page)
    await page.keyboard.press('End')
    await expect(nameBox(page)).toHaveValue('Z1')
    expect(await isInGridView(page, 'Z1')).toBe(true)
    await page.keyboard.press('Home')
    await expect(nameBox(page)).toHaveValue('A1')
    await page.keyboard.press('Control+End')
    await expect(nameBox(page)).toHaveValue('Z10000')
    await expect(cell(page, 'Z10000')).toHaveCount(1)
    expect(await isInGridView(page, 'Z10000')).toBe(true)
    expect(await gridHasFocus(page)).toBe(true)
    await page.keyboard.press('Control+Home')
    await expect(nameBox(page)).toHaveValue('A1')
    expect(await isInGridView(page, 'A1')).toBe(true)
  })

  test('A6: PageDown/PageUp move by a page and keep the active cell visible', async ({ page }) => {
    await ready(page)
    await focusGrid(page)
    await page.keyboard.press('PageDown')
    const addr = await activeAddress(page)
    const row = Number(addr.slice(1))
    expect(row).toBeGreaterThan(5)
    expect(await isInGridView(page, addr)).toBe(true)
    await page.keyboard.press('PageDown')
    const row2 = Number((await activeAddress(page)).slice(1))
    expect(row2).toBeGreaterThan(row)
    expect(await isInGridView(page, await activeAddress(page))).toBe(true)
    await page.keyboard.press('PageUp')
    await page.keyboard.press('PageUp')
    await expect(nameBox(page)).toHaveValue('A1')
  })

  test('A7: entering an address in Cell reference jumps there and focuses the grid', async ({ page }) => {
    await ready(page)
    await goTo(page, 'M5000')
    await expect(cell(page, 'M5000')).toHaveCount(1)
    expect(await isInGridView(page, 'M5000')).toBe(true)
    expect(await gridHasFocus(page)).toBe(true)
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowLeft')
    await expect(nameBox(page)).toHaveValue('A5000')
    await expect(contents(page)).toHaveValue('Item 5000')
  })

  test('A8: Shift+Arrow extends a rectangular selection exposed with aria-selected', async ({ page }) => {
    await ready(page)
    await goTo(page, 'B2')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowDown')
    await expect(nameBox(page)).toHaveValue('B2:D5')
    for (const a of ['B2', 'C3', 'D5', 'B5', 'D2']) expect(await selected(page, a), `${a} selected`).toBe(true)
    for (const a of ['A2', 'E3', 'C6', 'B1']) expect(await selected(page, a), `${a} not selected`).toBe(false)
    await page.keyboard.press('ArrowDown')
    expect(await selected(page, 'B2')).toBe(false)
    expect((await activeAddress(page)).includes(':')).toBe(false)
  })

  test('A9: Shift+click and mouse drag select rectangles', async ({ page }) => {
    await ready(page)
    await cell(page, 'B3').click()
    await cell(page, 'D6').click({ modifiers: ['Shift'] })
    await expect(nameBox(page)).toHaveValue('B3:D6')
    const from = (await cell(page, 'F2').boundingBox())!
    const to = (await cell(page, 'G4').boundingBox())!
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect(nameBox(page)).toHaveValue('F2:G4')
    expect(await selected(page, 'G3')).toBe(true)
  })

  test('A10: Enter, F2, typing and double-click edit; Enter/Tab commit and move; Escape cancels', async ({ page }) => {
    await ready(page)
    await goTo(page, 'E1')
    await page.keyboard.press('Enter')
    const ed = page.getByRole('textbox', { name: 'Edit E1' })
    await expect(ed).toBeFocused()
    await page.keyboard.type('hello')
    await page.keyboard.press('Enter')
    await expect(cell(page, 'E1')).toHaveText('hello')
    await expect(nameBox(page)).toHaveValue('E2')
    expect(await gridHasFocus(page)).toBe(true)
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('F2')
    await expect(page.getByRole('textbox', { name: 'Edit E1' })).toHaveValue('hello')
    await page.keyboard.type(' world')
    await page.keyboard.press('Tab')
    await expect(cell(page, 'E1')).toHaveText('hello world')
    await expect(nameBox(page)).toHaveValue('F1')
    await page.keyboard.type('x')
    await expect(page.getByRole('textbox', { name: 'Edit F1' })).toHaveValue('x')
    await page.keyboard.press('Escape')
    await expect(cell(page, 'F1')).toHaveText('')
    await expect(nameBox(page)).toHaveValue('F1')
    expect(await gridHasFocus(page)).toBe(true)
    await cell(page, 'E1').dblclick()
    await expect(page.getByRole('textbox', { name: 'Edit E1' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(cell(page, 'E1')).toHaveText('hello world')
  })

  test('A11: Delete clears the selection and each action is one saveCells call', async ({ page }) => {
    await ready(page)
    await goTo(page, 'E1')
    await page.keyboard.press('Enter')
    await page.keyboard.type('saved')
    await page.keyboard.press('Enter')
    const [first] = await waitForCalls(page, 'saveCells')
    expect(first.args[0]).toEqual({ E1: 'saved' })
    await goTo(page, 'B1')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Delete')
    for (const a of ['B1', 'C1', 'B2', 'C2']) await expect(cell(page, a)).toHaveText('')
    const calls = await waitForCalls(page, 'saveCells', 2)
    expect(calls).toHaveLength(2)
    expect(calls[1].args[0]).toEqual({ B1: '', C1: '', B2: '', C2: '' })
  })

  test('A12: copy, paste and cut use tab-separated values', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await ready(page)
    await goTo(page, 'A1')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Control+c')
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied.replace(/\r/g, '').replace(/\n$/, '')).toBe(`Item 1\t${INIT.B1}\nItem 2\t${INIT.B2}`)
    await page.evaluate(() => navigator.clipboard.writeText('p\tq\nr\ts'))
    await goTo(page, 'E10')
    await page.keyboard.press('Control+v')
    await expect(cell(page, 'E10')).toHaveText('p')
    await expect(cell(page, 'F10')).toHaveText('q')
    await expect(cell(page, 'E11')).toHaveText('r')
    await expect(cell(page, 'F11')).toHaveText('s')
    await expect(nameBox(page)).toHaveValue('E10:F11')
    const saves = await waitForCalls(page, 'saveCells')
    expect(saves.at(-1)!.args[0]).toEqual({ E10: 'p', F10: 'q', E11: 'r', F11: 's' })
    await goTo(page, 'E10')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Control+x')
    expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r?\n$/, '')).toBe('p\tq')
    await expect(cell(page, 'E10')).toHaveText('')
    await expect(cell(page, 'F10')).toHaveText('')
  })

  test('A13: focus stays in the grid when the active cell scrolls away; the next arrow brings it back', async ({ page }) => {
    await ready(page)
    await focusGrid(page)
    await page.keyboard.press('ArrowDown')
    await expect(nameBox(page)).toHaveValue('A2')
    const g = (await grid(page).boundingBox())!
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
    for (let i = 0; i < 15; i++) await page.mouse.wheel(0, 4000)
    await page.waitForTimeout(400)
    // The active cell has left the visible area. It may stay mounted (needed for aria-activedescendant).
    expect(await isOutOfView(page, 'A2'), 'A2 scrolled out of view').toBe(true)
    await expect(nameBox(page)).toHaveValue('A2')
    expect(await gridHasFocus(page), 'focus did not fall to <body>').toBe(true)
    await page.keyboard.press('ArrowDown')
    await expect(nameBox(page)).toHaveValue('A3')
    expect(await isInGridView(page, 'A3')).toBe(true)
  })

  test('A14: a failed save shows an alert with Retry, which saves again', async ({ page }) => {
    await ready(page, { failOnce: ['saveCells'] })
    await goTo(page, 'E1')
    await page.keyboard.press('Enter')
    await page.keyboard.type('z')
    await page.keyboard.press('Enter')
    const alert = page.getByRole('alert').filter({ hasText: loose("Couldn't save changes") })
    await expect(alert).toBeVisible()
    await expect(cell(page, 'E1')).toHaveText('z')
    await page.getByRole('button', { name: 'Retry' }).click()
    const calls = await waitForCalls(page, 'saveCells', 2)
    expect(calls[1].args[0]).toMatchObject({ E1: 'z' })
    await expect(alert).toBeHidden()
    expect((await mockCalls(page, 'saveCells')).at(-1)!.outcome).toBe('ok')
  })

  test.describe('mobile', () => {
    test.use({ viewport: { width: 375, height: 740 } })
    test('A15: at 375 px the page does not scroll horizontally and the grid fills the width', async ({ page }) => {
      await ready(page)
      expect(await noHorizontalScroll(page)).toBe(true)
      const box = (await grid(page).boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(330)
      expect(box.x + box.width).toBeLessThanOrEqual(376)
    })
  })

  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${scheme} mode`, () => {
      test.use({ colorScheme: scheme })
      test(`A15: ${scheme} mode renders readable content`, async ({ page }) => {
        await ready(page)
        await expectReadableTheme(page.getByRole('heading', { name: 'Sheet' }), scheme)
        await expectReadableTheme(cell(page, 'A1'), scheme)
      })
    })
  }

  test('axe: grid, range selection and editor', async ({ page }) => {
    const problems: string[] = []
    await ready(page)
    problems.push(...(await axeCheck(page, 'sheet-grid')))
    await goTo(page, 'B2')
    await page.keyboard.press('Shift+ArrowDown')
    problems.push(...(await axeCheck(page, 'sheet-selection')))
    await page.keyboard.press('Enter')
    problems.push(...(await axeCheck(page, 'sheet-editing')))
    expect(problems).toEqual([])
  })

  test.describe('axe dark', () => {
    test.use({ colorScheme: 'dark' })
    test('axe: grid in dark mode', async ({ page }) => {
      await ready(page)
      expect(await axeCheck(page, 'sheet-grid-dark')).toEqual([])
    })
  })

  test('kbd: navigate, edit and jump with the keyboard only', async ({ page }) => {
    await ready(page)
    for (let i = 0; i < 15 && !(await gridHasFocus(page)); i++) await page.keyboard.press('Tab')
    expect(await gridHasFocus(page)).toBe(true)
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(nameBox(page)).toHaveValue('E3')
    await page.keyboard.press('Enter')
    await page.keyboard.type('kbd')
    await page.keyboard.press('Enter')
    await expect(cell(page, 'E3')).toHaveText('kbd')
    for (let i = 0; i < 6 && !(await nameBox(page).evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Shift+Tab')
    await expect(nameBox(page)).toBeFocused()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('Z9999')
    await page.keyboard.press('Enter')
    await expect(nameBox(page)).toHaveValue('Z9999')
    expect(await isInGridView(page, 'Z9999')).toBe(true)
    await page.keyboard.press('Control+Home')
    await expect(nameBox(page)).toHaveValue('A1')
  })
})
