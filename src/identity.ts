// MeshKore-Sig — caller identity verification (reference implementation).
//
// The whole of authentication on MeshKore: a single header carrying a
// detached Ed25519 signature over a fixed canonical string. No sessions,
// no token negotiation. Verifying the signature proves the caller holds
// the private key for `pubkey` — that pubkey IS their identity.
//
// Spec: .meshkore/docs/conventions/agent-identity.md
//
//   Header:  MeshKore-Sig: v1 <pubkey_b64> <ts> <nonce> <sig_b64>
//   Signed:  "MK1\n" + METHOD + "\n" + path + "\n" + sha256hex(body) + "\n" + ts + "\n" + nonce
//   Verify:  1. |now-ts| <= 120s   2. nonce unseen (KV, 120s TTL)
//            3. ed25519_verify(pubkey, canonical, sig)
//
// This file is intentionally tiny and dependency-free (Web Crypto only)
// so the exact same ~40 lines drop into every CF-Worker agent.

import type { Env } from './types';

const SKEW_SECS = 120;
const enc = new TextEncoder();

export interface VerifiedIdentity {
  pubkey: string;   // raw Ed25519 public key, base64 (the wire id)
  did: string;      // did:key display form
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a MeshKore-Sig header. Returns the caller's identity, or null if
 * the header is absent / malformed / expired / replayed / signature-invalid.
 * `bodyText` is the raw request body (empty string for GET).
 * Non-throwing: any failure → null (caller decides how to gate).
 */
export async function verifyMeshKoreSig(
  env: Env, request: Request, bodyText: string,
): Promise<VerifiedIdentity | null> {
  const header = request.headers.get('meshkore-sig');
  if (!header) return null;

  const parts = header.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const pubkeyB64 = parts[1], tsStr = parts[2], nonce = parts[3], sigB64 = parts[4];
  if (!pubkeyB64 || !tsStr || !nonce || !sigB64) return null;

  const ts = parseInt(tsStr, 10);
  if (!Number.isFinite(ts)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > SKEW_SECS) return null;          // 1. replay window

  const nonceKey = `sig:nonce:${nonce}`;
  if (await env.CACHE.get(nonceKey)) return null;           // 2. single-use nonce

  const bodyHash = await sha256Hex(bodyText);
  const path = new URL(request.url).pathname;
  const canonical = `MK1\n${request.method}\n${path}\n${bodyHash}\n${ts}\n${nonce}`;

  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      'raw', b64decode(pubkeyB64), { name: 'Ed25519' }, false, ['verify'],
    );
    ok = await crypto.subtle.verify(
      { name: 'Ed25519' }, key, b64decode(sigB64), enc.encode(canonical),
    );
  } catch {
    return null;                                            // bad key/sig encoding
  }
  if (!ok) return null;                                     // 3. signature

  // Burn the nonce so this exact request can't be replayed within the window.
  await env.CACHE.put(nonceKey, '1', { expirationTtl: SKEW_SECS });

  return { pubkey: pubkeyB64, did: `did:key:${pubkeyB64}` };
}
