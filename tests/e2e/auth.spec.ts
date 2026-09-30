import { expect, test } from '@playwright/test'
import { ownerLogin } from './helpers.ts'

const AUTH = 'http://127.0.0.1:54321/auth/v1'
const API = 'http://127.0.0.1:54321/functions/v1'

test('logout ends the session and revokes the refresh token', async ({ page, request }) => {
  await ownerLogin(page, 'graphite')
  const session = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.endsWith('-auth-token'))!
    return JSON.parse(localStorage.getItem(key)!) as { access_token: string; refresh_token: string }
  })
  await page.getByRole('button', { name: 'Выйти' }).click()
  await expect(page).toHaveURL(/\/owner\/login$/)
  await page.goto('/s/graphite/owner/bookings')
  await expect(page).toHaveURL(/\/owner\/login$/)

  const refreshed = await request.post(`${AUTH}/token?grant_type=refresh_token`, { data: { refresh_token: session.refresh_token } })
  expect(refreshed.status()).toBeGreaterThanOrEqual(400)
})

test('self-service signup is disabled: studio staff are invited only', async ({ request }) => {
  const r = await request.post(`${AUTH}/signup`, { data: { email: `intruder-${Date.now()}@example.test`, password: 'intruder-password-1' } })
  expect(r.status()).toBeGreaterThanOrEqual(400)
  expect(JSON.stringify(await r.json())).toMatch(/signup.*disabled|not allowed/i)
})

test('owner API without, or with a garbage, token is 401', async ({ request }) => {
  expect((await request.get(`${API}/owner-api/me`)).status()).toBe(401)
  expect((await request.get(`${API}/owner-api/graphite/bookings`, { headers: { authorization: 'Bearer abc.def.ghi' } })).status()).toBe(401)
})
