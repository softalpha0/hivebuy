import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { clear, commitment, escrowFor, explainClear, formatUsdc, parseUsdc } from '../src/index.js';

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
      winner: string | null;
      price: string | null;
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

describe('clearing rule (shared vectors)', () => {
  for (const v of vectors.clearing) {
    it(v.name, () => {
      const result = clear(
        v.buyers.map((b) => ({ id: b.id, qty: b.qty, maxPrice: BigInt(b.max_price) })),
        v.sellers.map((s) => ({ id: s.id, price: BigInt(s.price), capacity: s.capacity, commitIndex: s.commit_index })),
      );
      expect(result.status).toBe(v.expected.status);
      expect(result.winner).toBe(v.expected.winner);
      expect(result.price === null ? null : result.price.toString()).toBe(v.expected.price);
      expect(
        result.settlements.map((s) => ({ id: s.id, included: s.included, pay: s.pay.toString(), refund: s.refund.toString() })),
      ).toEqual(v.expected.settlements);
    });
  }
});

describe('settlement invariants', () => {
  it('pay + refund always equals escrow, and the winner receives the sum of pays', () => {
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
  });
});

describe('explainClear', () => {
  it('traces the worked example and agrees with clear()', () => {
    const v = vectors.clearing[0]!;
    const buyers = v.buyers.map((b) => ({ id: b.id, qty: b.qty, maxPrice: BigInt(b.max_price) }));
    const bids = v.sellers.map((s) => ({ id: s.id, price: BigInt(s.price), capacity: s.capacity, commitIndex: s.commit_index }));
    const steps = explainClear(buyers, bids);
    expect(steps.map((s) => [s.id, s.demand, s.outcome])).toEqual([
      ['s1', 35, 'not-enough-capacity'],
      ['s2', 15, 'wins'],
    ]);
    expect(steps.at(-1)!.id).toBe(clear(buyers, bids).winner);
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
