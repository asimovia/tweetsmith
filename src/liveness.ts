// tweetsmith — unified-API liveness (api.meshkore.com).
//
// The unified API marks an agent online only via a live mesh WebSocket, which a
// serverless Worker can't cheaply hold. So we use the HTTP heartbeat: mint a JWT
// by SIGNING the token request with our own IDENTITY_JWK (self-sovereign — no
// shared api_key), then POST /v1/agents/me/heartbeat. Folded into the existing
// */5 cron → zero new cron slots. Stub-and-flag when API_URL / IDENTITY_JWK are
// absent. Reuses this agent's own loadSigner (mksign.ts); same MeshKore-Sig
// format as the partner reference agents.

import type { Env } from './types';
import { loadSigner } from './mksign';

export async function heartbeatUnified(env: Env): Promise<{ ok: boolean; reason?: string }> {
  const base = (env.API_URL || 'https://api.meshkore.com').replace(/\/$/, '');
  const signer = await loadSigner(env);
  if (!signer) return { ok: false, reason: 'no IDENTITY_JWK — cannot sign token exchange' };

  const tokenPath = '/v1/agents/token';
  const body = JSON.stringify({ agent_id: env.AGENT_ID });
  const sig = await signer.header('POST', tokenPath, body);
  const tr = await fetch(`${base}${tokenPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'MeshKore-Sig': sig },
    body,
  });
  if (!tr.ok) return { ok: false, reason: `token ${tr.status}: ${(await tr.text()).slice(0, 160)}` };
  const tok = (await tr.json()) as { token?: string };
  if (!tok.token) return { ok: false, reason: 'no token in response' };

  const hr = await fetch(`${base}/v1/agents/me/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.token}` },
  });
  if (!hr.ok) return { ok: false, reason: `heartbeat ${hr.status}: ${(await hr.text()).slice(0, 160)}` };
  return { ok: true };
}
