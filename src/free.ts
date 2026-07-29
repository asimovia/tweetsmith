// Tweetsmith — free-tier daily allowance (AG10).
//
// Sits BEFORE the x402 challenge in the request path. If the caller is
// under `FREE_DAILY_CAP` calls in the last 24h, we serve a tweet for
// free; over cap → return null and let the handler fall through to the
// existing 402 flow.
//
// Caller-id heuristic:
//   1. `X-Caller-Id` header if present (lets paid clients pin themselves)
//   2. otherwise SHA-256 of `CF-Connecting-IP` (or the first XFF entry).
//
// Storage: env.CACHE KV with `free:<caller-id>` → '<count>'. 24h TTL on
// the FIRST put for that caller; later increments keep the same TTL by
// re-putting with a TTL = remainder of the original window (which the
// KV layer doesn't expose, so we just reset the TTL to 24h on every
// increment — this is over-generous by at most ~24h, which is fine for
// a demo-grade free tier).

import type { Env } from './types';

const FREE_PREFIX = 'free:';
const FREE_TTL_SECONDS = 60 * 60 * 24;
const DEFAULT_FREE_CAP = 3;

export interface FreeCheckResult {
  callerId: string;
  used: number;
  cap: number;
  allowed: boolean;
}

export async function checkFreeAllowance(req: Request, env: Env): Promise<FreeCheckResult> {
  const callerId = await resolveCallerId(req);
  const cap = parseCap(env.FREE_DAILY_CAP) ?? DEFAULT_FREE_CAP;
  const raw = await env.CACHE.get(`${FREE_PREFIX}${callerId}`);
  const used = raw ? (Number.parseInt(raw, 10) || 0) : 0;
  return { callerId, used, cap, allowed: used < cap };
}

// Bump the counter AFTER a free call succeeds. Separate from the check
// so we don't burn a free slot on an upstream failure.
export async function recordFreeUse(env: Env, callerId: string, prev: number): Promise<void> {
  await env.CACHE.put(`${FREE_PREFIX}${callerId}`, String(prev + 1), {
    expirationTtl: FREE_TTL_SECONDS,
  });
}

function parseCap(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

async function resolveCallerId(req: Request): Promise<string> {
  const explicit = req.headers.get('X-Caller-Id');
  if (explicit && explicit.trim().length > 0) {
    return `id:${explicit.trim().slice(0, 80)}`;
  }
  const ip =
    req.headers.get('CF-Connecting-IP') ??
    (req.headers.get('X-Forwarded-For') ?? '').split(',')[0]?.trim() ??
    '0.0.0.0';
  return `ip:${await sha256Hex(ip || '0.0.0.0')}`;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out.slice(0, 32);
}
