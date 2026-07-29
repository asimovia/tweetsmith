#!/usr/bin/env bash
# Tweetsmith — pay-and-prove helper.
#
# Usage: scripts/pay-and-prove.sh <tier> [base-url]
#   tier    = mini | standard | extended | max
#   baseurl = http://127.0.0.1:8787 (default) or the deployed URL
#
# Workflow:
#   1. Call POST /v1/generate-tweet with no proof → harvest 402 envelope
#      (nonce, address, lamport amount, expiresAt).
#   2. STUB by default: print the envelope + a fake X-Payment-Proof so the
#      caller can wire up Solana-pay manually, OR exit cleanly so smoke.sh
#      can assert the "would pay" branch.
#   3. With SOLANA_PRIVATE_KEY set AND `solana-cli` on PATH, sign + send a
#      real devnet transfer with the nonce as memo, wait for confirmation,
#      then echo the signature as the X-Payment-Proof value.
#
# Output (stdout, last line): the X-Payment-Proof header value (signature)
# or the literal token `STUB:<nonce>` if no real payment was made.

set -euo pipefail

TIER="${1:-standard}"
BASE_URL="${2:-${BASE_URL:-http://127.0.0.1:8787}}"

case "$TIER" in
  mini|standard|extended|max) ;;
  *) echo "usage: $0 <mini|standard|extended|max> [base-url]" >&2; exit 2 ;;
esac

require() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
require curl
require jq

# ─── 1. harvest 402 envelope ────────────────────────────────────────
ENV_FILE=$(mktemp)
HTTP=$(curl -sS --max-time 15 -o "$ENV_FILE" -w "%{http_code}" \
  -X POST "$BASE_URL/v1/generate-tweet" \
  -H 'content-type: application/json' \
  -H "X-Caller-Id: pay-prove-$(date +%s)-$$" \
  -d "{\"prompt\":\"warmup\",\"tier\":\"$TIER\"}")

# Burn the free quota first if the worker returned 200 (free tier still open).
if [[ "$HTTP" == "200" ]]; then
  CALLER="pay-prove-$(date +%s)-$$"
  for i in 1 2 3 4 5; do
    HTTP=$(curl -sS --max-time 15 -o "$ENV_FILE" -w "%{http_code}" \
      -X POST "$BASE_URL/v1/generate-tweet" \
      -H 'content-type: application/json' \
      -H "X-Caller-Id: $CALLER" \
      -d "{\"prompt\":\"burn-$i\",\"tier\":\"$TIER\"}")
    [[ "$HTTP" == "402" ]] && break
  done
fi

[[ "$HTTP" == "402" ]] || { echo "could not get a 402 envelope (last HTTP=$HTTP)" >&2; cat "$ENV_FILE" >&2; exit 1; }

ENV=$(cat "$ENV_FILE"); rm -f "$ENV_FILE"
NONCE=$(echo "$ENV" | jq -r '.nonce')
ADDR=$(echo "$ENV"  | jq -r '.accepts[] | select(.tier=="'"$TIER"'") | .address' | head -1)
AMOUNT=$(echo "$ENV" | jq -r '.accepts[] | select(.tier=="'"$TIER"'") | .amount' | head -1)
NETWORK=$(echo "$ENV" | jq -r '.accepts[] | select(.tier=="'"$TIER"'") | .network' | head -1)

echo "402-envelope harvested:" >&2
echo "  network:  $NETWORK"     >&2
echo "  address:  $ADDR"        >&2
echo "  amount:   $AMOUNT lamports" >&2
echo "  nonce:    $NONCE"       >&2

# ─── 2. STUB unless SOLANA_PRIVATE_KEY + solana CLI both present ────
if [[ -z "${SOLANA_PRIVATE_KEY:-}" ]] || ! command -v solana >/dev/null 2>&1; then
  echo "STUB: would transfer $AMOUNT lamports to $ADDR with memo '$NONCE' on $NETWORK." >&2
  echo "      (set SOLANA_PRIVATE_KEY + install solana-cli to send a real tx)" >&2
  echo "STUB:$NONCE"
  exit 0
fi

# ─── 3. real path — sign + send + wait for confirmation ─────────────
# Persist key to a temp file the CLI accepts (JSON byte-array).
KEYFILE=$(mktemp)
trap 'rm -f "$KEYFILE"' EXIT
echo "$SOLANA_PRIVATE_KEY" > "$KEYFILE"
chmod 0600 "$KEYFILE"

RPC="${SOLANA_RPC:-https://api.devnet.solana.com}"
LAMPORTS_PER_SOL=1000000000
# bash arithmetic is fine for amounts < 2^53; biggest tier is 1M lamports.
AMT_SOL=$(awk -v a="$AMOUNT" -v d="$LAMPORTS_PER_SOL" 'BEGIN{ printf "%.9f", a/d }')

SIG=$(solana transfer --keypair "$KEYFILE" --url "$RPC" \
  --with-memo "$NONCE" \
  --allow-unfunded-recipient \
  "$ADDR" "$AMT_SOL" \
  --output json-compact 2>/dev/null | jq -r '.signature // empty')

[[ -n "$SIG" ]] || { echo "solana transfer returned no signature" >&2; exit 1; }
echo "tx sent · signature=$SIG" >&2
echo "$SIG"
