/**
 * NEAR Intents settlement, dry run (RULES.md section 8).
 *
 *   npm run intents:dry-run -- --seed 42 --round 1
 *
 * Takes a cleared round from the simulation, turns it into one signed `transfer` intent per
 * included buyer (qty × clearing price of mainnet USDC to the winner), and checks the batch with
 * `simulate_intents` on the real Verifier (`intents.near`). This is a read-only view call: nothing
 * is executed and no funds are needed. Agent keys are generated fresh for each run.
 */
import { randomBytes } from 'node:crypto';
import { KeyPair, baseEncode, keyToImplicitAddress } from 'near-api-js';
import { sha256 } from '@noble/hashes/sha2';
import { formatUsdc } from '@hivebuy/core';
import { runSimulation } from '@hivebuy/sim';

const RPC = process.env.NEAR_MAINNET_RPC_URL ?? 'https://free.rpc.fastnear.com';
const VERIFIER = 'intents.near';
/** Native USDC on NEAR mainnet, as listed by the 1Click API (GET /v0/tokens). */
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

/** NEP-413 hash: sha256(borsh(u32 2^31+413, message, nonce[32], recipient, callbackUrl = None)). */
function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  const str = (s: string) => {
    const bytes = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length);
    return Buffer.concat([len, bytes]);
  };
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  return sha256(Buffer.concat([tag, str(message), Buffer.from(nonce), str(recipient), Buffer.from([0])]));
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function view<T>(method: string, args: object): Promise<T> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'hivebuy',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: VERIFIER,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error.cause ?? body.error));
  if (body.result?.error) throw new Error(body.result.error);
  return JSON.parse(Buffer.from(body.result.result).toString()) as T;
}

const seed = Number(arg('seed', '42'));
const roundNo = Number(arg('round', '1'));
const round = runSimulation({ seed, rounds: roundNo }).rounds[roundNo - 1]!;
if (round.result.status !== 'cleared') {
  console.log(`Round ${roundNo} (seed ${seed}) did not clear; nothing to settle. Try another round.`);
  process.exit(0);
}
const price = round.result.price;
const included = round.result.settlements.filter((s) => s.included);

// One fresh key per agent; on mainnet these would be the agents' own keys.
const winnerKey = KeyPair.fromRandom('ed25519');
const winnerId = keyToImplicitAddress(winnerKey.getPublicKey());

// Nonce = [4-byte Verifier salt][28 random bytes] (docs: intent-types-and-execution, "Nonce structure").
const saltHex = await view<string>('current_salt', {});
const deadline = new Date(Date.now() + 5 * 60_000).toISOString();

const signed = included.map((s) => {
  const key = KeyPair.fromRandom('ed25519');
  const signerId = keyToImplicitAddress(key.getPublicKey());
  const nonce = new Uint8Array([...Buffer.from(saltHex, 'hex'), ...randomBytes(28)]);
  const message = JSON.stringify({
    signer_id: signerId,
    deadline,
    intents: [{ intent: 'transfer', receiver_id: winnerId, tokens: { [USDC]: s.pay.toString() } }],
  });
  const hash = nep413Hash(message, nonce, VERIFIER);
  return {
    buyer: s.id,
    pay: s.pay,
    payload: {
      standard: 'nep413',
      payload: { recipient: VERIFIER, nonce: Buffer.from(nonce).toString('base64'), message },
      public_key: key.getPublicKey().toString(),
      signature: `ed25519:${baseEncode(key.sign(hash).signature)}`,
    },
  };
});

console.log(`Round ${roundNo} (seed ${seed}): ${round.result.winner} wins at ${formatUsdc(price)} USDC.`);
console.log(`Built ${signed.length} transfer intents (buyer → winner), ${formatUsdc(included.reduce((a, s) => a + s.pay, 0n))} USDC in total.`);
console.log(`Verifier salt ${saltHex}; simulating on ${VERIFIER} (mainnet, read-only)…\n`);

try {
  const out = await view<unknown>('simulate_intents', { signed: signed.map((x) => x.payload) });
  console.log('simulate_intents accepted the batch:');
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.log('simulate_intents rejected the batch:');
  console.log(`  ${msg}`);
  if (/balance|insufficient|overflow/i.test(msg)) {
    console.log('\nExpected for a dry run: signatures, nonces and intent format were accepted, and the batch only');
    console.log('fails because these fresh agent accounts hold no USDC inside intents.near.');
  }
}
