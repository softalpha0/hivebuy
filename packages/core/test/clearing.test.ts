import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bondShares, clear, commitment, escrowFor, explainClear, formatNear, formatUsdc, parseUsdc, payments } from '../src/index.js';

interface Vectors {
  commitments: {
    name: string;
    round_id: number;
    seller_id: string;
    price: string;
    capacity: number;
    salt: string;
    expected: string;
  }[];
  clearing: {
    name: string;
    buyers: { id: string; qty: number; max_price: string }[];
    sellers: { id: string; price: string; capacity: number; commit_index: number }[];
    expected: {
      status: 'cleared' | 'failed';
      price: string | null;
      demand: number;
      price_set_by: string | null;
      fills: { id: string; units: number; payout: string }[];
      payments: { buyer: string; seller: string; units: number; amount: string }[];
      settlements: { id: string; included: boolean; pay: string; refund: string }[];
    };
  }[];
}

const vectors: Vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/clearing-vectors.json', import.meta.url)), 'utf8'),
);

describe('commitment hash (shared vectors)', () => {
  for (const v of vectors.commitments) {
    it(v.name, () => {
      expect(commitment(v.round_id, v.seller_id, BigInt(v.price), v.capacity, v.salt)).toBe(v.expected);
    });
  }
});

describe('commitment salt (RULES.md section 3)', () => {
  it('accepts 1-64 characters and rejects the rest, like the contract', () => {
    expect(commitment(1, 's.testnet', 1n, 1, 'a'.repeat(64))).toHaveLength(64);
    expect(commitment(1, 's.testnet', 1n, 1, 'é'.repeat(64))).toHaveLength(64);
    expect(() => commitment(1, 's.testnet', 1n, 1, 'a'.repeat(65))).toThrow(/1-64/);
    expect(() => commitment(1, 's.testnet', 1n, 1, '')).toThrow(/1-64/);
  });
});

describe('clearing rule (shared vectors)', () => {
  for (const v of vectors.clearing) {
    it(v.name, () => {
      const result = clear(
        v.buyers.map((b) => ({ id: b.id, qty: b.qty, maxPrice: BigInt(b.max_price) })),
        v.sellers.map((s) => ({ id: s.id, price: BigInt(s.price), capacity: s.capacity, commitIndex: s.commit_index })),
      );
      expect(result.status).toBe(v.expected.status);
      expect(result.price === null ? null : result.price.toString()).toBe(v.expected.price);
      expect(result.demand).toBe(v.expected.demand);
      expect(result.priceSetBy).toBe(v.expected.price_set_by);
      expect(result.fills.map((f) => ({ id: f.id, units: f.units, payout: f.payout.toString() }))).toEqual(v.expected.fills);
      const buyers = v.buyers.map((b) => ({ id: b.id, qty: b.qty, maxPrice: BigInt(b.max_price) }));
      expect(payments(buyers, result).map((p) => ({ ...p, amount: p.amount.toString() }))).toEqual(v.expected.payments);
      expect(
        result.settlements.map((s) => ({ id: s.id, included: s.included, pay: s.pay.toString(), refund: s.refund.toString() })),
      ).toEqual(v.expected.settlements);
    });
  }
});

