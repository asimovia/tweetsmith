// Tweetsmith — Cloudflare Worker bindings.

export interface Env {
  CACHE: KVNamespace;
  X402_NONCES: KVNamespace;
  X402_PAID_SIGS: KVNamespace;

  // vars (wrangler.toml [vars])
  HUB_URL: string;
  ORACLE_URL: string;
  AGENT_ID: string;
  PUBLIC_ENDPOINT: string;
  SOLANA_NETWORK: string;
  PAYMENT_NETWORK: string;
  SOLANA_RPC: string;
  TWEETSMITH_WALLET_PUBKEY: string;
  PAYMENT_ADDRESS: string;
  PRICE_MINI: string;
  PRICE_STANDARD: string;
  PRICE_EXTENDED: string;
  PRICE_MAX: string;
  PRICE_LAMPORTS: string;
  FREE_DAILY_CAP?: string;          // AG10 — default 3 if unset
  LAMPORTS_PER_CREDIT?: string;     // AG12 — default 100000 if unset (1 credit = 0.0001 SOL)

  // Identity + agent-using-agent demo (AG14).
  API_URL?: string;                 // reputation bureau base (default api.meshkore.com)
  IMAGE_AGENT_URL?: string;         // OUR image agent's live endpoint (the supplier)
  IMAGE_AGENT_ID?: string;          // its slug, for the reputation report target
  IMAGE_AGENT_API_KEY?: string;     // prepaid deposit key Tweetsmith holds with it (secret)

  AIML_TEXT_MODEL?: string;         // AIML chat model (default gpt-4o-mini)

  // secrets — wired up by AG8-AG11 + AG14.
  AIML_API_KEY?: string;            // primary text provider (centralized, one balance)
  LLM_API_KEY?: string;             // AG10 (Gemini fallback)
  GEMINI_API_KEY?: string;          // AG10 (legacy alias — fall-back only)
  SOLANA_PRIVATE_KEY?: string;      // AG8  (wallet — JSON array secret-key)
  IDENTITY_JWK?: string;            // AG14 (Tweetsmith's OWN Ed25519 identity key, JWK)
  HUB_TOKEN?: string;               // AG11
  HUB_API_KEY?: string;             // AG11
}

// ─── Skill request shape ──────────────────────────────────────────────

export type Tier = 'mini' | 'standard' | 'extended' | 'max';
export type Tone = 'professional' | 'casual' | 'viral' | 'informational';

export interface GenerateTweetRequest {
  prompt: string;
  tier: Tier;
  tone?: Tone;
  language?: string;
}

export interface GenerateTweetResponse {
  tweet: string;
  char_count: number;
  tier_paid: Tier;
  tx_proof: string;
}
