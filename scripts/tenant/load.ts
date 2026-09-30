import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { validateBusiness, type ValidationResult } from '@detailflow/config'

export const TENANTS_DIR = join(import.meta.dirname, '../../tenants')

export function tenantSlugs(): string[] {
  return readdirSync(TENANTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(TENANTS_DIR, d.name, 'business.json')))
    .map((d) => d.name)
    .sort()
}

export function loadTenant(slug: string, root = TENANTS_DIR): ValidationResult {
  const dir = join(root, slug)
  const raw: unknown = JSON.parse(readFileSync(join(dir, 'business.json'), 'utf8'))
  const result = validateBusiness(raw, { assetExists: (p) => existsSync(join(dir, p)) })
  if (result.ok && result.business!.slug !== slug) {
    return { ok: false, errors: [`slug "${result.business!.slug}" does not match directory "${slug}"`] }
  }
  return result
}

/** Public URL of a tenant asset (static, synced into apps/web/public/tenants). */
export function assetUrl(slug: string, path: string): string {
  return `/tenants/${slug}/${path.replace(/^assets\//, '')}`
}
