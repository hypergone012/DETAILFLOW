import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportEnv, generateSecret, pickKeys, poolerUrls, sqlLiteral } from './provision.ts'

describe('provision helpers', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('generated secrets are long and safe in URLs and SQL literals', () => {
    const s = generateSecret(36)
    expect(s).toMatch(/^[A-Za-z0-9_-]{48}$/)
    expect(generateSecret(36)).not.toBe(s)
  })

  it('quotes SQL literals', () => {
    expect(sqlLiteral("a'b")).toBe("'a''b'")
  })

  it('prefers new publishable/secret keys and falls back to legacy anon/service_role', () => {
    expect(pickKeys([
      { name: 'anon', type: 'legacy', api_key: 'eyJanon' },
      { name: 'service_role', type: 'legacy', api_key: 'eyJsr' },
      { name: 'default', type: 'publishable', api_key: 'sb_publishable_x' },
      { name: 'default', type: 'secret', api_key: 'sb_secret_y' },
    ])).toEqual({ publishable: 'sb_publishable_x', secret: 'sb_secret_y' })
    expect(pickKeys([
      { name: 'anon', type: 'legacy', api_key: 'eyJanon' },
      { name: 'service_role', type: 'legacy', api_key: 'eyJsr' },
    ])).toEqual({ publishable: 'eyJanon', secret: 'eyJsr' })
    expect(() => pickKeys([{ name: 'anon', type: 'legacy', api_key: 'eyJanon' }])).toThrow(/not found/)
  })

  it('builds session-mode admin and transaction-mode df_edge pooler URLs', () => {
    const u = poolerUrls({ db_host: 'aws-0-eu-central-1.pooler.supabase.com', db_name: 'postgres' }, 'abcdefghijklmnopqrst', 'P', 'E')
    expect(u.admin).toBe('postgres://postgres.abcdefghijklmnopqrst:P@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require')
    expect(u.edge).toBe('postgres://df_edge.abcdefghijklmnopqrst:E@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require')
  })

  it('masks secrets before exporting them to later steps', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    vi.stubEnv('GITHUB_ENV', '')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    exportEnv('X_SECRET', 'value-1', true)
    exportEnv('X_PUBLIC', 'value-2', false)
    expect(log.mock.calls.map((c) => c[0])).toEqual(['::add-mask::value-1'])
    expect(() => exportEnv('X', 'a\nb', false)).toThrow(/multi-line/)
    log.mockRestore()
  })
})
