import type { BookingStatus, VehicleClass } from '@detailflow/domain'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { supabase } from '@/owner/auth'

async function token(): Promise<string | undefined> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token
}

async function call<T>(path: string, opts: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {}): Promise<T> {
  return apiFetch<T>(`owner-api/${path}`, null, { ...opts, token: await token() })
}

export interface OwnerBookingRow {
  id: string
  ref_code: string
  status: BookingStatus
  start_at: string
  end_at: string
  service_name: string
  vehicle_class: VehicleClass
  multi_day: boolean
  price_from_minor: string
  final_price_minor: string | null
  contact_name: string
  contact_phone_e164: string
  vehicle: { make: string; model: string; year: number | null; color: string; plate: string | null }
  is_demo: boolean
  source: string
  resource_id: string | null
  resource_name: string | null
}

export interface DayView {
  tenant: { id: string; slug: string; name: string; status: string; timezone: string; role: string }
  date: string
  resources: Array<{ id: string; key: string; name: string; type: string }>
  bookings: OwnerBookingRow[]
  blocks: Array<{ id: string; resource_id: string; starts_at: string; ends_at: string; reason: string }>
  counters: { awaiting_confirmation: number; in_work: number; ready_for_pickup: number }
  notifications: { pending: number; failed: number; not_configured: number }
}

export interface BookingDetail {
  booking: OwnerBookingRow & { customer_id: string; customer_comment: string; contact_email: string | null; cancel_reason: string | null; cancelled_by: string | null }
  customer: { id: string; name: string; phone_e164: string; email: string | null; internal_notes: string; completed_visits: number }
  vehicle: { id: string; make: string; model: string; year: number | null; color: string; vehicle_class: VehicleClass; plate: string | null; notes: string }
  events: Array<{ at: string; actor: string; type: string; from_status: BookingStatus | null; to_status: BookingStatus | null; data: Record<string, unknown> }>
  notifications: Array<{ event: string; status: string; attempts: number; last_error: string | null; created_at: string }>
}

export interface CustomerRow {
  id: string
  name: string
  phone_e164: string
  email: string | null
  bookings: number
  last_visit: string | null
  vehicles: string | null
}

export const ownerApi = {
  me: () => call<{ userId: string; email: string | null; memberships: Array<{ slug: string; name: string; status: string; role: string }> }>('me'),
  day: (slug: string, date: string) => call<DayView>(`${slug}/day?date=${date}`),
  bookings: (slug: string, params: { status?: string; q?: string }) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => !!v) as Array<[string, string]>).toString()
    return call<{ bookings: OwnerBookingRow[] }>(`${slug}/bookings${qs ? `?${qs}` : ''}`)
  },
  booking: (slug: string, id: string) => call<BookingDetail>(`${slug}/bookings/${id}`),
  transition: (slug: string, id: string, to: BookingStatus, reason?: string) =>
    call(`${slug}/bookings/${id}/transition`, { method: 'POST', body: reason ? { to, reason } : { to } }),
  finalPrice: (slug: string, id: string, amountMinor: number | null) => call(`${slug}/bookings/${id}/final-price`, { method: 'POST', body: { amountMinor } }),
  rescheduleOptions: (slug: string, id: string, from: string, to: string) =>
    call<{ timezone: string; durationMin: number; days: Array<{ date: string; open: boolean; slots: Array<{ startAt: string; endAt: string; time: string }> }> }>(
      `${slug}/bookings/${id}/availability`, { method: 'POST', body: { from, to } }),
  reschedule: (slug: string, id: string, startAt: string) => call(`${slug}/bookings/${id}/reschedule`, { method: 'POST', body: { startAt } }),
  customers: (slug: string, q: string) => call<{ customers: CustomerRow[] }>(`${slug}/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  customer: (slug: string, id: string) =>
    call<{
      customer: { id: string; name: string; phone_e164: string; email: string | null; internal_notes: string; created_at: string }
      vehicles: BookingDetail['vehicle'][]
      bookings: Array<{ id: string; ref_code: string; status: BookingStatus; start_at: string; service_name: string; price_from_minor: string; final_price_minor: string | null; vehicle: OwnerBookingRow['vehicle'] }>
    }>(`${slug}/customers/${id}`),
  saveNotes: (slug: string, id: string, internalNotes: string) => call(`${slug}/customers/${id}`, { method: 'PATCH', body: { internalNotes } }),
  createBlock: (slug: string, body: { resourceId: string; startsAt: string; endsAt: string; reason: string }) => call<{ id: string }>(`${slug}/blocks`, { method: 'POST', body }),
  removeBlock: (slug: string, id: string) => call(`${slug}/blocks/${id}`, { method: 'DELETE' }),
}

export function useMe(enabled: boolean) {
  return useQuery({ queryKey: ['owner', 'me'], queryFn: ownerApi.me, enabled, staleTime: 60_000 })
}
