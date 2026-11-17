# Task: Spreadsheet grid

Build a single-page spreadsheet editor with 10,000 rows and 26 columns (A–Z). Data comes from the mock API in `src/mock/api.ts` (`loadSheet`, `saveCells`, plus helpers `columnName`, `parseAddress`, `formatAddress`, `ROW_COUNT`, `COLUMN_COUNT`). Values are plain strings; there are no formulas. Use the ARIA grid pattern (WAI-ARIA Authoring Practices, "Grid" and "Data Grid") as the reference for keyboard and focus behavior.

## Layout

- A heading "Sheet".
- Above the grid: a text field named "Cell reference" (shows the active cell like "C7", or the selected range like "B2:D5") and a text field named "Cell contents" (shows the raw value of the active cell).
- The grid, which fills the remaining space and scrolls inside its own container. The column header row and the row number column stay visible while scrolling.
- While the sheet loads, show "Loading sheet…".

## Accessibility contract

The tests rely only on this contract, so follow it exactly:

- The grid element has `role="grid"`, the accessible name "Spreadsheet", `aria-rowcount="10001"`, `aria-colcount="27"` and `aria-multiselectable="true"`.
- The header row has `role="row"` and `aria-rowindex="1"`. Its first cell is the top-left corner (`role="columnheader"`, `aria-colindex="1"`, may be empty). Then 26 cells with `role="columnheader"`, `aria-colindex` 2 to 27 and the text "A" to "Z".
- Data row n (1-based) has `role="row"` and `aria-rowindex` = n + 1. Its first cell has `role="rowheader"`, `aria-colindex="1"` and the text n. Then 26 cells with `role="gridcell"`, `aria-colindex` 2 to 27, whose text content is the cell value.
- Rows are virtualized: at most 200 data rows are in the DOM at any time. Every row and cell that is in the DOM carries the indices above.
- The grid is a single Tab stop. Exactly one cell is active. Use either a roving tabindex (the active gridcell has DOM focus) or `aria-activedescendant` on the focused grid element pointing to the active gridcell's id. When focus enters the grid for the first time, A1 is active.
- Every rendered gridcell in the selected range has `aria-selected="true"`; other rendered gridcells have `aria-selected="false"` or no `aria-selected`.
- While editing, the editor is a text field with the accessible name "Edit <address>" (for example "Edit B2"), and it has DOM focus.

## Navigation

- Arrow keys move the active cell by one, stopping at the edges.
- Home / End move to the first / last column of the row. Ctrl+Home / Ctrl+End move to A1 / Z10000.
- Ctrl+Arrow (Cmd+Arrow on macOS) moves to the edge of the sheet in that direction.
- PageDown / PageUp move by the number of rows visible in the grid.
- Moving to a cell that isn't rendered yet scrolls it into view and renders it; the active cell is always fully visible after keyboard navigation.
- Typing an address (like "M5000") into "Cell reference" and pressing Enter makes that cell active, scrolls to it, and moves focus to the grid.
- Scrolling with the mouse wheel or scrollbar doesn't change the active cell. If the active cell's row is scrolled out of the DOM, keyboard focus stays in the grid (never falls to `<body>`), and the next arrow key continues from the active cell and scrolls it back into view.

## Selection

- Shift+Arrow, Shift+Home/End, Shift+Ctrl+Arrow and Shift+PageUp/PageDown extend a rectangular selection from the anchor cell. A plain navigation key collapses the selection to the new active cell.
- Click makes a cell active; Shift+click extends the selection; dragging across cells selects the rectangle.
- Ctrl/Cmd+A selects the whole sheet.
- The selected range is visibly highlighted and the active cell has a distinct outline.

## Editing

- Enter or F2 starts editing the active cell with its current value. Typing a printable character starts editing with that character replacing the value. Double-click starts editing.
- While editing, Enter commits and moves down, Shift+Enter commits and moves up, Tab commits and moves right, Shift+Tab commits and moves left, and Escape cancels, restoring the previous value. In all cases focus returns to the grid. Arrow keys move the caret inside the editor. Clicking another cell commits.
- Delete or Backspace clears every cell in the selection.
- Editing "Cell contents" and pressing Enter commits the new value to the active cell.
- Ctrl/Cmd+C copies the selection to the clipboard as tab-separated values (rows separated by newlines, cells by tabs). Ctrl/Cmd+X copies and then clears the selection. Ctrl/Cmd+V pastes tab-separated text with its top-left at the active cell (or the top-left of the selection), clipped to the sheet, and selects the pasted range.
- Every change caused by one action (a commit, a clear, a cut, a paste) is saved with one `saveCells` call containing every changed cell (an empty string clears a cell). If saving fails, keep the new values on screen and show an alert (`role="alert"`) saying "Couldn't save changes" with a "Retry" button that sends the unsaved changes again.

## Responsive and themes

At 375 px wide the grid fills the width and scrolls inside its container; the page itself doesn't scroll horizontally. Everything must look right and remain readable in light and dark mode.

## Acceptance criteria

1. The grid follows the accessibility contract: roles, name, `aria-rowcount`, `aria-colcount`, row and column indices, headers.
2. Rows are virtualized (at most 200 data rows in the DOM) and the header row and row numbers stay visible while scrolling.
3. The grid is one Tab stop; A1 is active on first focus; Tab moves focus out of the grid.
4. Arrow keys move the active cell and stop at the edges; "Cell reference" and "Cell contents" follow the active cell.
5. Home/End and Ctrl+Home/Ctrl+End move to the row ends and the sheet corners, rendering cells that weren't rendered.
6. PageDown/PageUp move by a page and keep the active cell visible.
7. Entering an address in "Cell reference" jumps to that cell, renders it and focuses the grid.
8. Shift+Arrow extends a rectangular selection exposed through `aria-selected`; "Cell reference" shows the range.
9. Shift+click and mouse drag select rectangular ranges.
10. Enter, F2, typing and double-click start editing with an editor named "Edit <address>"; Enter and Tab commit and move; Escape cancels and restores.
11. Delete clears the selection; each change calls `saveCells` once with all changed cells.
12. Copy puts the selection on the clipboard as tab-separated values; paste fills a range from the active cell; cut clears the source.
13. Focus stays in the grid when the active cell scrolls out of the DOM, and the next arrow key brings it back into view.
14. A failed save shows "Couldn't save changes" with "Retry", which saves again.
15. At 375 px wide the page doesn't scroll horizontally; light and dark mode both render readable content.
