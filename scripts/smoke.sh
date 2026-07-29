#!/usr/bin/env bash
# Tweetsmith — end-to-end smoke test.
#
# Default: hits a locally-running `wrangler dev` (http://127.0.0.1:8787).
# Override BASE_URL to smoke a deployed worker (https://tweetsmith.…workers.dev
# or https://tweetsmith.agent.meshkore.com once the custom domain is wired).
#
# What it asserts, in order:
#   1. GET /health                       → 200 + ok=true + correct network tag
#   2. GET /.well-known/agent.json       → name="Tweetsmith", 1 skill, 4 pricing rows, url set
#   3. POST /v1/generate-tweet (no auth) → 200 + tier_paid="free" (fresh caller)
#      Burn the free quota down to 0, then assert a 4th call returns 402 with
#      an x402 envelope (accepts[], nonce, solanaPayUrl, X-Payment-Address).
#   4. POST /v1/topup                    → 200 + api_key + solanaPayUrl + memo
#   5. SKIP_PAY=1 (default): seed the api_key's balance via `wrangler kv key put`
#      (prod-bound KV if BASE_URL is remote, --local if BASE_URL is local) and
#      verify /v1/generate-tweet with X-Api-Key returns 200 + payment_mode=balance
#      with the cost debited. Skipped when SKIP_PAY=0 (caller arranges a real tx).
#
# Exits non-zero on the first mismatch. Pure bash + curl + jq + (optional) wrangler.

set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
SKIP_PAY="${SKIP_PAY:-1}"
FREE_CAP="${FREE_CAP:-3}"
CALLER_ID="${CALLER_ID:-smoke-$(date +%s)-$$}"

