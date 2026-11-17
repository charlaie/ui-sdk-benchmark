import { expect, test, type Locator, type Page } from '@playwright/test'
import { INITIAL_FLOW, NODE_TYPE_LABELS, type FlowDocument } from '../../tasks/04-flow-canvas/mock/fixtures'
import { axeCheck, expectReadableTheme, focusedInfo, liveRegionText, loose, mockCalls, noHorizontalScroll, open, waitForCalls, type OpenOptions } from '../helpers'

const canvas = (page: Page) => page.getByRole('application', { name: 'Flow canvas' })
const nodeById = (page: Page, id: string) => canvas(page).locator(`[data-node-id="${id}"]`)
const nodeByName = (page: Page, name: string) => canvas(page).getByRole('group', { name, exact: true })
const btn = (page: Page, name: string) => page.getByRole('button', { name, exact: true })

async function ready(page: Page, opts: OpenOptions = {}) {
  await open(page, opts)
  await expect(nodeById(page, 'n-start')).toBeVisible({ timeout: 10_000 })
}

async function edges(page: Page) {
  return canvas(page)
    .locator('[data-edge-id]')
    .evaluateAll((els) => els.map((e) => ({ source: e.getAttribute('data-source'), port: e.getAttribute('data-source-port'), target: e.getAttribute('data-target') })))
}
const hasEdge = async (page: Page, source: string, port: string, target: string) => (await edges(page)).some((e) => e.source === source && e.port === port && e.target === target)

async function pos(node: Locator) {
  return { x: Number(await node.getAttribute('data-x')), y: Number(await node.getAttribute('data-y')) }
}

async function zoom(page: Page) {
  const text = await page.getByRole('toolbar', { name: 'Canvas controls' }).innerText()
  const m = /(\d+)\s*%/.exec(text)
  if (!m) throw new Error('zoom percentage not found in "Canvas controls"')
  return Number(m[1]) / 100
}

/** A point inside `within` whose topmost element is not a node, port, button or field. */
async function emptyPoint(page: Page, within: Locator, prefer: 'center' | 'bottom-left' = 'bottom-left') {
  const box = (await within.boundingBox())!
  const point = await page.evaluate(
    ({ box, prefer }) => {
      const candidates: [number, number][] = []
      for (let fy = 0.95; fy > 0.05; fy -= 0.05) for (let fx = 0.05; fx < 0.95; fx += 0.05) candidates.push([box.x + fx * box.width, box.y + fy * box.height])
      if (prefer === 'center') candidates.sort((a, b) => Math.hypot(a[0] - box.x - box.width / 2, a[1] - box.y - box.height / 2) - Math.hypot(b[0] - box.x - box.width / 2, b[1] - box.y - box.height / 2))
      for (const [x, y] of candidates) {
        const el = document.elementFromPoint(x, y)
        if (el && el.closest('[role="application"]') && !el.closest('[data-node-id], [data-edge-id], button, input, textarea, select, a, [role="menu"], [role="toolbar"]')) return { x, y }
      }
      return null
    },
    { box, prefer },
  )
  if (!point) throw new Error('no empty canvas point found')
  return point
}

/** A point inside a node that is not on one of its buttons or fields. */
async function grabPoint(page: Page, node: Locator) {
  const id = await node.getAttribute('data-node-id')
  const box = (await node.boundingBox())!
  const p = await page.evaluate(
    ({ box, id }) => {
      for (let fy = 0.2; fy < 0.9; fy += 0.1)
        for (let fx = 0.3; fx < 0.8; fx += 0.1) {
          const x = box.x + fx * box.width
          const y = box.y + fy * box.height
          const el = document.elementFromPoint(x, y)
          if (el?.closest('[data-node-id]')?.getAttribute('data-node-id') === id && !el.closest('button, input, textarea, select, a')) return { x, y }
        }
      return null
    },
    { box, id },
  )
  if (!p) throw new Error(`no grab point on node ${id}`)
  return p
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, modifiers: string[] = []) {
  for (const m of modifiers) await page.keyboard.down(m)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + (to.x - from.x) / 3, from.y + (to.y - from.y) / 3, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
  for (const m of modifiers) await page.keyboard.up(m)
}

