import type { Amount, Settlement } from '@hivebuy/core';
import type { SimRun } from '@hivebuy/sim';

/** One round, whatever its source (local simulation or a testnet contract). */
export interface ViewRound {
  id: number;
  unit: string;
  source: 'simulation' | 'testnet';
  phase: 'join' | 'commit' | 'reveal' | 'clearable' | 'cleared' | 'failed';
  buyers: { id: string; strategy?: string; qty: number; maxPrice: Amount; escrow: Amount }[];
  sellers: {
    id: string;
    strategy?: string;
    commitIndex: number;
    commitment: string;
    revealed: { price: Amount; capacity: number } | null;
  }[];
  result: { winner: string | null; price: Amount | null; demand: number; settlements: Settlement[] } | null;
  forfeited: string[];
}

export function fromSimulation(run: SimRun): ViewRound[] {
  return run.rounds.map((r) => ({
    id: r.id,
    unit: '1M tokens',
    source: 'simulation',
    phase: r.result.status,
    buyers: r.buyers.map((b) => ({ id: b.id, strategy: b.strategy, qty: b.qty, maxPrice: b.maxPrice, escrow: b.escrow })),
    sellers: r.sellers.map((s) => ({
      id: s.id,
      strategy: s.strategy,
      commitIndex: s.commitIndex,
      commitment: s.commitment,
      revealed: s.revealed ? { price: s.price, capacity: s.capacity } : null,
    })),
    result: {
      winner: r.result.winner,
      price: r.result.price,
      demand: r.result.demand,
      settlements: r.result.settlements,
    },
    forfeited: r.forfeited,
  }));
}
