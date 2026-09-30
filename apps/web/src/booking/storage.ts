import type { VehicleInput } from '@detailflow/domain'

/** Device-only conveniences. Nothing here is trusted by the server. */
function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage unavailable (private mode): feature silently off
  }
}

export const savedVehicles = {
  list: (slug: string): VehicleInput[] => read(`df:vehicles:${slug}`, []),
  remember(slug: string, v: VehicleInput): void {
    const key = (x: VehicleInput) => `${x.make}|${x.model}|${x.plate ?? ''}`.toLowerCase()
    write(`df:vehicles:${slug}`, [v, ...this.list(slug).filter((x) => key(x) !== key(v))].slice(0, 4))
  },
}

export interface SavedBooking {
  token: string
  ref: string
  startAt: string
  service: string
}

export const savedBookings = {
  list: (slug: string): SavedBooking[] => read(`df:bookings:${slug}`, []),
  add(slug: string, b: SavedBooking): void {
    write(`df:bookings:${slug}`, [b, ...this.list(slug).filter((x) => x.token !== b.token)].slice(0, 10))
  },
}

export const savedContact = {
  get: (slug: string): { name: string; phone: string; email: string } | null => read(`df:contact:${slug}`, null),
  set: (slug: string, c: { name: string; phone: string; email: string }): void => write(`df:contact:${slug}`, c),
}

export function sessionDraft<T>(key: string) {
  return {
    load(): T | null {
      try {
        const raw = window.sessionStorage.getItem(key)
        return raw ? (JSON.parse(raw) as T) : null
      } catch {
        return null
      }
    },
    save(value: T): void {
      try {
        window.sessionStorage.setItem(key, JSON.stringify(value))
      } catch {
        // ignore
      }
    },
    clear(): void {
      try {
        window.sessionStorage.removeItem(key)
      } catch {
        // ignore
      }
    },
  }
}
