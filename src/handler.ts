// Tweetsmith — POST /v1/generate-tweet
// AG9a (challenge) + AG9b (verify + idempotency) + AG10 (free tier + LLM).
//
// Request-path order:
//
//   1. Parse body → {prompt, tier, tone?, language?}.
//   2. If `X-Payment-Proof` is set, skip free-tier and go straight to
//      verify (paying callers shouldn't burn free quota by accident).
//   3. Otherwise check the per-caller free counter in env.CACHE (24h
//      TTL). Under cap → generate + bump counter + 200 with
//      `tier_paid: 'free'`. Over cap → fall through to the 402 flow.
//   4. With a proof present: idempotency check → consume nonce →
//      verify on-chain → generate → cache `sig:<sig>` → 200.
//
// On every success path we call `generateTweet` from `./llm`, which
// hard-truncates at the tier char cap. STUB fallback fires when no
// LLM_API_KEY is set so the wire stays demoable.

import type { Env, Tier, Tone } from './types';
import { buildPricingBlock, priceFor } from './card';
import { issueNonce, consumeNonce, verifyProof } from './x402';
import { checkFreeAllowance, recordFreeUse } from './free';
import { generateTweet } from './llm';
import { debit, getBalance, apiKeyExists } from './balance';
import { costLamports } from './topup';

const DEFAULT_TIER: Tier = 'standard';
const PAID_SIG_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

interface ParsedBody {
  tier: Tier;
  prompt: string;
  tone?: Tone;
  language?: string;
}

