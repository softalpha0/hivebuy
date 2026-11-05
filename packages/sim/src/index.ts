import { type Amount, type ClearResult, clear, commitment, escrowFor } from '@hivebuy/core';

/** Seeded PRNG (mulberry32) so a run can be replayed exactly. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MICRO = 1_000_000;
const usdc = (dollars: number): Amount => BigInt(Math.round(dollars * MICRO));
const toDollars = (a: Amount): number => Number(a) / MICRO;

export type BuyerStrategy = 'fixed' | 'bargain' | 'budget';
export type SellerStrategy = 'cost-plus' | 'undercutter' | 'premium' | 'small-cheap' | 'flaky';

export interface BuyerAgent {
  id: string;
  strategy: BuyerStrategy;
  /** What one unit is worth to this buyer. */
  value: number;
  /** Typical units needed per round. */
  need: number;
}

export interface SellerAgent {
  id: string;
  strategy: SellerStrategy;
  /** Cost to serve one unit. */
  cost: number;
  capacity: number;
}

export interface BuyerOrder {
  id: string;
  strategy: BuyerStrategy;
  qty: number;
  maxPrice: Amount;
  escrow: Amount;
}

export interface SellerBid {
  id: string;
  strategy: SellerStrategy;
  commitIndex: number;
  commitment: string;
  /** Kept private until reveal. */
  price: Amount;
  capacity: number;
  salt: string;
  revealed: boolean;
}

export interface RoundRecord {
  id: number;
  buyers: BuyerOrder[];
  sellers: SellerBid[];
  result: ClearResult;
  forfeited: string[];
  stats: {
    joined: number;
    demandAtClear: number;
    escrowTotal: Amount;
    paidToProviders: Amount;
    refunded: Amount;
    /** Sum over included buyers of (max price − clearing price) × qty. */
    buyerSurplus: Amount;
  };
}

export interface SimConfig {
  seed: number;
  rounds: number;
  buyers?: number;
  sellers?: number;
  parent?: string;
}

export interface SimRun {
  config: Required<SimConfig>;
  buyers: BuyerAgent[];
  sellers: SellerAgent[];
  rounds: RoundRecord[];
}

const SELLER_STRATEGIES: SellerStrategy[] = ['cost-plus', 'undercutter', 'premium', 'small-cheap', 'flaky'];
const BUYER_STRATEGIES: BuyerStrategy[] = ['fixed', 'bargain', 'budget'];

