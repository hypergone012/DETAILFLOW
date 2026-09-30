#!/usr/bin/env bash
# Serves apps/web/dist with the Cloudflare Pages runtime (workerd via wrangler):
# SPA fallback, _headers and caching behave as on Pages. Usage: pages-dev.sh start|stop
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PID="$ROOT/.local/pages.pid"
case "${1:-start}" in
  start)
    WRANGLER_SEND_METRICS=false nohup "$ROOT/node_modules/.bin/wrangler" pages dev "$ROOT/apps/web/dist" --port 8788 --ip 127.0.0.1 >"$ROOT/.local/pages.log" 2>&1 &
    echo $! >"$PID"
    for _ in $(seq 1 60); do curl -fs http://127.0.0.1:8788/ >/dev/null 2>&1 && { echo "pages http://127.0.0.1:8788"; exit 0; }; sleep 1; done
    echo "pages dev failed, see .local/pages.log" >&2; exit 1 ;;
  stop)
    [ -f "$PID" ] && kill "$(cat "$PID")" 2>/dev/null || true
    rm -f "$PID"
    fuser -k 8788/tcp >/dev/null 2>&1 || true ;;
esac
