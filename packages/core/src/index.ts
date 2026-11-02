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

export type ClearResult =
  | { status: 'cleared'; winner: string; price: Amount; demand: number; settlements: Settlement[] }
  | { status: 'failed'; winner: null; price: null; demand: 0; settlements: Settlement[] };

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

/** Clearing rule, RULES.md section 4. Pure and deterministic. */
export function clear(buyers: readonly Buyer[], bids: readonly RevealedBid[]): ClearResult {
  const ordered = [...bids].sort((a, b) =>
    a.price === b.price ? a.commitIndex - b.commitIndex : a.price < b.price ? -1 : 1,
  );

  for (const bid of ordered) {
    const demand = buyers.reduce((sum, b) => (b.maxPrice >= bid.price ? sum + b.qty : sum), 0);
    if (demand > 0 && bid.capacity >= demand) {
      return {
        status: 'cleared',
        winner: bid.id,
        price: bid.price,
        demand,
        settlements: buyers.map((b) => {
          const escrow = escrowFor(b);
          if (b.maxPrice < bid.price) return { id: b.id, included: false, pay: 0n, refund: escrow };
          const pay = BigInt(b.qty) * bid.price;
          return { id: b.id, included: true, pay, refund: escrow - pay };
        }),
      };
    }
  }

  return {
    status: 'failed',
    winner: null,
    price: null,
    demand: 0,
    settlements: buyers.map((b) => ({ id: b.id, included: false, pay: 0n, refund: escrowFor(b) })),
  };
}

export interface ClearStep {
  id: string;
  price: Amount;
  capacity: number;
  demand: number;
  outcome: 'wins' | 'not-enough-capacity' | 'no-demand';
}

/** The clearing rule as a readable trace: each seller checked, cheapest first, until one wins. */
export function explainClear(buyers: readonly Buyer[], bids: readonly RevealedBid[]): ClearStep[] {
  const ordered = [...bids].sort((a, b) =>
    a.price === b.price ? a.commitIndex - b.commitIndex : a.price < b.price ? -1 : 1,
  );
  const steps: ClearStep[] = [];
  for (const bid of ordered) {
    const demand = buyers.reduce((sum, b) => (b.maxPrice >= bid.price ? sum + b.qty : sum), 0);
    const outcome = demand === 0 ? 'no-demand' : bid.capacity >= demand ? 'wins' : 'not-enough-capacity';
    steps.push({ id: bid.id, price: bid.price, capacity: bid.capacity, demand, outcome });
    if (outcome === 'wins') break;
  }
  return steps;
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
