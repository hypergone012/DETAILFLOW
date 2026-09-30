import { expect, test } from '@playwright/test'
import { book, fillBooking, testPhone } from './helpers.ts'

test('two customers race for the same last slot: one books, the other is sent back to pick a new time', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage()
  const b = await (await browser.newContext()).newPage()
  // ICE LAB has a single wash line: one car per slot.
  const same = { slug: 'ice-lab' as const, serviceSlug: 'express-detail', dayIndex: 5, slotIndex: 0 }
  await fillBooking(a, { ...same, name: 'Первый', phone: testPhone() })
  await fillBooking(b, { ...same, name: 'Второй', phone: testPhone() })

  await a.getByRole('button', { name: 'Записаться' }).click()
  await a.waitForURL(/\/b\//)
  await expect(a.getByText('Заявка отправлена')).toBeVisible() // ICE LAB confirms manually

  await b.getByRole('button', { name: 'Записаться' }).click()
  await expect(b.getByRole('alert')).toContainText('Это время только что заняли')
  await expect(b.getByRole('heading', { name: 'Дата и время' })).toBeVisible()
  await expect(b.getByRole('button', { name: 'Дальше' })).toBeDisabled() // slot cleared
})

test('customer reschedules and cancels through the manage link', async ({ page }) => {
  const { url } = await book(page, { slug: 'ice-lab', serviceSlug: 'leather-restore', name: 'Олег', phone: testPhone(), dayIndex: 2, slotIndex: 0 })
  const before = await page.getByText(/Когда/).locator('..').innerText()
  await page.getByRole('button', { name: 'Перенести' }).click()
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('tab').and(page.locator(':not([disabled])')).nth(3).click()
  await sheet.getByRole('radio').first().click()
  await sheet.getByRole('button', { name: 'Перенести' }).click()
  await expect(sheet).toBeHidden()
  const after = await page.getByText(/Когда/).locator('..').innerText()
  expect(after).not.toBe(before)

  await page.getByRole('button', { name: 'Отменить' }).click()
  await page.getByRole('dialog').getByPlaceholder('Причина').fill('Уезжаю')
  await page.getByRole('button', { name: 'Отменить запись' }).click()
  await expect(page.getByText('Отменена')).toBeVisible()
  await page.goto(url)
  await expect(page.getByText('Отменена')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Перенести' })).toHaveCount(0)
})

test('an unknown studio and an invalid manage link fail safely', async ({ page }) => {
  await page.goto('/s/no-such-studio')
  await expect(page.getByText('Студия не найдена')).toBeVisible()
  await page.goto(`/s/graphite/b/${'A'.repeat(43)}`)
  await expect(page.getByRole('heading', { name: 'Запись не найдена' })).toBeVisible()
})
