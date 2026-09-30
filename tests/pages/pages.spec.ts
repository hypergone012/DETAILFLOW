import { expect, test, type Page } from '@playwright/test'

/** Collects CSP violations and requests leaving the allowed origins. */
function watch(page: Page) {
  const csp: string[] = []
  const foreign: string[] = []
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text()) })
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (!['http://127.0.0.1:8788', 'http://127.0.0.1:54321'].includes(u.origin) && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) foreign.push(r.url())
  })
  return { csp, foreign }
}

test('SPA fallback: every deep link serves the app', async ({ page }) => {
  for (const path of ['/s/graphite', '/s/graphite/services/ceramic-3-layers', '/s/ice-lab/book', '/s/graphite/owner', '/s/graphite/owner/bookings/00000000-0000-0000-0000-000000000000', '/s/graphite/b/abc']) {
    const res = await page.goto(path)
    expect(res!.status(), path).toBe(200)
    await expect(page.locator('#root > *').first()).toBeVisible()
  }
})

test('security headers from the generated _headers file', async ({ request }) => {
  const res = await request.get('/s/graphite')
  const h = res.headers()
  expect(h['content-security-policy']).toContain("script-src 'self'")
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(h['content-security-policy']).toContain('connect-src')
  expect(h['x-frame-options']).toBe('DENY')
  expect(h['x-content-type-options']).toBe('nosniff')
  expect((await request.get('/sw.js')).headers()['cache-control']).toBe('no-cache')
  expect((await request.get('/tenants/graphite/manifest.webmanifest')).headers()['cache-control']).toBe('public, max-age=300')
})

test('booking flow and owner login run with no CSP violations and no third-party requests', async ({ page }) => {
  const seen = watch(page)
  await page.goto('/s/graphite')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.goto('/s/graphite/book?service=detailing-wash')
  await page.getByRole('button', { name: /Седан/ }).click()
  await page.getByLabel('Марка').fill('Skoda')
  await page.getByLabel('Модель').fill('Octavia')
  await page.getByRole('button', { name: 'Дальше' }).click()
  await expect(page.getByRole('radio').first()).toBeVisible()
  await page.goto('/s/graphite/owner/login')
  await page.getByLabel('Email').fill('owner@graphite-detailing.test')
  await page.getByLabel('Пароль').fill('detailflow-demo')
  await page.getByRole('button', { name: 'Войти' }).click()
  await expect(page.getByText('Ждут подтверждения')).toBeVisible()
  expect(seen.csp).toEqual([])
  expect(seen.foreign).toEqual([])
})

test('service worker installs; the studio page opens offline', async ({ page, context }) => {
  await page.goto('/s/ice-lab')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/ICE LAB/i)
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.reload()
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/ICE LAB/i)
  await context.setOffline(false)
})

test('each studio has its own install scope and icons', async ({ page, request }) => {
  for (const slug of ['graphite', 'ice-lab']) {
    await page.goto(`/s/${slug}`)
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', `/tenants/${slug}/manifest.webmanifest`)
    const m = await (await request.get(`/tenants/${slug}/manifest.webmanifest`)).json()
    expect(m).toMatchObject({ id: `/s/${slug}/`, scope: `/s/${slug}/`, start_url: `/s/${slug}/` })
    for (const icon of m.icons as Array<{ src: string }>) expect((await request.get(icon.src)).headers()['content-type']).toBe('image/png')
  }
})
