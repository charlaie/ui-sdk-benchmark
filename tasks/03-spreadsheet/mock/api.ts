// Mock API for the spreadsheet task. Simulated latency; failures can be forced with URL
// parameters (see ./runtime.ts), e.g. `?mock-fail=saveCells`.
import { mockCall } from './runtime'
import { COLUMN_COUNT, ROW_COUNT, buildInitialCells, type CellAddress, type SheetData } from './fixtures'

export * from './fixtures'
export { MockApiError } from './runtime'

let cells: Record<CellAddress, string> | null = null
const store = () => (cells ??= buildInitialCells())

/** Load the whole sheet. Default latency 500 ms. */
export function loadSheet(): Promise<SheetData> {
  return mockCall('loadSheet', [], 500, () => ({ rowCount: ROW_COUNT, columnCount: COLUMN_COUNT, cells: store() }))
}

/**
 * Persist changed cells. Pass every cell changed by one user action (an edit, a paste, a clear)
 * in a single call. An empty string clears a cell. Default latency 300 ms.
 */
export function saveCells(changes: Record<CellAddress, string>): Promise<void> {
  return mockCall('saveCells', [changes], 300, () => {
    const s = store()
    for (const [address, value] of Object.entries(changes)) {
      if (value === '') delete s[address]
      else s[address] = value
    }
  })
}
