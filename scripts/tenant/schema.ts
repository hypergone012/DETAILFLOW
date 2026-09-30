/** Writes tenants/business.schema.json (editor autocompletion for business.json). */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { businessSchema } from '@detailflow/config'
import { z } from 'zod'

writeFileSync(join(import.meta.dirname, '../../tenants/business.schema.json'), JSON.stringify(z.toJSONSchema(businessSchema), null, 2) + '\n')
console.log('tenants/business.schema.json written')