export async function handleGenerateTweet(req: Request, env: Env): Promise<Response> {
  const paymentProof = req.headers.get('X-Payment-Proof');
  const body = await readBody(req);
  const apiKey = (req.headers.get('X-Api-Key') ?? '').trim();

  // (A) No payment proof → try the free-tier daily allowance first.
  if (!paymentProof) {
    const free = await checkFreeAllowance(req, env);
    if (free.allowed) {
      const gen = await generateTweet(env, body);
      await recordFreeUse(env, free.callerId, free.used);
      const payload = {
        tweet: gen.tweet,
        char_count: gen.char_count,
        tier_paid: 'free' as const,
        tx_proof: null,
        _meta: {
          free_used: free.used + 1,
          free_cap: free.cap,
          stub_upstream: gen.stub,
          tier_requested: body.tier,
        },
      };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'X-Free-Used': String(free.used + 1),
          'X-Free-Cap': String(free.cap),
        },
      });
    }
    // Over free cap → try the prepaid-balance path (AG12) before falling
    // back to the per-call x402 challenge. The api_key header is the
    // only way for a caller to opt into the balance path; without it
    // we go straight to 402 so the caller's untracked dust doesn't get
    // silently consumed.
    if (apiKey && (await apiKeyExists(env, apiKey))) {
      const cost = costLamports(env, body.tier);
      const debited = await debit(env, apiKey, cost);
      if (debited.ok) {
        const gen = await generateTweet(env, body);
        const payload = {
          tweet: gen.tweet,
          char_count: gen.char_count,
          tier_paid: body.tier,
          tx_proof: null,
          _meta: {
            stub_upstream: gen.stub,
            tier_requested: body.tier,
            payment_mode: 'balance' as const,
            balance_lamports_remaining: debited.remaining.toString(),
            debited_lamports: cost.toString(),
          },
        };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'X-Payment-Mode': 'balance',
            'X-Balance-Remaining': debited.remaining.toString(),
            'X-Debited-Lamports': cost.toString(),
          },
        });
      }
      // insufficient balance → fall through to 402 with the remaining
      // balance surfaced in the response so the caller knows whether to
      // top up or pay per-call.
      return challenge402(env, body.tier, 'insufficient-balance', free.used, free.cap, debited.balance);
    }
    // No balance path → fall through to the 402 challenge.
    return challenge402(env, body.tier, undefined, free.used, free.cap);
  }

  // (B) Idempotency — short-circuit before touching the nonce KV or
  // the Solana RPC. A repeat of the same proof returns the cached
  // tweet so the caller's retries are free and deterministic.
  const cached = await env.X402_PAID_SIGS.get(`sig:${paymentProof}`);
  if (cached !== null) {
    return new Response(cached, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'X-Payment-Cached': 'true',
      },
    });
  }

  // (C) Single-use nonce consume.
  const claimedNonce = req.headers.get('X-Payment-Nonce') ?? '';
  if (!claimedNonce) {
    return challenge402(env, body.tier, 'nonce-unknown');
  }
  const consumed = await consumeNonce(env, claimedNonce);
  if (!consumed.ok) {
    return challenge402(env, body.tier, consumed.reason);
  }

  // (D) On-chain verify against Solana devnet.
  const expectedAmount = priceFor(env, body.tier);
  const verified = await verifyProof(env, paymentProof, expectedAmount, claimedNonce);
  if (!verified.ok) {
    return challenge402(env, body.tier, verified.reason);
  }

  // (E) Generate + cache by signature so a replay is free.
  const gen = await generateTweet(env, body);
  const payload = {
    tweet: gen.tweet,
    char_count: gen.char_count,
    tier_paid: body.tier,
    tx_proof: paymentProof,
    _meta: { stub_upstream: gen.stub },
  };
  const tweetJson = JSON.stringify(payload);
  await env.X402_PAID_SIGS.put(`sig:${paymentProof}`, tweetJson, {
    expirationTtl: PAID_SIG_TTL_SECONDS,
  });

  return new Response(tweetJson, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ─── Body parsing ──────────────────────────────────────────────────

async function readBody(req: Request): Promise<ParsedBody> {
  let tier: Tier = DEFAULT_TIER;
  let prompt = '';
  let tone: Tone | undefined;
  let language: string | undefined;
  try {
    const raw = (await req.clone().json()) as {
      tier?: unknown;
      prompt?: unknown;
      tone?: unknown;
      language?: unknown;
    };
    if (typeof raw?.tier === 'string') {
      const t = raw.tier;
      if (t === 'mini' || t === 'standard' || t === 'extended' || t === 'max') {
        tier = t;
      }
    }
    if (typeof raw?.prompt === 'string') prompt = raw.prompt;
    if (typeof raw?.tone === 'string') {
      const t = raw.tone;
      if (t === 'professional' || t === 'casual' || t === 'viral' || t === 'informational') {
        tone = t;
      }
    }
    if (typeof raw?.language === 'string') language = raw.language.slice(0, 16);
  } catch {
    // No body / not JSON — fall back to defaults.
  }
  return { tier, prompt, tone, language };
}

// ─── 402 challenge builder (shared by no-proof + verify-failed) ────

async function challenge402(
  env: Env,
  tier: Tier,
  errorReason?: string,
  freeUsed?: number,
  freeCap?: number,
  balanceLamports?: bigint,
): Promise<Response> {
  const network = env.PAYMENT_NETWORK || env.SOLANA_NETWORK || 'solana-devnet';
  const address = env.PAYMENT_ADDRESS || env.TWEETSMITH_WALLET_PUBKEY;
  const amount = priceFor(env, tier);
  const { nonce, expiresAt } = await issueNonce(env);

  const solanaPayUrl =
    `solana:${address}` +
    `?amount=${(amount / 1_000_000_000).toString()}` +
    `&spl-token=` +
    `&reference=${nonce}` +
    `&label=Tweetsmith` +
    `&message=Tweetsmith%20${tier}%20tweet` +
    `&memo=${nonce}`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'X-Payment-Network': network,
    'X-Payment-Address': address,
    'X-Payment-Amount': String(amount),
    'X-Payment-Nonce': nonce,
  };
  if (errorReason) headers['X-Payment-Verify-Error'] = errorReason;
  if (freeUsed !== undefined && freeCap !== undefined) {
    headers['X-Free-Used'] = String(freeUsed);
    headers['X-Free-Cap'] = String(freeCap);
  }

  const body: Record<string, unknown> = {
    x402Version: 1,
    error: errorReason ? 'payment-verify-failed' : 'payment-required',
    accepts: buildPricingBlock(env).map((row) => ({
      scheme: 'exact',
      network: row.network,
      address,
      amount: row.amount,
      currency: row.currency,
      tier: row.tier,
      unit: row.unit,
      nonce,
      expiresAt,
    })),
    solanaPayUrl,
    nonce,
    expiresAt,
  };
  if (errorReason) body['verify_error'] = errorReason;
  if (freeUsed !== undefined && freeCap !== undefined) {
    body['free_tier'] = { used: freeUsed, cap: freeCap, exhausted: freeUsed >= freeCap };
  }
  if (balanceLamports !== undefined) {
    headers['X-Balance-Lamports'] = balanceLamports.toString();
    body['balance'] = {
      lamports: balanceLamports.toString(),
      cost_lamports: priceFor(env, tier),
      hint: 'POST /v1/topup to refill, or pay this challenge per-call.',
    };
  }

  return new Response(JSON.stringify(body), { status: 402, headers });
}
