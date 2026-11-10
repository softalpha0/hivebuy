/**
 * The provider endpoint (RULES.md section 9), as a plain function with every outside call injected,
 * so its checks are unit-tested. api/provider.ts wires it to NEAR testnet, NEAR AI Cloud and env vars.
 *
 * POST { action: "voucher", seller, round_id, buyer }
 *   → a voucher signed by the seller, for exactly the units that seller sold that buyer.
 * POST { action: "redeem", voucher, prompt, buyer_public_key, buyer_signature }
 *   → one real inference call, its receipt, and the post_delivery transaction.
 *
 * Abuse limits: only sellers whose keys this endpoint holds; only buyers that really bought from that
 * seller in a cleared round; the buyer must sign with one of its own on-chain keys; one redemption
 * per (round, seller, buyer), enforced by the receipt already on-chain; short prompts and answers.
 */
import { KeyPair } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { payments } from '../../core/src/index.js';
import {
  MAX_PROMPT_CHARS,
  type Receipt,
  type SignedVoucher,
  checkVoucher,
  newVoucher,
  receiptHash,
  redeemMessage,
  sha256Hex,
  signVoucher,
  verify,
} from './index.js';

/** The parts of the coordinator's `get_round` view this endpoint needs. */
export interface ChainRound {
  id: number;
  status: 'Open' | 'Cleared' | 'Failed';
  buyers: { account_id: string; qty: number; max_price: string }[];
  outcome: { price: string | null; cleared_at: string } | null;
  fills: { account_id: string; units: number; payout: string }[];
  deliveries?: { seller: string; buyer: string }[];
}

export interface ProviderDeps {
  contract: string;
  /** Seller account → its full-access private key. Only these sellers are served. */
  sellerKeys: Record<string, KeyPairString>;
  getRound(roundId: number): Promise<ChainRound | null>;
  /** True when `publicKey` is an access key of `accountId` on-chain. */
  hasAccessKey(accountId: string, publicKey: string): Promise<boolean>;
  infer(prompt: string): Promise<{ model: string; completion: string; promptTokens: number; completionTokens: number }>;
  postDelivery(seller: string, key: KeyPairString, roundId: number, buyer: string, receiptHash: string): Promise<{ tx: string }>;
  now?: () => number;
  /** Vouchers are issued only for rounds cleared within this window. Default 7 days. */
  maxRoundAgeMs?: number;
}

export type ProviderResult = { status: number; body: Record<string, unknown> };

const fail = (status: number, error: string): ProviderResult => ({ status, body: { error } });

/** Units `seller` sold `buyer` in a cleared round: the same split as the contract's `units_sold`. */
export function unitsSold(round: ChainRound, seller: string, buyer: string): number {
  if (round.status !== 'Cleared' || !round.outcome?.price) return 0;
  const price = BigInt(round.outcome.price);
  const buyers = round.buyers.map((b) => ({ id: b.account_id, qty: b.qty, maxPrice: BigInt(b.max_price) }));
  const result = {
    status: 'cleared' as const,
    price,
    demand: round.fills.reduce((a, f) => a + f.units, 0),
    fills: round.fills.map((f) => ({ id: f.account_id, units: f.units, payout: BigInt(f.payout) })),
    priceSetBy: '',
    settlements: [],
  };
  return payments(buyers, result)
    .filter((p) => p.seller === seller && p.buyer === buyer)
    .reduce((a, p) => a + p.units, 0);
}

const delivered = (round: ChainRound, seller: string, buyer: string) =>
  (round.deliveries ?? []).some((d) => d.seller === seller && d.buyer === buyer);

export async function handleProvider(input: unknown, deps: ProviderDeps): Promise<ProviderResult> {
  const now = deps.now?.() ?? Date.now();
  if (typeof input !== 'object' || input === null) return fail(400, 'send a JSON object');
  const req = input as Record<string, unknown>;

  if (req.action === 'voucher') {
    const seller = String(req.seller ?? '');
    const buyer = String(req.buyer ?? '');
    const roundId = Number(req.round_id);
    const key = deps.sellerKeys[seller];
    if (!key) return fail(404, `this endpoint does not serve ${seller || 'that seller'}`);
    if (!Number.isInteger(roundId) || roundId < 1) return fail(400, 'round_id must be a positive integer');
    const round = await deps.getRound(roundId);
    if (!round || round.status !== 'Cleared' || !round.outcome) return fail(409, 'round has not cleared');
    const clearedAt = Number(BigInt(round.outcome.cleared_at) / 1_000_000n);
    if (now - clearedAt > (deps.maxRoundAgeMs ?? 7 * 24 * 3600 * 1000)) return fail(409, 'round is too old for new vouchers');
    const units = unitsSold(round, seller, buyer);
    if (units === 0) return fail(403, `${seller} sold no units to ${buyer} in round ${roundId}`);
    if (delivered(round, seller, buyer)) return fail(409, 'already delivered');
    const sv = signVoucher(key, newVoucher({ contract: deps.contract, round_id: roundId, buyer, seller, units }, now));
    return { status: 200, body: { voucher: sv } };
  }

  if (req.action === 'redeem') {
    const sv = req.voucher as SignedVoucher | undefined;
    const prompt = typeof req.prompt === 'string' ? req.prompt : '';
    const buyerPk = String(req.buyer_public_key ?? '');
    const buyerSig = String(req.buyer_signature ?? '');
    if (!sv?.voucher) return fail(400, 'voucher missing');
    const v = sv.voucher;
    const key = deps.sellerKeys[v.seller];
    if (!key) return fail(404, `this endpoint does not serve ${v.seller}`);
    if (v.contract !== deps.contract) return fail(400, 'voucher is for another coordinator');
    // The voucher must carry this seller's own key, so only vouchers this endpoint issued are valid.
    const ownPk = KeyPair.fromString(key).getPublicKey().toString();
    if (sv.public_key !== ownPk) return fail(403, 'voucher was not signed by this seller');
    const bad = checkVoucher(sv, now);
    if (bad) return fail(403, bad);
    if (prompt.length < 1 || prompt.length > MAX_PROMPT_CHARS) return fail(400, `prompt must be 1-${MAX_PROMPT_CHARS} characters`);
    if (!verify(buyerPk, redeemMessage(v.nonce, prompt), buyerSig)) return fail(403, 'buyer signature does not match');
    if (!(await deps.hasAccessKey(v.buyer, buyerPk))) return fail(403, `that key is not an access key of ${v.buyer}`);
    const round = await deps.getRound(v.round_id);
    if (!round) return fail(409, 'round not found');
    if (unitsSold(round, v.seller, v.buyer) !== v.units) return fail(403, 'voucher units do not match the round');
    if (delivered(round, v.seller, v.buyer)) return fail(409, 'already delivered: each voucher is redeemed once');

    const out = await deps.infer(prompt);
    const receipt: Receipt = {
      v: 1,
      contract: v.contract,
      round_id: v.round_id,
      buyer: v.buyer,
      seller: v.seller,
      units: v.units,
      voucher_nonce: v.nonce,
      model: out.model,
      prompt_sha256: sha256Hex(prompt),
      completion_sha256: sha256Hex(out.completion),
      prompt_tokens: out.promptTokens,
      completion_tokens: out.completionTokens,
      delivered_at: deps.now?.() ?? Date.now(),
    };
    const hash = receiptHash(receipt);
    const { tx } = await deps.postDelivery(v.seller, key, v.round_id, v.buyer, hash);
    return { status: 200, body: { completion: out.completion, receipt, receipt_hash: hash, post_tx: tx } };
  }

  return fail(400, 'action must be "voucher" or "redeem"');
}
