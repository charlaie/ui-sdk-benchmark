// Shared helpers for the hidden acceptance suites. Everything here works through roles, accessible
// names, the task's accessibility contract and the mock API call log (window.__mock.calls), never
// through library-specific markup.
import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Locator, type Page } from '@playwright/test'

export interface OpenOptions {
  /** Latency in ms for every mock operation (default 30, to keep tests fast). */
  latency?: number
  /** Per-operation latency overrides. */
  opLatency?: Record<string, number>
  fail?: string[]
  failOnce?: string[]
  theme?: 'light' | 'dark'
}

export function appUrl(opts: OpenOptions = {}): string {
  const params = new URLSearchParams()
  const lat = [String(opts.latency ?? 30), ...Object.entries(opts.opLatency ?? {}).map(([k, v]) => `${k}:${v}`)]
  params.set('mock-latency', lat.join(','))
  if (opts.fail?.length) params.set('mock-fail', opts.fail.join(','))
  if (opts.failOnce?.length) params.set('mock-fail-once', opts.failOnce.join(','))
  if (opts.theme) params.set('theme', opts.theme)
  return `./?${params.toString()}`
}

export async function open(page: Page, opts: OpenOptions = {}) {
  await page.goto(appUrl(opts))
}

export interface MockCall {
  op: string
  args: unknown[]
  outcome?: string
}

export async function mockCalls(page: Page, op?: string): Promise<MockCall[]> {
  const calls = (await page.evaluate(() => (window as unknown as { __mock?: { calls: MockCall[] } }).__mock?.calls ?? [])) as MockCall[]
  return op ? calls.filter((c) => c.op === op) : calls
}

export async function waitForCalls(page: Page, op: string, count = 1, timeout = 10_000) {
  await expect.poll(async () => (await mockCalls(page, op)).length, { timeout, message: `waiting for ${count} call(s) to ${op}` }).toBeGreaterThanOrEqual(count)
  return mockCalls(page, op)
}

/** Text that may use a typographic or ASCII apostrophe / ellipsis. */
export function loose(text: string): RegExp {
  const esc = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['’]/g, "['’]").replace(/…/g, '(…|\\.\\.\\.)')
  return new RegExp(esc, 'i')
}

export async function noHorizontalScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
}

/** True if the element is inside a live region (aria-live, or an implicit live role). */
export async function inLiveRegion(locator: Locator) {
  return locator.evaluate((el) => !!el.closest('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]'))
}

/** Text of every live region on the page (for checking announcements). */
export async function liveRegionText(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]')].map((e) => (e as HTMLElement).innerText || e.textContent || '').join('\n'),
  )
}

/** Description of the focused element (following aria-activedescendant) for assertions. */
export async function focusedInfo(page: Page) {
  return page.evaluate(() => {
    let el = document.activeElement as HTMLElement | null
    const ad = el?.getAttribute('aria-activedescendant')
    const active = ad ? document.getElementById(ad) : null
    const describe = (e: HTMLElement | null) => {
      if (!e) return ''
      const lb = e.getAttribute('aria-labelledby')
      const labelled = lb ? lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : ''
      // A focused container (a menu or listbox with no active item yet, say) is described by its name
      // only: its text holds every item's text and would match whichever item a test looks for.
      const container = /^(menu|menubar|listbox|grid|treegrid|tree|tablist|radiogroup|toolbar|dialog|alertdialog)$/.test(e.getAttribute('role') ?? '')
      const text = container ? '' : (e.innerText ?? e.textContent ?? '').slice(0, 200)
      return [e.getAttribute('aria-label') ?? '', labelled, e.getAttribute('title') ?? '', text].join(' | ')
    }
    if (active) el = active
    return {
      tag: el?.tagName.toLowerCase() ?? null,
      role: el?.getAttribute('role') ?? null,
      label: describe(el),
      isBody: document.activeElement === document.body || !document.activeElement,
    }
  })
}

/** Is `locator` (or something inside it) the focused element? */
export async function containsFocus(locator: Locator) {
  return locator.evaluate((el) => el.contains(document.activeElement))
}

