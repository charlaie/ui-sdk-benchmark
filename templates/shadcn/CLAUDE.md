# Project notes

- Vite + React 19 + TypeScript + Tailwind CSS v4. Dependencies are already installed with npm; use npm to add more.
- Scripts: `npm run dev`, `npm run typecheck` (`tsc -b`), `npm run build` (typecheck + production build into `dist/`).
- The production build must work when served from a subpath: keep `base: './'` in `vite.config.ts` and don't use absolute asset URLs.
- Dark mode: `src/main.tsx` toggles the `dark` class on `<html>` from the OS setting (or `?theme=light|dark`) and sets `color-scheme`. Tailwind's `dark:` variant follows that class.
- `@/` is an import alias for `src/`.
- Mock backend: `src/mock/api.ts` is a typed mock API with fixture data and simulated latency. Use it for all data. Don't edit `src/mock/`; if you need something it doesn't cover, add your own in-memory placeholder in a separate file.

## UI components: shadcn/ui

This project uses shadcn/ui (see `components.json`). Before building UI, follow the shadcn skill if it's installed. Add components with the shadcn CLI (`npx shadcn@latest add <component>`), and use `npx shadcn@latest docs <component>` or https://ui.shadcn.com/llms.txt for documentation.
