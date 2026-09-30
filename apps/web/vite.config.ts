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
      registerType: 'prompt',
      injectRegister: null,
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/functions\//, /^\/auth\//],
        globPatterns: ['**/*.{js,css,html,woff2,svg,webp,jpg,png}'],
        globIgnores: ['**/*-vietnamese-*', '**/*-greek-*', '**/*-greek-ext-*'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        runtimeCaching: [
          {
            // Availability, bookings, owner data: never served from cache.
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
