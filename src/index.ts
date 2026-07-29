// Tweetsmith — Cloudflare Worker entrypoint.
//
// Reference implementation of the full v1 MeshKore paid-agent protocol.
// This file (AG7) ships the four-endpoint HTTP surface only:
//
//   GET  /                        → banner (human-readable)
//   GET  /health                  → {ok, upstream_ready}
//   GET  /.well-known/agent.json  → PublicCard (A2A, interaction tier)
//   POST /v1/generate-tweet       → skill (STUB until AG10)
//
// Follow-up tasks layered on top of this surface:
//   AG8  — Solana devnet wallet (worker secret + cached pubkey).
//   AG9  — x402 challenge on /v1/generate-tweet, devnet RPC verify, idempotency.
//   AG10 — Real LLM call (Gemini Flash default), tier char-cap enforcement.
//   AG11 — Hub heartbeat cron (`scheduled()` handler).
//   AG12 — Optional deposit+balance flow (Phase E.7 Model 4).
//   AG13 — Smoke script + CF deploy + custom domain + README.

import type { Env } from './types';
import { buildPublicCard, priceFor } from './card';
import { heartbeatUnified } from './liveness';
import { handleGenerateTweet } from './handler';
import { handleTopup, handleBalanceGet, pollDeposits } from './topup';
import { handleTweetWithImage } from './demo';
import { verifyMeshKoreSig } from './identity';
import { loadSigner } from './mksign';

const SUPPORTED_TIERS = ['mini', 'standard', 'extended', 'max'] as const;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const cors = corsHeaders();
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let res: Response;
    try {
      res = await route(path, req, env);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res = j({ error: 'internal', detail: msg.slice(0, 200) }, 500);
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },

  // Hub heartbeat — fires every 5 min per wrangler.toml `[triggers]`.
  // The hub treats an agent as offline after 300s of silence, so the
  // cron interval has to stay ≤ that bound. Two idempotent pushes per
  // tick: refresh + re-publish the slim DiscoveryCard, then re-affirm
  // `availability.now`. Stub-and-flag while HUB_API_KEY is unset so
  // the worker boots cleanly before secrets land.
  async scheduled(_evt: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      // (1) Unified-API liveness (api.meshkore.com) — self-signed HTTP heartbeat
      // on the existing */5 cron (zero new cron slots). Signs the token request
      // with IDENTITY_JWK, then POST /v1/agents/me/heartbeat. This is what shows
      // tweetsmith online on the mesh/fichas; the legacy Fly-hub heartbeat was
      // removed (Fly is being retired).
      try {
        const r = await heartbeatUnified(env);
        if (!r.ok) console.warn('[heartbeat-unified] skipped:', r.reason);
      } catch (e) {
        console.error('[heartbeat-unified] failed:', e);
      }
      // (2) AG12 — poll inbound SOL transfers to the agent wallet and
      // credit the matching api_key balances. Self-stubs when the
      // wallet env var is unset (no crash, just a log line).
      try {
        const poll = await pollDeposits(env);
        if (poll.scanned > 0) {
          console.log(`[topup] scanned=${poll.scanned} credited=${poll.credited} unmapped=${poll.unmapped}`);
        }
      } catch (e) {
        console.error('[topup] poll failed:', e);
      }
    })());
  },
};

async function route(path: string, req: Request, env: Env): Promise<Response> {
  const upstreamReady = !!(env.LLM_API_KEY ?? env.GEMINI_API_KEY);
  const requestOrigin = new URL(req.url).origin;

  if (path === '/' || path === '/banner') {
    return new Response(
      [
        'Tweetsmith — MeshKore reference paid agent.',
        '',
        'See /.well-known/agent.json for the full A2A card (skills, pricing, payment_address).',
        'See /health for liveness + upstream-ready flag.',
        '',
        `Network: ${env.SOLANA_NETWORK || 'solana-devnet'}`,
        `Tiers:   ${SUPPORTED_TIERS.map((t) => `${t}=${priceFor(env, t)}L`).join(', ')}`,
        '',
        'Source: https://github.com/meshkore/tweetsmith',
      ].join('\n'),
      { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  if (path === '/health') {
    return j({
      ok: true,
      agent_id: env.AGENT_ID,
      upstream_ready: upstreamReady,
      network: env.SOLANA_NETWORK || 'solana-devnet',
      version: '0.1.0',
    });
  }

  if (path === '/.well-known/agent.json') {
    // Tier-2 (interaction). Peer agents fetch this directly after the
    // Oracle/hub points them at this worker's endpoint. Full skill +
    // examples + EXPLICIT network-tagged pricing + payment_address.
    return j(buildPublicCard(env, requestOrigin));
  }

  if (path === '/v1/generate-tweet' && req.method === 'POST') {
    return handleGenerateTweet(req, env);
  }

  // Agent-using-agent demo: write a tweet AND hire the image agent,
  // settle, profit, and rate the supplier — all in one signed call.
  if (path === '/v1/tweet-with-image' && req.method === 'POST') {
    return handleTweetWithImage(req, env);
  }

  // Identity attestation. (a) GET → who Tweetsmith is (its own pubkey/did,
  // derived from IDENTITY_JWK). (b) with a MeshKore-Sig header → also
  // echoes the verified CALLER identity, proving the verify path works.
  if (path === '/v1/whoami') {
    const signer = await loadSigner(env);
    const caller = await verifyMeshKoreSig(env, req, req.method === 'POST' ? await req.clone().text() : '');
    return j({
      agent_id: env.AGENT_ID,
      identity: signer ? { pubkey: signer.pubkey, did: signer.did } : null,
      identity_ready: !!signer,
      caller: caller ? { pubkey: caller.pubkey, did: caller.did, verified: true } : null,
    });
  }

  if (path === '/v1/topup' && req.method === 'POST') {
    return handleTopup(req, env);
  }

  if (path === '/v1/balance' && req.method === 'GET') {
    return handleBalanceGet(req, env);
  }

  return j({ error: 'not_found', path }, 404);
}

function j(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-payment-proof, x-payment-nonce, x-api-key, x-caller-id, authorization, meshkore-sig',
    'access-control-max-age': '86400',
  };
}
