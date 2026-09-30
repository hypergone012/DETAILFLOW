#!/usr/bin/env bash
# Deploys DETAILFLOW to a hosted Supabase project.
#
# Requires: supabase CLI >= 2.x, and in the environment
#   SUPABASE_ACCESS_TOKEN   personal access token (CLI auth)
#   SUPABASE_PROJECT_REF    project ref (xxxxxxxxxxxxxxxxxxxx)
#   SUPABASE_DB_PASSWORD    database password (for `db push`)
#   PROD_SECRETS_FILE       path to a dotenv file with function secrets
#                           (never committed; see docs/PRODUCTION.md)
#
# Steps are idempotent: link, migrations, secrets, functions.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

: "${SUPABASE_ACCESS_TOKEN:?}" "${SUPABASE_PROJECT_REF:?}" "${SUPABASE_DB_PASSWORD:?}" "${PROD_SECRETS_FILE:?}"

for required in DF_DB_URL DF_MANAGE_TOKEN_SECRET DF_ALLOWED_ORIGINS DF_APP_URL DF_DISPATCHER_SECRET; do
  grep -q "^${required}=." "$PROD_SECRETS_FILE" || { echo "missing ${required} in PROD_SECRETS_FILE" >&2; exit 1; }
done
if grep -q "^DF_ALLOW_PRIVILEGED_DB_ROLE=true" "$PROD_SECRETS_FILE"; then
  echo "refusing to deploy with DF_ALLOW_PRIVILEGED_DB_ROLE=true" >&2; exit 1
fi

supabase link --project-ref "$SUPABASE_PROJECT_REF" --password "$SUPABASE_DB_PASSWORD"
supabase db push --password "$SUPABASE_DB_PASSWORD"
supabase secrets set --project-ref "$SUPABASE_PROJECT_REF" --env-file "$PROD_SECRETS_FILE"

pnpm -s functions:vendor
for fn in public-api owner-api assistant notify-dispatcher; do
  supabase functions deploy "$fn" --project-ref "$SUPABASE_PROJECT_REF" --use-api
done
echo "deployed to https://${SUPABASE_PROJECT_REF}.supabase.co"
