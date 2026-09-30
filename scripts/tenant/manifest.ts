import type { Business } from '@detailflow/config'
import { BACKGROUND_HEX } from '@detailflow/config'

/**
 * Web app manifest for one studio. Each studio installs as its own app:
 * id/scope/start_url are the studio's path, so two studios on one origin are
 * two separate installed apps.
 */
export function buildManifest(b: Business, opts: { hasIcons: boolean }) {
  const base = `/s/${b.slug}/`
  return {
    id: base,
    name: b.name,
    short_name: b.name.length > 12 ? b.name.split(/\s+/)[0]! : b.name,
    description: b.branding.tagline,
    lang: 'ru',
    dir: 'ltr',
    start_url: base,
    scope: base,
    display: 'standalone',
    orientation: 'portrait',
    background_color: BACKGROUND_HEX,
    theme_color: BACKGROUND_HEX,
    categories: ['lifestyle', 'business'],
    icons: opts.hasIcons
      ? [
          { src: `/tenants/${b.slug}/icons/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: `/tenants/${b.slug}/icons/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: `/tenants/${b.slug}/icons/maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ]
      : [],
    shortcuts: [{ name: 'Записаться', url: `${base}book` }],
  }
}
