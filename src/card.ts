// Tweetsmith — DiscoveryCard + PublicCard builders.
//
// Two-tier discovery model (A2A standard, mirrored from
// meshkore-image-gen's split which is the cleanest reference in the
// codebase):
//
//   Discovery tier  → DiscoveryCard
//   ─────────────────────────────────
//   Pushed to the hub via PATCH /agents/me. Slim. Just what the
//   Oracle needs to LOCATE the agent (name, brand, category, tags,
//   pricing summary, online flag). The hub stores this.
//
//   Interaction tier → PublicCard
//   ─────────────────────────────────────────────────────────────────
//   Served from /.well-known/agent.json. What a peer agent fetches
//   DIRECTLY once the Oracle has pointed them at this worker. Full
//   skill list with examples + JSON schemas, version, default I/O
//   modes, EXPLICIT network-tagged pricing (one row per tier), the
//   on-chain payment address. The hub does NOT store this — it's
//   read live by the caller.
//
// Pricing block is the EXPLICIT network-tagged form documented in
// deploy-your-agent Phase E.7: an array of rows
// `{unit, amount, currency, network, tier}`. v0.2 mainnet swap is a
// single env-var flip (`SOLANA_NETWORK`) — no card rewrite.

import type { Env, Tier } from './types';
import { LLM_PROVIDER_TAG, TIER_CHAR_CAP } from './llm';

// Pricing map — locked (operator preference, AG10): mini=100k,
// standard=250k, extended=500k, max=1M lamports. wrangler.toml [vars]
// mirrors these values so the AG9a issuer's `accepts[].amount` and the
// `Env`-derived `priceFor()` agree. If wrangler.toml is stale the map
// here is the source of truth (priceFor falls back to it).
export const TIER_PRICES: Record<Tier, bigint> = {
  mini: 100_000n,
  standard: 250_000n,
  extended: 500_000n,
  max: 1_000_000n,
};

// ─── Tier 1: Discovery (pushed to the hub) ───────────────────────────

export interface DiscoveryCard {
  endpoint: string;
  name: string;
  owner_class: 'core' | 'partner' | 'third-party';
  brand: string;
  category: string;
  description: string;
  tags: string[];
  accepts: string[];
  produces: string[];
  protocols: string[];
  pricing: { unit: string; amount: number; currency: string };
  availability: { now: boolean };
}

export function buildDiscoveryCard(env: Env): DiscoveryCard {
  const upstreamReady = !!(env.LLM_API_KEY ?? env.GEMINI_API_KEY);
  return {
    endpoint: env.PUBLIC_ENDPOINT,
    name: 'Tweetsmith',
    owner_class: 'core',
    brand: 'core',
    category: 'text.tweet-generation',
    description:
      'Tweetsmith — turns a topic, URL or chunk of text into a ready-to-post ' +
      'tweet. Four tiers (mini / standard / extended / max). Paid per call ' +
      'in Solana devnet lamports. Reference impl of the full MeshKore v1 ' +
      'agent protocol (A2A card, hub heartbeat, x402, on-chain settlement).',
    tags: [
      'tweet',
      'text-generation',
      'llm',
      LLM_PROVIDER_TAG,
      'free-tier',
      'reference',
      'paid-agent',
      'solana-devnet',
      'x402',
      'tiered-pricing',
    ],
    accepts:   ['application/json'],
    produces:  ['application/json'],
    protocols: ['http', 'a2a'],
    pricing:   { unit: 'request', amount: priceFor(env, 'standard'), currency: 'lamports' },
    availability: { now: upstreamReady },
  };
}

// ─── Tier 2: Public / interaction (served by /.well-known/agent.json) ─

export interface PricingRow {
  unit: 'request';
  amount: number;
  currency: 'lamports';
  network: string;   // e.g. 'solana-devnet' — explicit per Phase E.7 contract
  tier: Tier;
}

export interface PublicCardSkill {
  id: string;
  name: string;
  description: string;
  examples: Array<{ input: unknown; output: unknown }>;
  input_schema: unknown;
  output_schema: unknown;
}

export interface PublicCard {
  name: string;
  description: string;
  url: string;
  version: string;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: PublicCardSkill[];
  pricing: PricingRow[];
  payment_address: string;
  payment: PaymentDeclaration;
  identity: { scheme: 'MeshKore-Sig'; whoami: string };
  protocols: string[];
  availability: { now: boolean; window_hours?: number; sla?: string };
  contact: Record<string, string>;
}

// Agent-controlled payment policy (agent-payments.md). Declared in the
// card so a caller — human or agent — knows up front which modes settle.
export interface PaymentDeclaration {
  modes: Array<'x402' | 'deposit'>;
  network: string;
  wallet: string;
  deposit?: { min_lamports: number; credit_unit: 'lamports' };
  postpay_min_reputation: number | null;
  free_tier: { calls_per_day: number; by: string };
}

export function buildPaymentDeclaration(env: Env): PaymentDeclaration {
  const freeCap = Number.parseInt(env.FREE_DAILY_CAP ?? '', 10);
  return {
    modes: ['x402', 'deposit'],
    network: env.SOLANA_NETWORK || 'solana-devnet',
    wallet: env.PAYMENT_ADDRESS || env.TWEETSMITH_WALLET_PUBKEY,
    deposit: { min_lamports: Number(TIER_PRICES.standard) * 4, credit_unit: 'lamports' },
    postpay_min_reputation: null, // pre-pay only for now (raise to enable trusted post-pay)
    free_tier: { calls_per_day: Number.isFinite(freeCap) && freeCap > 0 ? freeCap : 3, by: 'caller-id+ip' },
  };
}

