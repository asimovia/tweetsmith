// Tweetsmith as a CLIENT — hiring another MeshKore agent.
//
// This is the heart of the agent-using-agent demo: Tweetsmith discovers
// the image agent the SAME way any caller would (read its A2A card),
// proves its own identity (MeshKore-Sig), pays it (deposit/credit or
// free tier), and gets a result back. The economics it records here are
// what later become "spent" in the profit math and the inputs to the
// signed reputation report.
//
// Payment path used: the image agent's DEPOSIT mode (Tweetsmith holds a
// prepaid api_key with it — IMAGE_AGENT_API_KEY) when configured, else
// the image agent's free tier. True per-call x402 from inside a Worker
// needs an on-chain SOL sender (tracked separately); deposit is the
// natural rail for a high-frequency agent→agent relationship anyway.

import type { Env } from './types';
import type { Signer } from './mksign';

export interface HireResult {
  ok: boolean;
  image: string | null;
  endpoint: string;
  skill_url: string;
  quoted_lamports: number;   // the image agent's list price (from its card)
  spent_lamports: number;    // what we actually paid this call
  settled: 'free' | 'balance' | 'x402-required' | 'unpaid' | 'error';
  latency_ms: number;
  signed: boolean;
  provider_used?: string;
  error?: string;
}

interface ImageCard {
  contact?: Record<string, string>;
  pricing?: Array<{ amount?: number; tier?: string; network?: string }>;
  payment?: { wallet?: string; modes?: string[] };
}

function pickSkillUrl(base: string, card: ImageCard): string {
  // Prefer the configured base (IMAGE_AGENT_URL = the live worker). The
  // card's contact.http may advertise a canonical custom domain that isn't
  // bound yet → trusting it blindly 404s. Only use it if it shares the base
  // host (so the agent can still relocate its skill path).
  const http = card.contact?.http;
  try {
    if (http && new URL(http).host === new URL(base).host) return http;
  } catch { /* fall through */ }
  return `${base.replace(/\/$/, '')}/v1/text-to-image`;
}

function quotedFrom(card: ImageCard): number {
  const rows = Array.isArray(card.pricing) ? card.pricing : [];
  const std = rows.find((r) => r.tier === 'standard') ?? rows[0];
  return typeof std?.amount === 'number' ? std.amount : 0;
}

export async function hireImageAgent(
  env: Env, signer: Signer | null, prompt: string,
): Promise<HireResult> {
  const base = (env.IMAGE_AGENT_URL || '').replace(/\/$/, '');
  const out: HireResult = {
    ok: false, image: null, endpoint: base, skill_url: '',
    quoted_lamports: 0, spent_lamports: 0, settled: 'error',
    latency_ms: 0, signed: false,
  };
  if (!base) { out.error = 'IMAGE_AGENT_URL unset'; return out; }

  // 1. Discover — read the supplier's A2A card (price, wallet, skill url).
  let card: ImageCard = {};
  try {
    const cr = await fetch(`${base}/.well-known/agent.json`, { headers: { accept: 'application/json' } });
    if (cr.ok) card = (await cr.json()) as ImageCard;
  } catch { /* card optional — fall back to defaults below */ }
  const skillUrl = pickSkillUrl(base, card);
  out.skill_url = skillUrl;
  out.quoted_lamports = quotedFrom(card);

  // 2. Invoke — signed identity + (optional) prepaid api_key for the
  //    deposit/credit path.
  const bodyText = JSON.stringify({ prompt });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signer) {
    headers['MeshKore-Sig'] = await signer.header('POST', new URL(skillUrl).pathname, bodyText);
    out.signed = true;
  }
  const depositKey = (env.IMAGE_AGENT_API_KEY || '').trim();
  if (depositKey) headers['X-Api-Key'] = depositKey;

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(skillUrl, { method: 'POST', headers, body: bodyText });
  } catch (e) {
    out.error = `network: ${(e as Error).message}`.slice(0, 160);
    out.latency_ms = Date.now() - t0;
    return out;
  }
  out.latency_ms = Date.now() - t0;

  if (res.status === 402) {
    out.settled = 'x402-required';
    out.error = depositKey
      ? 'supplier returned 402 despite api_key (balance exhausted — top up the deposit)'
      : 'supplier requires payment; configure IMAGE_AGENT_API_KEY (deposit) to settle';
    return out;
  }
  if (!res.ok) {
    out.error = `supplier ${res.status}`;
    return out;
  }

  const data = (await res.json()) as Record<string, unknown>;
  // Image agents return `image` either as a string (URL / data-URI) or as a
  // RefImage object {data, mimeType} (lucid's shape) — normalize to a data-URI.
  const imgField = data.image;
  if (imgField && typeof imgField === 'object' && (imgField as { data?: string }).data) {
    const ref = imgField as { data: string; mimeType?: string };
    out.image = ref.data.startsWith('data:')
      ? ref.data
      : `data:${ref.mimeType || 'image/png'};base64,${ref.data}`;
  } else {
    out.image = (imgField as string) ?? (data.image_url as string) ?? null;
  }
  out.provider_used = (data.provider_used as string) ?? undefined;
  out.ok = !!out.image;

  // 3. Record what we paid. Deposit path debits the list price; free tier
  //    costs nothing (but we keep the quote so the margin math is honest).
  const mode = (data.payment_mode as string) ?? (depositKey ? 'balance' : 'free');
  if (mode === 'balance') {
    const debited = Number(data.debited_lamports ?? out.quoted_lamports) || out.quoted_lamports;
    out.spent_lamports = debited;
    out.settled = 'balance';
  } else {
    out.spent_lamports = 0;
    out.settled = 'free';
  }
  if (!out.ok) { out.settled = 'error'; out.error = out.error ?? 'no image in supplier response'; }
  return out;
}
