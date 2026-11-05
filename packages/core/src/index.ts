import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/** Amounts are integers in the smallest USDC unit (6 decimals). */
export type Amount = bigint;

export const USDC_DECIMALS = 6;

export interface Buyer {
  id: string;
  qty: number;
  maxPrice: Amount;
}

export interface RevealedBid {
  id: string;
  price: Amount;
  capacity: number;
  /** Order in which the seller committed; lower wins ties. */
  commitIndex: number;
}

export interface Settlement {
  id: string;
  included: boolean;
  pay: Amount;
  refund: Amount;
}

/** Units a provider sells in a cleared round, paid at the clearing price. */
export interface Fill {
  id: string;
  units: number;
  payout: Amount;
}

export type ClearResult =
  | {
      status: 'cleared';
      price: Amount;
      demand: number;
      /** Providers that sell, cheapest first. Payouts add up to what the included buyers pay. */
      fills: Fill[];
      /** The provider whose ask became the clearing price (it may sell nothing). */
      priceSetBy: string;
      settlements: Settlement[];
    }
  | { status: 'failed'; price: null; demand: 0; fills: []; priceSetBy: null; settlements: Settlement[] };

/** What a buyer locks in escrow when joining: qty × max price. */
export function escrowFor(buyer: Pick<Buyer, 'qty' | 'maxPrice'>): Amount {
  return BigInt(buyer.qty) * buyer.maxPrice;
}

/**
 * Seller commitment: sha256 of "<round_id>:<seller_id>:<price>:<capacity>:<salt>", hex encoded.
 * Must match the contract byte for byte (RULES.md section 3).
 */
export function commitment(
  roundId: number | bigint,
  sellerId: string,
  price: Amount,
  capacity: number,
  salt: string,
): string {
  return bytesToHex(sha256(utf8ToBytes(`${roundId}:${sellerId}:${price}:${capacity}:${salt}`)));
}

function byAsk(bids: readonly RevealedBid[]): RevealedBid[] {
  return [...bids].sort((a, b) => (a.price === b.price ? a.commitIndex - b.commitIndex : a.price < b.price ? -1 : 1));
}

function demandAt(buyers: readonly Buyer[], price: Amount): number {
  return buyers.reduce((sum, b) => (b.maxPrice >= price ? sum + b.qty : sum), 0);
}

export interface ClearStep {
  /** Who named this price: a provider's ask, or a buyer's max price. */
  id: string;
  kind: 'ask' | 'max';
  price: Amount;
  /** Units wanted by buyers whose max is at least `price`. */
  demand: number;
  /** Combined capacity of every provider asking `price` or less. */
  supply: number;
  outcome: 'clears' | 'not-enough-capacity' | 'no-demand';
}

/**
 * Clearing rule, RULES.md section 4. Pure and deterministic.
 *
 * Candidate prices are every revealed ask and every buyer's max price, from the cheapest ask up.
 * The first candidate where the providers asking that much or less can together make every unit
 * wanted at that price is the clearing price. Units go to the cheapest providers first (ties:
 * earlier commit), and everyone trades at that one price.
 */
export function clear(buyers: readonly Buyer[], bids: readonly RevealedBid[]): ClearResult {
  const ordered = byAsk(bids);
  const step = explainClear(buyers, bids).at(-1);
  if (step?.outcome === 'clears') {
    const price = step.price;
    let left = step.demand;
    const fills: Fill[] = [];
    for (const bid of ordered) {
      if (bid.price > price || left === 0) break;
      const units = Math.min(bid.capacity, left);
      left -= units;
      fills.push({ id: bid.id, units, payout: BigInt(units) * price });
    }
    return {
      status: 'cleared',
      price,
      demand: step.demand,
      fills,
      priceSetBy: step.id,
      settlements: buyers.map((b) => {
        const escrow = escrowFor(b);
        if (b.maxPrice < price) return { id: b.id, included: false, pay: 0n, refund: escrow };
        const pay = BigInt(b.qty) * price;
        return { id: b.id, included: true, pay, refund: escrow - pay };
      }),
    };
  }
  return {
    status: 'failed',
    price: null,
    demand: 0,
    fills: [],
    priceSetBy: null,
    settlements: buyers.map((b) => ({ id: b.id, included: false, pay: 0n, refund: escrowFor(b) })),
  };
}

