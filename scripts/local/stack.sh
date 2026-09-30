#!/usr/bin/env bash
# Local Supabase-compatible stack built from real components, no Docker required:
#   - PostgreSQL 16 cluster (.local/pg, port 54322) + Supabase platform bootstrap
#   - Supabase Auth (GoTrue) built from source at a pinned commit (port 54324)
#   - Edge Functions run on real Deno (see `pnpm functions:serve`)
#
# Usage: scripts/local/stack.sh <build-auth|init|start|stop|status|reset|createdb NAME|psql>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCAL="$ROOT/.local"
PGDATA="$LOCAL/pg"
PGPORT="${DF_PG_PORT:-54322}"
AUTH_PORT="${DF_AUTH_PORT:-54324}"
AUTH_COMMIT="ce9a8eee0cc042be8c7a42981a7ddae631e41d91" # supabase/auth master, 2026-09-22
AUTH_SRC="$LOCAL/src/auth"
AUTH_BIN="$LOCAL/bin/gotrue"
JWT_SECRET="${DF_JWT_SECRET:-super-secret-jwt-token-with-at-least-32-characters-long}"

PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
[ -n "$PGBIN" ] || PGBIN="$(dirname "$(command -v pg_ctl)")"

# initdb/postgres refuse to run as root; use the postgres system user when needed.
as_pg() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

psql_local() {
  PGOPTIONS="-c client_min_messages=warning" \
  psql -h 127.0.0.1 -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"
}

build_auth() {
  if [ -x "$AUTH_BIN" ]; then echo "gotrue already built: $AUTH_BIN"; return; fi
  mkdir -p "$LOCAL/src" "$LOCAL/bin"
  if [ ! -d "$AUTH_SRC/.git" ]; then
    git clone --filter=blob:none https://github.com/supabase/auth "$AUTH_SRC"
  fi
  git -C "$AUTH_SRC" checkout -q "$AUTH_COMMIT"
  (cd "$AUTH_SRC" && GOTOOLCHAIN=auto go build -o "$AUTH_BIN" .)
  echo "built $AUTH_BIN"
}

auth_env() {
  local db="$1"
  export GOTRUE_DB_DRIVER=postgres
  export DATABASE_URL="postgres://supabase_auth_admin:postgres@127.0.0.1:$PGPORT/$db?sslmode=disable"
  export GOTRUE_DB_MIGRATIONS_PATH="$AUTH_SRC/migrations"
  export API_EXTERNAL_URL="http://127.0.0.1:54321/auth/v1"
  export GOTRUE_SITE_URL="${DF_SITE_URL:-http://127.0.0.1:5173}"
  export GOTRUE_URI_ALLOW_LIST="http://127.0.0.1:5173/**,http://localhost:5173/**,http://127.0.0.1:4173/**"
  export GOTRUE_API_HOST=127.0.0.1
  export PORT="$AUTH_PORT"
  export GOTRUE_JWT_SECRET="$JWT_SECRET"
  export GOTRUE_JWT_EXP=3600
  export GOTRUE_JWT_AUD=authenticated
  export GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
  export GOTRUE_JWT_ADMIN_ROLES=service_role
  export GOTRUE_DISABLE_SIGNUP=true
  export GOTRUE_EXTERNAL_EMAIL_ENABLED=true
  export GOTRUE_MAILER_AUTOCONFIRM=true
  export GOTRUE_LOG_LEVEL=warn
}

migrate_auth() {
  local db="$1"
  [ -x "$AUTH_BIN" ] || { echo "gotrue not built: run '$0 build-auth'" >&2; exit 1; }
  ( auth_env "$db"; "$AUTH_BIN" migrate >/dev/null )
}

create_db() {
  local db="$1"
  psql_local -d postgres -c "drop database if exists \"$db\" with (force)"
  psql_local -d postgres -c "create database \"$db\""
  psql_local -d "$db" -f "$ROOT/supabase/local/bootstrap.sql"
  migrate_auth "$db"
  echo "database $db ready (bootstrap + auth schema)"
}

init() {
  mkdir -p "$LOCAL"
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    mkdir -p "$PGDATA"
    [ "$(id -u)" = "0" ] && chown postgres:postgres "$PGDATA"
    as_pg "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
    cat >> "$PGDATA/postgresql.conf" <<CONF
port = $PGPORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$PGDATA'
max_connections = 200
timezone = 'UTC'
CONF
  fi
  start_pg
  create_db postgres_df
}

start_pg() {
  if as_pg "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then return; fi
  as_pg "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" -w start >/dev/null
  echo "postgres :$PGPORT"
}

start_auth() {
  [ -x "$AUTH_BIN" ] || { echo "gotrue not built: run '$0 build-auth'" >&2; exit 1; }
  if curl -fsS "http://127.0.0.1:$AUTH_PORT/health" >/dev/null 2>&1; then return; fi
  ( auth_env postgres_df; nohup "$AUTH_BIN" serve >"$LOCAL/gotrue.log" 2>&1 & echo $! >"$LOCAL/gotrue.pid" )
  for _ in $(seq 1 50); do
    curl -fsS "http://127.0.0.1:$AUTH_PORT/health" >/dev/null 2>&1 && { echo "auth :$AUTH_PORT"; return; }
    sleep 0.2
  done
  echo "gotrue failed to start, see $LOCAL/gotrue.log" >&2; exit 1
}

stop() {
  if [ -f "$LOCAL/gotrue.pid" ]; then kill "$(cat "$LOCAL/gotrue.pid")" 2>/dev/null || true; rm -f "$LOCAL/gotrue.pid"; fi
  as_pg "$PGBIN/pg_ctl" -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  echo stopped
}

case "${1:-}" in
  build-auth) build_auth ;;
  init) build_auth; init ;;
  start) start_pg; start_auth ;;
  stop) stop ;;
  status)
    as_pg "$PGBIN/pg_ctl" -D "$PGDATA" status | head -1
    curl -fsS "http://127.0.0.1:$AUTH_PORT/health" && echo ;;
  reset)
    # GoTrue holds connections to postgres_df: stop it, recreate, restart.
    if [ -f "$LOCAL/gotrue.pid" ]; then kill "$(cat "$LOCAL/gotrue.pid")" 2>/dev/null || true; rm -f "$LOCAL/gotrue.pid"; sleep 0.5; fi
    start_pg; create_db postgres_df; start_auth ;;
  createdb) start_pg; create_db "${2:?db name}" ;;
  psql) shift; psql_local -d postgres_df "$@" ;;
  *) echo "usage: $0 <build-auth|init|start|stop|status|reset|createdb NAME|psql>" >&2; exit 2 ;;
esac
