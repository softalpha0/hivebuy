import { KeyPair } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import {
  type Receipt,
  VOUCHER_TTL_MS,
  checkReceipt,
  checkVoucher,
  newVoucher,
  receiptHash,
  redeemMessage,
  sha256Hex,
  sign,
  signVoucher,
  verify,
} from '../src/index.js';

const sellerKey = KeyPair.fromRandom('ed25519').toString() as KeyPairString;
const buyerKey = KeyPair.fromRandom('ed25519').toString() as KeyPairString;
const NOW = 1_800_000_000_000;
const voucher = newVoucher({ contract: 'market.hivebuy.testnet', round_id: 7, buyer: 'buyer-1.hivebuy.testnet', seller: 'seller-2.hivebuy.testnet', units: 8 }, NOW);

describe('vouchers', () => {
  it('a voucher signed by the seller verifies until it expires', () => {
    const sv = signVoucher(sellerKey, voucher);
    expect(checkVoucher(sv, NOW)).toBeNull();
    expect(checkVoucher(sv, NOW + VOUCHER_TTL_MS)).toBeNull();
    expect(checkVoucher(sv, NOW + VOUCHER_TTL_MS + 1)).toBe('voucher expired');
  });

  it('changing any field breaks the signature', () => {
    const sv = signVoucher(sellerKey, voucher);
    for (const change of [{ units: 80 }, { buyer: 'buyer-2.hivebuy.testnet' }, { round_id: 8 }, { expires_at: voucher.expires_at + 1 }]) {
      expect(checkVoucher({ ...sv, voucher: { ...voucher, ...change } }, NOW)).toBe('voucher signature does not match');
    }
  });

  it('a voucher signed by someone else does not verify as the seller', () => {
    const forged = signVoucher(buyerKey, voucher);
    expect(verify(KeyPair.fromString(sellerKey).getPublicKey().toString(), redeemMessage('x', 'y'), forged.signature)).toBe(false);
  });

  it('the buyer signs its redemption over the voucher nonce and its exact prompt', () => {
    const s = sign(buyerKey, redeemMessage(voucher.nonce, 'Hello'));
    expect(verify(s.public_key, redeemMessage(voucher.nonce, 'Hello'), s.signature)).toBe(true);
    expect(verify(s.public_key, redeemMessage(voucher.nonce, 'Hello!'), s.signature)).toBe(false);
    expect(verify(s.public_key, redeemMessage('0'.repeat(32), 'Hello'), s.signature)).toBe(false);
  });
});

describe('receipts', () => {
  const sv = signVoucher(sellerKey, voucher);
  const receipt: Receipt = {
    v: 1, contract: voucher.contract, round_id: 7, buyer: voucher.buyer, seller: voucher.seller, units: 8,
    voucher_nonce: voucher.nonce, model: 'z-ai/glm-5.3-flash', prompt_sha256: sha256Hex('Hello'),
    completion_sha256: sha256Hex('Hi there.'), prompt_tokens: 12, completion_tokens: 4, delivered_at: NOW + 5,
  };

  it('the hash is stable and 64 hex characters', () => {
    expect(receiptHash(receipt)).toMatch(/^[0-9a-f]{64}$/);
    expect(receiptHash({ ...receipt })).toBe(receiptHash(receipt));
  });

  it('the buyer accepts only a receipt for its voucher, prompt and completion', () => {
    const h = receiptHash(receipt);
    expect(checkReceipt(receipt, h, sv, 'Hello', 'Hi there.')).toBeNull();
    expect(checkReceipt(receipt, h, sv, 'Hello', 'Something else')).toBe('completion does not match the receipt');
    expect(checkReceipt(receipt, h, sv, 'Bye', 'Hi there.')).toBe('receipt is for another prompt');
    expect(checkReceipt({ ...receipt, units: 80 }, receiptHash({ ...receipt, units: 80 }), sv, 'Hello', 'Hi there.')).toBe('receipt is for another voucher');
    expect(checkReceipt(receipt, '0'.repeat(64), sv, 'Hello', 'Hi there.')).toBe('receipt hash does not match the receipt');
  });
});
