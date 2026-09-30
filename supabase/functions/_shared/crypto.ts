const enc = new TextEncoder()

export function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

export async function sha256Hex(data: string): Promise<string> {
  return [...(await sha256(data))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Manage-link token: HMAC(secret, booking id). Deterministic so an idempotent
 * replay (lost response, retry) returns the same link; only its SHA-256 is
 * stored in the database.
 */
export async function manageToken(secret: string, bookingId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`manage:${bookingId}`))))
}

/** Constant-time string comparison for shared secrets. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export function isWellFormedToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token)
}

/** Stable JSON (sorted keys) for request hashing. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`
}
