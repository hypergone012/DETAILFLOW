import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  computeAvailability,
  findOfferedSlot,
  multiDayEnd,
  occupancyWindow,
  workingIntervals,
  zonedInstant,
  type AvailabilityInput,
  type WeeklyHours,
} from './availability.ts'

const MSK = 'Europe/Moscow'
const weekdays = (opens: string, closes: string, days = [1, 2, 3, 4, 5, 6]): WeeklyHours[] =>
  days.map((weekday) => ({ weekday, opens, closes }))

function input(overrides: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    timezone: MSK,
    hours: weekdays('09:00', '21:00'),
    exceptions: [],
    service: { durationMin: 120, bufferBeforeMin: 0, bufferAfterMin: 0, multiDay: false },
    policy: { slotStepMin: 30, minNoticeMin: 0, horizonDays: 60 },
    resources: ['bay-1'],
    busy: [],
    now: new Date('2026-09-30T00:00:00Z'),
    from: '2026-10-05', // Monday
    to: '2026-10-05',
    ...overrides,
  }
}

const times = (days: ReturnType<typeof computeAvailability>) => days.flatMap((d) => d.slots.map((s) => s.localTime))

describe('working hours', () => {
  it('offers starts on the step grid so that the service ends by closing time', () => {
    const [day] = computeAvailability(input())
    expect(day!.open).toBe(true)
    expect(day!.slots[0]!.localTime).toBe('09:00')
    expect(day!.slots.at(-1)!.localTime).toBe('19:00')
    expect(day!.slots).toHaveLength(21)
    expect(day!.slots[0]!.start.toISOString()).toBe('2026-10-05T06:00:00.000Z')
    expect(day!.slots[0]!.end.toISOString()).toBe('2026-10-05T08:00:00.000Z')
  })

  it('never lets a same-day service straddle a lunch break', () => {
    const hours = [
      ...weekdays('09:00', '13:00'),
      ...weekdays('14:00', '20:00'),
    ]
    const t = times(computeAvailability(input({ hours })))
    expect(t).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00'])
  })

  it('treats days without hours as closed (Sunday)', () => {
    const [sunday] = computeAvailability(input({ from: '2026-10-04', to: '2026-10-04' }))
    expect(sunday).toMatchObject({ open: false, slots: [] })
  })

  it('date exceptions override weekly hours', () => {
    const days = computeAvailability(input({
      from: '2026-10-05',
      to: '2026-10-06',
      exceptions: [
        { date: '2026-10-05', closed: true },
        { date: '2026-10-06', closed: false, opens: '12:00', closes: '15:00' },
      ],
    }))
    expect(days[0]).toMatchObject({ open: false, slots: [] })
    expect(days[1]!.slots.map((s) => s.localTime)).toEqual(['12:00', '12:30', '13:00'])
  })
})

describe('policy', () => {
  it('respects minimum notice', () => {
    const now = new Date('2026-10-05T07:10:00Z') // 10:10 MSK
    const t = times(computeAvailability(input({ now, policy: { slotStepMin: 30, minNoticeMin: 120, horizonDays: 60 } })))
    expect(t[0]).toBe('12:30')
  })

  it('respects the horizon', () => {
    const days = computeAvailability(input({ policy: { slotStepMin: 30, minNoticeMin: 0, horizonDays: 3 } }))
    expect(days[0]!.slots).toEqual([])
  })
})

describe('occupancy', () => {
  it('excludes slots whose buffered window overlaps busy time', () => {
    const busy = [{ resourceId: 'bay-1', start: new Date('2026-10-05T08:00:00Z'), end: new Date('2026-10-05T10:00:00Z') }] // 11:00–13:00 MSK
    const service = { durationMin: 120, bufferBeforeMin: 0, bufferAfterMin: 30, multiDay: false }
    const t = times(computeAvailability(input({ busy, service })))
    expect(t).not.toContain('09:00') // 09:00–11:00 + 30 min buffer hits 11:00
    expect(t[0]).toBe('13:00')
    expect(t).not.toContain('12:30')
    expect(t.filter((x) => x < '13:00')).toEqual([])
  })

  it('reports which bays are free and hides a slot only when all are busy', () => {
    const busy = [{ resourceId: 'bay-1', start: new Date('2026-10-05T06:00:00Z'), end: new Date('2026-10-05T08:00:00Z') }]
    const [day] = computeAvailability(input({ resources: ['bay-1', 'bay-2'], busy }))
    expect(day!.slots[0]).toMatchObject({ localTime: '09:00', freeResourceIds: ['bay-2'] })
    const [full] = computeAvailability(input({ resources: ['bay-1'], busy }))
    expect(full!.slots[0]!.localTime).toBe('11:00') // 10:00–12:00 would overlap 09:00–11:00
  })

  it('computes the occupancy window with buffers on both sides', () => {
    const w = occupancyWindow({ durationMin: 60, bufferBeforeMin: 15, bufferAfterMin: 30, multiDay: false },
      new Date('2026-10-05T10:00:00Z'), new Date('2026-10-05T11:00:00Z'))
    expect(w.start.toISOString()).toBe('2026-10-05T09:45:00.000Z')
    expect(w.end.toISOString()).toBe('2026-10-05T11:30:00.000Z')
  })
})

