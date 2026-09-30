import { expect, test } from '@playwright/test'
import { book, testPhone } from './helpers.ts'

test('no LLM configured: no assistant button, booking works', async ({ page }) => {
  await page.goto('/s/graphite')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Спросить' })).toHaveCount(0)
  await book(page, { slug: 'graphite', serviceSlug: 'detailing-wash', name: 'Без ИИ', phone: testPhone(), dayIndex: 4, slotIndex: 3 })
  await expect(page.getByText('Вы записаны')).toBeVisible()
})

test('assistant failing mid-conversation degrades to the booking form', async ({ page }) => {
  // Simulate an upstream LLM outage at the network edge (the real endpoint would answer 503 the same way).
  await page.route('**/functions/v1/assistant/graphite/status', (r) => r.fulfill({ json: { available: true } }))
  await page.route('**/functions/v1/assistant/graphite/chat', (r) =>
    r.fulfill({ status: 503, json: { error: { code: 'AI_UNAVAILABLE', message: 'Ассистент сейчас недоступен.' } } }))
  await page.goto('/s/graphite')
  await page.getByRole('button', { name: 'Спросить' }).click()
  await page.getByLabel('Вопрос консультанту').fill('Сколько стоит полировка?')
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(page.getByRole('alert')).toContainText('недоступен')
  await page.getByRole('link', { name: 'Записаться через форму' }).click()
  await expect(page.getByRole('heading', { name: 'Услуга' })).toBeVisible()
})
