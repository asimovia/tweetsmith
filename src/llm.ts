// Tweetsmith — LLM upstream (AG10).
//
// One provider, declared in `card.ts` agent_card.tags as `llm:gemini-flash`.
// Single env-var key (`LLM_API_KEY`); the provider is hard-coded here so
// callers don't have to guess shape. Gemini Flash is the pick: cheapest
// per-token of the three options (Gemini Flash / aimlapi / Haiku), and
// the agent's whole pitch is "deliberately cheap so it runs indefinitely".
//
// Falls back to a deterministic STUB tweet when `LLM_API_KEY` is unset
// so the wire still demos end-to-end (smoke tests, local `wrangler dev`)
// without exposing the eventual prod secret in repos.
//
// The tier char-cap is enforced HERE — hard truncate at the boundary.
// Done that way (not "ask the model to respect N chars") because LLMs
// routinely overshoot; honest truncation is the only correct behaviour
// from the buyer's POV.

import type { Env, Tier, Tone } from './types';

export const TIER_CHAR_CAP: Record<Tier, number> = {
  mini: 140,
  standard: 280,
  extended: 560,
  max: 1120,
};

export const LLM_PROVIDER_TAG = 'llm:gemini-flash';

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = (model: string, key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

export interface GenerateInput {
  prompt: string;
  tier: Tier;
  tone?: Tone;
  language?: string;
}

export interface GenerateOutput {
  tweet: string;
  char_count: number;
  stub: boolean;
}

export async function generateTweet(env: Env, input: GenerateInput): Promise<GenerateOutput> {
  const cap = TIER_CHAR_CAP[input.tier];
  const sys = buildSystemPrompt(input, cap);

  // Primary: AIML (centralized — one key, one balance). Falls back to
  // Gemini, then to a deterministic STUB so the wire always demos.
  if (env.AIML_API_KEY) {
    try {
      const raw = await callAIML(env, sys, input.prompt);
      const tweet = truncate(raw, cap);
      return { tweet, char_count: tweet.length, stub: false };
    } catch (e) {
      // fall through to Gemini / stub
      console.warn('[llm] aiml failed, falling back:', (e as Error).message);
    }
  }

  const apiKey = env.LLM_API_KEY ?? env.GEMINI_API_KEY;
  if (!apiKey) {
    const stubText = `STUB: would tweet '${input.prompt.slice(0, 40)}' at tier=${input.tier}`;
    const truncated = truncate(stubText, cap);
    return { tweet: truncated, char_count: truncated.length, stub: true };
  }

  const raw = await callGemini(apiKey, sys, input.prompt);
  const tweet = truncate(raw, cap);
  return { tweet, char_count: tweet.length, stub: false };
}

// AIML — OpenAI-compatible chat completions (centralized provider).
async function callAIML(env: Env, system: string, userPrompt: string): Promise<string> {
  const model = env.AIML_TEXT_MODEL || 'gpt-4o-mini';
  const r = await fetch('https://api.aimlapi.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AIML_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 400,
      temperature: 0.7,
    }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 200);
    throw new Error(`aiml ${r.status}: ${detail}`);
  }
  const body = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return (body.choices?.[0]?.message?.content ?? '').trim();
}

function buildSystemPrompt(input: GenerateInput, cap: number): string {
  const tone = input.tone ?? 'informational';
  const language = input.language ?? 'en';
  return [
    `You are Tweetsmith, a tweet-writing assistant.`,
    `Write ONE tweet (no quotes, no preamble, no hashtags unless natural).`,
    `Hard limit: ${cap} characters. Stay clearly under it.`,
    `Tone: ${tone}. Language: ${language}.`,
    `Return ONLY the tweet text — no JSON, no markdown, no commentary.`,
  ].join(' ');
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

async function callGemini(apiKey: string, system: string, userPrompt: string): Promise<string> {
  const r = await fetch(GEMINI_URL(GEMINI_MODEL, apiKey), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 400 },
    }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 200);
    throw new Error(`gemini ${r.status}: ${detail}`);
  }
  const body = (await r.json()) as GeminiResponse;
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return text.trim();
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  // Reserve 1 char for the ellipsis; never silent drop.
  return s.slice(0, Math.max(0, cap - 1)) + '…';
}