export function createAgents(config: Required<SimConfig>): { buyers: BuyerAgent[]; sellers: SellerAgent[] } {
  const r = rng(config.seed);
  const buyers: BuyerAgent[] = Array.from({ length: config.buyers }, (_, i) => ({
    id: `buyer-${i + 1}.${config.parent}`,
    strategy: BUYER_STRATEGIES[i % BUYER_STRATEGIES.length]!,
    value: round2(1.0 + r() * 1.2),
    need: 2 + Math.floor(r() * 11),
  }));
  const sellers: SellerAgent[] = Array.from({ length: config.sellers }, (_, i) => {
    const strategy = SELLER_STRATEGIES[i % SELLER_STRATEGIES.length]!;
    const cost = round2(0.7 + r() * 0.4);
    const capacity =
      strategy === 'small-cheap'
        ? 30
        : strategy === 'premium'
          ? 400
          : strategy === 'undercutter'
            ? 130 + Math.floor(r() * 30)
            : 80 + Math.floor(r() * 60);
    return { id: `seller-${i + 1}.${config.parent}`, strategy, cost: strategy === 'small-cheap' ? 0.6 : cost, capacity };
  });
  return { buyers, sellers };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function buyerOrder(agent: BuyerAgent, r: () => number, lastPrice: number | null): BuyerOrder {
  const need = Math.max(1, agent.need + Math.floor(r() * 5) - 2);
  let qty = need;
  let max = agent.value;
  if (agent.strategy === 'bargain') max = agent.value * 0.85;
  if (agent.strategy === 'budget') {
    const budget = agent.need * agent.value * 0.9;
    const expected = lastPrice ?? agent.value;
    qty = Math.max(1, Math.min(need, Math.floor(budget / expected)));
  }
  const maxPrice = usdc(round2(max));
  return { id: agent.id, strategy: agent.strategy, qty, maxPrice, escrow: escrowFor({ qty, maxPrice }) };
}

function sellerPrice(agent: SellerAgent, r: () => number, lastPrice: number | null): number {
  switch (agent.strategy) {
    case 'cost-plus':
      return agent.cost * 1.35;
    case 'undercutter':
      return Math.max(agent.cost * 1.08, (lastPrice ?? agent.cost * 1.5) - 0.03);
    case 'premium':
      return agent.cost * 1.8;
    case 'small-cheap':
      return agent.cost * 1.25;
    case 'flaky':
      return agent.cost * (1.1 + r() * 0.2);
  }
}

/** Fisher–Yates, so the order is the same in every JavaScript engine. */
function shuffle<T>(items: readonly T[], r: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function salt(r: () => number): string {
  return Array.from({ length: 4 }, () => Math.floor(r() * 0xffffffff).toString(16).padStart(8, '0')).join('');
}

/** Runs the market for `config.rounds` rounds. Same config → same output. */
export function runSimulation(input: SimConfig): SimRun {
  const config: Required<SimConfig> = {
    buyers: 20,
    sellers: 5,
    parent: 'hivebuy.testnet',
    ...input,
  };
  const { buyers, sellers } = createAgents(config);
  const r = rng(config.seed ^ 0x9e3779b9);
  const rounds: RoundRecord[] = [];
  let lastPrice: number | null = null;

  for (let id = 1; id <= config.rounds; id++) {
    // Join phase: every buyer locks qty × max price.
    const orders = buyers.map((b) => buyerOrder(b, r, lastPrice));

    // Commit phase: sealed bids, in a shuffled commit order.
    const commitOrder = shuffle(sellers, r);
    const bids: SellerBid[] = commitOrder.map((s, commitIndex) => {
      const price = usdc(round2(sellerPrice(s, r, lastPrice)));
      // Spare capacity moves from round to round (80%–120% of the seller's base).
      const capacity = Math.max(1, Math.round(s.capacity * (0.8 + r() * 0.4)));
      const saltValue = salt(r);
      return {
        id: s.id,
        strategy: s.strategy,
        commitIndex,
        commitment: commitment(id, s.id, price, capacity, saltValue),
        price,
        capacity,
        salt: saltValue,
        // Reveal phase: the flaky seller skips reveal about half the time.
        revealed: s.strategy === 'flaky' ? r() < 0.5 : true,
      };
    });

    // Clear.
    const result = clear(
      orders.map((o) => ({ id: o.id, qty: o.qty, maxPrice: o.maxPrice })),
      bids.filter((b) => b.revealed).map((b) => ({ id: b.id, price: b.price, capacity: b.capacity, commitIndex: b.commitIndex })),
    );

    const escrowTotal = orders.reduce((s, o) => s + o.escrow, 0n);
    const paidToProviders = result.settlements.reduce((s, x) => s + x.pay, 0n);
    const refunded = result.settlements.reduce((s, x) => s + x.refund, 0n);
    const buyerSurplus =
      result.status === 'cleared'
        ? orders.reduce(
            (s, o) => (o.maxPrice >= result.price ? s + (o.maxPrice - result.price) * BigInt(o.qty) : s),
            0n,
          )
        : 0n;

    rounds.push({
      id,
      buyers: orders,
      sellers: bids,
      result,
      forfeited: bids.filter((b) => !b.revealed).map((b) => b.id),
      stats: {
        joined: orders.length,
        demandAtClear: result.demand,
        escrowTotal,
        paidToProviders,
        refunded,
        buyerSurplus,
      },
    });
    if (result.status === 'cleared') lastPrice = toDollars(result.price);
  }

  return { config, buyers, sellers, rounds };
}

/** JSON-safe copy (bigints → strings). */
export function toJson(run: SimRun): unknown {
  return JSON.parse(JSON.stringify(run, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
