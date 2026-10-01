import { expect, test, type Page } from '@playwright/test'
import { env, ownerLogin, requireEnv } from './env.ts'

const WIDTHS = [
  { width: 360, height: 760, mobile: true },
  { width: 390, height: 844, mobile: true },
  { width: 768, height: 1024, mobile: true },
  { width: 1440, height: 900, mobile: false },
] as const

/** Nothing may stick out sideways: no horizontal page scroll at this width. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0)
}

for (const vp of WIDTHS) {
  test(`${vp.width}px: storefront, service, booking start, owner login${vp.width >= 768 ? ', dashboard' : ''}`, async ({ browser }) => {
    requireEnv(['PROD_APP_URL', env.app])
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
      locale: 'ru-RU',
    })
    const page = await ctx.newPage()
    await page.goto('/s/graphite')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/GRAPHITE/i)
    await expectNoHorizontalScroll(page)

    await page.locator('a[href$="/services/detailing-wash"]').click()
    await expect(page.getByRole('link', { name: /Выбрать время/ })).toBeVisible()
    await expectNoHorizontalScroll(page)

    await page.getByRole('link', { name: /Выбрать время/ }).click()
    await expect(page.getByRole('button', { name: /Седан/ })).toBeVisible()
    await expectNoHorizontalScroll(page)

    await page.goto('/s/graphite/owner/login')
    await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible()
    await expectNoHorizontalScroll(page)

    if (env.graphite.password && vp.width >= 768) {
      await ownerLogin(page, 'graphite', env.graphite)
      await expect(page.getByRole('heading', { level: 1, name: /Сегодня/ })).toBeVisible()
      await expectNoHorizontalScroll(page)
      await page.goto('/s/graphite/owner/bookings')
      await expect(page.getByRole('heading', { level: 1, name: 'Записи' })).toBeVisible()
      await expectNoHorizontalScroll(page)
    }
    await ctx.close()
  })
}

test('owner dashboard on a phone (390px)', async ({ browser }) => {
  requireEnv(['PROD_APP_URL', env.app], ['PROD_GRAPHITE_OWNER_PASSWORD', env.graphite.password])
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'ru-RU' })
  const page = await ctx.newPage()
  await ownerLogin(page, 'graphite', env.graphite)
  await expect(page.getByRole('heading', { level: 1, name: /Сегодня/ })).toBeVisible()
  await expectNoHorizontalScroll(page)
  await ctx.close()
})

test('PWA: per-studio manifest and scope, service worker, offline studio shell, booking needs network', async ({ page, context, request }) => {
  requireEnv(['PROD_APP_URL', env.app])
  await page.goto('/s/graphite')
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/tenants/graphite/manifest.webmanifest')
  const m = await (await request.get('/tenants/graphite/manifest.webmanifest')).json()
  expect(m).toMatchObject({ id: '/s/graphite/', scope: '/s/graphite/', start_url: '/s/graphite/', display: 'standalone' })
  expect((m.icons as Array<{ sizes: string }>).map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
  for (const icon of m.icons as Array<{ src: string }>) expect((await request.get(icon.src)).headers()['content-type']).toBe('image/png')

  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.reload()
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/GRAPHITE/i)
  // Availability is network-only: offline, the booking step says so instead of showing stale slots.
  await page.locator('a[href$="/services/detailing-wash"]').click()
  await page.getByRole('link', { name: /Выбрать время/ }).click()
  await page.getByRole('button', { name: /Седан/ }).click()
  await page.getByLabel('Марка').fill('Skoda')
  await page.getByLabel('Модель').fill('Octavia')
  await page.getByRole('button', { name: 'Дальше' }).click()
  await expect(page.getByText(/Нет соединения/).first()).toBeVisible()
  await expect(page.getByRole('radio')).toHaveCount(0)
  await context.setOffline(false)
})
