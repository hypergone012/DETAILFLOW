import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { book, ownerLogin, testPhone } from './helpers.ts'

const received = () => {
  try {
    return readFileSync(join(import.meta.dirname, '../../.local/e2e-bot-received.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { chat_id: string; text: string })
  } catch {
    return []
  }
}

test('owner links the studio’s own Telegram chat, sends a test; another studio cannot take that chat; demo bookings send nothing', async ({ browser }) => {
  const GRAPHITE_CHAT = '-1009000000001'
  const ownerCtx = await browser.newContext()
  const page = await ownerCtx.newPage()
  await ownerLogin(page, 'graphite')
  await page.goto('/s/graphite/owner/settings')
  const state = page.getByTestId('telegram-state')
  await expect(state).toHaveText('Не настроено')
  await expect(page.getByText('@detailflow_e2e_bot').first()).toBeVisible()
  await page.getByLabel('ID чата').fill(GRAPHITE_CHAT)
  await page.getByLabel('Отправлять уведомления о записях в Telegram').check()
  await page.getByRole('button', { name: 'Сохранить' }).click()
  await expect(state).toHaveText('Подключено')
  await expect(page.getByText('••••0001')).toBeVisible()
  await expect(page.getByText(GRAPHITE_CHAT)).toHaveCount(0) // stored chat is shown masked

  await page.getByRole('button', { name: 'Отправить тестовое сообщение' }).click()
  await expect(page.getByRole('status')).toHaveText('Тестовое сообщение отправлено.')
  expect(received().filter((m) => m.chat_id === GRAPHITE_CHAT).map((m) => m.text.split('\n')[0])).toEqual(['DETAILFLOW · GRAPHITE Detailing'])

  // ICE LAB's owner cannot point ICE LAB at GRAPHITE's chat.
  const iceCtx = await browser.newContext()
  const ice = await iceCtx.newPage()
  await ownerLogin(ice, 'ice-lab')
  await ice.goto('/s/ice-lab/owner/settings')
  await ice.getByLabel('ID чата').fill(GRAPHITE_CHAT)
  await ice.getByRole('button', { name: 'Сохранить' }).click()
  await expect(ice.getByRole('alert')).toContainText('уже привязан к другой студии')
  await expect(ice.getByTestId('telegram-state')).toHaveText('Не настроено')

  // GRAPHITE is a demo studio: a real booking produces no Telegram message, even with chat + bot + enabled.
  const before = received().length
  const customer = await browser.newPage()
  await book(customer, { slug: 'graphite', serviceSlug: 'detailing-wash', name: 'Демо Телеграм', phone: testPhone(), dayIndex: 4, slotIndex: 1 })
  await page.waitForTimeout(3_000) // the local dispatcher runs every second
  expect(received().length).toBe(before)

  await page.getByRole('button', { name: 'Отвязать чат' }).click()
  await expect(state).toHaveText('Не настроено')
  await customer.close()
  await iceCtx.close()
  await ownerCtx.close()
})