describe('multi-day services', () => {
  const calendar = { timezone: MSK, hours: weekdays('09:00', '19:00', [1, 2, 3, 4, 5]), exceptions: [] }

  it('spreads working minutes over working days, skipping the weekend', () => {
    // Fri 2026-10-09 15:00 MSK, 16h of work: Fri 4h, Mon 10h, Tue 2h -> Tue 11:00.
    const start = zonedInstant('2026-10-09', '15:00', MSK)!
    expect(multiDayEnd(calendar, start, 960)!.toISOString()).toBe(zonedInstant('2026-10-13', '11:00', MSK)!.toISOString())
  })

  it('skips closed exception days', () => {
    const start = zonedInstant('2026-10-09', '15:00', MSK)!
    const end = multiDayEnd({ ...calendar, exceptions: [{ date: '2026-10-12', closed: true }] }, start, 960)
    expect(end!.toISOString()).toBe(zonedInstant('2026-10-14', '11:00', MSK)!.toISOString())
  })

  it('blocks the bay continuously: a weekend block makes the Friday start unavailable', () => {
    const service = { durationMin: 960, bufferBeforeMin: 0, bufferAfterMin: 0, multiDay: true }
    const busy = [{ resourceId: 'bay-1', start: zonedInstant('2026-10-10', '10:00', MSK)!, end: zonedInstant('2026-10-10', '12:00', MSK)! }]
    const base = input({ ...calendar, service, from: '2026-10-09', to: '2026-10-09' })
    expect(times(computeAvailability(base))).toContain('15:00')
    expect(times(computeAvailability({ ...base, busy }))).not.toContain('15:00')
  })

  it('offers multi-day starts late in the day (drop-off), unlike same-day services', () => {
    const service = { durationMin: 960, bufferBeforeMin: 0, bufferAfterMin: 0, multiDay: true }
    const t = times(computeAvailability(input({ ...calendar, service, from: '2026-10-09', to: '2026-10-09' })))
    expect(t.at(-1)).toBe('18:30')
  })
})

describe('DST (Europe/Berlin)', () => {
  const BERLIN = 'Europe/Berlin'
  const night = (date: string): AvailabilityInput =>
    input({ timezone: BERLIN, hours: [{ weekday: 7, opens: '00:00', closes: '06:00' }], from: date, to: date,
      service: { durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0, multiDay: false },
      policy: { slotStepMin: 60, minNoticeMin: 0, horizonDays: 400 }, now: new Date('2026-01-01T00:00:00Z') })

  it('spring forward: 02:xx does not exist and is never offered; durations stay absolute', () => {
    const [day] = computeAvailability(night('2026-03-29'))
    expect(day!.slots.map((s) => s.localTime)).toEqual(['00:00', '01:00', '03:00', '04:00', '05:00'])
    for (const s of day!.slots) expect(s.end.getTime() - s.start.getTime()).toBe(3_600_000)
    expect(zonedInstant('2026-03-29', '02:30', BERLIN)).toBeNull()
  })

  it('fall back: the repeated hour yields 7 real one-hour slots in a 6-hour wall window', () => {
    const [day] = computeAvailability(night('2026-10-25'))
    expect(day!.slots.map((s) => s.localTime)).toEqual(['00:00', '01:00', '02:00', '02:00', '03:00', '04:00', '05:00'])
    expect(new Set(day!.slots.map((s) => s.start.getTime())).size).toBe(7)
    const [interval] = workingIntervals(night('2026-10-25'), '2026-10-25')
    expect(interval!.end.getTime() - interval!.start.getTime()).toBe(7 * 3_600_000)
  })

  it('an opening time inside the DST gap starts at the first valid minute', () => {
    const cal = { timezone: BERLIN, hours: [{ weekday: 7, opens: '02:30', closes: '05:00' }], exceptions: [] }
    const [interval] = workingIntervals(cal, '2026-03-29')
    expect(interval!.start.toISOString()).toBe('2026-03-29T01:00:00.000Z') // 03:00 CEST
  })
})

