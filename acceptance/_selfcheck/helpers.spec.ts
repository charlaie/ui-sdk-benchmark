import { expect, test } from '@playwright/test'
import { chooseOption, displayedValue, expectReadableTheme, focusedInfo, inLiveRegion, isDisabled, loose, optionLabels, textContrast } from '../helpers'

test('native select helpers', async ({ page }) => {
  await page.setContent(`<label>Start time <select id=s><option value="">Choose</option><option>09:00</option><option>09:30</option></select></label>`)
  const f = page.getByRole('combobox', { name: 'Start time' })
  expect(await optionLabels(page, f)).toEqual(['Choose', '09:00', '09:30'])
  await chooseOption(page, f, '09:30')
  expect(await displayedValue(f)).toBe('09:30')
})

test('custom listbox helpers', async ({ page }) => {
  await page.setContent(`<button role=combobox aria-label="Duration" aria-expanded=false id=b>30 min</button><div id=l hidden role=listbox><div role=option>15 min</div><div role=option>30 min</div></div>
  <script>b.onclick=()=>{l.hidden=!l.hidden};l.onclick=(e)=>{b.textContent=e.target.textContent;l.hidden=true};document.onkeydown=(e)=>{if(e.key==='Escape')l.hidden=true}</script>`)
  const f = page.getByRole('combobox', { name: 'Duration' })
  expect(await optionLabels(page, f)).toEqual(['15 min', '30 min'])
  await chooseOption(page, f, '15 min')
  expect(await displayedValue(f)).toBe('15 min')
})

test('contrast, live region, disabled, focus, loose', async ({ page }) => {
  await page.setContent(`<div style="background:#111;color:#eee"><h1 id=h>Dark</h1></div><h2 id=l style="color:#222">Light</h2><div role=status><span id=s>Searching…</span></div><div role=gridcell aria-disabled=true><button id=d>9</button></div><input id=i aria-activedescendant=o><div id=o role=option aria-label="Ana Ruiz">x</div>`)
  await expectReadableTheme(page.locator('#h'), 'dark')
  await expectReadableTheme(page.locator('#l'), 'light')
  expect((await textContrast(page.locator('#h'))).contrast).toBeGreaterThan(10)
  expect(await inLiveRegion(page.locator('#s'))).toBe(true)
  expect(await isDisabled(page.locator('#d'))).toBe(true)
  await page.locator('#i').focus()
  expect((await focusedInfo(page)).label).toContain('Ana Ruiz')
  expect(loose("Couldn't load people").test('Couldn’t load people')).toBe(true)
  expect(loose('Searching…').test('Searching...')).toBe(true)
})

test('dark theme with oklch tokens (shadcn-style) resolves', async ({ page }) => {
  await page.setContent(`<html style="background:oklch(0.145 0 0)"><body><p id=p style="color:oklch(0.985 0 0)">Text</p></body></html>`)
  await expectReadableTheme(page.locator('#p'), 'dark')
})
