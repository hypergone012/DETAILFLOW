import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CircleAlert } from 'lucide-react'
import { useState } from 'react'
import { errorMessage } from '@/lib/api'
import { ownerApi } from '@/owner/api'
import { useTenant } from '@/tenant/context'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { Skeleton } from '@/ui/skeleton'

const STATUS_TEXT: Record<string, string> = {
  sent: 'доставлено',
  failed: 'ошибка доставки',
  pending: 'в очереди',
  suppressed_demo: 'не отправлено: демо-режим',
  not_configured: 'не отправлено: не настроено',
}

export function SettingsPage() {
  const { slug, storefront } = useTenant()
  const queryClient = useQueryClient()
  const data = useQuery({ queryKey: ['owner', slug, 'settings'], queryFn: () => ownerApi.settings(slug) })
  const [chatId, setChatId] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (v: string | null) => ownerApi.setTelegramChat(slug, v),
    onSuccess: () => {
      setChatId(null)
      void queryClient.invalidateQueries({ queryKey: ['owner', slug, 'settings'] })
    },
  })
  if (data.isPending) return <Skeleton className="m-4 h-60" />
  if (data.isError) return <p className="p-6 text-danger">{errorMessage(data.error)}</p>
  const { settings, telegramBotConfigured, lastNotification, role } = data.data
  const value = chatId ?? settings.telegram_chat_id ?? ''
  return (
    <main className="mx-auto max-w-2xl space-y-4 px-4 py-4">
      <h1 className="text-lg font-medium">Настройки</h1>
      <section className="rounded-md border border-line bg-surface-1 p-4">
        <h2 className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">Уведомления в Telegram</h2>
        <ul className="mt-3 space-y-1.5 text-sm">
          <li className="flex items-center gap-2">
            {telegramBotConfigured ? <CheckCircle2 className="size-4 text-success" /> : <CircleAlert className="size-4 text-warning" />}
            Бот платформы: {telegramBotConfigured ? 'подключён' : 'не подключён (нет токена на сервере)'}
          </li>
          <li className="flex items-center gap-2">
            {settings.telegram_chat_id ? <CheckCircle2 className="size-4 text-success" /> : <CircleAlert className="size-4 text-warning" />}
            Чат студии: {settings.telegram_chat_id ? <span className="font-mono">{settings.telegram_chat_id}</span> : 'не указан'}
          </li>
          {storefront.tenant.status === 'demo' && (
            <li className="flex items-center gap-2 text-warning"><CircleAlert className="size-4" /> Демо-режим: уведомления не отправляются никогда.</li>
          )}
          {lastNotification && (
            <li className="text-muted-foreground">Последнее уведомление: {STATUS_TEXT[lastNotification.status] ?? lastNotification.status}{lastNotification.last_error ? ` — ${lastNotification.last_error}` : ''}</li>
          )}
        </ul>
        {role === 'owner' ? (
          <form className="mt-4 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate(value.trim() || null) }}>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="tg-chat">ID чата или группы</Label>
              <Input id="tg-chat" className="font-mono" inputMode="numeric" value={value} onChange={(e) => setChatId(e.target.value)} placeholder="-1001234567890" />
            </div>
            <Button type="submit" disabled={save.isPending || chatId === null}>Сохранить</Button>
          </form>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">Изменить чат может только владелец студии.</p>
        )}
        {save.isError && <p role="alert" className="mt-2 text-sm text-danger">{errorMessage(save.error)}</p>}
        <p className="mt-3 text-xs text-muted-foreground">Добавьте бота платформы в чат студии и укажите ID чата. Новые записи, подтверждения, переносы и отмены будут приходить туда.</p>
      </section>
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
