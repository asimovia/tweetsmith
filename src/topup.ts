// Tweetsmith — deposit poller + /v1/topup handler (AG12).
//
// The deposit/credit rail described in agent-payments.md. Differences
// from a naive design:
//   - We use the MEMO (api_key) for attribution, not a payer→api_key
//     binding table. Cleaner — same payer wallet can fund multiple keys,
//     and the api_key→payer binding kept for audit is informational only.
//   - State lives in env.CACHE (KV) instead of D1 — we only need a
//     monotonic cursor + sig markers + balances; no relational joins.
//
// Cursor: `topup:last_sig` in env.CACHE — newest signature already
//   processed. Used as `until` in subsequent polls so we never re-walk
//   old history. On a crash mid-loop the marker advances only past
//   already-credited txs.
//
// Idempotency: balance.credit() checks `credit:<sig>` before mutating
// the balance KV — even a duplicate replay is a silent no-op.

import type { Env, Tier } from './types';
import { credit, getBalance, mintApiKey, bindApiKey, lamportsPerCredit } from './balance';
import { priceFor } from './card';

const LAST_SIG_KEY = 'topup:last_sig';
const SOLANA_SYSTEM_PROGRAM = '11111111111111111111111111111111';
const MEMO_PROGRAM_IDS = new Set<string>([
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
]);

// ─── RPC primitives ─────────────────────────────────────────────────

interface RpcEnvelope<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

