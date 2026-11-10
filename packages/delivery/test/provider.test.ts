import { KeyPair } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { checkReceipt, redeemMessage, sign, signVoucher } from '../src/index.js';
import { type ChainRound, type ProviderDeps, handleProvider, unitsSold } from '../src/provider.js';

const C = 'market.hivebuy.testnet';
const NOW = 1_800_000_000_000;
const key = () => KeyPair.fromRandom('ed25519').toString() as KeyPairString;
const s1 = key();
const s2 = key();
const buyerA = key();
const pkOf = (k: KeyPairString) => KeyPair.fromString(k).getPublicKey().toString();

/** RULES.md worked example: s1 sells 20 (a 10, b 10), s2 sells 5 (b 5), c is out. */
const round: ChainRound = {
  id: 1,
  status: 'Cleared',
  buyers: [
    { account_id: 'a', qty: 10, max_price: '2000000' },
    { account_id: 'b', qty: 15, max_price: '1500000' },
    { account_id: 'c', qty: 20, max_price: '1200000' },
  ],
  outcome: { price: '1400000', cleared_at: String(BigInt(NOW - 60_000) * 1_000_000n) },
  fills: [
    { account_id: 's1', units: 20, payout: '28000000' },
    { account_id: 's2', units: 5, payout: '7000000' },
  ],
  deliveries: [],
};

function deps(over: Partial<ProviderDeps> = {}) {
  const posted: { seller: string; buyer: string; hash: string }[] = [];
  let inferCalls = 0;
  const d: ProviderDeps = {
    contract: C,
    sellerKeys: { s1, s2 },
    getRound: async (id) => (id === 1 ? structuredClone(round) : null),
    hasAccessKey: async (account, pk) => account === 'a' && pk === pkOf(buyerA),
    infer: async () => {
      inferCalls++;
      return { model: 'z-ai/glm-5.3-flash', completion: 'NEAR is a layer-1 blockchain.', promptTokens: 14, completionTokens: 9 };
    },
    postDelivery: async (seller, _k, _r, buyer, hash) => {
      posted.push({ seller, buyer, hash });
      return { tx: 'TX123' };
    },
    now: () => NOW,
    ...over,
  };
  return { d, posted, calls: () => inferCalls };
}

async function voucherFor(d: ProviderDeps, seller = 's1', buyer = 'a') {
  return handleProvider({ action: 'voucher', seller, round_id: 1, buyer }, d);
}

function redeemBody(sv: unknown, prompt = 'What is NEAR?', k = buyerA) {
  const voucher = (sv as { voucher: { nonce: string } }).voucher;
  const s = sign(k, redeemMessage(voucher.nonce, prompt));
  return { action: 'redeem', voucher: sv, prompt, buyer_public_key: s.public_key, buyer_signature: s.signature };
}

describe('provider endpoint: vouchers', () => {
  it('issues a voucher for exactly the units the seller sold that buyer', async () => {
    expect(unitsSold(round, 's1', 'b')).toBe(10);
    expect(unitsSold(round, 's2', 'b')).toBe(5);
    const { d } = deps();
    const r = await voucherFor(d, 's2', 'b');
    expect(r.status).toBe(200);
    expect((r.body.voucher as { voucher: { units: number } }).voucher.units).toBe(5);
  });

  it('refuses unknown sellers, uncleared or old rounds, buyers it did not sell to, and delivered pairs', async () => {
    const { d } = deps();
    expect((await voucherFor(d, 'stranger', 'a')).status).toBe(404);
    expect((await voucherFor(d, 's2', 'a')).status).toBe(403);
    expect((await voucherFor(d, 's1', 'c')).status).toBe(403);
    expect((await handleProvider({ action: 'voucher', seller: 's1', round_id: 2, buyer: 'a' }, d)).status).toBe(409);
    const old = deps({ now: () => NOW + 8 * 24 * 3600 * 1000 });
    expect((await voucherFor(old.d)).status).toBe(409);
    const done = deps({ getRound: async () => ({ ...structuredClone(round), deliveries: [{ seller: 's1', buyer: 'a' }] }) });
    expect((await voucherFor(done.d)).status).toBe(409);
  });
});

describe('provider endpoint: redemption', () => {
  it('makes one inference call, posts the receipt hash on-chain, and the buyer can verify it', async () => {
    const { d, posted, calls } = deps();
    const sv = (await voucherFor(d)).body.voucher;
    const r = await handleProvider(redeemBody(sv), d);
    expect(r.status).toBe(200);
    expect(calls()).toBe(1);
    expect(posted).toEqual([{ seller: 's1', buyer: 'a', hash: r.body.receipt_hash }]);
    const ok = checkReceipt(r.body.receipt as never, r.body.receipt_hash as string, sv as never, 'What is NEAR?', r.body.completion as string);
    expect(ok).toBeNull();
  });

  it('refuses forged vouchers, wrong buyer keys, long prompts and replays, without calling the model', async () => {
    const { d, calls } = deps();
    const sv = (await voucherFor(d)).body.voucher as { voucher: Record<string, unknown> };
    // A voucher re-signed by another key, or edited after signing.
    const forged = signVoucher(s2, sv.voucher as never);
    expect((await handleProvider(redeemBody(forged), d)).status).toBe(403);
    expect((await handleProvider(redeemBody({ ...sv, voucher: { ...sv.voucher, units: 999 } }), d)).status).toBe(403);
    // Signed by a key that is not one of the buyer's on-chain keys.
    expect((await handleProvider(redeemBody(sv, 'What is NEAR?', key()), d)).status).toBe(403);
    // Signature over a different prompt.
    const body = redeemBody(sv, 'What is NEAR?');
    expect((await handleProvider({ ...body, prompt: 'Something else' }, d)).status).toBe(403);
    expect((await handleProvider(redeemBody(sv, 'x'.repeat(501)), d)).status).toBe(400);
    // Expired.
    const late = deps({ now: () => NOW + 2 * 3600 * 1000 });
    expect((await handleProvider(redeemBody(sv), late.d)).status).toBe(403);
    // Already delivered on-chain.
    const done = deps({ getRound: async () => ({ ...structuredClone(round), deliveries: [{ seller: 's1', buyer: 'a' }] }) });
    expect((await handleProvider(redeemBody(sv), done.d)).status).toBe(409);
    expect(calls() + late.calls() + done.calls()).toBe(0);
  });

  it('rejects anything that is not a known action', async () => {
    const { d } = deps();
    expect((await handleProvider({ action: 'drain' }, d)).status).toBe(400);
    expect((await handleProvider(null, d)).status).toBe(400);
  });
});