export function priceFor(env: Env, tier: Tier): number {
  // env wins (lets a deploy flip prices without a code push); the
  // TIER_PRICES map is the source-of-truth fallback when env is blank.
  const fallback = Number(TIER_PRICES[tier]);
  switch (tier) {
    case 'mini':     return parseInt(env.PRICE_MINI, 10)     || fallback;
    case 'standard': return parseInt(env.PRICE_STANDARD, 10) || fallback;
    case 'extended': return parseInt(env.PRICE_EXTENDED, 10) || fallback;
    case 'max':      return parseInt(env.PRICE_MAX, 10)      || fallback;
  }
}

export function buildPricingBlock(env: Env): PricingRow[] {
  const network = env.SOLANA_NETWORK || 'solana-devnet';
  return (['mini', 'standard', 'extended', 'max'] as const).map((tier) => ({
    unit: 'request' as const,
    amount: priceFor(env, tier),
    currency: 'lamports' as const,
    network,
    tier,
  }));
}

export function buildPublicCard(env: Env, requestOrigin?: string): PublicCard {
  const upstreamReady = !!(env.LLM_API_KEY ?? env.GEMINI_API_KEY);
  const freeCap = Number.parseInt(env.FREE_DAILY_CAP ?? '', 10);
  const freeCapDisplay = Number.isFinite(freeCap) && freeCap > 0 ? freeCap : 3;
  // PUBLIC_ENDPOINT is the canonical production URL; fall back to the
  // live request origin when running under `wrangler dev` (no custom
  // domain bound yet). Lets the local curl-checklist pass.
  const url = env.PUBLIC_ENDPOINT || requestOrigin || 'http://localhost:8787';

  const skill: PublicCardSkill = {
    id: 'generate-tweet',
    name: 'Generate a tweet',
    description:
      'Turn a topic, URL or chunk of text into a ready-to-post tweet. ' +
      `Pick a tier — mini (≤${TIER_CHAR_CAP.mini} chars, headline / hook), ` +
      `standard (≤${TIER_CHAR_CAP.standard} chars, normal tweet), ` +
      `extended (≤${TIER_CHAR_CAP.extended} chars, long-form), ` +
      `max (≤${TIER_CHAR_CAP.max} chars, thread material). ` +
      'The agent hard-truncates at the tier cap and charges that tier\'s ' +
      'price in Solana devnet lamports. Optional `tone` (professional / ' +
      'casual / viral / informational) and `language` (ISO-639-1, default ' +
      `"en"). FREE TIER: every caller gets ${freeCapDisplay} free calls per ` +
      'rolling 24h (counted by `X-Caller-Id` header or hashed IP) before ' +
      'the 402 challenge kicks in. Stateless beyond that counter — the ' +
      'agent stores nothing about prompts or outputs between calls.',
    examples: [
      {
        input:  { prompt: 'Summarise meshkore.com for a developer audience', tier: 'standard', tone: 'professional' },
        output: { tweet: 'MeshKore is a local-first standard for multi-agent cockpits — a Python daemon per project + a shared SolidJS cockpit that attaches over loopback. Open spec, no SaaS lock-in.', char_count: 197, tier_paid: 'standard', tx_proof: '<solana-tx-sig>' },
      },
      {
        input:  { prompt: 'Launch announcement: new Solana devnet payment loop', tier: 'mini', tone: 'viral' },
        output: { tweet: 'Tweetsmith is live — pay devnet SOL, get a tweet. 🧵', char_count: 53, tier_paid: 'mini', tx_proof: '<solana-tx-sig>' },
      },
    ],
    input_schema: {
      type: 'object',
      required: ['prompt', 'tier'],
      properties: {
        prompt:   { type: 'string', description: 'Topic, URL, or text to summarise.' },
        tier:     { type: 'string', enum: ['mini', 'standard', 'extended', 'max'] },
        tone:     { type: 'string', enum: ['professional', 'casual', 'viral', 'informational'] },
        language: { type: 'string', description: 'ISO-639-1, default "en".' },
      },
    },
    output_schema: {
      type: 'object',
      required: ['tweet', 'char_count', 'tier_paid', 'tx_proof'],
      properties: {
        tweet:      { type: 'string' },
        char_count: { type: 'integer' },
        tier_paid:  { type: 'string', enum: ['mini', 'standard', 'extended', 'max'] },
        tx_proof:   { type: 'string', description: 'Solana tx signature that paid for this call.' },
      },
    },
  };

  return {
    name: 'Tweetsmith',
    url,
    version: '0.1.0',
    description:
      'Tweetsmith — turns a topic, URL or chunk of text into a ready-to-post ' +
      'tweet at one of four tiers (mini / standard / extended / max). Paid ' +
      'per call in Solana devnet lamports via x402. The canonical public ' +
      'reference implementation of the full MeshKore v1 agent protocol: ' +
      'A2A PublicCard, hub heartbeat, slim DiscoveryCard with brand fields, ' +
      'tiered pricing, on-chain settlement.',
    defaultInputModes:  ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [skill],
    pricing: buildPricingBlock(env),
    // Real Solana devnet pubkey, wired by AG8 from
    // `.meshkore/credentials/wallets/tweetsmith-solana-devnet.json`.
    // Surface as a wrangler.toml [vars] entry so the card stays
    // self-contained (no Worker secret round-trip on every fetch).
    payment_address: env.TWEETSMITH_WALLET_PUBKEY,
    payment: buildPaymentDeclaration(env),
    identity: { scheme: 'MeshKore-Sig', whoami: `${url}/v1/whoami` },
    protocols: ['http', 'a2a'],
    availability: { now: upstreamReady, window_hours: 168, sla: '99%' },
    contact: {
      http: `${url}/v1/generate-tweet`,
      a2a:  `${url}/.well-known/agent.json`,
    },
  };
}
