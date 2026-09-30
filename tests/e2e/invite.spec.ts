import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

test('tenant pipeline: invited staff member accepts the invite, sets a password and lands in the dashboard', async ({ page }) => {
  const email = `staff-${Date.now()}@graphite-detailing.test`
  const out = execFileSync('pnpm', ['-s', 'tenant', 'invite-owner', 'graphite', email, '--role', 'staff'], {
    cwd: join(import.meta.dirname, '../..'),
    encoding: 'utf8',
  })
  const link = /(http\S+\/owner\/accept\?token_hash=\S+)/.exec(out)?.[1]
  expect(link, out).toBeTruthy()

  await page.goto(link!)
  await page.getByLabel('Придумайте пароль').fill('staff-password-2026')
  await page.getByRole('button', { name: 'Войти в кабинет' }).click()
  await expect(page.getByText('Ждут подтверждения')).toBeVisible()
  await expect(page.getByText(`${email} · staff`)).toBeAttached()

  // The single-use link cannot be replayed.
  await page.goto(link!)
  await expect(page.getByRole('alert')).toContainText('недействительна')
})
