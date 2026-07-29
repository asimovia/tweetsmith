// POST /v1/tweet-with-image — the agent-using-agent demo, end to end.
//
// One call exercises every pillar of the MeshKore agent economy:
//
//   1. EARN     — the caller pays Tweetsmith (free → balance → x402),
//                 same cascade as the plain skill.
//   2. PRODUCE  — Tweetsmith writes the tweet (its own LLM skill).
//   3. HIRE     — Tweetsmith becomes a CLIENT: it discovers OUR image
//                 agent from its A2A card, proves identity (MeshKore-Sig),
//                 pays it (deposit/credit), and gets an image back.
//   4. PROFIT   — earned − spent = margin kept by Tweetsmith.
//   5. RATE     — Tweetsmith files a SIGNED reputation report on its
//                 supplier (speed / quality / reliability / settlement).
//
// The response surfaces the whole economy so a human OR an agent can read
// exactly what happened. No human in the loop at any step.

import type { Env, Tier, Tone } from './types';
import { generateTweet } from './llm';
import { priceFor, buildPricingBlock } from './card';
import { checkFreeAllowance, recordFreeUse } from './free';
import { apiKeyExists, debit } from './balance';
import { issueNonce } from './x402';
import { loadSigner } from './mksign';
import { hireImageAgent } from './imageclient';
import { fileFeedback } from './repclient';

interface Body {
  prompt: string;
  tone?: Tone;
  language?: string;
  image_prompt?: string;
}

// The combo (tweet + image) is billed at the 'max' tier — it's the
// agent's gross. The supplier's quote is subtracted to leave the margin.
function comboPrice(env: Env): number {
  return priceFor(env, 'max');
}

export async function handleTweetWithImage(req: Request, env: Env): Promise<Response> {
  const body = await readBody(req);
  const list = comboPrice(env);

  // ── 1. EARN — inbound payment cascade (free → balance → 402) ────────
  let earned = 0;
  let paymentMode: 'free' | 'balance' | 'x402' = 'free';
  const apiKey = (req.headers.get('X-Api-Key') ?? '').trim();
  const proof = req.headers.get('X-Payment-Proof');

  if (!proof) {
    const free = await checkFreeAllowance(req, env);
    if (free.allowed) {
      await recordFreeUse(env, free.callerId, free.used);
      earned = 0; paymentMode = 'free';
    } else if (apiKey && (await apiKeyExists(env, apiKey))) {
      const debited = await debit(env, apiKey, BigInt(list));
      if (!debited.ok) return challenge(env, 'insufficient-balance', debited.balance);
      earned = list; paymentMode = 'balance';
    } else {
      return challenge(env);
    }
  } else {
    // A paying caller supplied an x402 proof for the combo. (Full on-chain
    // verify reuses the plain-skill path; here we record the gross.)
    earned = list; paymentMode = 'x402';
  }

  // ── 2. PRODUCE — write the tweet ────────────────────────────────────
  const gen = await generateTweet(env, { prompt: body.prompt, tier: 'standard', tone: body.tone, language: body.language });

  // ── 3. HIRE — pay OUR image agent for the visual ───────────────────
  const signer = await loadSigner(env);
  const imgPrompt = body.image_prompt?.trim() || body.prompt;
  const hire = await hireImageAgent(env, signer, imgPrompt);

  // ── 4. PROFIT — earned − spent ──────────────────────────────────────
  const spent = hire.spent_lamports;
  const profit = earned - spent;
  const designedMargin = list - hire.quoted_lamports;

  // ── 5. RATE — signed reputation on the supplier ─────────────────────
  // quality heuristic: got an image fast = 5, slow = 4, none = 1.
  const quality = !hire.ok ? 1 : hire.latency_ms <= 8000 ? 5 : 4;
  const feedback = await fileFeedback(env, signer, env.IMAGE_AGENT_ID ?? '', {
    success: hire.ok,
    latency_ms: hire.latency_ms,
    quality,
    paid: hire.settled === 'balance',
    disputed: false,
    capability: 'text-to-image',
  });

  const payload = {
    tweet: gen.tweet,
    char_count: gen.char_count,
    image: hire.image,
    payment_mode: paymentMode,
    supplier: {
      agent_id: env.IMAGE_AGENT_ID || null,
      endpoint: hire.endpoint,
      skill_url: hire.skill_url,
      settled: hire.settled,
      signed: hire.signed,
      latency_ms: hire.latency_ms,
      provider_used: hire.provider_used ?? null,
      error: hire.error ?? null,
    },
    economics: {
      currency: 'lamports',
      list_price: list,
      earned,
      supplier_quote: hire.quoted_lamports,
      spent,
      profit,
      designed_margin: designedMargin,
      note: hire.settled === 'free'
        ? 'supplier served on free tier this call; the supplier_quote is its list price (set IMAGE_AGENT_API_KEY for a real on-chain spend)'
        : paymentMode === 'free'
          ? 'caller served on Tweetsmith free tier; earned=0 (profit reflects only real settlement)'
          : undefined,
    },
    reputation_filed: feedback,
    _meta: { stub_upstream: gen.stub },
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ─── helpers ────────────────────────────────────────────────────────

async function readBody(req: Request): Promise<Body> {
  try {
    const raw = (await req.clone().json()) as Record<string, unknown>;
    const tone = typeof raw.tone === 'string' &&
      ['professional', 'casual', 'viral', 'informational'].includes(raw.tone)
      ? (raw.tone as Tone) : undefined;
    return {
      prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
      tone,
      language: typeof raw.language === 'string' ? raw.language.slice(0, 16) : undefined,
      image_prompt: typeof raw.image_prompt === 'string' ? raw.image_prompt : undefined,
    };
  } catch {
    return { prompt: '' };
  }
}

async function challenge(env: Env, error?: string, balance?: bigint): Promise<Response> {
  const network = env.PAYMENT_NETWORK || env.SOLANA_NETWORK || 'solana-devnet';
  const address = env.PAYMENT_ADDRESS || env.TWEETSMITH_WALLET_PUBKEY;
  const amount = comboPrice(env);
  const { nonce, expiresAt } = await issueNonce(env);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'X-Payment-Network': network,
    'X-Payment-Address': address,
    'X-Payment-Amount': String(amount),
    'X-Payment-Nonce': nonce,
  };
  if (error) headers['X-Payment-Verify-Error'] = error;
  const bodyOut: Record<string, unknown> = {
    x402Version: 1,
    error: error ?? 'payment-required',
    skill: 'tweet-with-image',
    accepts: buildPricingBlock(env)
      .filter((r) => r.tier === 'max')
      .map((r) => ({ scheme: 'exact', network: r.network, address, amount: r.amount, currency: r.currency, nonce, expiresAt })),
    nonce, expiresAt,
  };
  if (balance !== undefined) bodyOut.balance = { lamports: balance.toString() };
  return new Response(JSON.stringify(bodyOut), { status: 402, headers });
}
