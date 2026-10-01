import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Circle, CircleAlert, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { errorMessage } from '@/lib/api'
import { ownerApi, type TelegramSettings } from '@/owner/api'
import { useTenant } from '@/tenant/context'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { Skeleton } from '@/ui/skeleton'

const STATE: Record<TelegramSettings['state'], { label: string; tone: string; icon: typeof CheckCircle2 }> = {
  connected: { label: 'Подключено', tone: 'text-success', icon: CheckCircle2 },
  not_configured: { label: 'Не настроено', tone: 'text-muted-foreground', icon: Circle },
  disabled: { label: 'Выключено', tone: 'text-muted-foreground', icon: Circle },
  delivery_error: { label: 'Ошибка доставки', tone: 'text-danger', icon: CircleAlert },
}

/** Chat ids are shown masked; the full value is only typed in, never echoed back on screen. */
const maskChat = (id: string) => `••••${id.slice(-4)}`

export function SettingsPage() {
  const { slug } = useTenant()
  const queryClient = useQueryClient()
  const data = useQuery({ queryKey: ['owner', slug, 'settings'], queryFn: () => ownerApi.settings(slug) })
  if (data.isPending) return <Skeleton className="m-4 h-60" />
  if (data.isError) return <p className="p-6 text-danger">{errorMessage(data.error)}</p>
  const { settings, telegram, role } = data.data
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['owner', slug, 'settings'] })
  return (
    <main className="mx-auto max-w-2xl space-y-4 px-4 py-4">
      <h1 className="text-lg font-medium">Настройки</h1>
      {telegram
        ? <TelegramSection slug={slug} telegram={telegram} canEdit={role === 'owner'} onChanged={refresh} />
        : (
          <section className="rounded-md border border-line bg-surface-1 p-4 text-sm text-muted-foreground">
            Уведомления в Telegram настраивает владелец студии.
          </section>
        )}
      <section className="rounded-md border border-line bg-surface-1 p-4 text-sm">
        <h2 className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">Правила записи</h2>
        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-1.5">
          <dt className="text-muted-foreground">Шаг сетки</dt><dd className="font-mono">{settings.slot_step_min} мин</dd>
          <dt className="text-muted-foreground">Минимум до визита</dt><dd className="font-mono">{settings.min_notice_min} мин</dd>
          <dt className="text-muted-foreground">Запись вперёд</dt><dd className="font-mono">{settings.horizon_days} дн</dd>
          <dt className="text-muted-foreground">Отмена клиентом не позднее</dt><dd className="font-mono">{settings.cancel_cutoff_hours} ч</dd>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">Меняются через конфигурацию студии (business.json) на этапе запуска.</p>
      </section>
    </main>
  )
}

function TelegramSection({ slug, telegram, canEdit, onChanged }: { slug: string; telegram: TelegramSettings; canEdit: boolean; onChanged: () => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [chatId, setChatId] = useState('')
  const on = enabled ?? telegram.enabled
  const save = useMutation({
    mutationFn: (body: { enabled: boolean; chatId?: string | null }) => ownerApi.setTelegram(slug, body),
    onSuccess: () => {
      setEnabled(null)
      setChatId('')
      onChanged()
    },
  })
  const test = useMutation({ mutationFn: () => ownerApi.sendTelegramTest(slug), onSettled: onChanged })
  const state = STATE[telegram.state]
  const dirty = enabled !== null || chatId.trim() !== ''
  return (
    <section className="rounded-md border border-line bg-surface-1 p-4" aria-labelledby="tg-title">
      <h2 id="tg-title" className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">Telegram</h2>
      <p className={`mt-2 flex items-center gap-2 text-base font-medium ${state.tone}`} data-testid="telegram-state">
        <state.icon className="size-4" /> {state.label}
      </p>
      {telegram.problem && <p className="mt-1 text-sm text-danger">{telegram.problem}</p>}
      <ul className="mt-3 space-y-1.5 text-sm">
        <li className="flex items-center gap-2">
          {telegram.botConfigured ? <CheckCircle2 className="size-4 text-success" /> : <CircleAlert className="size-4 text-warning" />}
          {telegram.botConfigured
            ? <>Бот платформы: {telegram.botUsername ? <span className="font-mono">@{telegram.botUsername}</span> : 'подключён'}</>
            : 'Бот платформы ещё не подключён администратором'}
        </li>
        <li className="flex items-center gap-2">
          {telegram.chatId ? <CheckCircle2 className="size-4 text-success" /> : <Circle className="size-4 text-muted-foreground" />}
          Чат студии: {telegram.chatId ? <span className="font-mono">{maskChat(telegram.chatId)}</span> : 'не указан'}
        </li>
        {telegram.demo && (
          <li className="flex items-center gap-2 text-warning"><CircleAlert className="size-4" /> Демо-режим: уведомления о записях не отправляются никогда. Тестовое сообщение — можно.</li>
        )}
      </ul>

      {canEdit ? (
        <>
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              const typed = chatId.trim()
              save.mutate(typed ? { enabled: on, chatId: typed } : { enabled: on })
            }}
          >
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--tenant-accent)]" checked={on} onChange={(e) => setEnabled(e.target.checked)} />
              Отправлять уведомления о записях в Telegram
            </label>
            <div className="space-y-1.5">
              <Label htmlFor="tg-chat">ID чата</Label>
              <Input id="tg-chat" className="font-mono" inputMode="numeric" autoComplete="off" value={chatId} onChange={(e) => setChatId(e.target.value)}
                placeholder={telegram.chatId ? `${maskChat(telegram.chatId)} — введите, чтобы заменить` : '-1001234567890'} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={save.isPending || !dirty}>Сохранить</Button>
              <Button type="button" variant="secondary" disabled={test.isPending || !telegram.chatId || !telegram.botConfigured} onClick={() => test.mutate()}>
                {test.isPending && <Loader2 className="animate-spin" />} Отправить тестовое сообщение
              </Button>
              {telegram.chatId && (
                <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => save.mutate({ enabled: false, chatId: null })}>Отвязать чат</Button>
              )}
            </div>
          </form>
          {save.isError && <p role="alert" className="mt-2 text-sm text-danger">{errorMessage(save.error)}</p>}
          {test.isSuccess && <p role="status" className="mt-2 text-sm text-success">Тестовое сообщение отправлено.</p>}
          {test.isError && <p role="alert" className="mt-2 text-sm text-danger">{errorMessage(test.error)}</p>}
          <ol className="mt-4 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            <li>Создайте в Telegram группу для уведомлений студии.</li>
            <li>Добавьте в неё бота{telegram.botUsername ? <> <span className="font-mono">@{telegram.botUsername}</span></> : ' платформы'} и напишите в группе любое сообщение.</li>
            <li>Откройте группу на web.telegram.org: число после «#» в адресной строке (например, -1001234567890) — это ID чата.</li>
            <li>Вставьте ID сюда, включите уведомления, сохраните и отправьте тестовое сообщение.</li>
          </ol>
        </>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">Изменить настройки Telegram может только владелец студии.</p>
      )}
    </section>
  )
}