# When seeding KV against `wrangler dev`, --local mode writes to the same
# persistent .wrangler/state dir wrangler dev reads from. For a remote
# deploy, we hit the prod-bound namespace instead.
KV_FLAG="--local"
if [[ "$BASE_URL" != http://127.0.0.1* && "$BASE_URL" != http://localhost* ]]; then
  KV_FLAG="--remote"
fi

green() { printf "\033[32m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*"; }
step()  { printf "\n\033[1;36m→ %s\033[0m\n" "$*"; }
die()   { red "FAIL: $*"; exit 1; }

require() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }
require curl
require jq

cd "$(dirname "$0")/.."   # repository root

green "tweetsmith smoke · BASE_URL=$BASE_URL · SKIP_PAY=$SKIP_PAY · CALLER=$CALLER_ID"

# ─── 1. /health ─────────────────────────────────────────────────────
step "1. GET /health"
HEALTH=$(curl -sS --max-time 10 "$BASE_URL/health")
echo "$HEALTH" | jq -e '.ok == true' >/dev/null || die "/health ok!=true: $HEALTH"
NETWORK=$(echo "$HEALTH" | jq -r '.network')
[[ "$NETWORK" == solana-devnet || "$NETWORK" == solana ]] || die "/health network unexpected: $NETWORK"
green "  ok · network=$NETWORK · version=$(echo "$HEALTH" | jq -r '.version')"

# ─── 2. /.well-known/agent.json ─────────────────────────────────────
step "2. GET /.well-known/agent.json"
CARD=$(curl -sS --max-time 10 "$BASE_URL/.well-known/agent.json")
echo "$CARD" | jq -e '.name == "Tweetsmith"' >/dev/null || die "card name != Tweetsmith"
SKILLS_LEN=$(echo "$CARD" | jq '[.skills[]?] | length')
[[ "$SKILLS_LEN" == "1" ]] || die "card skills_len=$SKILLS_LEN (expected 1)"
SKILL_ID=$(echo "$CARD" | jq -r '.skills[0].id')
[[ "$SKILL_ID" == "generate-tweet" ]] || die "card skill_id=$SKILL_ID (expected generate-tweet)"
PRICING_LEN=$(echo "$CARD" | jq '[.pricing[]?] | length')
[[ "$PRICING_LEN" == "4" ]] || die "card pricing_len=$PRICING_LEN (expected 4)"
URL=$(echo "$CARD" | jq -r '.url // empty')
[[ -n "$URL" ]] || die "card .url is empty"
PAY_ADDR=$(echo "$CARD" | jq -r '.payment_address // empty')
[[ -n "$PAY_ADDR" ]] || die "card .payment_address is empty"
green "  ok · name=Tweetsmith · skill=$SKILL_ID · pricing=4 rows · url=$URL"

# ─── 3. Free tier + 402 envelope ────────────────────────────────────
step "3. POST /v1/generate-tweet — burn free quota, expect 402 on overflow"
i=0
while (( i < FREE_CAP )); do
  i=$((i+1))
  RESP=$(curl -sS --max-time 15 -X POST "$BASE_URL/v1/generate-tweet" \
    -H 'content-type: application/json' \
    -H "X-Caller-Id: $CALLER_ID" \
    -d '{"prompt":"smoke test","tier":"mini"}')
  TIER_PAID=$(echo "$RESP" | jq -r '.tier_paid // empty')
  [[ "$TIER_PAID" == "free" ]] || die "free-call #$i: tier_paid=$TIER_PAID (expected free) · resp=$RESP"
done
green "  free quota exhausted ($FREE_CAP/$FREE_CAP)"

OVERFLOW_DUMP=$(mktemp)
HTTP=$(curl -sS --max-time 15 -o "$OVERFLOW_DUMP" -w "%{http_code}" \
  -D "$OVERFLOW_DUMP.h" \
  -X POST "$BASE_URL/v1/generate-tweet" \
  -H 'content-type: application/json' \
  -H "X-Caller-Id: $CALLER_ID" \
  -d '{"prompt":"overflow","tier":"mini"}')
[[ "$HTTP" == "402" ]] || die "overflow HTTP=$HTTP (expected 402); body: $(cat "$OVERFLOW_DUMP")"

OVERFLOW=$(cat "$OVERFLOW_DUMP")
echo "$OVERFLOW" | jq -e '.x402Version == 1' >/dev/null || die "x402Version!=1: $OVERFLOW"
echo "$OVERFLOW" | jq -e '[.accepts[]?] | length == 4' >/dev/null || die "accepts len != 4"
NONCE=$(echo "$OVERFLOW" | jq -r '.nonce // empty')
[[ -n "$NONCE" ]] || die "402 missing nonce"
echo "$OVERFLOW" | jq -e '.solanaPayUrl | startswith("solana:")' >/dev/null || die "solanaPayUrl shape wrong"
grep -i '^x-payment-address:' "$OVERFLOW_DUMP.h" >/dev/null || die "missing X-Payment-Address header"
grep -i '^x-payment-nonce:'   "$OVERFLOW_DUMP.h" >/dev/null || die "missing X-Payment-Nonce header"
rm -f "$OVERFLOW_DUMP" "$OVERFLOW_DUMP.h"
green "  ok · 402 + x402 envelope (accepts=4 · nonce=${NONCE:0:8}…)"

# ─── 4. /v1/topup ───────────────────────────────────────────────────
step "4. POST /v1/topup — mint api_key + solanaPayUrl"
# Fixed devnet payer for smoke (the agent's own pubkey works fine as a
# placeholder — we never actually transfer in SKIP_PAY mode).
PAYER="${SMOKE_PAYER:-J4Y1HqyshcYovUhoVU5bzMggFXxcU5Q6X8wcmNnATUNS}"
TOPUP=$(curl -sS --max-time 15 -X POST "$BASE_URL/v1/topup" \
  -H 'content-type: application/json' \
  -d "{\"payer_address\":\"$PAYER\"}")
API_KEY=$(echo "$TOPUP" | jq -r '.api_key // empty')
[[ -n "$API_KEY" ]] || die "topup api_key missing: $TOPUP"
[[ "$API_KEY" == tk_* ]] || die "topup api_key shape wrong: $API_KEY"
echo "$TOPUP" | jq -e '.deposit.solanaPayUrl | startswith("solana:")' >/dev/null || die "topup solanaPayUrl shape wrong"
echo "$TOPUP" | jq -e '.deposit.memo == "'"$API_KEY"'"' >/dev/null || die "topup memo != api_key"
green "  ok · api_key=$API_KEY · memo=$API_KEY"

# ─── 5. SKIP_PAY=1: seed KV balance + verify debit path ─────────────
if [[ "$SKIP_PAY" == "1" ]]; then
  step "5. SKIP_PAY=1 — seed balance via wrangler kv key put $KV_FLAG"
  if ! command -v wrangler >/dev/null 2>&1; then
    red "  SKIP: wrangler CLI missing — cannot seed balance; the debit path is unverified."
  else
    SEED_LAMPORTS="${SEED_LAMPORTS:-5000000}"   # 5M lamports = 50 credits
    # The /v1/topup call above already wrote the `apikey:<key>` binding;
    # we only need to seed the prepaid lamport balance the debit reads.
    # `apikey:` (not `payer:`) is what src/balance.ts apiKeyExists() checks.
    wrangler kv key put $KV_FLAG --binding=CACHE "balance:$API_KEY" "$SEED_LAMPORTS" >/dev/null \
      || die "wrangler kv put balance:$API_KEY failed"
    wrangler kv key put $KV_FLAG --binding=CACHE "apikey:$API_KEY" "$PAYER" >/dev/null \
      || die "wrangler kv put apikey:$API_KEY failed"

    # Burn fresh free quota with a NEW caller id so the balance path isn't
    # masked by free-tier success.
    BAL_CALLER="bal-$CALLER_ID"
    j=0; while (( j < FREE_CAP )); do
      j=$((j+1))
      curl -sS --max-time 15 -X POST "$BASE_URL/v1/generate-tweet" \
        -H 'content-type: application/json' \
        -H "X-Caller-Id: $BAL_CALLER" \
        -H "X-Api-Key: $API_KEY" \
        -d '{"prompt":"warmup","tier":"mini"}' >/dev/null
    done

    BAL_RESP_FILE=$(mktemp)
    BAL_HTTP=$(curl -sS --max-time 15 -o "$BAL_RESP_FILE" -w "%{http_code}" \
      -X POST "$BASE_URL/v1/generate-tweet" \
      -H 'content-type: application/json' \
      -H "X-Caller-Id: $BAL_CALLER" \
      -H "X-Api-Key: $API_KEY" \
      -d '{"prompt":"balance debit","tier":"mini"}')
    BAL_RESP=$(cat "$BAL_RESP_FILE"); rm -f "$BAL_RESP_FILE"

    [[ "$BAL_HTTP" == "200" ]] || die "balance-debit HTTP=$BAL_HTTP body=$BAL_RESP"
    MODE=$(echo "$BAL_RESP" | jq -r '._meta.payment_mode // empty')
    [[ "$MODE" == "balance" ]] || die "balance-debit payment_mode=$MODE (expected balance) · $BAL_RESP"
    REMAIN=$(echo "$BAL_RESP" | jq -r '._meta.balance_lamports_remaining // empty')
    DEBITED=$(echo "$BAL_RESP" | jq -r '._meta.debited_lamports // empty')
    [[ -n "$REMAIN" && -n "$DEBITED" ]] || die "missing remaining/debited fields: $BAL_RESP"
    green "  ok · payment_mode=balance · debited=${DEBITED}L · remaining=${REMAIN}L"
  fi
else
  step "5. SKIP_PAY=0 — caller arranges a real devnet tx (this script doesn't)"
  green "  skipped (use scripts/pay-and-prove.sh + retry /v1/generate-tweet with X-Payment-Proof)"
fi

step "all checks passed"
green "tweetsmith smoke OK · base=$BASE_URL"
