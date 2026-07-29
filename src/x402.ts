// Tweetsmith — x402 nonce + on-chain verify (AG9a + AG9b).
//
// AG9a (shipped): `issueNonce` mints a 16-byte base58 token, stores it
// in env.X402_NONCES (`nonce:<token>` → '<expiresAt-epoch-seconds>')
// with a 10-min TTL.
//
// AG9b (this file): `consumeNonce` + `verifyProof` close the loop.
//   - `consumeNonce` enforces single-use semantics: it rejects unknown,
//     expired, and already-consumed nonces, and tombstones a successful
//     consume so a replay reports `nonce-already-consumed` instead of
//     re-passing.
//   - `verifyProof` calls Solana RPC (`getTransaction`, jsonParsed) on
//     env.SOLANA_RPC and asserts: tx confirmed (no err), destination ==
//     env.TWEETSMITH_WALLET_PUBKEY, lamport delta ≥ expectedAmount,
//     memo contains the nonce.
//
// Wire contract — handler.ts plugs them together:
//   challenge → issueNonce → caller pays Solana with nonce in memo →
//   handler reads X-Payment-Proof + X-Payment-Nonce → consumeNonce →
//   verifyProof → generator → cache sig→tweet in X402_PAID_SIGS.

import type { Env } from './types';

const NONCE_TTL_SECONDS = 600;

// Solana Memo program ids — accept both v1 (legacy) and v2 (current).
const MEMO_PROGRAM_IDS = new Set<string>([
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
]);

// base58 alphabet (Bitcoin / Solana — no 0/O/I/l ambiguity).
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  // Count leading zeros — they become leading '1's in base58.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Convert to base58 via repeated big-int division on a byte buffer.
  const input = Array.from(bytes);
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
  const leadChar = B58_ALPHABET[0] ?? '1';
  for (let i = 0; i < zeros; i++) s += leadChar;
  for (let i = out.length - 1; i >= 0; i--) s += B58_ALPHABET[out[i] ?? 0] ?? '';
  return s;
}

export interface IssuedNonce {
  nonce: string;
  expiresAt: number; // unix epoch seconds
}

export async function issueNonce(env: Env): Promise<IssuedNonce> {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  const nonce = base58Encode(raw);
  const expiresAt = Math.floor(Date.now() / 1000) + NONCE_TTL_SECONDS;
  // Store the expiresAt epoch as the value so consumeNonce can
  // distinguish `nonce-expired` from `nonce-unknown` when the TTL
  // hasn't quite purged the key yet. TTL is intentionally a touch
  // longer than the logical expiry so the post-expiry window stays
  // observable for a minute.
  await env.X402_NONCES.put(`nonce:${nonce}`, String(expiresAt), {
    expirationTtl: NONCE_TTL_SECONDS + 60,
  });
  return { nonce, expiresAt };
}

// ─── AG9b — single-use consume ─────────────────────────────────────

export type ConsumeReason =
  | 'nonce-unknown'
  | 'nonce-expired'
  | 'nonce-already-consumed';

export type ConsumeResult =
  | { ok: true }
  | { ok: false; reason: ConsumeReason };

const CONSUMED_PREFIX = 'consumed:';

export async function consumeNonce(env: Env, nonce: string): Promise<ConsumeResult> {
  const key = `nonce:${nonce}`;
  const v = await env.X402_NONCES.get(key);
  if (v === null) return { ok: false, reason: 'nonce-unknown' };
  if (v.startsWith(CONSUMED_PREFIX)) {
    return { ok: false, reason: 'nonce-already-consumed' };
  }

  const expiresAt = Number.parseInt(v, 10);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(expiresAt) || now > expiresAt) {
    return { ok: false, reason: 'nonce-expired' };
  }

  // Tombstone so a replay reports `nonce-already-consumed` rather
  // than racing through verify again. Keep the tombstone alive for
  // the rest of the original window plus a small grace buffer.
  const remaining = Math.max(60, expiresAt - now);
  await env.X402_NONCES.put(key, `${CONSUMED_PREFIX}${Date.now()}`, {
    expirationTtl: remaining,
  });
  return { ok: true };
}

// ─── AG9b — on-chain verify ────────────────────────────────────────

export type VerifyReason =
  | 'not-confirmed'
  | 'amount-too-low'
  | 'wrong-destination'
  | 'memo-mismatch';

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyReason };

interface RpcEnvelope {
  jsonrpc: '2.0';
  id: number;
  result?: ParsedTx | null;
  error?: { code: number; message: string };
}

interface ParsedTx {
  slot?: number;
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
  } | null;
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey: string; signer?: boolean; writable?: boolean }>;
      instructions?: Array<{
        program?: string;
        programId?: string;
        parsed?: unknown;
        data?: string;
      }>;
    };
    signatures?: string[];
  };
}

export async function verifyProof(
  env: Env,
  sig: string,
  expectedAmount: number,
  expectedNonce: string,
): Promise<VerifyResult> {
  const rpcUrl = env.SOLANA_RPC || 'https://api.devnet.solana.com';

  let envelope: RpcEnvelope;
  try {
    const r = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [
          sig,
          {
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          },
        ],
      }),
    });
    if (!r.ok) return { ok: false, reason: 'not-confirmed' };
    envelope = (await r.json()) as RpcEnvelope;
  } catch {
    return { ok: false, reason: 'not-confirmed' };
  }

  const tx = envelope?.result;
  if (!tx || tx.meta?.err) return { ok: false, reason: 'not-confirmed' };

  const dest = env.TWEETSMITH_WALLET_PUBKEY || env.PAYMENT_ADDRESS;

  const accountKeys = tx.transaction?.message?.accountKeys ?? [];
  const destIdx = accountKeys.findIndex((k) => {
    const pk = typeof k === 'string' ? k : k?.pubkey;
    return pk === dest;
  });
  if (destIdx === -1) return { ok: false, reason: 'wrong-destination' };

  const pre = tx.meta?.preBalances?.[destIdx] ?? 0;
  const post = tx.meta?.postBalances?.[destIdx] ?? 0;
  const delta = post - pre;
  if (delta < expectedAmount) return { ok: false, reason: 'amount-too-low' };

  const instructions = tx.transaction?.message?.instructions ?? [];
  const memoText = instructions
    .filter((ix) => {
      if (ix?.program === 'spl-memo') return true;
      if (ix?.programId && MEMO_PROGRAM_IDS.has(ix.programId)) return true;
      return false;
    })
    .map((ix) => (typeof ix?.parsed === 'string' ? ix.parsed : ''))
    .join(' ');

  if (!memoText.includes(expectedNonce)) {
    return { ok: false, reason: 'memo-mismatch' };
  }

  return { ok: true };
}
