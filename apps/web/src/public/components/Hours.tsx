const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

/** Groups consecutive weekdays with identical hours: "Пн–Пт 09:00–21:00". */
export function groupHours(hours: Array<{ weekday: number; opens: string; closes: string }>): Array<{ days: string; hours: string }> {
  const perDay = DAYS.map((_, i) => hours.filter((h) => h.weekday === i + 1).map((h) => `${h.opens}–${h.closes}`).join(', ') || 'выходной')
  const out: Array<{ days: string; hours: string }> = []
  let start = 0
  for (let i = 1; i <= 7; i++) {
    if (i === 7 || perDay[i] !== perDay[start]) {
      out.push({ days: i - 1 === start ? DAYS[start]! : `${DAYS[start]}–${DAYS[i - 1]}`, hours: perDay[start]! })
      start = i
    }
  }
  return out
}

export function Hours({ hours }: { hours: Array<{ weekday: number; opens: string; closes: string }> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 font-mono text-sm tabular">
      {groupHours(hours).map((g) => (
        <div key={g.days} className="contents">
          <dt className="text-muted-foreground">{g.days}</dt>
          <dd className={g.hours === 'выходной' ? 'text-faint-foreground' : ''}>{g.hours}</dd>
        </div>
      ))}
    </dl>
  )
}
