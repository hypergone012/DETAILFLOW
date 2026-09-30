import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@/app/App'
import '@/styles/index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

if (import.meta.env.PROD) {
  // Offline shell + cached storefront; API calls are network-only (see vite.config.ts).
  void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }))
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
