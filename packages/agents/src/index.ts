/**
 * Agent brains: how a buyer turns its need into a bid, and how a seller picks its sealed price.
 *
 * Two brains share one interface:
 * - `scripted`: deterministic rules, no network (used by the simulation and as the fallback).
 * - `nearai`: a model on NEAR AI Cloud (OpenAI-compatible API) answers in a JSON schema. Every
 *   answer is validated here; an invalid answer is retried once with the validation error, and if
 *   it is still invalid (or the API fails) the agent falls back to the scripted rule and says so.
 *
 * Amounts are integers in the smallest USDC unit (6 decimals).
 */
import { type Amount, formatUsdc, parseUsdc } from '@hivebuy/core';

export const MIN_PRICE = 100_000n; // 0.10 USDC per unit
export const MAX_PRICE = 3_000_000n; // 3.00 USDC per unit
export const MAX_QTY = 20;

export interface BuyerProfile {
  id: string;
  /** Units (1M tokens) the buyer needs this round. */
  need: number;
  /** What one unit is worth to the buyer. */
  valuePerUnit: Amount;
  /** Most it will lock in escrow this round (also capped by its token balance). */
  budget: Amount;
}

export interface SellerProfile {
  id: string;
  /** Cost to serve one unit. */
  cost: Amount;
  /** Most units it can serve this round. */
  capacity: number;
}

export interface MarketContext {
  /** Clearing price of the previous round, if any. */
  lastPrice: Amount | null;
}

/**
 * What a provider is told before it bids (docs/MECHANISM.md).
 * - `full`: every public join and the previous clearing price.
 * - `minimal`: only the aggregate demand curve (units wanted at or above each price). No previous
 *   clearing price and no individual orders, so providers have less to coordinate on between rounds.
 */
export type InfoPolicy = 'full' | 'minimal';

export interface SellerContext extends MarketContext {
  /** Public joins of this round: what each buyer asked for. */
  demand: { qty: number; maxPrice: Amount }[];
  /** Default `full`. */
  info?: InfoPolicy;
}

/** "≥1.89: 4 units; ≥1.80: 10 units; …": units wanted at or above each distinct max price, highest first. */
export function demandCurve(demand: readonly { qty: number; maxPrice: Amount }[]): string {
  const prices = [...new Set(demand.map((d) => d.maxPrice))].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  return prices.map((p) => `≥${formatUsdc(p)}: ${demand.reduce((s, d) => (d.maxPrice >= p ? s + d.qty : s), 0)} units`).join('; ') || 'no buyers';
}

/** The context with what `info` hides removed, so no code path can leak it. */
function visible(ctx: SellerContext): SellerContext {
  return ctx.info === 'minimal' ? { ...ctx, lastPrice: null } : ctx;
}

export interface BuyerDecision {
  qty: number;
  maxPrice: Amount;
  reasoning: string;
  source: 'scripted' | 'ai' | 'fallback';
}

export interface SellerDecision {
  price: Amount;
  capacity: number;
  reasoning: string;
  source: 'scripted' | 'ai' | 'fallback';
}

export interface Brain {
  readonly name: string;
  buyer(profile: BuyerProfile, ctx: MarketContext): Promise<BuyerDecision>;
  seller(profile: SellerProfile, ctx: SellerContext): Promise<SellerDecision>;
}

// ---------- validation (shared by both brains) ----------

/** Checks a buyer bid against the profile; returns an error message or null. */
export function checkBuyer(p: BuyerProfile, qty: number, maxPrice: Amount): string | null {
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return `qty must be a whole number from 1 to ${MAX_QTY}`;
  if (maxPrice < MIN_PRICE || maxPrice > MAX_PRICE) return `max_price must be between ${formatUsdc(MIN_PRICE)} and ${formatUsdc(MAX_PRICE)}`;
  if (BigInt(qty) * maxPrice > p.budget) return `qty × max_price = ${formatUsdc(BigInt(qty) * maxPrice)} exceeds the budget ${formatUsdc(p.budget)}`;
  return null;
}

/** Checks a seller bid against the profile; returns an error message or null. */
export function checkSeller(p: SellerProfile, price: Amount, capacity: number): string | null {
  if (price < p.cost) return `price must be at least your cost ${formatUsdc(p.cost)}`;
  if (price > MAX_PRICE) return `price must be at most ${formatUsdc(MAX_PRICE)}`;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > p.capacity) return `capacity must be a whole number from 1 to ${p.capacity}`;
  return null;
}

/** Rounds down to whole cents. */
const cents = (a: Amount): Amount => (a / 10_000n) * 10_000n;

// ---------- scripted brain ----------

