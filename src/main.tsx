import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './index.css'
import { TripDebtCalculatorPage } from './pages/TripDebtCalculatorPage.tsx'
import {
  currentBrowser,
  manifestFor,
  withoutOpenExternalBrowser,
} from './features/expense-divider/homeScreen.ts'

// Arriving from LINE's 「用 Safari 打開」: drop LINE's parameter before anything
// reads the address, so it never ends up in a Home Screen icon or a shared link.
const cleaned = withoutOpenExternalBrowser(window.location.href)
if (cleaned) window.history.replaceState(window.history.state, '', cleaned)

// index.html links the iOS manifest; other browsers get the one Chrome can install.
const manifestLink = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
const manifest = manifestFor(currentBrowser())
if (manifestLink && !manifestLink.href.endsWith(manifest)) manifestLink.href = `./${manifest}`

// Served as a GitHub Pages project site under /trip-debt-calculator/, so the
// basename lives here and every `navigate()` inside the page stays relative.
// The two routes reproduce the URLs this tool had as a route in the portfolio
// repo, which matters: room-code links are already shared with other people.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename="/trip-debt-calculator">
      <Routes>
        <Route path="/" element={<TripDebtCalculatorPage />} />
        <Route path="/:groupId" element={<TripDebtCalculatorPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
