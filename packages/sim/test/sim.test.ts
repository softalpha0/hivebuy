import { clear, commitment } from '@hivebuy/core';
import { describe, expect, it } from 'vitest';
import { runSimulation, toJson } from '../src/index.js';

describe('simulation', () => {
  const run = runSimulation({ seed: 42, rounds: 12 });

  it('has 20 buyers and 5 sellers on their own sub-accounts', () => {
    expect(run.buyers).toHaveLength(20);
    expect(run.sellers).toHaveLength(5);
    expect(run.buyers[0]!.id).toBe('buyer-1.hivebuy.testnet');
    expect(run.sellers[4]!.id).toBe('seller-5.hivebuy.testnet');
    expect(new Set([...run.buyers, ...run.sellers].map((a) => a.id)).size).toBe(25);
  });

  it('is replayable: same seed gives the same run', () => {
    expect(toJson(runSimulation({ seed: 42, rounds: 12 }))).toEqual(toJson(run));
    expect(toJson(runSimulation({ seed: 43, rounds: 12 }))).not.toEqual(toJson(run));
  });

  it('every commitment matches its reveal', () => {
    for (const r of run.rounds) {
      for (const b of r.sellers) {
        expect(commitment(r.id, b.id, b.price, b.capacity, b.salt)).toBe(b.commitment);
      }
    }
  });

  it('every result equals the clearing rule applied to the revealed bids', () => {
    for (const r of run.rounds) {
      const again = clear(
        r.buyers.map((o) => ({ id: o.id, qty: o.qty, maxPrice: o.maxPrice })),
        r.sellers.filter((b) => b.revealed).map((b) => ({ id: b.id, price: b.price, capacity: b.capacity, commitIndex: b.commitIndex })),
      );
      expect(again).toEqual(r.result);
    }
  });

  it('conserves escrow in every round', () => {
    for (const r of run.rounds) {
      expect(r.stats.paidToProviders + r.stats.refunded).toBe(r.stats.escrowTotal);
    }
  });

  it('exercises the bond forfeit and clears most rounds', () => {
    expect(run.rounds.some((r) => r.forfeited.length > 0)).toBe(true);
    expect(run.rounds.filter((r) => r.result.status === 'cleared').length).toBeGreaterThan(6);
  });
});