export const scripted: Brain = {
  name: 'scripted',
  async buyer(p, ctx) {
    // Bid up to the value, never more than the budget allows.
    let maxPrice = cents(p.valuePerUnit);
    if (maxPrice > MAX_PRICE) maxPrice = MAX_PRICE;
    if (maxPrice < MIN_PRICE) maxPrice = MIN_PRICE;
    const affordable = Number(p.budget / maxPrice);
    const qty = Math.max(1, Math.min(p.need, affordable, MAX_QTY));
    const last = ctx.lastPrice === null ? '' : `; last price ${formatUsdc(ctx.lastPrice)}`;
    return { qty, maxPrice, reasoning: `Bid my value ${formatUsdc(maxPrice)} for ${qty} units${last}`, source: 'scripted' };
  },
  async seller(p, fullCtx) {
    const ctx = visible(fullCtx);
    // Cost plus 30%, but undercut the last clearing price when that still covers cost.
    let price = cents((p.cost * 130n) / 100n);
    if (ctx.lastPrice !== null && ctx.lastPrice - 10_000n >= p.cost && ctx.lastPrice - 10_000n < price) price = ctx.lastPrice - 10_000n;
    if (price > MAX_PRICE) price = MAX_PRICE;
    return { price, capacity: p.capacity, reasoning: `Cost ${formatUsdc(p.cost)} plus margin → ${formatUsdc(price)}`, source: 'scripted' };
  },
};

// ---------- NEAR AI brain ----------

export interface NearAiOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Base delay between retries (doubles each time). */
  backoffMs?: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

export const DEFAULT_MODEL = 'z-ai/glm-5.3-flash';
export const DEFAULT_BASE_URL = 'https://cloud-api.near.ai/v1';

const BUYER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['qty', 'max_price', 'reasoning'],
  properties: {
    qty: { type: 'integer', description: 'Units (1M tokens each) to request' },
    max_price: { type: 'string', description: 'Highest USDC price per unit, like "1.25"' },
    reasoning: { type: 'string', maxLength: 240, description: 'One short sentence, at most 15 words' },
  },
};

const SELLER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['price', 'capacity', 'reasoning'],
  properties: {
    price: { type: 'string', description: 'Sealed USDC price per unit, like "1.10"' },
    capacity: { type: 'integer', description: 'Units you offer' },
    reasoning: { type: 'string', maxLength: 240, description: 'One short sentence, at most 15 words' },
  },
};

const RULES_SUMMARY =
  'Hivebuy market rules: buyers join with (qty, max_price) and lock qty × max_price USDC. Sellers submit sealed (price, capacity). ' +
  'The contract tries candidate prices (every seller price and every buyer max_price), cheapest first. It stops at the first price where the sellers asking that much or less ' +
  'can together supply every unit wanted by buyers whose max_price >= that price. Units go to the cheapest sellers first, so several sellers can win, ' +
  'and every winner is paid the same clearing price for each unit it sells. ' +
  'Each included buyer pays qty × clearing price and gets the rest of its escrow back. Excluded buyers get everything back. ' +
  'Answer only with the JSON object. Keep "reasoning" to one plain, complete sentence of at most 15 words.';

export class NearAiError extends Error {}

