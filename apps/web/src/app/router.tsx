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
      { path: 'owner/login', lazy: lazyPage(() => import('@/owner/LoginPage'), 'LoginPage') },
      {
        path: 'owner',
        lazy: lazyPage(() => import('@/owner/OwnerLayout'), 'OwnerLayout'),
        children: [
          { index: true, lazy: lazyPage(() => import('@/owner/TodayPage'), 'TodayPage') },
          { path: 'bookings', lazy: lazyPage(() => import('@/owner/BookingsPage'), 'BookingsPage') },
          { path: 'bookings/:id', lazy: lazyPage(() => import('@/owner/BookingDetailPage'), 'BookingDetailPage') },
          { path: 'customers', lazy: lazyPage(() => import('@/owner/CustomersPage'), 'CustomersPage') },
          { path: 'customers/:id', lazy: lazyPage(() => import('@/owner/CustomersPage'), 'CustomerPage') },
          { path: 'settings', lazy: lazyPage(() => import('@/owner/SettingsPage'), 'SettingsPage') },
        ],
      },
    ],
  },
  { path: '*', element: <RouteError notFound /> },
])
