import { expect, test } from '@playwright/test'
import { book, expectNoSeriousA11yViolations, ownerLogin, testPhone } from './helpers.ts'

test('customer books GRAPHITE without an account, the owner works the car through to pickup', async ({ page, browser }) => {
  // Customer
  await page.goto('/s/graphite')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/GRAPHITE/i)
  await expect(page.getByText('Демо-режим')).toBeVisible()
  const { ref, url } = await book(page, {
    slug: 'graphite', serviceSlug: 'detailing-wash', vehicleClass: 'Кроссовер',
    make: 'Lexus', model: 'RX', plate: 'М777ММ77', name: 'Ирина E2E', phone: testPhone(), dayIndex: 2, slotIndex: 1,
  })
  await expect(page.getByText('Вы записаны')).toBeVisible()
  await expect(page.getByText('от 4 500 ₽')).toBeVisible() // SUV variant price, computed by the server

  // Owner (separate browser context = separate device)
  const ownerCtx = await browser.newContext({ viewport: { width: 1360, height: 860 } })
  const owner = await ownerCtx.newPage()
  await ownerLogin(owner, 'graphite')
  await owner.getByRole('link', { name: 'Записи' }).first().click()
  await owner.getByLabel('Поиск').fill(ref)
  await expect(owner.locator('[aria-busy="false"] tbody tr')).toHaveCount(1)
  await owner.locator('tbody tr').getByRole('link').click()
  await expect(owner.getByText(`№ ${ref}`)).toBeVisible()
  await expect(owner.getByText('М777ММ77').first()).toBeVisible()
  for (const action of ['Принять авто', 'Начать работу', 'Готово', 'Выдать']) {
    await owner.getByRole('button', { name: action, exact: true }).click()
    await expect(owner.getByRole('button', { name: action, exact: true })).toHaveCount(0)
  }
  await owner.getByLabel('Итоговая цена, ₽').fill('5200')
  await owner.getByRole('button', { name: 'Сохранить' }).click()
  await expect(owner.getByText('5 200 ₽').first()).toBeVisible()
  await expect(owner.getByText('Выдано').first()).toBeVisible()

  // Customer sees the status on the manage link
  await page.goto(url)
  await expect(page.getByText('Выдано')).toBeVisible()
  await ownerCtx.close()
})

test('storefront and booking flow have no serious accessibility violations', async ({ page }) => {
  await page.goto('/s/graphite')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectNoSeriousA11yViolations(page)
  await page.goto('/s/ice-lab/book?service=express-detail')
  await expect(page.getByRole('button', { name: /Седан/ })).toBeVisible()
  await expectNoSeriousA11yViolations(page)
})
