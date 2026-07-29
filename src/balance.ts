// Tweetsmith — prepaid-balance helpers (AG12).
//
// Optional second payment path alongside AG9's x402-per-call. State lives
// in env.CACHE under three prefixes:
//
//   balance:<api_key>          → '<lamports-as-decimal-string>'
//   credit:<solana-signature>  → '1'  (idempotency marker — block re-credit)
//   apikey:<api_key>           → '<payer_address>'  (binding for audit)
//
// Lamports are stored as a decimal string so we never lose precision; all
// arithmetic happens in BigInt and is serialised on the way out.
//
// `credit` is idempotent on `sig`: a second call with the same signature
// is a silent no-op so the cron can re-process the same on-chain tx after
// a crash without double-crediting.

import type { Env } from './types';

const BALANCE_PREFIX = 'balance:';
const CREDIT_MARK_PREFIX = 'credit:';
const APIKEY_PREFIX = 'apikey:';
const APIKEY_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year — long-lived binding
const CREDIT_MARK_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 d — outlasts any retry window

// base58 alphabet (Bitcoin / Solana).
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function mintApiKey(): string {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  let zeros = 0;
  while (zeros < raw.length && raw[zeros] === 0) zeros++;
  const input = Array.from(raw);
  const out: number[] = [];
  let start = zeros;
  while (start < input.length) {
    let remainder = 0;
    for (let i = start; i < input.length; i++) {
      const acc = remainder * 256 + (input[i] ?? 0);
      input[i] = Math.floor(acc / 58);
      remainder = acc % 58;
    }
    out.push(remainder);
    while (start < input.length && input[start] === 0) start++;
  }
  let s = '';
  const lead = B58_ALPHABET[0] ?? '1';
  for (let i = 0; i < zeros; i++) s += lead;
  for (let i = out.length - 1; i >= 0; i--) s += B58_ALPHABET[out[i] ?? 0] ?? '';
  return `tk_${s}`;
}

export async function getBalance(env: Env, apiKey: string): Promise<bigint> {
  const v = await env.CACHE.get(`${BALANCE_PREFIX}${apiKey}`);
  if (!v) return 0n;
  try { return BigInt(v); } catch { return 0n; }
}

export async function debit(env: Env, apiKey: string, lamports: bigint): Promise<{ ok: true; remaining: bigint } | { ok: false; reason: 'insufficient'; balance: bigint }> {
  const current = await getBalance(env, apiKey);
  if (current < lamports) return { ok: false, reason: 'insufficient', balance: current };
  const next = current - lamports;
  await env.CACHE.put(`${BALANCE_PREFIX}${apiKey}`, next.toString());
  return { ok: true, remaining: next };
}

export async function credit(env: Env, apiKey: string, lamports: bigint, sig: string): Promise<{ credited: boolean; balance: bigint; reason?: 'already-credited' | 'zero' }> {
  if (lamports <= 0n) {
    return { credited: false, balance: await getBalance(env, apiKey), reason: 'zero' };
  }
  const mark = await env.CACHE.get(`${CREDIT_MARK_PREFIX}${sig}`);
  if (mark !== null) {
    return { credited: false, balance: await getBalance(env, apiKey), reason: 'already-credited' };
  }
  const current = await getBalance(env, apiKey);
  const next = current + lamports;
  await env.CACHE.put(`${BALANCE_PREFIX}${apiKey}`, next.toString());
  await env.CACHE.put(`${CREDIT_MARK_PREFIX}${sig}`, apiKey, { expirationTtl: CREDIT_MARK_TTL_SECONDS });
  return { credited: true, balance: next };
}

export async function bindApiKey(env: Env, apiKey: string, payerAddress: string): Promise<void> {
  await env.CACHE.put(`${APIKEY_PREFIX}${apiKey}`, payerAddress, {
    expirationTtl: APIKEY_TTL_SECONDS,
  });
}

export async function apiKeyExists(env: Env, apiKey: string): Promise<boolean> {
  // Either the api_key has been bound at topup time or already has a non-zero balance.
  if ((await env.CACHE.get(`${APIKEY_PREFIX}${apiKey}`)) !== null) return true;
  if ((await env.CACHE.get(`${BALANCE_PREFIX}${apiKey}`)) !== null) return true;
  return false;
}

export function lamportsPerCredit(env: Env): bigint {
  const raw = env.LAMPORTS_PER_CREDIT;
  if (raw) {
    try {
      const n = BigInt(raw);
      if (n > 0n) return n;
    } catch { /* fall through */ }
  }
  return 100_000n;
}
