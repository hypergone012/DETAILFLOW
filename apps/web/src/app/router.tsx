import { createBrowserRouter } from 'react-router'
import { RouteError } from '@/app/RouteError'
import { StudioIndex } from '@/app/StudioIndex'
import { TenantLayout } from '@/tenant/TenantLayout'

const lazyPage = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) => async () => ({ Component: (await load())[name] })

export const router = createBrowserRouter([
  { path: '/', element: <StudioIndex />, errorElement: <RouteError /> },
  {
    path: '/s/:slug',
    element: <TenantLayout />,
    errorElement: <RouteError />,
    children: [
      {
        lazy: lazyPage(() => import('@/public/PublicLayout'), 'PublicLayout'),
        children: [
          { index: true, lazy: lazyPage(() => import('@/public/HomePage'), 'HomePage') },
          { path: 'services/:serviceSlug', lazy: lazyPage(() => import('@/public/ServicePage'), 'ServicePage') },
          { path: 'b/:token', lazy: lazyPage(() => import('@/booking/ManagePage'), 'ManagePage') },
        ],
      },
      { path: 'book', lazy: lazyPage(() => import('@/booking/BookingPage'), 'BookingPage') },
    ],
  },
  { path: '*', element: <RouteError notFound /> },
])
