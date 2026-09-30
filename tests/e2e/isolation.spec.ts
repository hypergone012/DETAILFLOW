import { expect, test } from '@playwright/test'
import { book, ownerLogin, testPhone } from './helpers.ts'

test('two studios run side by side and never see each other', async ({ page, browser }) => {
  const ice = await book(page, { slug: 'ice-lab', serviceSlug: 'interior-premium', name: 'Клиент ICE', phone: testPhone(), dayIndex: 3, slotIndex: 0 })
  const graphite = await book(page, { slug: 'graphite', serviceSlug: 'leather-care', name: 'Клиент GRAPHITE', phone: testPhone(), dayIndex: 3, slotIndex: 2 })

  // A GRAPHITE manage link does not open under ICE LAB.
  await page.goto(graphite.url.replace('/s/graphite/', '/s/ice-lab/'))
  await expect(page.getByRole('heading', { name: 'Запись не найдена' })).toBeVisible()

  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } })
  const owner = await ctx.newPage()
  await ownerLogin(owner, 'graphite')
  // Own booking is findable, the other studio's is not.
  await owner.goto('/s/graphite/owner/bookings')
  await owner.getByLabel('Поиск').fill(graphite.ref)
  await expect(owner.locator('[aria-busy="false"] tbody tr')).toHaveCount(1)
  await expect(owner.getByRole('cell').filter({ hasText: 'Клиент GRAPHITE' })).toBeVisible()
  await owner.getByLabel('Поиск').fill(ice.ref)
  await expect(owner.locator('p[aria-busy="false"]', { hasText: 'Ничего не найдено' })).toBeVisible()
  // The other studio's dashboard is closed.
  await owner.goto('/s/ice-lab/owner')
  await expect(owner.getByText('Нет доступа к этой студии')).toBeVisible()
  await ctx.close()
})

test('ICE LAB owner sees own booking with its own accent and timezone', async ({ page, browser }) => {
  const ice = await book(page, { slug: 'ice-lab', serviceSlug: 'express-detail', name: 'Время Екб', phone: testPhone(), dayIndex: 4, slotIndex: 0 })
  const when = await page.getByRole('definition').first().innerText() // e.g. "пт, 9 октября, 10:00–11:30"
  const studioTime = /(\d{2}:\d{2})–/.exec(when)![1]!
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, timezoneId: 'Europe/London' })
  const owner = await ctx.newPage()
  await ownerLogin(owner, 'ice-lab')
  const accent = await owner.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tenant-accent').trim())
  expect(accent).toBe('#5ec8e5')
  await owner.goto('/s/ice-lab/owner/bookings')
  await owner.getByLabel('Поиск').fill(ice.ref)
  await expect(owner.locator('[aria-busy="false"] tbody tr')).toHaveCount(1)
  // Shown in the studio's timezone (Asia/Yekaterinburg), not the viewer's (Europe/London).
  await expect(owner.locator('tbody tr').getByRole('link')).toHaveText(new RegExp(`${studioTime}$`))
  expect(Number(studioTime.slice(0, 2))).toBeGreaterThanOrEqual(10) // ICE LAB opens at 10:00 local
  await ctx.close()
})