describe('findOfferedSlot (server-side validation)', () => {
  it('accepts an offered start and returns the server-computed end', () => {
    const slot = findOfferedSlot(input(), new Date('2026-10-05T07:00:00Z'))
    expect(slot!.end.toISOString()).toBe('2026-10-05T09:00:00.000Z')
  })

  it('rejects off-grid, closed-hours and busy starts', () => {
    expect(findOfferedSlot(input(), new Date('2026-10-05T07:10:00Z'))).toBeNull()
    expect(findOfferedSlot(input(), new Date('2026-10-05T03:00:00Z'))).toBeNull()
    const busy = [{ resourceId: 'bay-1', start: new Date('2026-10-05T07:00:00Z'), end: new Date('2026-10-05T08:00:00Z') }]
    expect(findOfferedSlot(input({ busy }), new Date('2026-10-05T07:00:00Z'))).toBeNull()
  })
})

describe('properties', () => {
  const busyArb = fc.array(
    fc.record({
      resourceId: fc.constantFrom('bay-1', 'bay-2'),
      startMin: fc.integer({ min: 0, max: 3 * 24 * 60 }),
      lenMin: fc.integer({ min: 15, max: 600 }),
    }),
    { maxLength: 12 },
  )

  it('never offers a window that overlaps busy time on the bays it reports as free', () => {
    fc.assert(
      fc.property(busyArb, fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 60 }), fc.boolean(), fc.integer({ min: 30, max: 900 }),
        (busySpec, bufBefore, bufAfter, multiDay, duration) => {
          const origin = new Date('2026-10-05T00:00:00Z').getTime()
          const busy = busySpec.map((b) => ({ resourceId: b.resourceId, start: new Date(origin + b.startMin * 60_000), end: new Date(origin + (b.startMin + b.lenMin) * 60_000) }))
          const service = { durationMin: multiDay ? duration : Math.min(duration, 600), bufferBeforeMin: bufBefore, bufferAfterMin: bufAfter, multiDay }
          const days = computeAvailability(input({ resources: ['bay-1', 'bay-2'], busy, service, from: '2026-10-05', to: '2026-10-07' }))
          for (const slot of days.flatMap((d) => d.slots)) {
            const w = occupancyWindow(service, slot.start, slot.end)
            expect(slot.freeResourceIds.length).toBeGreaterThan(0)
            for (const id of slot.freeResourceIds) {
              expect(busy.some((b) => b.resourceId === id && b.start < w.end && w.start < b.end)).toBe(false)
            }
            if (!multiDay) expect(slot.end.getTime() - slot.start.getTime()).toBe(service.durationMin * 60_000)
          }
        }),
      { numRuns: 300 },
    )
  })

  it('same-day slots always lie inside one working interval', () => {
    fc.assert(
      fc.property(fc.integer({ min: 6, max: 11 }), fc.integer({ min: 14, max: 22 }), fc.integer({ min: 15, max: 480 }), fc.constantFrom(15, 30, 60),
        (openH, closeH, duration, step) => {
          const hours = weekdays(`${String(openH).padStart(2, '0')}:00`, `${String(closeH).padStart(2, '0')}:00`)
          const data = input({ hours, service: { durationMin: duration, bufferBeforeMin: 0, bufferAfterMin: 0, multiDay: false }, policy: { slotStepMin: step, minNoticeMin: 0, horizonDays: 60 } })
          const [day] = computeAvailability(data)
          const [interval] = workingIntervals(data, '2026-10-05')
          for (const s of day!.slots) {
            expect(s.start >= interval!.start && s.end <= interval!.end).toBe(true)
          }
        }),
      { numRuns: 200 },
    )
  })

  it('is deterministic', () => {
    const a = computeAvailability(input({ from: '2026-10-05', to: '2026-10-11' }))
    const b = computeAvailability(input({ from: '2026-10-05', to: '2026-10-11' }))
    expect(a).toEqual(b)
  })
})
