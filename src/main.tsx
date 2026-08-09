import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './index.css'
import { TripDebtCalculatorPage } from './pages/TripDebtCalculatorPage.tsx'

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