describe('settlement invariants', () => {
  it('pay + refund always equals escrow, and providers receive exactly what buyers pay', () => {
    const buyers = Array.from({ length: 20 }, (_, i) => ({
      id: `b${i}`,
      qty: 1 + (i % 7),
      maxPrice: BigInt(900_000 + i * 37_000),
    }));
    const bids = [
      { id: 's0', price: 1_100_000n, capacity: 30, commitIndex: 0 },
      { id: 's1', price: 1_250_000n, capacity: 80, commitIndex: 1 },
    ];
    const result = clear(buyers, bids);
    expect(result.status).toBe('cleared');
    for (const s of result.settlements) {
      const buyer = buyers.find((b) => b.id === s.id)!;
      expect(s.pay + s.refund).toBe(escrowFor(buyer));
      expect(s.refund >= 0n).toBe(true);
    }
    if (result.status !== 'cleared') return;
    const paid = result.settlements.reduce((a, s) => a + s.pay, 0n);
    expect(result.fills.reduce((a, f) => a + f.payout, 0n)).toBe(paid);
    expect(result.fills.reduce((a, f) => a + f.units, 0)).toBe(result.demand);
  });

  it('never charges more than the one-winner rule did, on 2,000 random rounds', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 2000; n++) {
      const buyers = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) => ({
        id: `b${i}`,
        qty: 1 + Math.floor(rnd() * 10),
        maxPrice: BigInt(800_000 + Math.floor(rnd() * 800_000)),
      }));
      const bids = Array.from({ length: Math.floor(rnd() * 5) }, (_, i) => ({
        id: `s${i}`,
        price: BigInt(800_000 + Math.floor(rnd() * 8) * 100_000),
        capacity: 1 + Math.floor(rnd() * 30),
        commitIndex: i,
      }));
      const result = clear(buyers, bids);
      // Never worse than trying only provider asks, nor than the one-winner rule.
      // Old rule: the cheapest single provider that can serve everyone at its own ask.
      const single = [...bids]
        .sort((a, b) => (a.price === b.price ? a.commitIndex - b.commitIndex : a.price < b.price ? -1 : 1))
        .find((b) => {
          const d = buyers.reduce((s, x) => (x.maxPrice >= b.price ? s + x.qty : s), 0);
          return d > 0 && b.capacity >= d;
        });
      if (single) {
        expect(result.status).toBe('cleared');
        expect(result.price! <= single.price).toBe(true);
      }
      if (result.status === 'cleared') {
        for (const f of result.fills) expect(f.units <= bids.find((b) => b.id === f.id)!.capacity).toBe(true);
        expect(result.fills.reduce((a, f) => a + f.units, 0)).toBe(result.demand);
      }
    }
  });
});

describe('explainClear', () => {
  it('traces the worked example and agrees with clear()', () => {
    const v = vectors.clearing[0]!; // two providers split the order
    const buyers = v.buyers.map((b) => ({ id: b.id, qty: b.qty, maxPrice: BigInt(b.max_price) }));
    const bids = v.sellers.map((s) => ({ id: s.id, price: BigInt(s.price), capacity: s.capacity, commitIndex: s.commit_index }));
    const steps = explainClear(buyers, bids);
    expect(steps.map((s) => [s.id, s.kind, s.demand, s.supply, s.outcome])).toEqual([
      ['s1', 'ask', 45, 20, 'not-enough-capacity'],
      ['c', 'max', 45, 20, 'not-enough-capacity'],
      ['s2', 'ask', 25, 35, 'clears'],
    ]);
    expect(steps.at(-1)!.id).toBe(clear(buyers, bids).priceSetBy);
  });
});

describe('payments', () => {
  it('splits buyers across providers so both sides reconcile, for every shared vector', () => {
    for (const v of vectors.clearing) {
      const buyers = v.buyers.map((b) => ({ id: b.id, qty: b.qty, maxPrice: BigInt(b.max_price) }));
      const bids = v.sellers.map((s) => ({ id: s.id, price: BigInt(s.price), capacity: s.capacity, commitIndex: s.commit_index }));
      const result = clear(buyers, bids);
      const pays = payments(buyers, result);
      for (const st of result.settlements) {
        expect(pays.filter((p) => p.buyer === st.id).reduce((a, p) => a + p.amount, 0n), v.name).toBe(st.pay);
      }
      for (const f of result.fills) {
        expect(pays.filter((p) => p.seller === f.id).reduce((a, p) => a + p.amount, 0n), v.name).toBe(f.payout);
      }
    }
  });
});

describe('bond shares', () => {
  it('splits by units like the contract, dust to the treasury', () => {
    const bond = 100_000_000_000_000_000_000_000n; // 0.1 NEAR
    expect(bondShares([1, 2], bond)).toEqual({ shares: [bond / 3n, (bond * 2n) / 3n], dust: bond - bond / 3n - (bond * 2n) / 3n });
    expect(bondShares([1, 1, 1], 10n)).toEqual({ shares: [3n, 3n, 3n], dust: 1n });
    expect(bondShares([], 5n)).toEqual({ shares: [], dust: 5n });
    expect(formatNear(bond / 3n)).toBe('0.033');
  });
});

describe('USDC formatting', () => {
  it('round-trips', () => {
    expect(formatUsdc(1_400_000n)).toBe('1.40');
    expect(formatUsdc(500_000n, 6)).toBe('0.500000');
    expect(parseUsdc('1.4')).toBe(1_400_000n);
    expect(parseUsdc('12')).toBe(12_000_000n);
    expect(() => parseUsdc('1.0000001')).toThrow();
  });
});
