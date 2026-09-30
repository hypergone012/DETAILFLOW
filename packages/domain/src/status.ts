export const BOOKING_STATUSES = [
  'requested',
  'confirmed',
  'checked_in',
  'in_progress',
  'ready',
  'completed',
  'cancelled',
  'no_show',
] as const
export type BookingStatus = (typeof BOOKING_STATUSES)[number]

/** Mirrors private.allowed_transition in SQL (a unit test enforces parity). */
export const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  requested: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['in_progress', 'cancelled'],
  in_progress: ['ready'],
  ready: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
}

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export const STATUS_LABELS: Record<BookingStatus, string> = {
  requested: 'Ждёт подтверждения',
  confirmed: 'Подтверждена',
  checked_in: 'Авто принято',
  in_progress: 'В работе',
  ready: 'Готово к выдаче',
  completed: 'Выдано',
  cancelled: 'Отменена',
  no_show: 'Не приехал',
}

/** Button label for moving *to* a status. */
export const ACTION_LABELS: Record<BookingStatus, string> = {
  requested: '',
  confirmed: 'Подтвердить',
  checked_in: 'Принять авто',
  in_progress: 'Начать работу',
  ready: 'Готово',
  completed: 'Выдать',
  cancelled: 'Отменить',
  no_show: 'Не приехал',
}

export const ACTIVE_STATUSES: readonly BookingStatus[] = ['requested', 'confirmed', 'checked_in', 'in_progress', 'ready']
