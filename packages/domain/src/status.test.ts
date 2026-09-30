import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOOKING_STATUSES, TRANSITIONS, canTransition } from './status.ts'

describe('status machine', () => {
  it('matches private.allowed_transition in the SQL migration exactly', () => {
    const sql = readFileSync(join(import.meta.dirname, '../../../supabase/migrations/20260930000003_booking.sql'), 'utf8')
    const fn = sql.slice(sql.indexOf('create function private.allowed_transition'), sql.indexOf('create function private.transition_booking'))
    const pairs = [...fn.matchAll(/\('([a-z_]+)'(?:::public\.booking_status)?,\s*'([a-z_]+)'(?:::public\.booking_status)?\)/g)].map((m) => `${m[1]}->${m[2]}`)
    const ts = BOOKING_STATUSES.flatMap((from) => TRANSITIONS[from].map((to) => `${from}->${to}`))
    expect(new Set(pairs)).toEqual(new Set(ts))
    expect(pairs.length).toBe(ts.length)
  })

  it('terminal statuses have no exits', () => {
    for (const s of ['completed', 'cancelled', 'no_show'] as const) expect(TRANSITIONS[s]).toEqual([])
    expect(canTransition('requested', 'completed')).toBe(false)
  })
})
