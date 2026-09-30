import { Loader2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router'
import { supabase, useSession } from '@/owner/auth'
import { useTenant } from '@/tenant/context'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'

export function LoginPage() {
  const { slug, storefront } = useTenant()
  const { session } = useSession()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (session) return <Navigate to={(location.state as { from?: string } | null)?.from ?? `/s/${slug}/owner`} replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setBusy(false)
    if (err) setError(err.status === 400 ? 'Неверный email или пароль' : 'Не удалось войти. Попробуйте ещё раз.')
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      {storefront.profile.logo_url && <img src={storefront.profile.logo_url} alt="" className="size-10" />}
      <p className="mt-6 font-mono text-[11px] tracking-[0.16em] text-muted-foreground uppercase">Кабинет студии</p>
      <h1 className="mt-2 font-display text-xl uppercase">{storefront.tenant.name}</h1>
      <form className="mt-8 space-y-4" onSubmit={(e) => void submit(e)}>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Пароль</Label>
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />} Войти
        </Button>
      </form>
    </main>
  )
}
