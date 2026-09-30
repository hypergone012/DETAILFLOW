import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Per-tenant manifests are generated into public/s/{slug}/ by the tenant pipeline.
      manifest: false,
      registerType: 'autoUpdate',
      injectRegister: null,
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/functions\//, /^\/auth\//],
        globPatterns: ['**/*.{js,css,html,woff2,svg,webp,jpg,png}'],
        globIgnores: ['**/*-vietnamese-*', '**/*-greek-*', '**/*-greek-ext-*'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        runtimeCaching: [
          {
            // Public studio profile + catalog: usable offline, refreshed in the background.
            urlPattern: ({ url }) => url.pathname.startsWith('/functions/v1/public-api/storefront/'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'storefront', expiration: { maxEntries: 20, maxAgeSeconds: 7 * 24 * 3600 } },
          },
          {
            // Availability, bookings, manage links, owner data, assistant: never served from cache.
            urlPattern: ({ url }) => url.pathname.startsWith('/functions/v1/'),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/tenants/'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'tenant-assets', expiration: { maxEntries: 200 } },
          },
        ],
      },
    }),
  ],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
})
