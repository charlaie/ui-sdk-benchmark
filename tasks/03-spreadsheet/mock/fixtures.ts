// Fixture data for the spreadsheet task. Self-contained (no imports) so it can be shared.

export const ROW_COUNT = 10_000
export const COLUMN_COUNT = 26

/** Cell address like "A1" (column letter + 1-based row number). */
export type CellAddress = string

export interface SheetData {
  rowCount: number
  columnCount: number
  /** Raw cell values by address. Missing addresses are empty. Values are plain strings, no formulas. */
  cells: Record<CellAddress, string>
}

/** 0-based column index to letter: 0 -> "A", 25 -> "Z". */
export function columnName(index: number): string {
  return String.fromCharCode(65 + index)
}

/** "B12" -> { row: 11, col: 1 } (both 0-based). Returns null for anything that isn't a valid address. */
export function parseAddress(address: string): { row: number; col: number } | null {
  const m = /^([A-Za-z])(\d{1,5})$/.exec(address.trim())
  if (!m) return null
  const col = m[1].toUpperCase().charCodeAt(0) - 65
  const row = Number(m[2]) - 1
  if (row < 0 || row >= ROW_COUNT || col < 0 || col >= COLUMN_COUNT) return null
  return { row, col }
}

/** { row: 11, col: 1 } (0-based) -> "B12". */
export function formatAddress(row: number, col: number): CellAddress {
  return `${columnName(col)}${row + 1}`
}

const CATEGORIES = ['Hardware', 'Software', 'Services', 'Supplies', 'Travel']

/** Columns A–D are filled for every row; E–Z start empty. */
export function buildInitialCells(): Record<CellAddress, string> {
  const cells: Record<CellAddress, string> = {}
  for (let r = 0; r < ROW_COUNT; r++) {
    const n = r + 1
    cells[`A${n}`] = `Item ${n}`
    cells[`B${n}`] = String(((n * 37) % 97) + 1)
    cells[`C${n}`] = (((n * 53) % 1000) / 10 + 1).toFixed(2)
    cells[`D${n}`] = CATEGORIES[n % CATEGORIES.length]
  }
  return cells
}
