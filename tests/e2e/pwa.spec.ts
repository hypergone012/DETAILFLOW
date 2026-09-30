import { expect, test } from '@playwright/test'

test('each studio page links its own installable manifest', async ({ page, request }) => {
  for (const slug of ['graphite', 'ice-lab']) {
    await page.goto(`/s/${slug}`)
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', `/tenants/${slug}/manifest.webmanifest`)
    const manifest = await (await request.get(`/tenants/${slug}/manifest.webmanifest`)).json()
    expect(manifest).toMatchObject({ scope: `/s/${slug}/`, start_url: `/s/${slug}/`, display: 'standalone' })
    for (const icon of manifest.icons as Array<{ src: string }>) {
      const res = await request.get(icon.src)
      expect(res.status(), icon.src).toBe(200)
      expect(res.headers()['content-type']).toContain('image/png')
    }
  }
})
