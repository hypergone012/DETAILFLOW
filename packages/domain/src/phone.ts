import { parsePhoneNumberFromString } from 'libphonenumber-js/min'

/** Normalizes a Russian-market phone to E.164, or null when invalid. */
export function normalizePhone(input: string, defaultCountry: 'RU' = 'RU'): string | null {
  const parsed = parsePhoneNumberFromString(input.trim(), defaultCountry)
  if (!parsed || !parsed.isValid()) return null
  return parsed.number
}

export function formatPhone(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164)
  return parsed ? parsed.formatInternational() : e164
}

export function normalizePlate(input: string | null | undefined): string | null {
  const v = (input ?? '').replace(/\s+/g, '').toUpperCase()
  return v.length > 0 ? v : null
}
