/** Money is stored as integer minor units (kopecks for RUB). */
export type MinorUnits = number

const rubFormatter = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 0,
})

export function formatRub(minor: MinorUnits): string {
  if (!Number.isInteger(minor)) throw new TypeError('money must be integer minor units')
  return rubFormatter.format(Math.round(minor / 100))
}

/** "от 45 000 ₽" — detailing prices are always a lower bound until inspection. */
export function formatPriceFrom(minor: MinorUnits): string {
  return `от ${formatRub(minor)}`
}

export function rubToMinor(rub: number): MinorUnits {
  if (!Number.isFinite(rub) || rub < 0) throw new RangeError('invalid rub amount')
  return Math.round(rub * 100)
}
