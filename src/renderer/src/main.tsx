import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { THEME_KEY } from './components/Sidebar'

// The saved theme goes on <html> before the first render, so a light theme never flashes dark. Here rather than
// an inline script in index.html, which the CSP blocks. No attribute = dark.
try {
  if (localStorage.getItem(THEME_KEY) === 'light') document.documentElement.dataset.theme = 'light'
} catch {
  // storage unavailable; stays dark
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
