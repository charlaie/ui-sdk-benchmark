import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Theme: follows the OS setting, or ?theme=light|dark. Toggles the `dark` class on <html>,
// which Tailwind's `dark:` variant is configured to follow, and sets color-scheme.
const forced = new URLSearchParams(window.location.search).get('theme')
const media = window.matchMedia('(prefers-color-scheme: dark)')
function applyTheme() {
  const dark = forced === 'dark' || (forced !== 'light' && media.matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}
applyTheme()
media.addEventListener('change', applyTheme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