/** The clearing rule as a readable trace: each candidate price, cheapest first, until one clears. */
export function explainClear(buyers: readonly Buyer[], bids: readonly RevealedBid[]): ClearStep[] {
  const ordered = byAsk(bids);
  if (!ordered.length) return [];
  const floor = ordered[0]!.price;
  // Who names each candidate price: the earliest-committed ask, else the first buyer with that max.
  const namer = new Map<Amount, { id: string; kind: 'ask' | 'max' }>();
  for (const b of ordered) if (!namer.has(b.price)) namer.set(b.price, { id: b.id, kind: 'ask' });
  for (const b of buyers) if (b.maxPrice >= floor && !namer.has(b.maxPrice)) namer.set(b.maxPrice, { id: b.id, kind: 'max' });
  const prices = [...namer.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const steps: ClearStep[] = [];
  for (const price of prices) {
    const demand = demandAt(buyers, price);
    const supply = ordered.reduce((sum, b) => (b.price <= price ? sum + b.capacity : sum), 0);
    const outcome = demand === 0 ? 'no-demand' : supply >= demand ? 'clears' : 'not-enough-capacity';
    steps.push({ ...namer.get(price)!, price, demand, supply, outcome });
    if (outcome !== 'not-enough-capacity') break;
  }
  return steps;
}

/**
 * The rule Hivebuy v1 used, kept for comparison: the cheapest single provider that can serve
 * everyone willing to pay its own ask wins alone. Returns the units it would have served.
 */
export function oneWinnerUnits(buyers: readonly Buyer[], bids: readonly RevealedBid[]): number {
  for (const bid of byAsk(bids)) {
    const demand = demandAt(buyers, bid.price);
    if (demand > 0 && bid.capacity >= demand) return demand;
  }
  return 0;
}

/** Headline numbers for a set of rounds: units vs a one-winner market, and how far below their max buyers paid. */
export function headline(rounds: readonly { buyers: readonly Buyer[]; bids: readonly RevealedBid[]; price: Amount | null; demand: number }[]) {
  let units = 0;
  let oneWinner = 0;
  let maxSpend = 0n;
  let paid = 0n;
  for (const r of rounds) {
    oneWinner += oneWinnerUnits(r.buyers, r.bids);
    if (r.price === null) continue;
    units += r.demand;
    for (const b of r.buyers) {
      if (b.maxPrice < r.price) continue;
      maxSpend += b.maxPrice * BigInt(b.qty);
      paid += r.price * BigInt(b.qty);
    }
  }
  return {
    units,
    oneWinnerUnits: oneWinner,
    /** e.g. 0.17 = 17% more units than one winner would have served. */
    moreUnits: oneWinner > 0 ? units / oneWinner - 1 : 0,
    /** e.g. 0.40 = included buyers paid 40% less than the most they said they'd pay. */
    belowMax: maxSpend > 0n ? Number(maxSpend - paid) / Number(maxSpend) : 0,
  };
}

export interface Payment {
  buyer: string;
  seller: string;
  units: number;
  amount: Amount;
}

/**
 * Who pays whom in a cleared round: included buyers (input order) are matched to fills
 * (cheapest first), splitting a buyer across two providers when needed. Per buyer the amounts
 * add up to its `pay`, per provider to its `payout`. Used for the NEAR Intents transfers.
 */
export function payments(buyers: readonly Buyer[], result: ClearResult): Payment[] {
  if (result.status !== 'cleared') return [];
  const out: Payment[] = [];
  const fills = result.fills.map((f) => ({ id: f.id, left: f.units }));
  let i = 0;
  for (const b of buyers) {
    if (b.maxPrice < result.price) continue;
    let need = b.qty;
    while (need > 0) {
      const f = fills[i]!;
      const units = Math.min(need, f.left);
      if (units > 0) out.push({ buyer: b.id, seller: f.id, units, amount: BigInt(units) * result.price });
      need -= units;
      f.left -= units;
      if (f.left === 0) i++;
    }
  }
  return out;
}

/**
 * Forfeited seller bonds split among the round's buyers by units locked (RULES.md section 6).
 * Rounds down; `dust` goes to the treasury. Mirrors `bond_shares` in the contract.
 */
export function bondShares(qtys: readonly number[], forfeited: bigint): { shares: bigint[]; dust: bigint } {
  const total = qtys.reduce((a, q) => a + BigInt(q), 0n);
  if (total === 0n) return { shares: qtys.map(() => 0n), dust: forfeited };
  const perUnit = forfeited / total;
  const rest = forfeited % total;
  const shares = qtys.map((q) => perUnit * BigInt(q) + (rest * BigInt(q)) / total);
  return { shares, dust: forfeited - shares.reduce((a, s) => a + s, 0n) };
}

/** yoctoNEAR -> "0.033" NEAR for display. */
export function formatNear(yocto: bigint, digits = 3): string {
  const base = 10n ** 24n;
  const scaled = (yocto * 10n ** BigInt(digits)) / base;
  const s = scaled.toString().padStart(digits + 1, '0');
  return digits > 0 ? `${s.slice(0, -digits)}.${s.slice(-digits)}` : s;
}

/** "1400000" -> "1.40" for display. */
export function formatUsdc(amount: Amount, digits = 2): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(USDC_DECIMALS);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(USDC_DECIMALS, '0').slice(0, digits);
  return `${negative ? '-' : ''}${whole}${digits > 0 ? `.${frac}` : ''}`;
}

/** "1.40" -> 1400000n. Rejects more than 6 decimals. */
export function parseUsdc(text: string): Amount {
  const match = /^(\d+)(?:\.(\d{0,6}))?$/.exec(text.trim());
  if (!match) throw new Error(`Not a USDC amount: "${text}"`);
  const [, whole, frac = ''] = match;
  return BigInt(whole!) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, '0'));
}
