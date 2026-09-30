import { createClient, type Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '@/lib/env'

/** Supabase Auth only; all data goes through the owner-api Edge Function under RLS. */
export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
})

export function useSession(): { session: Session | null; loading: boolean } {
  const [state, setState] = useState<{ session: Session | null; loading: boolean }>({ session: null, loading: true })
  useEffect(() => {
    let active = true
    void supabase.auth.getSession().then(({ data }) => active && setState({ session: data.session, loading: false }))
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setState({ session, loading: false }))
    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])
  return state
}
