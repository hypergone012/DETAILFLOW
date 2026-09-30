import { deriveAccentTokens } from '@detailflow/config'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { Outlet, useParams } from 'react-router'
import { ApiError, publicApi } from '@/lib/api'
import { TenantContext } from '@/tenant/context'
import { Skeleton } from '@/ui/skeleton'

export function useStorefrontQuery(slug: string) {
  return useQuery({
    queryKey: ['storefront', slug],
    queryFn: ({ signal }) => publicApi.storefront(slug, signal),
    staleTime: 60_000,
  })
}

/** Resolves the studio from the URL slug and applies its single accent colour. */
export function TenantLayout() {
  const { slug = '' } = useParams()
  const query = useStorefrontQuery(slug)
  const storefront = query.data

  useEffect(() => {
    if (!storefront) return
    const t = deriveAccentTokens(storefront.profile.accent_hex)
    const root = document.documentElement.style
    root.setProperty('--tenant-accent', t.accent)
    root.setProperty('--tenant-accent-hover', t.accentHover)
    root.setProperty('--tenant-accent-subtle', t.accentSubtle)
    root.setProperty('--tenant-on-accent', t.onAccent)
    document.title = storefront.tenant.name
  }, [storefront])

  const value = useMemo(() => (storefront ? { slug, storefront } : null), [slug, storefront])

  if (query.isPending) {
    return (
      <div className="mx-auto max-w-lg space-y-4 p-6" aria-busy="true">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    )
  }
  if (query.isError || !value) {
    const notFound = query.error instanceof ApiError && query.error.status === 404
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-6">
        <p className="font-mono text-xs text-muted-foreground">{notFound ? '404' : 'ERROR'}</p>
        <h1 className="font-display text-2xl">{notFound ? 'Студия не найдена' : 'Не удалось загрузить страницу'}</h1>
        <p className="text-muted-foreground">{notFound ? 'Проверьте ссылку.' : 'Проверьте соединение и обновите страницу.'}</p>
      </main>
    )
  }
  return (
    <TenantContext.Provider value={value}>
      <Outlet />
    </TenantContext.Provider>
  )
}
