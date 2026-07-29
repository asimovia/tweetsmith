// Tweetsmith — hub auth + heartbeat (AG11).
//
// The hub never pings agents. `is_agent_online()` only flips true when
// the agent itself has pushed within the last 300s. Cloudflare Workers
// can't keep an internal busy-loop, so we drive a `*/5 * * * *` cron
// and on every tick do two idempotent pushes:
//
//   1. publishFullCard() — PATCH /agents/me with the SLIM DiscoveryCard.
//      Re-syncs the hub-stored brand/tags/pricing so edits ship without
//      a manual re-publish step.
//
//   2. publishHeartbeat() — POST /agents/token to refresh the short-
//      lived JWT (the same call internally invokes touch_polling_agent
//      which flips the directory's `online: true`), then POST
//      /agents/me/state with the current `availability.now`.
//
// Order matters: full card first so the heartbeat's narrower state
// merge runs against the latest schema.
//
// Both functions short-circuit cleanly when HUB_API_KEY is unset —
// callers log `STUB: would heartbeat to hub` and return without
// touching the network.

import type { Env } from './types';
import { buildDiscoveryCard } from './card';

async function refreshToken(env: Env): Promise<{ token?: string; reason?: string }> {
  if (!env.HUB_API_KEY) return { reason: 'HUB_API_KEY not set' };
  const r = await fetch(`${env.HUB_URL}/agents/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent_id: env.AGENT_ID, api_key: env.HUB_API_KEY }),
  });
  if (!r.ok) {
    const text = (await r.text()).slice(0, 200);
    return { reason: `hub ${r.status}: ${text}` };
  }
  const body = (await r.json()) as { token?: string };
  if (!body.token) return { reason: 'no token in response' };
  return { token: body.token };
}

export async function publishFullCard(env: Env): Promise<{ ok: boolean; reason?: string }> {
  const tok = await refreshToken(env);
  if (!tok.token) return { ok: false, reason: tok.reason };

  const card = buildDiscoveryCard(env);
  const r = await fetch(`${env.HUB_URL}/agents/me`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${tok.token}`,
    },
    body: JSON.stringify({
      description:  card.description,
      capabilities: card.tags,
      agent_card:   card,
    }),
  });
  if (!r.ok) {
    const text = (await r.text()).slice(0, 200);
    return { ok: false, reason: `hub ${r.status}: ${text}` };
  }
  return { ok: true };
}

export async function publishHeartbeat(env: Env): Promise<{ ok: boolean; reason?: string }> {
  const tok = await refreshToken(env);
  if (!tok.token) return { ok: false, reason: tok.reason };

  const upstreamReady = !!(env.LLM_API_KEY ?? env.GEMINI_API_KEY);
  const r = await fetch(`${env.HUB_URL}/agents/me/state`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${tok.token}`,
    },
    body: JSON.stringify({ availability: { now: upstreamReady } }),
  });
  if (!r.ok) {
    const text = (await r.text()).slice(0, 200);
    return { ok: false, reason: `state ${r.status}: ${text}` };
  }
  return { ok: true };
}
