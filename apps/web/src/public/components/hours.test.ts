import { describe, expect, it } from 'vitest'
import { addDaysIso, formatWindow } from '@/lib/format'
import { groupHours } from './Hours'

describe('groupHours', () => {
  it('groups consecutive identical days and marks closed ones', () => {
    const hours = [
      ...[2, 3, 4, 5].flatMap((weekday) => [{ weekday, opens: '10:00', closes: '14:00' }, { weekday, opens: '15:00', closes: '19:00' }]),
      { weekday: 6, opens: '10:00', closes: '16:00' },
    ]
    expect(groupHours(hours)).toEqual([
      { days: 'Пн', hours: 'выходной' },
      { days: 'Вт–Пт', hours: '10:00–14:00, 15:00–19:00' },
      { days: 'Сб', hours: '10:00–16:00' },
      { days: 'Вс', hours: 'выходной' },
    ])
  })
})

describe('format', () => {
  it('renders windows in the studio timezone', () => {
    expect(formatWindow('2026-10-05T06:00:00Z', '2026-10-05T08:00:00Z', 'Europe/Moscow', false)).toBe('пн, 5 октября, 09:00–11:00')
    expect(formatWindow('2026-10-05T06:00:00Z', '2026-10-05T08:00:00Z', 'Asia/Yekaterinburg', false)).toBe('пн, 5 октября, 11:00–13:00')
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01')
  })
})