const center = async (l: Locator) => {
  const b = (await l.boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/** Clear the selection with Escape from a focused node (the spec's keyboard contract); the app may select a node on load. */
async function clearSelection(page: Page) {
  await nodeById(page, 'n-start').focus()
  await page.keyboard.press('Escape')
  await expect(canvas(page).locator('[data-node-id][data-selected="true"]')).toHaveCount(0)
}

async function fit(page: Page) {
  await btn(page, 'Fit to view').click()
  await page.waitForTimeout(300)
}

async function lastSaved(page: Page) {
  const calls = await mockCalls(page, 'saveFlow')
  return calls.at(-1)?.args[0] as FlowDocument | undefined
}

test.describe('agent flow canvas', () => {
  test('A1: the flow loads and is exposed through the accessibility contract', async ({ page }) => {
    await open(page, { opLatency: { loadFlow: 1500 } })
    await expect(page.getByText(loose('Loading flow…')).first()).toBeVisible()
    await expect(nodeById(page, 'n-start')).toBeVisible({ timeout: 10_000 })
    await expect(canvas(page).locator('[data-node-id]')).toHaveCount(INITIAL_FLOW.nodes.length)
    for (const n of INITIAL_FLOW.nodes) {
      const node = nodeById(page, n.id)
      await expect(node).toHaveAttribute('role', 'group')
      await expect(node).toHaveAttribute('aria-roledescription', 'node')
      await expect(node).toHaveAccessibleName(`${NODE_TYPE_LABELS[n.type]}: ${n.title}`)
      expect(await pos(node)).toEqual(n.position)
      // The spec doesn't say what is selected on load, only that the attribute is "true" or "false".
      await expect(node).toHaveAttribute('data-selected', /^(true|false)$/)
      await expect(node).toHaveAttribute('data-run-state', 'idle')
    }
    const e = await edges(page)
    expect(e).toHaveLength(INITIAL_FLOW.edges.length)
    for (const x of INITIAL_FLOW.edges) expect(await hasEdge(page, x.source, x.sourcePort, x.target), `edge ${x.id}`).toBe(true)
    await expect(btn(page, 'Output Success of Look up order')).toHaveCount(1)
    await expect(btn(page, 'Output Else of Check status')).toHaveCount(1)
    await expect(btn(page, 'Input of Greeting')).toHaveCount(1)
    await expect(btn(page, 'Input of Start')).toHaveCount(0)
    await open(page, { failOnce: ['loadFlow'] })
    await expect(page.getByText(loose("Couldn't load flow")).first()).toBeVisible()
    await btn(page, 'Retry').click()
    await expect(nodeById(page, 'n-start')).toBeVisible()
  })

  test('A2: pan by dragging, zoom with Ctrl+wheel and buttons, fit to view', async ({ page }) => {
    await ready(page)
    const z0 = await zoom(page)
    await btn(page, 'Zoom in').click()
    expect(await zoom(page)).toBeCloseTo(Math.min(2, z0 * 1.25), 1)
    await btn(page, 'Zoom out').click()
    expect(await zoom(page)).toBeCloseTo(z0, 1)
    const before = (await nodeById(page, 'n-greet').boundingBox())!
    const p = await emptyPoint(page, canvas(page))
    await drag(page, p, { x: p.x + 100, y: p.y - 40 })
    const after = (await nodeById(page, 'n-greet').boundingBox())!
    expect(after.x - before.x).toBeGreaterThan(80)
    expect(after.x - before.x).toBeLessThan(120)
    expect(await pos(nodeById(page, 'n-greet'))).toEqual({ x: 340, y: 220 })
    const c = await emptyPoint(page, canvas(page), 'center')
    await page.mouse.move(c.x, c.y)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -400)
    await page.keyboard.up('Control')
    await page.waitForTimeout(200)
    expect(await zoom(page)).toBeGreaterThan(z0)
    // Zoom further in before fitting; a "Zoom in" button disabled at the 200% maximum is fine.
    for (let i = 0; i < 3; i++) if (await btn(page, 'Zoom in').isEnabled()) await btn(page, 'Zoom in').click()
    await fit(page)
    expect(await zoom(page)).toBeLessThanOrEqual(1)
    const cb = (await canvas(page).boundingBox())!
    for (const n of INITIAL_FLOW.nodes) {
      const b = (await nodeById(page, n.id).boundingBox())!
      expect(b.x, `${n.id} inside after fit`).toBeGreaterThanOrEqual(cb.x - 1)
      expect(b.y).toBeGreaterThanOrEqual(cb.y - 1)
      expect(b.x + b.width).toBeLessThanOrEqual(cb.x + cb.width + 1)
      expect(b.y + b.height).toBeLessThanOrEqual(cb.y + cb.height + 1)
    }
  })

  test('A3: palette buttons add snapped, selected, focused nodes; dragging places them', async ({ page }) => {
    await ready(page)
    const palette = page.getByRole('toolbar', { name: 'Add node' })
    await palette.getByRole('button', { name: 'Add Message' }).click()
    const node = nodeByName(page, 'Message: Message 1')
    await expect(node).toBeVisible()
    await expect(node).toHaveAttribute('data-selected', 'true')
    expect(await node.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    const p = await pos(node)
    expect(p.x % 20).toBe(0)
    expect(p.y % 20).toBe(0)
    const cb = (await canvas(page).boundingBox())!
    const nc = await center(node)
    expect(Math.abs(nc.x - (cb.x + cb.width / 2))).toBeLessThan(200)
    expect(Math.abs(nc.y - (cb.y + cb.height / 2))).toBeLessThan(200)
    const target = await emptyPoint(page, canvas(page))
    // Convert the drop point to flow coordinates now: the app may pan to the new node after the drop.
    const ref = nodeById(page, 'n-start')
    const refBox = (await ref.boundingBox())!
    const refPos = await pos(ref)
    const z = await zoom(page)
    const dropFlow = { x: refPos.x + (target.x - refBox.x) / z, y: refPos.y + (target.y - refBox.y) / z }
    await palette.getByRole('button', { name: 'Add Question' }).dragTo(canvas(page), { targetPosition: { x: target.x - cb.x, y: target.y - cb.y } })
    const q = nodeByName(page, 'Question: Question 1')
    await expect(q).toBeVisible()
    const qp = await pos(q)
    expect(Math.abs(qp.x - dropFlow.x), 'node placed at the drop point (flow x)').toBeLessThan(250)
    expect(Math.abs(qp.y - dropFlow.y), 'node placed at the drop point (flow y)').toBeLessThan(250)
  })

  test('A4: "Add step after" and "Insert step between" insert and connect nodes', async ({ page }) => {
    await ready(page)
    await page.getByRole('toolbar', { name: 'Add node' }).getByRole('button', { name: 'Add Message' }).click()
    const m1 = nodeByName(page, 'Message: Message 1')
    const m1id = (await m1.getAttribute('data-node-id'))!
    await btn(page, 'Add step after Next of Message 1').click()
    const chooser = page.getByRole('menu', { name: 'Add step' })
    await expect(chooser).toBeVisible()
    for (const t of ['Message', 'Question', 'Condition', 'Action', 'End']) await expect(chooser.getByRole('menuitem', { name: t, exact: true })).toBeVisible()
    await chooser.getByRole('menuitem', { name: 'End', exact: true }).click()
    const end1 = nodeByName(page, 'End: End 1')
    await expect(end1).toBeVisible()
    const end1id = (await end1.getAttribute('data-node-id'))!
    expect(await hasEdge(page, m1id, 'next', end1id)).toBe(true)
    expect((await pos(end1)).x).toBeGreaterThan((await pos(m1)).x)
    const insert = btn(page, 'Insert step between Greeting and Ask order number')
    await insert.focus()
    await page.keyboard.press('Enter')
    await page.getByRole('menu', { name: 'Add step' }).getByRole('menuitem', { name: 'Message', exact: true }).click()
    const m2 = nodeByName(page, 'Message: Message 2')
    await expect(m2).toBeVisible()
    const m2id = (await m2.getAttribute('data-node-id'))!
    expect(await hasEdge(page, 'n-greet', 'next', m2id)).toBe(true)
    expect(await hasEdge(page, m2id, 'next', 'n-ask')).toBe(true)
    expect(await hasEdge(page, 'n-greet', 'next', 'n-ask')).toBe(false)
    const x = (await pos(m2)).x
    expect(x).toBeGreaterThan(340 - 40)
    expect(x).toBeLessThan(640 + 40)
  })

  test('A5: dragging from an output port connects; invalid drops do nothing and announce', async ({ page }) => {
    await ready(page)
    await fit(page)
    await drag(page, await center(btn(page, 'Output Next of Greeting')), await center(btn(page, 'Input of Not found')))
    await expect.poll(() => hasEdge(page, 'n-greet', 'next', 'n-notfound')).toBe(true)
    expect(await hasEdge(page, 'n-greet', 'next', 'n-ask')).toBe(false)
    const count = (await edges(page)).length
    await drag(page, await center(btn(page, 'Output Next of Shipped reply')), await grabPoint(page, nodeById(page, 'n-start')))
    await expect.poll(() => liveRegionText(page)).toMatch(loose("Can't connect"))
    expect(await hasEdge(page, 'n-shipped', 'next', 'n-start')).toBe(false)
    await drag(page, await center(btn(page, 'Output Next of Processing reply')), await grabPoint(page, nodeById(page, 'n-processing')))
    expect(await hasEdge(page, 'n-processing', 'next', 'n-processing')).toBe(false)
    await drag(page, await center(btn(page, 'Input of Other reply')), await center(btn(page, 'Input of Shipped reply')))
    expect((await edges(page)).length).toBe(count)
    expect(await hasEdge(page, 'n-shipped', 'next', 'n-end')).toBe(true)
  })

  test('A6: activating an output port lists valid targets, connects, announces, and disconnects', async ({ page }) => {
    await ready(page)
    const port = btn(page, 'Output Next of Shipped reply')
    await port.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu').last()
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Message: Not found' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Trigger: Start' })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: 'Message: Shipped reply' })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: 'Disconnect' })).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Message: Not found' }).click()
    await expect.poll(() => hasEdge(page, 'n-shipped', 'next', 'n-notfound')).toBe(true)
    expect(await hasEdge(page, 'n-shipped', 'next', 'n-end')).toBe(false)
    await expect.poll(() => liveRegionText(page)).toMatch(/Connected Shipped reply to Not found/i)
    await port.focus()
    await page.keyboard.press('Enter')
    await page.getByRole('menu').last().getByRole('menuitem', { name: 'Disconnect' }).click()
    await expect.poll(async () => (await edges(page)).some((e) => e.source === 'n-shipped')).toBe(false)
    await expect.poll(() => liveRegionText(page)).toMatch(/Disconnected Shipped reply from Not found/i)
  })

  test('A7: dragging nodes moves them with 20 px snapping, and moves the whole selection', async ({ page }) => {
    await ready(page)
    // The spec doesn't require every node to be visible on load; Fit to view guarantees it.
    await fit(page)
    const z = await zoom(page)
    const greet = nodeById(page, 'n-greet')
    const g = await grabPoint(page, greet)
    await drag(page, g, { x: g.x + 57 * z, y: g.y + 33 * z })
    const p = await pos(greet)
    expect(p.x % 20).toBe(0)
    expect(p.y % 20).toBe(0)
    expect(Math.abs(p.x - 397)).toBeLessThanOrEqual(20)
    expect(Math.abs(p.y - 253)).toBeLessThanOrEqual(20)
    const ask0 = await pos(nodeById(page, 'n-ask'))
    const askPoint = await grabPoint(page, nodeById(page, 'n-ask'))
    await page.mouse.click(askPoint.x, askPoint.y)
    const lk = await grabPoint(page, nodeById(page, 'n-lookup'))
    await page.keyboard.down('Shift')
    await page.mouse.click(lk.x, lk.y)
    await page.keyboard.up('Shift')
    await expect(nodeById(page, 'n-ask')).toHaveAttribute('data-selected', 'true')
    await expect(nodeById(page, 'n-lookup')).toHaveAttribute('data-selected', 'true')
    const lk0 = await pos(nodeById(page, 'n-lookup'))
    const a = await grabPoint(page, nodeById(page, 'n-ask'))
    await drag(page, a, { x: a.x, y: a.y + 100 * z })
    expect((await pos(nodeById(page, 'n-ask'))).y - ask0.y).toBe(100)
    expect((await pos(nodeById(page, 'n-lookup'))).y - lk0.y).toBe(100)
  })

  test('A8: Shift+click and lasso select several nodes; Ctrl+A and Escape', async ({ page }) => {
    await ready(page)
    await fit(page)
    const s = (await nodeById(page, 'n-shipped').boundingBox())!
    const pr = (await nodeById(page, 'n-processing').boundingBox())!
    await drag(page, { x: s.x - 12, y: s.y - 12 }, { x: pr.x + pr.width + 12, y: pr.y + pr.height + 6 }, ['Shift'])
    await expect(nodeById(page, 'n-shipped')).toHaveAttribute('data-selected', 'true')
    await expect(nodeById(page, 'n-processing')).toHaveAttribute('data-selected', 'true')
    await expect(nodeById(page, 'n-greet')).toHaveAttribute('data-selected', 'false')
    const e = await emptyPoint(page, canvas(page))
    await page.mouse.click(e.x, e.y)
    await expect(canvas(page).locator('[data-selected="true"]')).toHaveCount(0)
    const g = await grabPoint(page, nodeById(page, 'n-greet'))
    await page.mouse.click(g.x, g.y)
    const k = await grabPoint(page, nodeById(page, 'n-check'))
    await page.keyboard.down('Shift')
    await page.mouse.click(k.x, k.y)
    await page.keyboard.up('Shift')
    await expect(canvas(page).locator('[data-selected="true"]')).toHaveCount(2)
    await page.keyboard.press('Control+a')
    await expect(canvas(page).locator('[data-selected="true"]')).toHaveCount(INITIAL_FLOW.nodes.length)
    await page.keyboard.press('Escape')
    await expect(canvas(page).locator('[data-selected="true"]')).toHaveCount(0)
  })

  test('A9: Delete removes nodes and edges (not the Trigger); duplicate copies with internal edges', async ({ page }) => {
    await ready(page)
    await fit(page)
    const nf = await grabPoint(page, nodeById(page, 'n-notfound'))
    await page.mouse.click(nf.x, nf.y)
    await page.keyboard.press('Delete')
    await expect(nodeById(page, 'n-notfound')).toHaveCount(0)
    expect((await edges(page)).some((x) => x.source === 'n-notfound' || x.target === 'n-notfound')).toBe(false)
    await expect.poll(() => liveRegionText(page)).toMatch(/Deleted 1 node/i)
    const st = await grabPoint(page, nodeById(page, 'n-start'))
    await page.mouse.click(st.x, st.y)
    await page.keyboard.press('Delete')
    await expect(nodeById(page, 'n-start')).toHaveCount(1)
    const g = await grabPoint(page, nodeById(page, 'n-greet'))
    await page.mouse.click(g.x, g.y)
    const a = await grabPoint(page, nodeById(page, 'n-ask'))
    await page.keyboard.down('Shift')
    await page.mouse.click(a.x, a.y)
    await page.keyboard.up('Shift')
    await page.keyboard.press('Control+d')
    const gc = nodeByName(page, 'Message: Greeting copy')
    const ac = nodeByName(page, 'Question: Ask order number copy')
    await expect(gc).toBeVisible()
    await expect(ac).toBeVisible()
    expect(await pos(gc)).toEqual({ x: 380, y: 260 })
    expect(await pos(ac)).toEqual({ x: 680, y: 260 })
    expect(await hasEdge(page, (await gc.getAttribute('data-node-id'))!, 'next', (await ac.getAttribute('data-node-id'))!)).toBe(true)
    await expect(gc).toHaveAttribute('data-selected', 'true')
    await expect(nodeById(page, 'n-greet')).toHaveAttribute('data-selected', 'false')
    await btn(page, 'More options for Shipped reply').click()
    await page.getByRole('menuitem', { name: 'Duplicate' }).click()
    await expect(nodeByName(page, 'Message: Shipped reply copy')).toBeVisible()
    await btn(page, 'More options for Start').click()
    const del = page.getByRole('menuitem', { name: 'Delete' })
    expect(await del.evaluate((el) => el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled === true || el.hasAttribute('data-disabled'))).toBe(true)
  })

  test('A10: the Properties panel shows the right fields, edits live, validates and edits branches', async ({ page }) => {
    await ready(page)
    await fit(page)
    await clearSelection(page)
    const props = page.getByRole('region', { name: 'Properties' }).or(page.getByRole('complementary', { name: 'Properties' })).first()
    await expect(props).toContainText('Select a node to edit its properties')
    const click = async (id: string) => {
      const p = await grabPoint(page, nodeById(page, id))
      await page.mouse.click(p.x, p.y)
    }
    await click('n-greet')
    await expect(props.getByRole('textbox', { name: 'Title' })).toHaveValue('Greeting')
    await expect(props.getByRole('textbox', { name: 'Message text' })).toHaveValue('Hi! I can help you track your order.')
    await props.getByRole('textbox', { name: 'Title' }).fill('Hello there')
    await expect(nodeById(page, 'n-greet')).toHaveAccessibleName('Message: Hello there')
    await click('n-ask')
    await expect(props.getByRole('textbox', { name: 'Question' })).toHaveValue("What's your order number?")
    const variable = props.getByRole('textbox', { name: 'Save answer as' })
    await expect(variable).toHaveValue('orderNumber')
    await expect(props.getByRole('combobox', { name: 'Answer type' }).or(props.getByRole('button', { name: /^Answer type/ })).or(props.getByRole('radiogroup', { name: 'Answer type' })).first()).toBeVisible()
    await variable.fill('1bad')
    await expect(props.getByText(/Use letters, numbers and underscores, and don.t start with a number/)).toBeVisible()
    await expect(variable).toHaveAttribute('aria-invalid', 'true')
    await click('n-check')
    await expect(props.getByRole('textbox', { name: 'Branch 1 label' })).toHaveValue('Shipped')
    await expect(props.getByRole('textbox', { name: 'Branch 2 condition' })).toHaveValue('order.status == "processing"')
    const ports = () => page.getByRole('button', { name: /^Output .+ of Check status$/ }).count()
    expect(await ports()).toBe(3)
    await props.getByRole('button', { name: 'Add branch' }).click()
    await expect(props.getByRole('textbox', { name: 'Branch 3 label' })).toBeVisible()
    await expect.poll(ports).toBe(4)
    await props.getByRole('button', { name: 'Remove branch 1' }).click()
    await expect(btn(page, 'Output Shipped of Check status')).toHaveCount(0)
    expect((await edges(page)).some((x) => x.source === 'n-check' && x.target === 'n-shipped')).toBe(false)
    await click('n-lookup')
    await expect(props.getByRole('combobox', { name: 'Tool' }).or(props.getByRole('button', { name: /^Tool/ })).first()).toContainText('Look up order').catch(async () => {
      expect(await props.getByRole('combobox', { name: 'Tool' }).evaluate((el) => (el as HTMLSelectElement).selectedOptions?.[0]?.text ?? '')).toBe('Look up order')
    })
    await click('n-start')
    await expect(props.getByRole('textbox', { name: 'Trigger phrases' })).toHaveValue(/Where is my order/)
    const e = await grabPoint(page, nodeById(page, 'n-end'))
    await page.keyboard.down('Shift')
    await page.mouse.click(e.x, e.y)
    await page.keyboard.up('Shift')
    await expect(props).toContainText('2 nodes selected')
  })

  test('A11: undo and redo reverse and reapply adds, moves, deletes and property edits', async ({ page }) => {
    await ready(page)
    await expect(btn(page, 'Undo')).toBeDisabled()
    await page.getByRole('toolbar', { name: 'Add node' }).getByRole('button', { name: 'Add Message' }).click()
    await expect(nodeByName(page, 'Message: Message 1')).toBeVisible()
    await nodeByName(page, 'Message: Message 1').focus()
    await page.keyboard.press('Control+z')
    await expect(nodeByName(page, 'Message: Message 1')).toHaveCount(0)
    await canvas(page).locator('[data-node-id="n-greet"]').focus()
    await page.keyboard.press('Control+Shift+z')
    await expect(nodeByName(page, 'Message: Message 1')).toHaveCount(1)
    const greet = nodeById(page, 'n-greet')
    await greet.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Alt+ArrowRight')
    expect((await pos(greet)).x).toBe(360)
    await btn(page, 'Undo').click()
    expect((await pos(greet)).x).toBe(340)
    await btn(page, 'Redo').click()
    expect((await pos(greet)).x).toBe(360)
    const nf = nodeById(page, 'n-notfound')
    await nf.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Delete')
    await expect(nf).toHaveCount(0)
    await greet.focus()
    await page.keyboard.press('Control+z')
    await expect(nodeById(page, 'n-notfound')).toHaveCount(1)
    expect(await hasEdge(page, 'n-lookup', 'failure', 'n-notfound')).toBe(true)
    expect(await hasEdge(page, 'n-notfound', 'next', 'n-end')).toBe(true)
    await greet.focus()
    await page.keyboard.press('Enter')
    const title = page.getByRole('region', { name: 'Properties' }).or(page.getByRole('complementary', { name: 'Properties' })).first().getByRole('textbox', { name: 'Title' })
    await title.fill('Renamed')
    await expect(greet).toHaveAccessibleName('Message: Renamed')
    await greet.focus()
    await page.keyboard.press('Control+z')
    await expect(greet).toHaveAccessibleName('Message: Greeting')
  })

  test('A12: arrow keys move focus between nodes; Space/Enter select; Alt+Arrow moves and announces', async ({ page }) => {
    await ready(page)
    await clearSelection(page)
    await nodeById(page, 'n-greet').focus()
    await page.keyboard.press('ArrowRight')
    await expect(nodeById(page, 'n-ask')).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(nodeById(page, 'n-greet')).toBeFocused()
    await page.keyboard.press('Space')
    await expect(nodeById(page, 'n-greet')).toHaveAttribute('data-selected', 'true')
    await page.keyboard.press('ArrowRight')
    await expect(nodeById(page, 'n-ask')).toBeFocused()
    await page.keyboard.press('Space')
    await expect(nodeById(page, 'n-ask')).toHaveAttribute('data-selected', 'true')
    await expect(nodeById(page, 'n-greet')).toHaveAttribute('data-selected', 'true')
    await page.keyboard.press('Enter')
    await expect(nodeById(page, 'n-greet')).toHaveAttribute('data-selected', 'false')
    await expect(nodeById(page, 'n-ask')).toHaveAttribute('data-selected', 'true')
    await page.keyboard.press('Alt+ArrowDown')
    expect(await pos(nodeById(page, 'n-ask'))).toEqual({ x: 640, y: 240 })
    await expect.poll(() => liveRegionText(page)).toMatch(/Moved Ask order number/i)
    await page.keyboard.press('Alt+Shift+ArrowRight')
    expect(await pos(nodeById(page, 'n-ask'))).toEqual({ x: 740, y: 240 })
    expect((await focusedInfo(page)).isBody).toBe(false)
  })

  test('A13: changes are autosaved with the current document and the status shows Saving… then Saved', async ({ page }) => {
    await ready(page, { opLatency: { saveFlow: 1500 } })
    await nodeById(page, 'n-ask').focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Alt+ArrowDown')
    await expect(page.getByText(loose('Saving…')).first()).toBeVisible({ timeout: 4000 })
    await expect(page.getByText(/^\s*Saved\s*$/).first()).toBeVisible({ timeout: 8000 })
    const doc = (await lastSaved(page))!
    expect(doc.nodes).toHaveLength(INITIAL_FLOW.nodes.length)
    expect(doc.edges).toHaveLength(INITIAL_FLOW.edges.length)
    expect(doc.nodes.find((n) => n.id === 'n-ask')!.position).toEqual({ x: 640, y: 240 })
    expect(doc.nodes.find((n) => n.id === 'n-greet')).toEqual(INITIAL_FLOW.nodes.find((n) => n.id === 'n-greet'))
  })

  test('A14: a failed save shows "Save failed" and Retry saves', async ({ page }) => {
    await ready(page, { failOnce: ['saveFlow'] })
    await nodeById(page, 'n-ask').focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Alt+ArrowDown')
    await expect(page.getByText(/Save failed/i).first()).toBeVisible({ timeout: 6000 })
    await btn(page, 'Retry').click()
    await expect(page.getByText(/^\s*Saved\s*$/).first()).toBeVisible({ timeout: 6000 })
    const calls = await waitForCalls(page, 'saveFlow', 2)
    expect(calls.at(-1)!.outcome).toBe('ok')
  })

  test('A15: Test run highlights each step, logs them, completes, and can be stopped', async ({ page }) => {
    await ready(page)
    await btn(page, 'Test run').click()
    await expect(btn(page, 'Stop test run')).toBeVisible()
    await expect(nodeById(page, 'n-greet')).toHaveAttribute('data-run-state', 'running', { timeout: 4000 })
    await expect(nodeById(page, 'n-greet')).toHaveAttribute('data-run-state', 'done', { timeout: 4000 })
    const log = page.getByRole('log', { name: 'Test run' })
    await expect(log).toContainText('Greeting')
    await expect(log).toContainText('Run completed', { timeout: 15_000 })
    await expect(nodeById(page, 'n-end')).toHaveAttribute('data-run-state', 'done')
    await expect(nodeById(page, 'n-notfound')).toHaveAttribute('data-run-state', 'idle')
    await btn(page, 'Test run').click()
    await expect(nodeById(page, 'n-end')).toHaveAttribute('data-run-state', 'idle', { timeout: 2000 })
    await expect(nodeById(page, 'n-greet')).toHaveAttribute('data-run-state', 'running', { timeout: 4000 })
    await btn(page, 'Stop test run').click()
    await expect(log).toContainText('Run stopped', { timeout: 4000 })
    await expect(btn(page, 'Test run')).toBeVisible()
  })

  test.describe('mobile', () => {
    test.use({ viewport: { width: 375, height: 740 } })
    test('A16: at 375 px no horizontal scrolling and the canvas uses the full width', async ({ page }) => {
      await ready(page)
      expect(await noHorizontalScroll(page)).toBe(true)
      const b = (await canvas(page).boundingBox())!
      expect(b.width).toBeGreaterThanOrEqual(360)
      await expect(btn(page, 'Test run')).toBeVisible()
    })
  })

  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${scheme} mode`, () => {
      test.use({ colorScheme: scheme })
      test(`A16: ${scheme} mode renders readable content`, async ({ page }) => {
        await ready(page)
        await expectReadableTheme(nodeById(page, 'n-greet').getByText('Greeting', { exact: true }).first(), scheme)
        // A filled primary button is dark-on-light inverted by design, so only its contrast is checked.
        await expectReadableTheme(btn(page, 'Test run'), scheme, { background: false })
      })
    })
  }

  test('axe: canvas, selection with properties, connect menu and add-step menu', async ({ page }) => {
    const problems: string[] = []
    await ready(page)
    problems.push(...(await axeCheck(page, 'flow-canvas')))
    await nodeById(page, 'n-greet').focus()
    await page.keyboard.press('Enter')
    problems.push(...(await axeCheck(page, 'flow-selected')))
    await btn(page, 'Output Next of Greeting').focus()
    await page.keyboard.press('Enter')
    problems.push(...(await axeCheck(page, 'flow-connect-menu')))
    await page.keyboard.press('Escape')
    await btn(page, 'Insert step between Greeting and Ask order number').focus()
    await page.keyboard.press('Enter')
    problems.push(...(await axeCheck(page, 'flow-add-step')))
    expect(problems).toEqual([])
  })

  test.describe('axe dark', () => {
    test.use({ colorScheme: 'dark' })
    test('axe: canvas in dark mode', async ({ page }) => {
      await ready(page)
      expect(await axeCheck(page, 'flow-canvas-dark')).toEqual([])
    })
  })

  test('kbd: add, connect, move and undo with the keyboard only', async ({ page }) => {
    await ready(page)
    const add = page.getByRole('toolbar', { name: 'Add node' }).getByRole('button', { name: 'Add Message' })
    for (let i = 0; i < 60 && !(await add.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab')
    await expect(add).toBeFocused()
    await page.keyboard.press('Enter')
    const m1 = nodeByName(page, 'Message: Message 1')
    await expect(m1).toBeVisible()
    const m1id = (await m1.getAttribute('data-node-id'))!
    const port = btn(page, 'Output Next of Message 1')
    for (let i = 0; i < 10 && !(await port.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab')
    await expect(port).toBeFocused()
    await page.keyboard.press('Enter')
    for (let i = 0; i < 15 && !/End: End/.test((await focusedInfo(page)).label); i++) await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect.poll(() => hasEdge(page, m1id, 'next', 'n-end')).toBe(true)
    for (let i = 0; i < 10 && !(await m1.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Shift+Tab')
    await expect(m1).toBeFocused()
    const p0 = await pos(m1)
    await page.keyboard.press('Alt+ArrowDown')
    expect((await pos(m1)).y).toBe(p0.y + 20)
    await page.keyboard.press('Control+z')
    expect((await pos(m1)).y).toBe(p0.y)
    await waitForCalls(page, 'saveFlow', 1, 8000)
  })
})
