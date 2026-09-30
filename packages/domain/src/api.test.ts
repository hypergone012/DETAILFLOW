import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { availabilityRequestSchema, createBookingRequestSchema } from './api.ts'

const valid = {
  serviceId: randomUUID(),
  startAt: '2026-10-05T07:00:00.000Z',
  vehicle: { make: 'BMW', model: 'X5', year: 2021, color: 'Чёрный', vehicleClass: 'suv', plate: null, notes: '' },
  customer: { name: 'Иван', phone: '+7 916 123-45-67', email: null, consent: true },
  comment: '',
  idempotencyKey: randomUUID(),
}

describe('createBookingRequestSchema', () => {
  it('accepts a valid request', () => {
    expect(createBookingRequestSchema.safeParse(valid).success).toBe(true)
  })

  it.each([
    ['tenant_id', { tenant_id: randomUUID() }],
    ['price', { price: 1 }],
    ['priceFromMinor', { priceFromMinor: 1 }],
    ['durationMin', { durationMin: 15 }],
    ['status', { status: 'confirmed' }],
    ['endAt', { endAt: '2026-10-05T07:15:00.000Z' }],
    ['resourceId', { resourceId: randomUUID() }],
  ])('rejects client-supplied %s', (_name, extra) => {
    expect(createBookingRequestSchema.safeParse({ ...valid, ...extra }).success).toBe(false)
  })

  it('rejects nested extras and missing consent', () => {
    expect(createBookingRequestSchema.safeParse({ ...valid, vehicle: { ...valid.vehicle, price: 1 } }).success).toBe(false)
    expect(createBookingRequestSchema.safeParse({ ...valid, customer: { ...valid.customer, consent: false } }).success).toBe(false)
  })

  it('rejects a filled honeypot', () => {
    expect(createBookingRequestSchema.safeParse({ ...valid, website: 'spam' }).success).toBe(false)
  })
})

describe('availabilityRequestSchema', () => {
  it('limits the range', () => {
    const base = { serviceId: randomUUID(), vehicleClass: 'sedan' }
    expect(availabilityRequestSchema.safeParse({ ...base, from: '2026-10-01', to: '2026-10-14' }).success).toBe(true)
    expect(availabilityRequestSchema.safeParse({ ...base, from: '2026-10-01', to: '2026-12-14' }).success).toBe(false)
    expect(availabilityRequestSchema.safeParse({ ...base, from: '2026-10-02', to: '2026-10-01' }).success).toBe(false)
  })
})
