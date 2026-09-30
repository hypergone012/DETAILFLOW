import type { Storefront } from '@detailflow/domain'
import { createContext, useContext } from 'react'

export interface TenantContextValue {
  slug: string
  storefront: Storefront
}

export const TenantContext = createContext<TenantContextValue | null>(null)

export function useTenant(): TenantContextValue {
  const ctx = useContext(TenantContext)
  if (!ctx) throw new Error('useTenant outside TenantLayout')
  return ctx
}
