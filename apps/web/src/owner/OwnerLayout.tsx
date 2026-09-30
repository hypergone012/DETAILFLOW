import { CalendarDays, ClipboardList, LogOut, Settings, Users } from 'lucide-react'
import { Navigate, NavLink, Outlet, useLocation } from 'react-router'
import { cn } from '@/lib/utils'
import { useMe } from '@/owner/api'
import { supabase, useSession } from '@/owner/auth'
import { useTenant } from '@/tenant/context'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Skeleton } from '@/ui/skeleton'

const NAV = [
  { to: '', label: 'Сегодня', icon: CalendarDays, end: true },
  { to: 'bookings', label: 'Записи', icon: ClipboardList, end: false },
  { to: 'customers', label: 'Клиенты', icon: Users, end: false },
  { to: 'settings', label: 'Настройки', icon: Settings, end: false },
]

export function OwnerLayout() {
  const { slug, storefront } = useTenant()
  const { session, loading } = useSession()
  const location = useLocation()
  const me = useMe(!!session)

  if (loading) return <Skeleton className="m-6 h-40" />
  if (!session) return <Navigate to={`/s/${slug}/owner/login`} replace state={{ from: location.pathname }} />
  if (me.isPending) return <Skeleton className="m-6 h-40" />
  const membership = me.data?.memberships.find((m) => m.slug === slug)
  if (!membership) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6">
        <h1 className="font-display text-xl">Нет доступа к этой студии</h1>
        <p className="text-sm text-muted-foreground">Аккаунт {me.data?.email ?? ''} не является сотрудником «{storefront.tenant.name}».</p>
        <Button variant="secondary" className="self-start" onClick={() => void supabase.auth.signOut()}>Выйти</Button>
      </main>
    )
  }
  const base = `/s/${slug}/owner`
  return (
    <div className="flex min-h-dvh flex-col pb-16 md:pb-0">
      <header className="sticky top-0 z-30 border-b border-line bg-background/90 backdrop-blur-md">
        <div className="mx-auto flex h-12 max-w-7xl items-center gap-4 px-4">
          <span className="truncate font-display text-xs tracking-wide uppercase">{storefront.tenant.name}</span>
          {storefront.tenant.status === 'demo' && <Badge tone="warning">демо</Badge>}
          <nav className="ml-4 hidden gap-1 md:flex">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to ? `${base}/${n.to}` : base} end={n.end}
                className={({ isActive }) => cn('rounded-sm px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground', isActive && 'bg-surface-2 text-foreground')}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden font-mono text-xs text-faint-foreground sm:inline">{me.data?.email} · {membership.role}</span>
            <Button variant="ghost" size="sm" onClick={() => void supabase.auth.signOut()} aria-label="Выйти">
              <LogOut />
            </Button>
          </div>
        </div>
      </header>
      <div className="flex-1">
        <Outlet />
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-line bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to ? `${base}/${n.to}` : base} end={n.end}
            className={({ isActive }) => cn('flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground', isActive && 'text-accent')}>
            <n.icon className="size-5" />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
