#!/usr/bin/env bash
# Fresh database for E2E: recreate postgres_df (restarting Supabase Auth),
# apply migrations, seed both demo studios with their owners.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
scripts/local/stack.sh reset >/dev/null
pnpm -s tsx scripts/db/migrate.ts >/dev/null
scripts/local/stack.sh enable-edge-role >/dev/null
pnpm -s tsx scripts/tenant/seed.ts --all
