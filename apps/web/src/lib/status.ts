import type { BookingStatus } from '@detailflow/domain'

export const STATUS_TONE: Record<BookingStatus, 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'> = {
  requested: 'warning',
  confirmed: 'success',
  checked_in: 'info',
  in_progress: 'info',
  ready: 'accent',
  completed: 'neutral',
  cancelled: 'danger',
  no_show: 'danger',
}

/** Solid fills for timeline blocks (status colour carries meaning, not decoration). */
export const STATUS_BAR: Record<BookingStatus, string> = {
  requested: 'border-warning/60 bg-warning/15',
  confirmed: 'border-success/50 bg-success/12',
  checked_in: 'border-info/60 bg-info/15',
  in_progress: 'border-info bg-info/25',
  ready: 'border-accent bg-accent-subtle',
  completed: 'border-line-strong bg-surface-3 opacity-70',
  cancelled: 'border-danger/40 bg-danger/10 opacity-60',
  no_show: 'border-danger/40 bg-danger/10 opacity-60',
}
