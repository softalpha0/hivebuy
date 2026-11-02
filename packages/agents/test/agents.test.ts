import { describe, expect, it } from 'vitest';
import {
  type BuyerProfile,
  NearAiClient,
  type SellerProfile,
  checkBuyer,
  checkSeller,
  nearAiBrain,
  scripted,
} from '../src/index.js';

const buyer: BuyerProfile = { id: 'buyer-1', need: 6, valuePerUnit: 1_500_000n, budget: 8_000_000n };
const seller: SellerProfile = { id: 'seller-1', cost: 900_000n, capacity: 40 };

/** A fake NEAR AI endpoint that returns the given answers in order and records each request. */
function fakeApi(answers: (object | string | number)[]) {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    const next = answers.shift();
    if (typeof next === 'number') return new Response('error', { status: next });
    const content = typeof next === 'string' ? next : JSON.stringify(next);
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as typeof fetch;
  return { requests, client: new NearAiClient({ apiKey: 'test-key', fetch: fetcher, backoffMs: 1 }) };
}

describe('validation', () => {
  it('rejects bids over budget, out-of-range quantities and prices below cost', () => {
    expect(checkBuyer(buyer, 6, 1_500_000n)).toMatch(/exceeds the budget/);
    expect(checkBuyer(buyer, 5, 1_500_000n)).toBeNull();
    expect(checkBuyer(buyer, 0, 1_000_000n)).toMatch(/qty/);
    expect(checkSeller(seller, 800_000n, 10)).toMatch(/at least your cost/);
    expect(checkSeller(seller, 1_000_000n, 41)).toMatch(/capacity/);
    expect(checkSeller(seller, 1_000_000n, 40)).toBeNull();
  });
});

describe('scripted brain', () => {
  it('stays within budget and above cost', async () => {
    const b = await scripted.buyer(buyer, { lastPrice: null });
    expect(checkBuyer(buyer, b.qty, b.maxPrice)).toBeNull();
    const s = await scripted.seller(seller, { lastPrice: 1_100_000n, demand: [] });
    expect(checkSeller(seller, s.price, s.capacity)).toBeNull();
    expect(s.price).toBe(1_090_000n); // undercuts the last price by a cent
  });
});

describe('NEAR AI brain', () => {
  it('uses a valid AI bid and sends a JSON-schema request to the chat endpoint', async () => {
    const { client, requests } = fakeApi([{ qty: 5, max_price: '1.40', reasoning: 'Five units fit my budget.' }]);
    const d = await nearAiBrain(client).buyer(buyer, { lastPrice: null });
    expect(d).toMatchObject({ qty: 5, maxPrice: 1_400_000n, source: 'ai', reasoning: 'Five units fit my budget.' });
    expect(requests[0]!.url).toBe('https://cloud-api.near.ai/v1/chat/completions');
    expect(requests[0]!.body.model).toBe('z-ai/glm-5.3-flash');
    expect((requests[0]!.body.response_format as { type: string }).type).toBe('json_schema');
  });

  it('retries once with the validation error, then accepts the corrected answer', async () => {
    const { client, requests } = fakeApi([
      { qty: 6, max_price: '1.50', reasoning: 'all of it' },
      { qty: 5, max_price: '1.50', reasoning: 'trimmed to budget' },
    ]);
    const d = await nearAiBrain(client).buyer(buyer, { lastPrice: null });
    expect(d).toMatchObject({ qty: 5, source: 'ai' });
    const secondPrompt = (requests[1]!.body.messages as { content: string }[])[1]!.content;
    expect(secondPrompt).toMatch(/exceeds the budget/);
  });

  it('falls back to the scripted rule when the model keeps breaking the rules', async () => {
    const { client } = fakeApi([
      { price: '0.10', capacity: 40, reasoning: 'cheap' },
      { price: '0.20', capacity: 40, reasoning: 'still cheap' },
    ]);
    const d = await nearAiBrain(client).seller(seller, { lastPrice: null, demand: [{ qty: 10, maxPrice: 1_500_000n }] });
    expect(d.source).toBe('fallback');
    expect(checkSeller(seller, d.price, d.capacity)).toBeNull();
  });

  it('falls back when the API keeps failing, but surfaces a bad API key', async () => {
    const { client } = fakeApi([500, 500, 500, 500, 500, 500]);
    expect((await nearAiBrain(client).buyer(buyer, { lastPrice: null })).source).toBe('fallback');
    const bad = fakeApi([401]);
    await expect(nearAiBrain(bad.client).buyer(buyer, { lastPrice: null })).rejects.toThrow(/API key/);
  });

  it('check() accepts a working key and rejects a bad one', async () => {
    await expect(fakeApi([{ ok: true }]).client.check()).resolves.toBeUndefined();
    await expect(fakeApi([401]).client.check()).rejects.toThrow(/API key/);
    await expect(fakeApi([402]).client.check()).rejects.toThrow(/credits/);
  });

  it('refuses to start without an API key', () => {
    expect(() => new NearAiClient({ apiKey: '' })).toThrow(/NEARAI_API_KEY/);
  });
});
