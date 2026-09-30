import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'

export const OWNERS = {
  graphite: { email: 'owner@graphite-detailing.test', password: process.env.DF_DEMO_OWNER_PASSWORD ?? 'detailflow-demo' },
  'ice-lab': { email: 'owner@icelab-detailing.test', password: process.env.DF_DEMO_OWNER_PASSWORD ?? 'detailflow-demo' },
} as const

export interface BookOptions {
  slug: 'graphite' | 'ice-lab'
  serviceSlug: string
  vehicleClass?: 'Компакт' | 'Седан' | 'Кроссовер' | 'Большой SUV'
  make?: string
  model?: string
  plate?: string
  name: string
  phone: string
  /** Which enabled day tab to use (0 = first with slots). */
  dayIndex?: number
  /** Which time slot on that day. */
  slotIndex?: number
}

/** Walks the whole customer flow up to the review step. */
export async function fillBooking(page: Page, o: BookOptions): Promise<void> {
  await page.goto(`/s/${o.slug}/book?service=${o.serviceSlug}`)
  await page.getByRole('button', { name: new RegExp(o.vehicleClass ?? 'Седан') }).click()
  await page.getByLabel('Марка').fill(o.make ?? 'Toyota')
  await page.getByLabel('Модель').fill(o.model ?? 'Camry')
  await page.getByLabel('Год').fill('2022')
  await page.getByLabel('Цвет').fill('Белый')
  if (o.plate) await page.getByLabel('Госномер').fill(o.plate)
  await page.getByRole('button', { name: 'Дальше' }).click()
  await pickSlot(page, o.dayIndex ?? 0, o.slotIndex ?? 0)
  await page.getByRole('button', { name: 'Дальше' }).click()
  await page.getByLabel('Имя').fill(o.name)
  await page.getByLabel('Телефон').fill(o.phone)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Проверить' }).click()
  await expect(page.getByText('Итоговую стоимость мастер назовёт')).toBeVisible()
}

export async function pickSlot(page: Page, dayIndex: number, slotIndex: number): Promise<void> {
  const days = page.getByRole('tab').and(page.locator(':not([disabled])'))
  await days.first().waitFor()
  await days.nth(dayIndex).click()
  await page.getByRole('radio').nth(slotIndex).click()
}

/** Books and returns { ref, url } of the manage page. */
export async function book(page: Page, o: BookOptions): Promise<{ ref: string; url: string }> {
  await fillBooking(page, o)
  await page.getByRole('button', { name: 'Записаться' }).click()
  await page.waitForURL(/\/b\/[A-Za-z0-9_-]{43}$/)
  const refText = await page.getByText(/ЗАПИСЬ №/).innerText()
  return { ref: refText.replace(/.*№\s*/, '').trim(), url: page.url() }
}

export async function ownerLogin(page: Page, slug: keyof typeof OWNERS): Promise<void> {
  await page.goto(`/s/${slug}/owner/login`)
  await page.getByLabel('Email').fill(OWNERS[slug].email)
  await page.getByLabel('Пароль').fill(OWNERS[slug].password)
  await page.getByRole('button', { name: 'Войти' }).click()
  await expect(page.getByText('Ждут подтверждения')).toBeVisible()
}

export async function expectNoSeriousA11yViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze()
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([])
}

let phone = 0
export function testPhone(): string {
  phone += 1
  return `+7926${String(Date.now() % 1_000_000).padStart(6, '0').slice(0, 5)}${String(phone).padStart(2, '0')}`
}
