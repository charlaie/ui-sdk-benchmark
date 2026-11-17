## Rules

- UI only. There is no real backend, server or authentication. Use the mock API in `src/mock/api.ts` for all data; don't edit anything in `src/mock/`. If you need something it doesn't cover, add your own in-memory placeholder in a separate file.
- Build the whole task as the app's single page (replace `src/App.tsx`). No routing is needed.
- You may add utility libraries (for example drag-and-drop, virtualization, positioning or table-state helpers). Don't add a ready-made implementation of the widget you are asked to build (for example a data grid or spreadsheet component, a node-graph or flow-canvas library, or a calendar/scheduler suite).
- It must work in light and dark mode (see the dark mode note in AGENTS.md / CLAUDE.md) and at mobile width (375 px) as well as desktop.
- Follow the accessibility requirements in the task, including any accessibility contract: exact roles, accessible names and attributes are part of the task.
- Keep `base: './'` in `vite.config.ts` so the build works from a subpath.
