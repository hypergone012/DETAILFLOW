/** Supabase project URL (local: the dev gateway from `pnpm functions:serve`). */
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? 'http://127.0.0.1:54321'
/** Publishable (anon) key; required by the hosted Supabase gateway, unused locally. */
export const SUPABASE_PUBLISHABLE_KEY: string = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? 'local-publishable-key'
