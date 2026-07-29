#!/usr/bin/env bash
# Tweetsmith — deploy helper.
#
# Stub-and-flag deploy:
#   - CLOUDFLARE_API_TOKEN unset → echo what it would do, exit 0, and run
#     smoke.sh against `wrangler dev` (http://127.0.0.1:8787) instead.
#   - CLOUDFLARE_API_TOKEN set    → `wrangler deploy`, then smoke.sh against
#     the live URL. Non-zero on any failure.
#
# Custom-domain tweetsmith.agent.meshkore.com is wired by uncommenting the
# `[[routes]]` block in wrangler.toml and re-deploying. The DNS record
# (CNAME → tweetsmith.<account>.workers.dev) must already exist in the
# Cloudflare zone for `meshkore.com`; without it the deploy fails fast
# with a CF API error. See README §Custom domain.

set -euo pipefail
cd "$(dirname "$0")/.."

LIVE_URL="${LIVE_URL:-https://tweetsmith.agent.meshkore.com}"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "STUB: CLOUDFLARE_API_TOKEN unset — would 'wrangler deploy' tweetsmith now." >&2
  echo "      Falling back to a wrangler-dev smoke run." >&2
  # Boot wrangler dev in the background, wait for the port to open, smoke,
  # then kill the worker. Trap ensures cleanup on any exit path.
  LOG=$(mktemp); PID=""
  cleanup() { [[ -n "$PID" ]] && kill "$PID" 2>/dev/null || true; rm -f "$LOG"; }
  trap cleanup EXIT
  wrangler dev --port 8787 --local --ip 127.0.0.1 >"$LOG" 2>&1 &
  PID=$!
  for i in $(seq 1 40); do
    sleep 0.5
    if curl -sS --max-time 2 http://127.0.0.1:8787/health >/dev/null 2>&1; then break; fi
    if (( i == 40 )); then
      echo "wrangler dev failed to come up; log:" >&2
      cat "$LOG" >&2
      exit 1
    fi
  done
  BASE_URL=http://127.0.0.1:8787 bash scripts/smoke.sh
  exit 0
fi

echo "→ wrangler deploy"
wrangler deploy

echo "→ smoke.sh against $LIVE_URL"
BASE_URL="$LIVE_URL" bash scripts/smoke.sh
