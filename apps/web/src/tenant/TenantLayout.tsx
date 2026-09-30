import { Outlet, useParams } from 'react-router'

export function TenantLayout() {
  const { slug } = useParams()
  return (
    <div data-tenant={slug} className="min-h-dvh">
      <Outlet />
    </div>
  )
}
