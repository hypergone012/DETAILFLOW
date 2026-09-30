/**
 * One configurable accent per tenant. Derived tokens are computed, and the
 * accent must pass WCAG contrast on DETAILFLOW's graphite background.
 */
export const BACKGROUND_HEX = '#0b0c0e'
const DARK_TEXT = '#0b0c0e'
const LIGHT_TEXT = '#ffffff'

export interface AccentTokens {
  accent: string
  accentHover: string
  accentSubtle: string
  onAccent: string
}

function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) throw new RangeError(`invalid hex color: ${hex}`)
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)]
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function mix(hex: string, towards: string, amount: number): string {
  const a = rgb(hex)
  const b = rgb(towards)
  return toHex([0, 1, 2].map((i) => a[i]! + (b[i]! - a[i]!) * amount) as [number, number, number])
}

export function deriveAccentTokens(accentHex: string): AccentTokens {
  const accent = accentHex.toLowerCase()
  const [r, g, b] = rgb(accent)
  const onAccent = contrastRatio(accent, DARK_TEXT) >= contrastRatio(accent, LIGHT_TEXT) ? DARK_TEXT : LIGHT_TEXT
  return {
    accent,
    accentHover: mix(accent, '#ffffff', 0.12),
    accentSubtle: `rgb(${r} ${g} ${b} / 0.14)`,
    onAccent,
  }
}

export interface ContrastReport {
  accentOnBackground: number
  textOnAccent: number
  ok: boolean
}

/** Accent as text/UI on the background (AA large/UI: 3.0) and label on accent (AA: 4.5). */
export function checkAccentContrast(accentHex: string): ContrastReport {
  const tokens = deriveAccentTokens(accentHex)
  const accentOnBackground = contrastRatio(tokens.accent, BACKGROUND_HEX)
  const textOnAccent = contrastRatio(tokens.onAccent, tokens.accent)
  return { accentOnBackground, textOnAccent, ok: accentOnBackground >= 4.5 && textOnAccent >= 4.5 }
}
