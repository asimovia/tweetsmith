// Tweetsmith files SIGNED reputation on its supplier.
//
// After hiring the image agent, Tweetsmith reports the outcome to the
// MeshKore reputation bureau (api.meshkore.com). The report is signed
// with Tweetsmith's identity key (MeshKore-Sig), so it counts as a real,
// attributable, non-self rating — exactly the agent-by-agent reputation
// the trust layer is built on (see agent-reputation.md).

import type { Env } from './types';
import type { Signer } from './mksign';

export interface FeedbackInput {
  success: boolean;
  latency_ms: number;
  quality?: number;       // 1..5, optional
  paid: boolean;
  disputed?: boolean;
  capability?: string;
}

export interface FeedbackResult {
  ok: boolean;
  score?: number;
  dims?: Record<string, number>;
  error?: string;
}

export async function fileFeedback(
  env: Env, signer: Signer | null, targetId: string, fb: FeedbackInput,
): Promise<FeedbackResult> {
  if (!signer) return { ok: false, error: 'IDENTITY_JWK unset — signed feedback skipped' };
  if (!targetId) return { ok: false, error: 'IMAGE_AGENT_ID unset' };

  const apiBase = (env.API_URL || 'https://api.meshkore.com').replace(/\/$/, '');
  const path = `/v1/agents/${encodeURIComponent(targetId)}/feedback`;
  const bodyText = JSON.stringify(fb);

  let res: Response;
  try {
    const sig = await signer.header('POST', path, bodyText);
    res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'MeshKore-Sig': sig },
      body: bodyText,
    });
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}`.slice(0, 160) };
  }

  if (!res.ok) {
    return { ok: false, error: `bureau ${res.status}: ${(await res.text()).slice(0, 120)}` };
  }
  const j = (await res.json()) as { reputation?: { score?: number } & Record<string, number> };
  const rep = j.reputation ?? {};
  return {
    ok: true,
    score: typeof rep.score === 'number' ? rep.score : undefined,
    dims: {
      reliability: rep.reliability as number,
      speed: rep.speed as number,
      quality: rep.quality as number,
      settlement: rep.settlement as number,
    },
  };
}
