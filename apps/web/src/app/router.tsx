import { createBrowserRouter } from 'react-router'
import { RouteError } from '@/app/RouteError'
import { StudioIndex } from '@/app/StudioIndex'
import { TenantLayout } from '@/tenant/TenantLayout'

export const router = createBrowserRouter([
  { path: '/', element: <StudioIndex />, errorElement: <RouteError /> },
  {
    path: '/s/:slug',
    element: <TenantLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, lazy: async () => ({ Component: (await import('@/public/HomePage')).HomePage }) },
    ],
  },
  { path: '*', element: <RouteError notFound /> },
])
