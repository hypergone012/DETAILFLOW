import { formatPriceFrom, VEHICLE_CLASS_LABELS, type VehicleClass } from '@detailflow/domain'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowRight, Loader2, MessageSquare, Send } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { apiFetch, errorMessage } from '@/lib/api'
import { formatWindow } from '@/lib/format'
import { useTenant } from '@/tenant/context'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/ui/sheet'

interface Draft {
  serviceSlug: string
  serviceName: string
  vehicleClass: VehicleClass
  startAt: string
  endAt: string
  priceFromMinor: number
}
interface Turn {
  role: 'user' | 'assistant'
  text: string
  draft?: Draft | null
}

/**
 * Optional AI concierge. Rendered only when the server reports it available;
 * any failure degrades to a link to the regular booking form.
 */
export function AssistantLauncher() {
  const { slug, storefront } = useTenant()
  const status = useQuery({
    queryKey: ['assistant-status', slug],
    queryFn: () => apiFetch<{ available: boolean }>(`assistant/${slug}/status`, null),
    enabled: storefront.ai_enabled,
    staleTime: 60_000,
    retry: false,
  })
  const [open, setOpen] = useState(false)
  const [sessionId] = useState(() => crypto.randomUUID())
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')

  const send = useMutation({
    mutationFn: (history: Turn[]) =>
      apiFetch<{ reply: string; draft: Draft | null }>(`assistant/${slug}/chat`, null, {
        method: 'POST',
        body: { sessionId, messages: history.slice(-19).map(({ role, text }) => ({ role, text })) },
      }),
    onSuccess: (res) => setTurns((t) => [...t, { role: 'assistant', text: res.reply, draft: res.draft }]),
  })

  if (!storefront.ai_enabled || !status.data?.available) return null
  const tz = storefront.tenant.timezone

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || send.isPending) return
    const history: Turn[] = [...turns, { role: 'user', text }]
    setTurns(history)
    setInput('')
    send.mutate(history)
  }

  return (
    <>
      <Button className="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 shadow-xl" onClick={() => setOpen(true)}>
        <MessageSquare /> Спросить
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="h-[85dvh] px-4 pt-5 pb-safe">
          <SheetTitle>Консультант {storefront.tenant.name}</SheetTitle>
          <SheetDescription className="mt-1">Подберёт услугу и время. Записываетесь вы сами — в обычной форме.</SheetDescription>
          <div className="mt-4 flex-1 space-y-3 overflow-y-auto" aria-live="polite">
            {turns.length === 0 && (
              <p className="text-sm text-muted-foreground">Например: «Что лучше для новой машины — керамика или плёнка?»</p>
            )}
            {turns.map((t, i) => (
              <div key={i} className={t.role === 'user' ? 'ml-10 rounded-md bg-surface-3 p-3 text-sm' : 'mr-6 text-sm leading-relaxed whitespace-pre-line'}>
                {t.text}
                {t.draft && (
                  <div className="mt-3 rounded-md border border-accent/50 bg-accent-subtle p-3">
                    <p className="font-medium">{t.draft.serviceName}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {formatWindow(t.draft.startAt, t.draft.endAt, tz, false).split(',').slice(0, 2).join(',')} · {VEHICLE_CLASS_LABELS[t.draft.vehicleClass].label} · {formatPriceFrom(t.draft.priceFromMinor)}
                    </p>
                    <Button asChild size="sm" className="mt-3">
                      <Link to={`/s/${slug}/book?service=${t.draft.serviceSlug}&class=${t.draft.vehicleClass}&start=${encodeURIComponent(t.draft.startAt)}&end=${encodeURIComponent(t.draft.endAt)}`}>
                        Продолжить запись <ArrowRight />
                      </Link>
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {send.isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            {send.isError && (
              <div role="alert" className="rounded-md border border-line bg-surface-2 p-3 text-sm">
                {errorMessage(send.error)}
                <Button asChild size="sm" variant="secondary" className="mt-2 flex w-fit">
                  <Link to={`/s/${slug}/book`}>Записаться через форму</Link>
                </Button>
              </div>
            )}
          </div>
          <form onSubmit={submit} className="mt-3 flex gap-2">
            <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ваш вопрос" maxLength={2000} aria-label="Вопрос консультанту" />
            <Button type="submit" size="icon" disabled={send.isPending || !input.trim()} aria-label="Отправить"><Send /></Button>
          </form>
        </SheetContent>
      </Sheet>
    </>
  )
}
