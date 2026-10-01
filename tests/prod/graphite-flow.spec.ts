import { expect, test } from '@playwright/test'
import { accessToken, apiHeaders, env, ownerLogin, requireEnv } from './env.ts'

test('GRAPHITE: fresh browser -> booking -> owner sees it -> status change -> Telegram notification', async ({ browser, request }) => {
  requireEnv(['PROD_APP_URL', env.app], ['PROD_SUPABASE_URL', env.api], ['PROD_GRAPHITE_OWNER_EMAIL', env.graphite.email], ['PROD_GRAPHITE_OWNER_PASSWORD', env.graphite.password])
  const storefront = await (await request.get(`${env.api}/functions/v1/public-api/storefront/graphite`, { headers: apiHeaders() })).json()
  const live = storefront.tenant.status === 'active'
  test.info().annotations.push({ type: 'tenant-status', description: storefront.tenant.status })

  // Customer: brand-new context = fresh browser (no storage, no SW)
  const customerCtx = await browser.newContext()
  const page = await customerCtx.newPage()
  await page.goto('/s/graphite')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/GRAPHITE/i)
  await page.locator('a[href$="/services/detailing-wash"]').click()
  await page.getByRole('link', { name: /Выбрать время/ }).click()
  await page.getByRole('button', { name: /Седан/ }).click()
  await page.getByLabel('Марка').fill('Skoda')
  await page.getByLabel('Модель').fill('Octavia')
  await page.getByLabel('Год').fill('2020')
  await page.getByLabel('Цвет').fill('Серый')
  await page.getByRole('button', { name: 'Дальше' }).click()
  const days = page.getByRole('tab').and(page.locator(':not([disabled])'))
  await days.nth(2).click()
  await page.getByRole('radio').first().click()
  await page.getByRole('button', { name: 'Дальше' }).click()
  const name = `SMOKE TEST ${new Date().toISOString().slice(0, 16)}`
  await page.getByLabel('Имя').fill(name)
  await page.getByLabel('Телефон').fill(env.phone)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Проверить' }).click()
  await page.getByRole('button', { name: 'Записаться' }).click()
  await page.waitForURL(/\/b\/[A-Za-z0-9_-]{43}$/)
  const ref = (await page.getByText(/ЗАПИСЬ №/).innerText()).replace(/.*№\s*/, '').trim()
  test.info().annotations.push({ type: 'booking-ref', description: ref })

  // Customer: the manage link works without an account; move the booking to another day.
  const before = await page.getByText(/Когда/).locator('..').innerText()
  await page.getByRole('button', { name: 'Перенести' }).click()
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('tab').and(page.locator(':not([disabled])')).nth(3).click()
  await sheet.getByRole('radio').first().click()
  await sheet.getByRole('button', { name: 'Перенести' }).click()
  await expect(sheet).toBeHidden()
  expect(await page.getByText(/Когда/).locator('..').innerText()).not.toBe(before)

  // Owner: separate context
  const ownerCtx = await browser.newContext({ viewport: { width: 1360, height: 860 } })
  const owner = await ownerCtx.newPage()
  await ownerLogin(owner, 'graphite', env.graphite)
  await expect(owner.getByText('Ждут подтверждения')).toBeVisible()
  await owner.goto('/s/graphite/owner/bookings')
  await owner.getByLabel('Поиск').fill(ref)
  await expect(owner.locator('[aria-busy="false"] tbody tr')).toHaveCount(1)
  await owner.locator('tbody tr').getByRole('link').click()
  await expect(owner.getByText(`№ ${ref}`)).toBeVisible()

  // Owner moves it once more (one transaction: the old slot stays if the new one is taken).
  await owner.getByRole('button', { name: 'Перенести' }).click()
  const ownerSheet = owner.getByRole('dialog')
  await ownerSheet.getByRole('tab').and(owner.locator(':not([disabled])')).nth(4).click()
  await ownerSheet.getByRole('radio').first().click()
  await ownerSheet.getByRole('button', { name: 'Перенести' }).click()
  await expect(ownerSheet).toBeHidden()
  await expect(owner.getByText(/Перенесена на/)).toHaveCount(2) // customer's move + owner's move

  const action = (await owner.getByRole('button', { name: 'Подтвердить', exact: true }).count()) ? 'Подтвердить' : 'Принять авто'
  await owner.getByRole('button', { name: action, exact: true }).click()
  await expect(owner.getByRole('button', { name: action, exact: true })).toHaveCount(0)

  // Telegram: the dispatcher runs every minute. Live studio -> "отправлено"; demo -> suppressed.
  const expected = live ? 'отправлено' : 'не отправлено (демо)'
  try {
    await expect(async () => {
      await owner.reload()
      await expect(owner.getByText(expected, { exact: true }).first()).toBeVisible({ timeout: 15_000 })
    }).toPass({ timeout: 240_000, intervals: [5_000] })
  } catch (err) {
    // Diagnostics without secrets: what the owner page and the owner API show for this booking.
    const section = await owner.locator('section', { has: owner.getByRole('heading', { name: 'Уведомления студии' }) }).innerText().catch(() => '(section not found)')
    console.log(`[diag] url=${owner.url()}\n[diag] notifications section: ${section.replace(/\s+/g, ' ')}`)
    const token = await accessToken(owner)
    const id = owner.url().split('/').pop()
    const detail = await request.get(`${env.api}/functions/v1/owner-api/graphite/bookings/${id}`, { headers: { ...apiHeaders(), authorization: `Bearer ${token}` } })
    console.log(`[diag] owner-api ${detail.status()} notifications: ${JSON.stringify(((await detail.json().catch(() => ({}))) as { notifications?: unknown }).notifications ?? null)}`)
    throw err
  }
  if (live) await expect(owner.getByText('ошибка')).toHaveCount(0)

  // Cleanup: free the slot again
  await owner.getByRole('button', { name: 'Отменить' }).click()
  await owner.getByRole('dialog').getByPlaceholder('Причина').fill('smoke test cleanup')
  await owner.getByRole('button', { name: 'Отменить запись' }).click()
  await expect(owner.getByText('Отменена').first()).toBeVisible()
  // Every event (created/confirmed, rescheduled, cancelled) goes through the same path.
  await expect(async () => {
    await owner.reload()
    await expect(owner.getByText('booking.cancelled')).toBeVisible({ timeout: 15_000 })
    await expect(owner.getByText('booking.rescheduled').first()).toBeVisible({ timeout: 15_000 })
    const rows = await owner.locator('section', { has: owner.getByRole('heading', { name: 'Уведомления студии' }) }).locator('li').count()
    await expect(owner.getByText(expected, { exact: true })).toHaveCount(rows, { timeout: 15_000 })
  }).toPass({ timeout: 240_000, intervals: [5_000] })
  await customerCtx.close()
  await ownerCtx.close()
})
