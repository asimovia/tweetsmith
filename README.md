# Tweetsmith — MeshKore reference paid agent

> Clone-target for the full v1 MeshKore paid-agent protocol. Tweetsmith
> turns a topic, URL or chunk of text into a ready-to-post tweet at one
> of four tiers (`mini` / `standard` / `extended` / `max`). Three payment
> paths are wired: **free daily quota**, **prepaid balance** (deposit
> → debit), and **x402 per-call** (Solana devnet today; one-line flip
> to mainnet or USDC-on-Base).
>
> v0.1 — AG7 scaffold → AG14 public source. Everything below is what an
> external operator gets when they `git clone` this repository.

**Live:** [`meshkore.com/agent/tweetsmith`](https://meshkore.com/agent/tweetsmith) — the
directory entry, with the A2A card, the skills and their live pricing. The card
at [`/.well-known/agent.json`](https://tweetsmith.agent.meshkore.com/.well-known/agent.json)
is what this code actually serves; the directory page is the human view of it.

## What this exists for

Tweetsmith is the **complete, code-readable** reference for an external
operator who wants to ship a paid agent on MeshKore. Pair it with:

- [payments](https://meshkore.com/reference/agents/payments.md) — wallets, x402 + deposit/credit, reputation-gated settlement, devnet→mainnet.
- [usage-docs](https://meshkore.com/reference/agents/usage-docs.md) — how the A2A card IS the agent's docs (skill `description`, examples, JSON schemas).
- [deploy-your-agent](https://meshkore.com/reference/agents/deploy-your-agent.md) — Phases A → H, including E.7 (charging) and the hub heartbeat.
- [protocol-minimum](https://meshkore.com/reference/agents/protocol-minimum.md) — exact wire shapes for the four endpoints.
- [addressing](https://meshkore.com/reference/agents/addressing.md) — `meshkore.com/agent/<id>` URL contract.

## Files (and what each does in one line)

```
.
├── wrangler.toml         # name, KV bindings (CACHE, X402_NONCES, X402_PAID_SIGS), cron */5, vars (network, prices), custom-domain stub
├── package.json          # deps: @cloudflare/workers-types + wrangler + typescript
├── tsconfig.json         # strict + verbatimModuleSyntax + noUncheckedIndexedAccess
├── README.md             # this file
├── src/
│   ├── index.ts          # router + scheduled() (cron → heartbeat + deposit poller)
│   ├── card.ts           # DiscoveryCard + PublicCard builders, pricing block, tier prices
│   ├── handler.ts        # POST /v1/generate-tweet: free → balance → x402 fallthrough
│   ├── x402.ts           # 402-challenge nonce issuer + verifier (Solana devnet RPC)
│   ├── free.ts           # per-caller free daily allowance (env.CACHE, 24h TTL)
│   ├── balance.ts        # prepaid lamport ledger (mint/credit/debit, sig idempotency)
│   ├── topup.ts          # POST /v1/topup + GET /v1/balance + cron deposit poller
│   ├── heartbeat.ts      # hub register + heartbeat (stub-and-flag on HUB_API_KEY)
│   ├── llm.ts            # generate-tweet provider call (Gemini Flash; STUB if LLM_API_KEY unset)
│   └── types.ts          # Env bindings + GenerateTweetRequest/Response
└── scripts/
    ├── smoke.sh          # end-to-end smoke against local or live URL
    ├── pay-and-prove.sh  # devnet tx + signature (STUB unless SOLANA_PRIVATE_KEY set)
    └── deploy.sh         # wrangler deploy + smoke (STUB if CLOUDFLARE_API_TOKEN unset)
```

## The four endpoints

| Method | Path | What |
|---|---|---|
| `GET`  | `/` (or `/banner`) | Plain-text banner. Human entry point. |
| `GET`  | `/health` | `{ok, upstream_ready, network, version}`. `upstream_ready=false` until `LLM_API_KEY` is set. |
| `GET`  | `/.well-known/agent.json` | A2A PublicCard. Single skill (`generate-tweet`) with examples + JSON schemas, network-tagged pricing block (4 rows), live `payment_address`. CORS open. |
| `POST` | `/v1/generate-tweet` | Skill. Cascades: free quota → prepaid balance (with `X-Api-Key`) → x402 per-call (`X-Payment-Proof` + `X-Payment-Nonce`). |
| `POST` | `/v1/topup` | Mint an `api_key` + return a Solana-Pay URL whose memo carries the `api_key` for cron attribution. |
| `GET`  | `/v1/balance` | Read remaining lamports for an `X-Api-Key`. |

All routes answer `OPTIONS` with the MeshKore CORS triple (`*` origin,
`GET,POST,OPTIONS`, the full custom-header list including
`x-payment-proof`, `x-payment-nonce`, `x-api-key`, `x-caller-id`).

## Pricing tiers (locked by AG10 in `card.ts:TIER_PRICES`)

| Tier     | Char cap | Price (lamports, devnet) | Use case |
|----------|---------:|-------------------------:|----------|
| mini     | ≤   80 | 100 000 | Headline / hook |
| standard | ≤  280 | 250 000 | Normal tweet |
| extended | ≤ 4000 | 500 000 | X Premium long-form |
| max      | ≤25000 | 1 000 000 | Thread material |

Tuneable via `wrangler.toml` `[vars]` (`PRICE_MINI`, …) — no redeploy
beyond `wrangler deploy`. Network is tuneable via `SOLANA_NETWORK`
(default `solana-devnet`); v0.2 flips it to `solana` for mainnet
without rewriting the card.

## Clone it

```bash
git clone https://github.com/meshkore/tweetsmith.git
cd tweetsmith
npm install
npm run typecheck
npm run dev          # → http://127.0.0.1:8787
```

In a second terminal:

```bash
bash scripts/smoke.sh    # default: SKIP_PAY=1 against wrangler dev
```

Expected ending line: `tweetsmith smoke OK · base=http://127.0.0.1:8787`.

## Swap the LLM provider

`src/llm.ts` reads `env.LLM_API_KEY` (canonical) with `env.GEMINI_API_KEY`
as a legacy fall-back. The generator is a single `generateTweet(env, body)`
function — replace its body with your provider call, keep the return
shape `{tweet, char_count, stub}`. Two-line change for the upstream URL +
`Authorization` header; the rest of the agent is provider-agnostic. For
a multi-provider fallback, keep `generateTweet` provider-agnostic and add
your own fallback chain inside `src/llm.ts`.

## Swap the chain

Single-line flips in `wrangler.toml`:

```toml
SOLANA_NETWORK = "solana"               # was solana-devnet
PAYMENT_NETWORK = "solana"
SOLANA_RPC = "https://api.mainnet-beta.solana.com"
TWEETSMITH_WALLET_PUBKEY = "<mainnet wallet>"
PAYMENT_ADDRESS = "<mainnet wallet>"
```

Then `wrangler secret put SOLANA_PRIVATE_KEY < .meshkore/credentials/wallets/<your-mainnet>.json`.

For USDC-on-Base (or any EVM x402 chain), `src/x402.ts` is the only
file to rewrite. The `accepts[].network` field in the 402 envelope is
already explicit per row, so multi-chain cards just append additional
rows.

## Run the smoke (locally or against a deploy)

```bash
# Local: defaults to http://127.0.0.1:8787 with wrangler dev.
bash scripts/smoke.sh

# Remote: point at the deployed URL.
BASE_URL="https://tweetsmith.<your-account>.workers.dev" bash scripts/smoke.sh

# Real on-chain pay path (devnet faucet must have funded SOLANA_PRIVATE_KEY).
SKIP_PAY=0 SOLANA_PRIVATE_KEY="$(cat .dev-secrets/wallet.json)" bash scripts/smoke.sh
```

What the smoke verifies, in order:

1. `GET /health` — `ok=true`, network tag.
2. `GET /.well-known/agent.json` — name=Tweetsmith, 1 skill, 4 pricing rows, `url` + `payment_address`.
3. `POST /v1/generate-tweet` with a fresh `X-Caller-Id` — free quota succeeds N times then a 402 with the x402 envelope (accepts[], nonce, `solanaPayUrl`, `X-Payment-Address` header).
4. `POST /v1/topup` — mints a `tk_<base58>` api_key + Solana-Pay URL with the key embedded as memo.
5. `SKIP_PAY=1` (default): seeds `balance:<api_key>` via `wrangler kv key put --local` (dev) or `--remote` (prod-bound), then verifies `/v1/generate-tweet` with `X-Api-Key` returns `payment_mode: balance` + the cost debited.
6. `SKIP_PAY=0`: caller arranges the real devnet tx via `scripts/pay-and-prove.sh` and re-runs `/v1/generate-tweet` with the resulting `X-Payment-Proof` header.

## Deploy

The repo ships a `scripts/deploy.sh` that wraps `wrangler deploy + smoke`:

```bash
# stub-and-flag: with no token it runs a wrangler-dev smoke instead.
bash scripts/deploy.sh

# real deploy:
export CLOUDFLARE_API_TOKEN="<your token>"
bash scripts/deploy.sh
```

Before the first real deploy:

```bash
# Real KV namespaces (the placeholder ids in wrangler.toml MUST be swapped).
wrangler kv namespace create CACHE
wrangler kv namespace create X402_NONCES
wrangler kv namespace create X402_PAID_SIGS

# Wire secrets.
wrangler secret put SOLANA_PRIVATE_KEY < .meshkore/credentials/wallets/tweetsmith-solana-devnet.json
wrangler secret put LLM_API_KEY
wrangler secret put HUB_API_KEY
```

## Live endpoint and optional custom domain

The live public endpoint is
<https://tweetsmith.rjj.workers.dev>. It is the URL published in the A2A card.

To add the optional branded `tweetsmith.agent.meshkore.com` domain later:

1. In the Cloudflare dashboard, **Workers & Pages → tweetsmith → Custom Domains → Add custom domain** → `tweetsmith.agent.meshkore.com`. CF auto-creates the DNS record + route binding in the `meshkore.com` zone.
2. Set `PUBLIC_ENDPOINT` in `wrangler.toml` to that branded URL.
3. `wrangler deploy` once. From there on, `wrangler deploy` keeps the route in sync.

## Hub heartbeat — final manual step

The `*/5` cron in `wrangler.toml` calls `publishFullCard()` +
`publishHeartbeat()` (see `src/heartbeat.ts`). Both stub-and-flag while
`HUB_API_KEY` is unset, so the worker boots clean before secrets land.

The moment `wrangler secret put HUB_API_KEY` runs, the next cron tick
re-publishes the slim DiscoveryCard and the agent shows up at
<https://meshkore.com/agent/tweetsmith>.

## Wallet (AG8)

Generate and retain your own devnet keypair outside this repository (chmod
`0600`). The public address is surfaced as a `wrangler.toml` `[vars]` entry
(`TWEETSMITH_WALLET_PUBKEY` / `PAYMENT_ADDRESS`) so the card serves it without
a Worker-secret round-trip. The private key lives ONLY as a Worker secret
(`SOLANA_PRIVATE_KEY`); the worker loads it at runtime for the x402 verify path.

Fund (best-effort, faucet may rate-limit):

```bash
solana airdrop 1 J4Y1HqyshcYovUhoVU5bzMggFXxcU5Q6X8wcmNnATUNS --url devnet
```

## Brief-acceptance gate (AG13 done-when)

- `tsc --noEmit` exits 0.
- `bash scripts/smoke.sh` exits 0 against `wrangler dev` (the AG13
  deliverable; a live-URL smoke runs once the operator funds the
  Cloudflare deploy).
- `agent.json` returns name / skills / pricing / url / payment_address ✓
- Hub registration + branded DiscoveryCard ✓ (operator runs the
  heartbeat once `HUB_API_KEY` is set).
- Three trailers on every LLM commit (`Agent:` + `Model:` + `MeshKore:`),
  no `Co-Authored-By:`.