async function rpc<T>(env: Env, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(env.SOLANA_RPC || 'https://api.devnet.solana.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`solana rpc ${method} ${r.status}`);
  const j = (await r.json()) as RpcEnvelope<T>;
  if (j.error) throw new Error(`solana rpc ${method}: ${j.error.message}`);
  if (j.result === undefined) throw new Error(`solana rpc ${method}: empty result`);
  return j.result;
}

interface SignatureItem {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown | null;
  memo: string | null;
}

interface ParsedTx {
  slot: number;
  blockTime: number | null;
  meta: { err: unknown | null } | null;
  transaction: {
    message: {
      instructions: Array<{
        program?: string;
        programId?: string;
        parsed?: { type?: string; info?: { source?: string; destination?: string; lamports?: number } } | string;
      }>;
    };
  };
}

interface DecodedDeposit {
  signature: string;
  from: string;
  lamports: number;
  apiKey: string | null;
}

function extractMemoApiKey(raw: string | null): string | null {
  // getSignaturesForAddress already returns a `memo` string when the tx
  // has a memo. Format is `[N] <utf-8>` where N is the byte-length tag.
  // Strip the tag if present and look for our `tk_<base58>` token; fall
  // back to the full memo text if it already matches.
  if (!raw) return null;
  const stripped = raw.replace(/^\[\d+\]\s*/, '').trim();
  const match = stripped.match(/tk_[1-9A-HJ-NP-Za-km-z]{16,32}/);
  if (match) return match[0];
  if (stripped.startsWith('tk_')) return stripped;
  return null;
}

async function decodeDeposit(env: Env, item: SignatureItem, wallet: string): Promise<DecodedDeposit | null> {
  if (item.err) return null;
  let tx: ParsedTx | null;
  try {
    tx = await rpc<ParsedTx | null>(env, 'getTransaction', [
      item.signature,
      { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]);
  } catch {
    return null;
  }
  if (!tx || tx.meta?.err) return null;

  let from: string | null = null;
  let lamports = 0;
  let memoText = '';
  for (const ix of tx.transaction.message.instructions ?? []) {
    if (ix.programId === SOLANA_SYSTEM_PROGRAM && typeof ix.parsed === 'object' && ix.parsed?.type === 'transfer') {
      const info = ix.parsed.info;
      if (info?.destination === wallet && typeof info.source === 'string' && typeof info.lamports === 'number') {
        from = info.source;
        lamports = info.lamports;
      }
    } else if ((ix.program === 'spl-memo') || (ix.programId && MEMO_PROGRAM_IDS.has(ix.programId))) {
      if (typeof ix.parsed === 'string') memoText += ' ' + ix.parsed;
    }
  }
  if (!from || lamports <= 0) return null;
  const memoApiKey = extractMemoApiKey(memoText) ?? extractMemoApiKey(item.memo);
  return { signature: item.signature, from, lamports, apiKey: memoApiKey };
}

// ─── pollDeposits — cron handler ────────────────────────────────────

export async function pollDeposits(env: Env): Promise<{ scanned: number; credited: number; unmapped: number }> {
  const wallet = env.TWEETSMITH_WALLET_PUBKEY || env.PAYMENT_ADDRESS;
  if (!wallet) {
    console.log('STUB: pollDeposits skipped (TWEETSMITH_WALLET_PUBKEY unset)');
    return { scanned: 0, credited: 0, unmapped: 0 };
  }

  const lastSig = await env.CACHE.get(LAST_SIG_KEY);
  let sigs: SignatureItem[];
  try {
    const opts: Record<string, unknown> = { limit: 50 };
    if (lastSig) opts.until = lastSig;
    sigs = await rpc<SignatureItem[]>(env, 'getSignaturesForAddress', [wallet, opts]);
  } catch (e) {
    console.warn('[topup] getSignaturesForAddress failed:', String(e));
    return { scanned: 0, credited: 0, unmapped: 0 };
  }

  if (!sigs || sigs.length === 0) return { scanned: 0, credited: 0, unmapped: 0 };

  const ordered = [...sigs].reverse(); // oldest → newest so the cursor advances monotonically
  const unitLamports = lamportsPerCredit(env);
  let credited = 0;
  let unmapped = 0;
  let lastProcessed: string | null = null;

  for (const item of ordered) {
    const decoded = await decodeDeposit(env, item, wallet);
    if (!decoded) {
      lastProcessed = item.signature;
      continue;
    }
    if (!decoded.apiKey) {
      unmapped++;
      lastProcessed = item.signature;
      continue;
    }
    // Round-down to whole credit units so dust transfers don't bloat balances.
    const lamportsBig = BigInt(decoded.lamports);
    const wholeUnits = lamportsBig / unitLamports;
    const creditableLamports = wholeUnits * unitLamports;
    const result = await credit(env, decoded.apiKey, creditableLamports, decoded.signature);
    if (result.credited) credited++;
    lastProcessed = item.signature;
  }

  if (lastProcessed) {
    await env.CACHE.put(LAST_SIG_KEY, lastProcessed);
  }
  return { scanned: ordered.length, credited, unmapped };
}

// ─── /v1/topup endpoint ─────────────────────────────────────────────

interface TopupBody {
  payer_address?: string;
  api_key?: string;
}

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function handleTopup(req: Request, env: Env): Promise<Response> {
  const wallet = env.TWEETSMITH_WALLET_PUBKEY || env.PAYMENT_ADDRESS;
  if (!wallet) {
    return j({
      error: 'topup_not_configured',
      detail: 'Agent wallet env (TWEETSMITH_WALLET_PUBKEY / PAYMENT_ADDRESS) is unset — operator must wire AG8 before /v1/topup is available.',
    }, 501);
  }

  let body: TopupBody = {};
  try { body = (await req.clone().json()) as TopupBody; } catch { /* empty body ok */ }

  const payer = (body.payer_address ?? '').trim();
  if (!payer) {
    return j({
      error: 'missing_payer_address',
      detail: 'POST {"payer_address":"<your Solana wallet>"} so the polling cron can attribute deposits to your api_key.',
    }, 400);
  }
  if (!SOLANA_ADDRESS_RE.test(payer)) {
    return j({ error: 'invalid_payer_address', detail: 'expected base58 Solana address (32-44 chars)' }, 400);
  }

  const explicitKey = (req.headers.get('X-Api-Key') ?? body.api_key ?? '').trim();
  const apiKey = explicitKey || mintApiKey();
  await bindApiKey(env, apiKey, payer);
  const balance = await getBalance(env, apiKey);

  const network = env.PAYMENT_NETWORK || env.SOLANA_NETWORK || 'solana-devnet';
  const unitLamports = lamportsPerCredit(env);
  const suggestedLamports = unitLamports * 10n; // 10 credits ≈ 0.001 SOL default
  const suggestedSol = (Number(suggestedLamports) / 1_000_000_000).toString();

  const memo = encodeURIComponent(apiKey);
  const reference = encodeURIComponent(apiKey);
  const solanaPayUrl =
    `solana:${wallet}` +
    `?amount=${suggestedSol}` +
    `&reference=${reference}` +
    `&label=Tweetsmith%20Topup` +
    `&message=Tweetsmith%20prepaid%20balance` +
    `&memo=${memo}`;

  return j({
    status: 'registered',
    api_key: apiKey,
    payer_address: payer,
    balance_lamports: balance.toString(),
    deposit: {
      recipient: wallet,
      network,
      lamports_per_credit: unitLamports.toString(),
      suggested_lamports: suggestedLamports.toString(),
      memo: apiKey,
      reference: apiKey,
      solanaPayUrl,
    },
    note: 'Transfer SOL to recipient with the api_key as the memo (Solana-Pay URL embeds it). Balance updates within ~5 min — POST same body to /v1/topup to recheck, or call /v1/generate-tweet (it surfaces remaining balance in headers).',
  });
}

// ─── /v1/balance endpoint ───────────────────────────────────────────

export async function handleBalanceGet(req: Request, env: Env): Promise<Response> {
  const apiKey = (req.headers.get('X-Api-Key') ?? '').trim();
  if (!apiKey) return j({ error: 'missing_api_key', detail: 'send X-Api-Key header' }, 401);
  const balance = await getBalance(env, apiKey);
  const unit = lamportsPerCredit(env);
  return j({
    api_key: apiKey,
    balance_lamports: balance.toString(),
    balance_credits: (balance / unit).toString(),
    lamports_per_credit: unit.toString(),
  });
}

// ─── tier→lamports cost (re-exported for the handler) ──────────────

export function costLamports(env: Env, tier: Tier): bigint {
  return BigInt(priceFor(env, tier));
}

function j(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
