// MeshKore-Sig — the CLIENT side (signing) of agent identity.
//
// The mirror of every agent's `identity.ts` (which VERIFIES). When
// Tweetsmith acts as a *caller* — hiring the image agent, filing a
// signed reputation report — it must prove its own identity the same
// way: a single detached Ed25519 signature header.
//
//   Header:  MeshKore-Sig: v1 <pubkey_b64> <ts> <nonce> <sig_b64>
//   Signed:  "MK1\n" + METHOD + "\n" + path + "\n" + sha256hex(body) + "\n" + ts + "\n" + nonce
//
// The identity key is Tweetsmith's OWN Ed25519 keypair (NOT its Solana
// payment wallet — those are deliberately separate, see agent-payments.md).
// It's supplied as a Worker secret `IDENTITY_JWK`: the private key in JWK
// form (`{kty:"OKP",crv:"Ed25519",x,d}`). Web Crypto imports Ed25519 keys
// from JWK in both CF Workers and Node, which is why we use JWK over raw.
//
// Stub-and-flag: with no IDENTITY_JWK the agent still runs (the demo
// falls back to unsigned calls / free tiers); signed paths just report
// `signed:false` so the wire stays honest.

import type { Env } from './types';

const enc = new TextEncoder();

export interface Signer {
  pubkey: string;                       // raw Ed25519 pubkey, standard base64 (the wire id)
  did: string;                          // did:key:<pubkey>
  header(method: string, path: string, bodyText: string): Promise<string>;
}

function b64urlToB64(s: string): string {
  return s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (s.length % 4)) % 4);
}

function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Build a Signer from the IDENTITY_JWK secret, or null if unset/invalid.
 * Non-throwing: callers treat null as "run unsigned" (stub-and-flag).
 */
export async function loadSigner(env: Env): Promise<Signer | null> {
  const raw = env.IDENTITY_JWK;
  if (!raw) return null;
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(raw) as JsonWebKey;
  } catch {
    return null;
  }
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x || !jwk.d) return null;

  let key: CryptoKey;
  try {
    // Import only the canonical OKP fields — extra members (key_ops/ext/alg)
    // from a JWK export can make workerd's importKey reject the key.
    const clean: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d };
    key = await crypto.subtle.importKey('jwk', clean, { name: 'Ed25519' }, false, ['sign']);
  } catch {
    return null;
  }
  // The wire id is the RAW pubkey in standard base64; JWK.x is base64url of it.
  const pubkey = b64urlToB64(jwk.x);

  return {
    pubkey,
    did: `did:key:${pubkey}`,
    async header(method: string, path: string, bodyText: string): Promise<string> {
      const ts = Math.floor(Date.now() / 1000);
      const nonce = randNonce();
      const bodyHash = await sha256Hex(bodyText);
      const canonical = `MK1\n${method}\n${path}\n${bodyHash}\n${ts}\n${nonce}`;
      const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, enc.encode(canonical));
      return `v1 ${pubkey} ${ts} ${nonce} ${bytesToB64(new Uint8Array(sig))}`;
    },
  };
}
