import { test, type Page } from '@playwright/test'

export const env = {
  app: process.env.PROD_APP_URL ?? '',
  api: process.env.PROD_SUPABASE_URL ?? '',
  apikey: process.env.PROD_SUPABASE_PUBLISHABLE_KEY ?? '',
  graphite: { email: process.env.PROD_GRAPHITE_OWNER_EMAIL ?? '', password: process.env.PROD_GRAPHITE_OWNER_PASSWORD ?? '' },
  ice: { email: process.env.PROD_ICE_OWNER_EMAIL ?? '', password: process.env.PROD_ICE_OWNER_PASSWORD ?? '' },
  phone: process.env.PROD_SMOKE_PHONE ?? '+79990000001',
}

/** Never pretend: a missing credential skips the test with an explicit NOT VERIFIED reason. */
export function requireEnv(...pairs: Array<[string, string]>): void {
  const missing = pairs.filter(([, v]) => !v).map(([k]) => k)
  test.skip(missing.length > 0, `NOT VERIFIED: missing ${missing.join(', ')}`)
}

export async function ownerLogin(page: Page, slug: string, creds: { email: string; password: string }): Promise<void> {
  await page.goto(`/s/${slug}/owner/login`)
  await page.getByLabel('Email').fill(creds.email)
  await page.getByLabel('Пароль').fill(creds.password)
  await page.getByRole('button', { name: 'Войти' }).click()
}

/** Access token of the signed-in owner (supabase-js keeps it in localStorage). */
export async function accessToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.endsWith('-auth-token'))
    return key ? (JSON.parse(localStorage.getItem(key)!) as { access_token: string }).access_token : ''
  })
}

export const apiHeaders = () => ({ apikey: env.apikey, 'content-type': 'application/json' })
