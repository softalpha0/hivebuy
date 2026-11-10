/**
 * Delivery vouchers and receipts (RULES.md section 9).
 *
 * After a round clears, each provider that sold units to a buyer signs a voucher with its NEAR key.
 * The buyer redeems it with one real inference call through the provider's endpoint, signing the
 * request with its own NEAR key. The provider returns the completion and a receipt; the receipt's
 * sha256 goes on-chain with `post_delivery`, and the buyer confirms it with `confirm_delivery`.
 *
 * Only relative imports here: the Vercel function in api/ imports this file directly.
 */
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils';
import { KeyPair, PublicKey } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';

export interface Voucher {
  v: 1;
  /** Coordinator contract the round lives on. */
  contract: string;
  round_id: number;
  buyer: string;
  seller: string;
  /** Units (1M tokens each) the buyer bought from this seller in the round. */
  units: number;
  /** Milliseconds since epoch. */
  expires_at: number;
  /** 32 hex characters, unique per voucher. */
  nonce: string;
}

export interface SignedVoucher {
  voucher: Voucher;
  /** The seller's public key, "ed25519:…"; must be an access key of `voucher.seller`. */
  public_key: string;
  /** base64 ed25519 signature over `voucherMessage(voucher)`. */
  signature: string;
}

export interface Receipt {
  v: 1;
  contract: string;
  round_id: number;
  buyer: string;
  seller: string;
  units: number;
  voucher_nonce: string;
  model: string;
  prompt_sha256: string;
  completion_sha256: string;
  prompt_tokens: number;
  completion_tokens: number;
  /** Milliseconds since epoch. */
  delivered_at: number;
}

export const VOUCHER_TTL_MS = 60 * 60 * 1000;
export const MAX_PROMPT_CHARS = 500;

const enc = (s: string) => utf8ToBytes(s);
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

export const sha256Hex = (s: string) => bytesToHex(sha256(enc(s)));

/** The exact bytes a seller signs. Fields joined with "|", in a fixed order. */
export function voucherMessage(v: Voucher): string {
  return ['hivebuy-voucher', `v${v.v}`, v.contract, v.round_id, v.buyer, v.seller, v.units, v.expires_at, v.nonce].join('|');
}

/** The exact bytes a buyer signs to redeem: the voucher nonce and the sha256 of its prompt. */
export function redeemMessage(nonce: string, prompt: string): string {
  return ['hivebuy-redeem', 'v1', nonce, sha256Hex(prompt)].join('|');
}

export function newVoucher(fields: Omit<Voucher, 'v' | 'expires_at' | 'nonce'>, now = Date.now()): Voucher {
  return { v: 1, ...fields, expires_at: now + VOUCHER_TTL_MS, nonce: bytesToHex(randomBytes(16)) };
}

export function sign(key: KeyPairString, message: string): { public_key: string; signature: string } {
  const kp = KeyPair.fromString(key);
  return { public_key: kp.getPublicKey().toString(), signature: b64(kp.sign(enc(message)).signature) };
}

export function verify(publicKey: string, message: string, signature: string): boolean {
  try {
    return PublicKey.fromString(publicKey).verify(enc(message), unb64(signature));
  } catch {
    return false;
  }
}

export function signVoucher(key: KeyPairString, voucher: Voucher): SignedVoucher {
  return { voucher, ...sign(key, voucherMessage(voucher)) };
}

/** Checks the signature and expiry only; the caller checks the key belongs to the seller on-chain. */
export function checkVoucher(sv: SignedVoucher, now = Date.now()): string | null {
  if (!verify(sv.public_key, voucherMessage(sv.voucher), sv.signature)) return 'voucher signature does not match';
  if (now > sv.voucher.expires_at) return 'voucher expired';
  if (!/^[0-9a-f]{32}$/.test(sv.voucher.nonce)) return 'voucher nonce must be 32 hex characters';
  return null;
}

/** Canonical JSON (fixed key order) so both sides hash the same bytes. */
export function receiptJson(r: Receipt): string {
  return JSON.stringify([
    r.v, r.contract, r.round_id, r.buyer, r.seller, r.units, r.voucher_nonce, r.model,
    r.prompt_sha256, r.completion_sha256, r.prompt_tokens, r.completion_tokens, r.delivered_at,
  ]);
}

/** What goes on-chain with `post_delivery`. */
export const receiptHash = (r: Receipt) => sha256Hex(receiptJson(r));

/**
 * The buyer's check before confirming on-chain: the receipt is for its voucher and prompt, and the
 * completion it received is the one the receipt describes.
 */
export function checkReceipt(r: Receipt, hash: string, sv: SignedVoucher, prompt: string, completion: string): string | null {
  if (receiptHash(r) !== hash) return 'receipt hash does not match the receipt';
  const v = sv.voucher;
  if (r.voucher_nonce !== v.nonce || r.buyer !== v.buyer || r.seller !== v.seller || r.round_id !== v.round_id || r.units !== v.units)
    return 'receipt is for another voucher';
  if (r.prompt_sha256 !== sha256Hex(prompt)) return 'receipt is for another prompt';
  if (r.completion_sha256 !== sha256Hex(completion)) return 'completion does not match the receipt';
  return null;
}
