import {
  API_ERROR_MESSAGES,
  availabilityResponseSchema,
  createBookingResponseSchema,
  managedBookingSchema,
  storefrontSchema,
  type AvailabilityRequest,
  type AvailabilityResponse,
  type CreateBookingRequest,
  type CreateBookingResponse,
  type ManagedBooking,
  type Storefront,
} from '@detailflow/domain'
import type { z } from 'zod'
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '@/lib/env'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return API_ERROR_MESSAGES.INTERNAL!
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  token?: string | undefined
  signal?: AbortSignal | undefined
}

export async function apiFetch<T>(path: string, schema: z.ZodType<T> | null, opts: RequestOptions = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'Нет соединения. Проверьте интернет и попробуйте ещё раз.')
  }
  const text = await res.text()
  const data: unknown = text ? JSON.parse(text) : null
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error
    const code = err?.code ?? 'INTERNAL'
    throw new ApiError(res.status, code, API_ERROR_MESSAGES[code] ?? err?.message ?? API_ERROR_MESSAGES.INTERNAL!)
  }
  return schema ? schema.parse(data) : (data as T)
}

const enc = encodeURIComponent

export const publicApi = {
  storefront: (slug: string, signal?: AbortSignal): Promise<Storefront> =>
    apiFetch(`public-api/storefront/${enc(slug)}`, storefrontSchema, { signal }),
  availability: (slug: string, body: AvailabilityRequest, signal?: AbortSignal): Promise<AvailabilityResponse> =>
    apiFetch(`public-api/availability/${enc(slug)}`, availabilityResponseSchema, { method: 'POST', body, signal }),
  createBooking: (slug: string, body: CreateBookingRequest): Promise<CreateBookingResponse> =>
    apiFetch(`public-api/bookings/${enc(slug)}`, createBookingResponseSchema, { method: 'POST', body }),
  managed: (slug: string, token: string, signal?: AbortSignal): Promise<ManagedBooking> =>
    apiFetch(`public-api/manage/${enc(slug)}/${enc(token)}`, managedBookingSchema, { signal }),
  manageAvailability: (slug: string, token: string, body: { from: string; to: string }): Promise<AvailabilityResponse> =>
    apiFetch(`public-api/manage/${enc(slug)}/${enc(token)}/availability`, availabilityResponseSchema, { method: 'POST', body }),
  reschedule: (slug: string, token: string, startAt: string): Promise<ManagedBooking> =>
    apiFetch(`public-api/manage/${enc(slug)}/${enc(token)}/reschedule`, managedBookingSchema, { method: 'POST', body: { startAt } }),
  cancel: (slug: string, token: string, reason?: string): Promise<ManagedBooking> =>
    apiFetch(`public-api/manage/${enc(slug)}/${enc(token)}/cancel`, managedBookingSchema, { method: 'POST', body: reason ? { reason } : {} }),
}
