import { isRouteErrorResponse, Link, useRouteError } from 'react-router'
import { Button } from '@/ui/button'

export function RouteError({ notFound = false }: { notFound?: boolean }) {
  const error = useRouteError()
  const is404 = notFound || (isRouteErrorResponse(error) && error.status === 404)
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6">
      <p className="font-mono text-xs text-muted-foreground">{is404 ? '404' : 'ERROR'}</p>
      <h1 className="font-display text-2xl">{is404 ? 'Страница не найдена' : 'Что-то пошло не так'}</h1>
      <p className="text-muted-foreground">
        {is404 ? 'Проверьте адрес ссылки.' : 'Обновите страницу. Если ошибка повторяется — свяжитесь со студией.'}
      </p>
      <Button asChild variant="secondary" className="self-start">
        <Link to="/">На главную</Link>
      </Button>
    </main>
  )
}