export class NearAiClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly opts: NearAiOptions) {
    if (!opts.apiKey) throw new NearAiError('NEARAI_API_KEY is not set');
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.backoffMs = opts.backoffMs ?? 500;
    this.fetcher = opts.fetch ?? fetch;
  }

  /** Confirms the API key with a tiny request (a few tokens). Throws NearAiError if the key is rejected. */
  async check(): Promise<void> {
    const res = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 5, reasoning_effort: 'low' }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 401 || res.status === 403) throw new NearAiError('NEAR AI rejected the API key (check NEARAI_API_KEY)');
    if (res.status === 402) throw new NearAiError('NEAR AI says the account has no credits left');
    if (!res.ok) throw new NearAiError(`NEAR AI answered ${res.status} to a test request; try again in a minute`);
  }

  /** One chat completion constrained to a JSON schema. Retries network/5xx errors with backoff. */
  async json(name: string, schema: object, system: string, user: string): Promise<Record<string, unknown>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, this.backoffMs * 2 ** (attempt - 1)));
      try {
        const res = await this.fetcher(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
            // GLM-5.3 Flash reasons by default; cap it to keep each decision cheap (docs: reasoning-models).
            thinking_token_budget: 256,
            max_tokens: 600,
            temperature: 0.4,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 401 || res.status === 403) throw new NearAiError('NEAR AI rejected the API key (check NEARAI_API_KEY)');
        if (!res.ok) throw new Error(`NEAR AI answered ${res.status}`);
        const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = body.choices?.[0]?.message?.content;
        if (!content) throw new Error('NEAR AI returned no content');
        return JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '')) as Record<string, unknown>;
      } catch (e) {
        if (e instanceof NearAiError) throw e;
        lastError = e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function asPrice(v: unknown): Amount | null {
  try {
    return typeof v === 'string' || typeof v === 'number' ? parseUsdc(String(v)) : null;
  } catch {
    return null;
  }
}

/** One line, at most `max` characters, cut at a word boundary with an ellipsis if needed. */
export function shortText(v: unknown, max = 120): string {
  if (typeof v !== 'string') return '';
  const t = v.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/** Asks the model, validates, retries once with the error, then falls back to the scripted rule. */
async function decide<T>(
  ask: (feedback: string) => Promise<Record<string, unknown>>,
  parse: (raw: Record<string, unknown>) => { value: T } | { error: string },
  fallback: () => Promise<T & { reasoning: string; source: string }>,
): Promise<T & { reasoning: string; source: 'ai' | 'fallback' | 'scripted' }> {
  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed = parse(await ask(feedback));
      if ('value' in parsed) return { ...parsed.value, source: 'ai' } as T & { reasoning: string; source: 'ai' };
      feedback = `\nYour previous answer was invalid: ${parsed.error}. Answer again within the limits.`;
    } catch (e) {
      if (e instanceof NearAiError) throw e;
      feedback = '';
      if (attempt === 1) break;
    }
  }
  const fb = await fallback();
  return { ...fb, reasoning: `AI answer unusable, used the scripted rule: ${fb.reasoning}`, source: 'fallback' } as T & {
    reasoning: string;
    source: 'fallback';
  };
}

export function nearAiBrain(client: NearAiClient): Brain {
  return {
    name: `nearai:${client.model}`,
    buyer(p, ctx) {
      const user =
        `You are buyer agent ${p.id}. You need ${p.need} units this round. One unit is worth ${formatUsdc(p.valuePerUnit)} USDC to you. ` +
        `Your budget for qty × max_price is ${formatUsdc(p.budget)} USDC. ` +
        (ctx.lastPrice === null ? 'There is no previous clearing price. ' : `The previous round cleared at ${formatUsdc(ctx.lastPrice)} USDC. `) +
        `Choose qty (1-${MAX_QTY}) and max_price. A higher max_price makes you more likely to be included; you never pay more than the clearing price.`;
      return decide<{ qty: number; maxPrice: Amount; reasoning: string }>(
        (feedback) => client.json('buyer_bid', BUYER_SCHEMA, RULES_SUMMARY, user + feedback),
        (raw) => {
          const qty = Number(raw.qty);
          const maxPrice = asPrice(raw.max_price);
          if (maxPrice === null) return { error: 'max_price must be a USDC amount like "1.25"' };
          const err = checkBuyer(p, qty, maxPrice);
          return err ? { error: err } : { value: { qty, maxPrice, reasoning: shortText(raw.reasoning) } };
        },
        () => scripted.buyer(p, ctx),
      );
    },
    seller(p, fullCtx) {
      const ctx = visible(fullCtx);
      const total = ctx.demand.reduce((s, d) => s + d.qty, 0);
      const book =
        ctx.info === 'minimal'
          ? `units wanted at or above each price: ${demandCurve(ctx.demand)}`
          : ctx.demand.map((d) => `${d.qty} units up to ${formatUsdc(d.maxPrice)}`).join('; ') || 'no buyers';
      const user =
        `You are provider agent ${p.id}. Your cost is ${formatUsdc(p.cost)} USDC per unit and you can serve at most ${p.capacity} units. ` +
        `This round's public demand (${total} units): ${book}. ` +
        (ctx.lastPrice === null ? '' : `The previous round cleared at ${formatUsdc(ctx.lastPrice)} USDC. `) +
        'Other providers bid sealed prices too. Choose your sealed price (at least your cost) and capacity to maximise expected profit.';
      return decide<{ price: Amount; capacity: number; reasoning: string }>(
        (feedback) => client.json('seller_bid', SELLER_SCHEMA, RULES_SUMMARY, user + feedback),
        (raw) => {
          const price = asPrice(raw.price);
          const capacity = Number(raw.capacity);
          if (price === null) return { error: 'price must be a USDC amount like "1.10"' };
          const err = checkSeller(p, price, capacity);
          return err ? { error: err } : { value: { price: cents(price), capacity, reasoning: shortText(raw.reasoning) } };
        },
        () => scripted.seller(p, ctx),
      );
    },
  };
}
