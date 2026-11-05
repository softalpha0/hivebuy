import type { Amount, Fill, Settlement } from '@hivebuy/core';
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
  result: {
    price: Amount | null;
    demand: number;
    /** Providers that sell, cheapest first (empty when the round failed). */
    fills: Fill[];
    priceSetBy: string | null;
    settlements: Settlement[];
  } | null;
  /** Phase deadlines in ms since epoch (testnet rounds), for the live countdown. */
  ends?: { join: number; commit: number; reveal: number };
  forfeited: string[];
  /** Forfeited bonds paid to buyers (testnet rounds cleared by v2.1), in yoctoNEAR. */
  bondShares?: { id: string; amount: bigint }[];
  /** Seller bond for this round, in yoctoNEAR (testnet rounds). */
  bond?: bigint;
  /** Published agent reasoning (testnet rounds run by scripts/testnet.ts). */
  notes?: { brain: string; byAgent: Record<string, { reasoning: string; source: string }> };
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
      price: r.result.price,
      fills: r.result.fills,
      priceSetBy: r.result.priceSetBy,
      demand: r.result.demand,
      settlements: r.result.settlements,
    },
    forfeited: r.forfeited,
  }));
}
