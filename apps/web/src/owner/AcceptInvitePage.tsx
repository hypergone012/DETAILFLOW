import { Loader2 } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { supabase } from '@/owner/auth'
import { useTenant } from '@/tenant/context'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'

/** Invite acceptance: exchanges the one-time token with Supabase Auth, then the new member sets a password. */
export function AcceptInvitePage() {
  const { slug, storefront } = useTenant()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const tokenHash = params.get('token_hash')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // One-time token: verify exactly once, never retry.
  const verify = useQuery({
    queryKey: ['accept-invite', tokenHash],
    queryFn: async () => {
      const { error: err } = await supabase.auth.verifyOtp({ token_hash: tokenHash!, type: 'invite' })
      if (err) throw err
      return true
    },
    enabled: !!tokenHash,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const state = !tokenHash || verify.isError ? 'error' : verify.isSuccess ? 'set-password' : 'verifying'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const { error: err } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (err) setError('Не удалось сохранить пароль. Минимум 8 символов.')
    else navigate(`/s/${slug}/owner`, { replace: true })
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <p className="font-mono text-[11px] tracking-[0.16em] text-muted-foreground uppercase">Приглашение</p>
      <h1 className="mt-2 font-display text-xl uppercase">{storefront.tenant.name}</h1>
      {state === 'verifying' && <Loader2 className="mt-8 animate-spin text-muted-foreground" />}
      {state === 'error' && <p role="alert" className="mt-6 text-danger">Ссылка недействительна или уже использована. Попросите новое приглашение.</p>}
      {state === 'set-password' && (
        <form className="mt-8 space-y-4" onSubmit={(e) => void submit(e)}>
          <div className="space-y-1.5">
            <Label htmlFor="new-password">Придумайте пароль</Label>
            <Input id="new-password" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <Button type="submit" size="lg" className="w-full" disabled={busy || password.length < 8}>Войти в кабинет</Button>
        </form>
      )}
    </main>
  )
}
