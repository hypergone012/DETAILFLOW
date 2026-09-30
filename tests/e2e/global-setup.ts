import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export default function globalSetup(): void {
  execFileSync(join(import.meta.dirname, '../../scripts/local/e2e-prepare.sh'), { stdio: 'inherit' })
}
