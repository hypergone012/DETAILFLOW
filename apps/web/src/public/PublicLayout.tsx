import { lazy, Suspense } from 'react'
import { Link, Outlet } from 'react-router'
import { useTenant } from '@/tenant/context'

// The assistant is a separate chunk: the storefront and booking never depend on it.
const AssistantLauncher = lazy(async () => ({ default: (await import('@/assistant/AssistantLauncher')).AssistantLauncher }))

export function DemoBanner() {
  return (
    <div role="note" className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-center text-xs text-warning">
      Демо-режим: записи настоящие для системы, но уведомления в студию не отправляются.
    </div>
  )
}

export function PublicLayout() {
  const { slug, storefront } = useTenant()
  const { tenant, profile } = storefront
  if (tenant.status === 'suspended') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-6">
        <h1 className="font-display text-2xl">{tenant.name}</h1>
        <p className="text-muted-foreground">Онлайн-запись временно недоступна. {profile.phone_display ? `Позвоните: ${profile.phone_display}` : ''}</p>
      </main>
    )
  }
  return (
    <div className="flex min-h-dvh flex-col">
      {tenant.status === 'demo' && <DemoBanner />}
      <header className="sticky top-0 z-30 border-b border-line bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
          <Link to={`/s/${slug}`} className="flex min-w-0 items-center gap-2.5">
            {profile.logo_url && <img src={profile.logo_url} alt="" className="size-7 shrink-0" />}
            <span className="truncate font-display text-sm tracking-wide uppercase">{tenant.name}</span>
          </Link>
          {profile.phone_e164 && (
            <a href={`tel:${profile.phone_e164}`} className="font-mono text-xs text-muted-foreground hover:text-foreground">
              {profile.phone_display ?? profile.phone_e164}
            </a>
          )}
        </div>
      </header>
      <div className="flex-1">
        <Outlet />
      </div>
      <Suspense fallback={null}>
        <AssistantLauncher />
      </Suspense>
      <footer className="border-t border-line px-4 py-6 text-center text-xs text-faint-foreground">
        {tenant.name} · Онлайн-запись на платформе DETAILFLOW
      </footer>
    </div>
  )
}