export async function isDisabled(locator: Locator) {
  return locator.evaluate((el) => (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true' || !!el.closest('[aria-disabled="true"]'))
}

/** Option labels of a select-like control (native <select> or a combobox/button with a listbox). */
export async function optionLabels(page: Page, field: Locator): Promise<string[]> {
  if ((await field.evaluate((el) => el.tagName)) === 'SELECT') {
    return field.evaluate((el) => [...(el as HTMLSelectElement).options].filter((o) => !o.disabled || o.value).map((o) => o.text.trim()).filter(Boolean))
  }
  const before = await page.getByRole('listbox').count()
  await field.click()
  const listbox = page.getByRole('listbox').last()
  await expect(listbox).toBeVisible()
  const labels = (await listbox.getByRole('option').allInnerTexts()).map((t) => t.trim())
  await page.keyboard.press('Escape')
  // Wait for the popup to finish closing, so the next call never reads this listbox.
  await expect(page.getByRole('listbox')).toHaveCount(before)
  return labels
}

/** Choose an option in a select-like control by its visible label. */
export async function chooseOption(page: Page, field: Locator, label: string) {
  if ((await field.evaluate((el) => el.tagName)) === 'SELECT') {
    await field.selectOption({ label })
    return
  }
  await field.click()
  await page.getByRole('option', { name: label, exact: true }).last().click()
}

/** Current displayed value of a select-like control. */
export async function displayedValue(field: Locator) {
  return field.evaluate((el) => {
    if (el.tagName === 'SELECT') return ((el as HTMLSelectElement).selectedOptions[0]?.text ?? '').trim()
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return (el as HTMLInputElement).value.trim()
    return (el.textContent ?? '').trim()
  })
}

/** Press Tab until `predicate` holds for the focused element (keyboard-only navigation). */
export async function tabTo(page: Page, target: Locator, max = 40) {
  for (let i = 0; i < max; i++) {
    // Short timeout: a missing target should fail fast, not wait out the action timeout on every press.
    if (await target.evaluate((el) => el === document.activeElement || el.contains(document.activeElement), undefined, { timeout: 500 }).catch(() => false)) return
    await page.keyboard.press('Tab')
  }
  throw new Error('tabTo: target never received focus')
}

function luminance([r, g, b]: number[]) {
  const c = [r, g, b].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/** Contrast of `locator`'s text against its effective background, plus that background's luminance. */
export async function textContrast(locator: Locator) {
  // Let colour transitions (a theme fading in after load, hover states) finish before measuring.
  await locator.evaluate(() => Promise.race([Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))), new Promise((r) => setTimeout(r, 3000))]))
  const { fg, bg } = await locator.evaluate((el) => {
    const parse = (s: string) => {
      const m = s.match(/rgba?\(([^)]+)\)/)
      if (m) {
        const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
        return [p[0], p[1], p[2], p[3] ?? 1]
      }
      const ctx = document.createElement('canvas').getContext('2d')!
      ctx.fillStyle = s
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return [d[0], d[1], d[2], d[3] / 255]
    }
    const fg = parse(getComputedStyle(el).color)
    let node: Element | null = el
    let bg = [255, 255, 255, 1]
    while (node) {
      const c = parse(getComputedStyle(node).backgroundColor)
      if (c[3] > 0.5) {
        bg = c
        break
      }
      node = node.parentElement
    }
    if (!node) {
      const root = parse(getComputedStyle(document.documentElement).backgroundColor)
      if (root[3] > 0.5) bg = root
      else if (getComputedStyle(document.documentElement).colorScheme.includes('dark') && document.documentElement.classList.contains('dark')) bg = [18, 18, 18, 1]
    }
    return { fg, bg }
  })
  const l1 = luminance(fg)
  const l2 = luminance(bg)
  return { contrast: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05), bgLuminance: l2 }
}

export async function expectReadableTheme(locator: Locator, scheme: 'light' | 'dark', { background = true }: { background?: boolean } = {}) {
  // Retried for a few seconds: themes and colours may settle after the first render.
  await expect(async () => {
    const { contrast, bgLuminance } = await textContrast(locator)
    expect(contrast, `text contrast in ${scheme} mode`).toBeGreaterThanOrEqual(4.5)
    if (!background) return
    if (scheme === 'dark') expect(bgLuminance, 'background should be dark in dark mode').toBeLessThan(0.2)
    else expect(bgLuminance, 'background should be light in light mode').toBeGreaterThan(0.5)
  }).toPass({ timeout: 4000 })
}

/**
 * Run axe on the current page state and save the result to RESULTS_DIR/axe-<name>.json.
 * Returns the serious and critical violations (the tests fail on those; all are recorded).
 */
export async function axeCheck(page: Page, name: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  const dir = process.env.RESULTS_DIR
  if (dir) {
    fs.mkdirSync(dir, { recursive: true })
    const slim = results.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) }))
    fs.writeFileSync(path.join(dir, `axe-${name}.json`), JSON.stringify({ url: page.url(), violations: slim }, null, 2))
  }
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.impact}): ${v.help} x${v.nodes.length}`)
}
