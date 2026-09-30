import { expect, test } from '@playwright/test'
import { accessToken, apiHeaders, env, ownerLogin, requireEnv } from './env.ts'

test.describe('ICE LAB is a different studio and GRAPHITE stays out of reach', () => {
  test.beforeEach(() => requireEnv(['PROD_APP_URL', env.app], ['PROD_SUPABASE_URL', env.api]))

  test('own schedule, timezone and catalog', async ({ page, request }) => {
    const ice = await (await request.get(`${env.api}/functions/v1/public-api/storefront/ice-lab`, { headers: apiHeaders() })).json()
    const graphite = await (await request.get(`${env.api}/functions/v1/public-api/storefront/graphite`, { headers: apiHeaders() })).json()
    expect(ice.tenant.timezone).toBe('Asia/Yekaterinburg')
    expect(graphite.tenant.timezone).toBe('Europe/Moscow')
    expect(ice.policy.slot_step_min).toBe(60)
    const iceSlugs = ice.services.map((s: { slug: string }) => s.slug)
    expect(iceSlugs.some((s: string) => graphite.services.some((g: { slug: string }) => g.slug === s))).toBe(false)
    expect(ice.hours.some((h: { weekday: number }) => h.weekday === 1 || h.weekday === 7)).toBe(false)

    const svc = ice.services.find((s: { slug: string }) => s.slug === 'express-detail').id
    const from = new Date().toISOString().slice(0, 10)
    const to = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
    const av = await (await request.post(`${env.api}/functions/v1/public-api/availability/ice-lab`, { headers: apiHeaders(), data: { serviceId: svc, vehicleClass: 'sedan', from, to } })).json()
    for (const d of av.days as Array<{ date: string; open: boolean; slots: Array<{ time: string }> }>) {
      const dow = new Date(`${d.date}T12:00:00Z`).getUTCDay()
      if (dow === 0 || dow === 1) expect(d.open).toBe(false)
      if (dow >= 2 && dow <= 5) expect(d.slots.every((s) => s.time !== '14:00')).toBe(true)
    }

    await page.goto('/s/ice-lab')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/ICE LAB/i)
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tenant-accent').trim())).toBe('#5ec8e5')
  })

  test('GRAPHITE data is not reachable through ICE LAB', async ({ request }) => {
    const graphite = await (await request.get(`${env.api}/functions/v1/public-api/storefront/graphite`, { headers: apiHeaders() })).json()
    const gSvc = graphite.services[0].id
    const from = new Date().toISOString().slice(0, 10)
    const res = await request.post(`${env.api}/functions/v1/public-api/availability/ice-lab`, { headers: apiHeaders(), data: { serviceId: gSvc, vehicleClass: 'sedan', from, to: from } })
    expect(res.status()).toBe(404)
    const bad = await request.post(`${env.api}/functions/v1/public-api/bookings/ice-lab`, { headers: apiHeaders(), data: { serviceId: gSvc, tenant_id: 'x' } })
    expect(bad.status()).toBe(400)
  })

  test('ICE LAB owner cannot open GRAPHITE (UI and API)', async ({ page, request }) => {
    requireEnv(['PROD_ICE_OWNER_EMAIL', env.ice.email], ['PROD_ICE_OWNER_PASSWORD', env.ice.password])
    await ownerLogin(page, 'ice-lab', env.ice)
    await expect(page.getByText('Ждут подтверждения')).toBeVisible()
    await page.goto('/s/graphite/owner')
    await expect(page.getByText('Нет доступа к этой студии')).toBeVisible()
    const token = await accessToken(page)
    expect(token).not.toBe('')
    for (const path of ['graphite/bookings', 'graphite/customers', `graphite/day?date=${new Date().toISOString().slice(0, 10)}`, 'graphite/settings']) {
      const r = await request.get(`${env.api}/functions/v1/owner-api/${path}`, { headers: { ...apiHeaders(), authorization: `Bearer ${token}` } })
      expect(r.status(), path).toBe(404)
    }
    const me = await (await request.get(`${env.api}/functions/v1/owner-api/me`, { headers: { ...apiHeaders(), authorization: `Bearer ${token}` } })).json()
    expect(me.memberships.map((m: { slug: string }) => m.slug)).toEqual(['ice-lab'])
  })
})
