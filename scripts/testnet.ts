/**
 * Hivebuy on NEAR testnet.
 *
 *   npm run testnet -- setup   one time: coordinator, (test token), buyer and seller sub-accounts
 *   npm run testnet -- round   one live round: open → join → commit → reveal → clear → withdraw
 *   npm run testnet -- status  balances and the latest round
 *
 * Reads PARENT_ACCOUNT (and optionally PARENT_PRIVATE_KEY, TOKEN, BUYERS, SELLERS, PHASE_SECS) from
 * the environment or `.env`. Agent keys are written to `.hivebuy/testnet.json`, which is gitignored.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, getTransactionLastResult, nearToYocto, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { commitment, formatUsdc } from '@hivebuy/core';

// ---------- config ----------

loadDotEnv(resolve('.env'));

// rpc.testnet.near.org is deprecated and rate limited; FastNEAR is the free endpoint listed in the NEAR docs.
const NETWORK_RPC = process.env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com';
const EMPTY_CODE = '11111111111111111111111111111111';
const EXPLORER = 'https://testnet.nearblocks.io/txns';
const CIRCLE_TESTNET_USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const STATE_FILE = resolve('.hivebuy', 'testnet.json');
const MARKET_WASM = resolve(process.env.MARKET_WASM ?? 'contracts/market/target/near/hivebuy_market.wasm');
const TOKEN_WASM = resolve(process.env.TOKEN_WASM ?? 'contracts/test-token/target/near/hivebuy_test_token.wasm');
const BOND = nearToYocto('0.1');
const GAS = teraToGas('30');
const GAS_FT_CALL = teraToGas('60');
const GAS_WITHDRAW = teraToGas('50');
const BUYER_NEAR = '0.3';
const SELLER_NEAR = '0.5';
/** Circle's faucet gives 20 USDC per claim, so 4 USDC for each of 5 buyers. */
const CIRCLE_PER_BUYER = '4000000';

const parentId = required('PARENT_ACCOUNT');
const provider = new JsonRpcProvider({ url: NETWORK_RPC });

interface AgentKey {
  id: string;
  key: KeyPairString;
}
interface State {
  parent: string;
  market: AgentKey;
  token: string;
  testToken: boolean;
  tokenKey?: AgentKey;
  buyers: AgentKey[];
  sellers: AgentKey[];
}

// ---------- helpers ----------

function loadDotEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in (see docs/TESTNET.md).`);
    process.exit(1);
  }
  return v;
}

/** Parent key: PARENT_PRIVATE_KEY, or the file NEAR CLI writes with save-to-legacy-keychain. */
function parentKey(): KeyPairString {
  if (process.env.PARENT_PRIVATE_KEY) return process.env.PARENT_PRIVATE_KEY as KeyPairString;
  const file = join(homedir(), '.near-credentials', 'testnet', `${parentId}.json`);
  if (!existsSync(file)) {
    console.error(`No key for ${parentId}. Set PARENT_PRIVATE_KEY in .env or create the account with NEAR CLI (docs/TESTNET.md).`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(file, 'utf8')).private_key as KeyPairString;
}

const account = (id: string, key: KeyPairString) => new Account(id, provider, KeyPairSigner.fromSecretKey(key));
const parent = () => account(parentId, parentKey());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (id: string): string => id.split('.')[0] ?? id;
const txLink = (res: { transaction: { hash: string } }) => `${EXPLORER}/${res.transaction.hash}`;

function loadState(): State {
  if (!existsSync(STATE_FILE)) {
    console.error('Run `npm run testnet -- setup` first.');
    process.exit(1);
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
}

async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction<T & object>({ contractId, method, args })) as T;
}

async function exists(id: string): Promise<boolean> {
  try {
    await new Account(id, provider).getState();
    return true;
  } catch {
    return false;
  }
}

/** Creates `<prefix>.<parent>` with a fresh key, unless it already exists in the state file. */
async function subAccount(p: Account, prefix: string, near: string, known?: AgentKey): Promise<AgentKey> {
  const id = `${prefix}.${parentId}`;
  if (known && (await exists(id))) return known;
  if (await exists(id)) throw new Error(`${id} exists but its key is not in ${STATE_FILE}. Delete the account or pick another parent.`);
  const kp = KeyPair.fromRandom('ed25519');
  await p.createSubAccount({ accountOrPrefix: prefix, publicKey: kp.getPublicKey(), nearToTransfer: nearToYocto(near as `${number}`) });
  console.log(`  created ${id}`);
  return { id, key: kp.toString() };
}

/** Tops `id` up to `near` NEAR so it can pay for gas (and bonds). */
async function topUp(p: Account, id: string, near: string) {
  const target = nearToYocto(near as `${number}`);
  const have = await new Account(id, provider).getBalance();
  if (have >= target) return;
  await p.transfer({ receiverId: id, amount: target - have });
  console.log(`  topped up ${short(id)}`);
}

async function registerOnToken(payer: Account, token: string, who: string) {
  const bal = await view<unknown>(token, 'storage_balance_of', { account_id: who });
  if (bal) return;
  await payer.callFunction({ contractId: token, methodName: 'storage_deposit', args: { account_id: who, registration_only: true }, deposit: nearToYocto('0.00125'), gas: GAS });
}

// ---------- commands ----------

async function setup() {
  const p = parent();
  const prev = existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<State>) : {};
  if (prev.parent && prev.parent !== parentId) throw new Error(`${STATE_FILE} belongs to ${prev.parent}. Move it away to set up ${parentId}.`);
  const tokenChoice = process.env.TOKEN ?? 'test';
  const nBuyers = Number(process.env.BUYERS ?? 5);
  const nSellers = Number(process.env.SELLERS ?? 3);
  console.log(`Setting up Hivebuy under ${parentId} (${nBuyers} buyers, ${nSellers} sellers, token: ${tokenChoice})`);

  // Saved after every step, so a failure halfway never loses a key.
  const state: Partial<State> = { ...prev, parent: parentId, buyers: prev.buyers ?? [], sellers: prev.sellers ?? [] };
  const save = () => {
    mkdirSync(resolve('.hivebuy'), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  };

  // Token: the test token (tUSDC) or Circle's testnet USDC.
  const testToken = tokenChoice === 'test';
  const token = testToken ? `tusdc.${parentId}` : tokenChoice === 'circle' ? CIRCLE_TESTNET_USDC : tokenChoice;
  state.token = token;
  state.testToken = testToken;
  if (testToken) {
    const t = await subAccount(p, 'tusdc', '2.2', prev.tokenKey);
    state.tokenKey = t;
    save();
    if ((await new Account(token, provider).getState()).codeHash === EMPTY_CODE) {
      if (!existsSync(TOKEN_WASM)) throw new Error('Build the test token first: cd contracts/test-token; cargo near build non-reproducible-wasm');
      await account(token, t.key).signAndSendTransaction({
        receiverId: token,
        actions: [actions.deployContract(readFileSync(TOKEN_WASM)), actions.functionCall('new', {}, GAS, 0n)],
      });
      console.log(`  deployed test token ${token}`);
    }
  }

  // Coordinator contract.
  const market = await subAccount(p, 'market', '2.6', prev.market);
  state.market = market;
  save();
  if ((await new Account(market.id, provider).getState()).codeHash === EMPTY_CODE) {
    if (!existsSync(MARKET_WASM)) throw new Error('Build the contract first: cd contracts/market; cargo near build non-reproducible-wasm');
    await account(market.id, market.key).signAndSendTransaction({
      receiverId: market.id,
      actions: [
        actions.deployContract(readFileSync(MARKET_WASM)),
        actions.functionCall('new', { owner_id: parentId, usdc_token_id: token }, GAS, 0n),
      ],
    });
    console.log(`  deployed coordinator ${market.id}`);
  }

  // Agents, each on its own sub-account.
  for (let i = 1; i <= nBuyers; i++) {
    state.buyers![i - 1] = await subAccount(p, `buyer-${i}`, BUYER_NEAR, prev.buyers?.[i - 1]);
    save();
    await topUp(p, state.buyers![i - 1]!.id, BUYER_NEAR);
  }
  for (let i = 1; i <= nSellers; i++) {
    state.sellers![i - 1] = await subAccount(p, `seller-${i}`, SELLER_NEAR, prev.sellers?.[i - 1]);
    save();
    await topUp(p, state.sellers![i - 1]!.id, SELLER_NEAR);
  }
  const buyers = state.buyers!.slice(0, nBuyers);
  const sellers = state.sellers!.slice(0, nSellers);

  // Token storage for the coordinator and every agent, then fund buyers.
  for (const who of [market.id, ...buyers.map((b) => b.id), ...sellers.map((x) => x.id)]) await registerOnToken(p, token, who);
  for (const b of buyers) {
    const bal = BigInt(await view<string>(token, 'ft_balance_of', { account_id: b.id }));
    if (bal >= (testToken ? 50_000_000n : BigInt(CIRCLE_PER_BUYER))) continue;
    if (testToken) {
      await p.callFunction({ contractId: token, methodName: 'mint', args: { account_id: b.id, amount: '100000000' }, gas: GAS });
    } else {
      await p.callFunction({ contractId: token, methodName: 'ft_transfer', args: { receiver_id: b.id, amount: CIRCLE_PER_BUYER }, deposit: 1n, gas: GAS });
    }
    console.log(`  funded ${short(b.id)}`);
  }

  state.buyers = buyers;
  state.sellers = sellers;
  save();
  console.log(`\nDone. Keys saved to ${STATE_FILE} (gitignored). Next: npm run testnet -- round`);
}

async function round() {
  const s = loadState();
  const phase = Number(process.env.PHASE_SECS ?? 30);
  const p = parent();
  const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

  console.log(`Opening a round on ${s.market.id} (${phase}s per phase)…`);
  const roundId = await p.callFunction<number>({
    contractId: s.market.id,
    methodName: 'open_round',
    args: { unit: '1M tokens', join_secs: phase, commit_secs: phase, reveal_secs: phase, seller_bond: BOND.toString() },
    gas: GAS,
  });
  const r0 = await view<{ join_end: string; commit_end: string; reveal_end: string }>(s.market.id, 'get_round', { round_id: roundId });
  console.log(`Round ${roundId} open.`);

  // Join: each buyer locks qty × max price with ft_transfer_call. All buyers send at once.
  await Promise.all(
    s.buyers.map(async (b) => {
      const max = BigInt(Math.round(rand(1.0, 1.9) * 100)) * 10_000n;
      // Never lock more than the buyer holds.
      const balance = BigInt(await view<string>(s.token, 'ft_balance_of', { account_id: b.id }));
      const qty = Math.min(Math.floor(rand(2, 9)), Number(balance / max));
      if (qty < 1) {
        console.log(`  ${short(b.id)} skips: balance ${formatUsdc(balance)} is below one unit at ${formatUsdc(max)}`);
        return;
      }
      const amount = BigInt(qty) * max;
      const res = await account(b.id, b.key).callFunctionRaw({
        contractId: s.token,
        methodName: 'ft_transfer_call',
        args: { receiver_id: s.market.id, amount: amount.toString(), msg: JSON.stringify({ round_id: roundId, qty, max_price: max.toString() }) },
        deposit: 1n,
        gas: GAS_FT_CALL,
      });
      // ft_transfer_call returns the amount the coordinator kept; 0 means the join was rejected and refunded.
      const used = BigInt((getTransactionLastResult(res) as string | null) ?? '0');
      console.log(
        used === amount
          ? `  ${short(b.id)} joins: ${qty} units, max ${formatUsdc(max)}  ${txLink(res)}`
          : `  ${short(b.id)} was refunded: the coordinator rejected the join (late or invalid)  ${txLink(res)}`,
      );
    }),
  );

  await waitUntil(BigInt(r0.join_end), 'commit phase');

  // Commit: sealed price + bond. Salts stay in memory until reveal.
  const bids = s.sellers.map((sel, i) => ({
    sel,
    price: BigInt(Math.round(rand(0.9, 1.5) * 100)) * 10_000n,
    capacity: Math.floor(rand(10, 45)),
    salt: crypto.randomUUID(),
    reveals: i < s.sellers.length - 1 || s.sellers.length === 1 || Math.random() < 0.5,
  }));
  await Promise.all(
    bids.map(async (b) => {
      const hash = commitment(roundId, b.sel.id, b.price, b.capacity, b.salt);
      const res = await account(b.sel.id, b.sel.key).callFunctionRaw({ contractId: s.market.id, methodName: 'commit', args: { round_id: roundId, commitment: hash }, deposit: BOND, gas: GAS });
      console.log(`  ${short(b.sel.id)} commits ${hash.slice(0, 12)}…  ${txLink(res)}`);
    }),
  );

  await waitUntil(BigInt(r0.commit_end), 'reveal phase');

  await Promise.all(
    bids.map(async (b) => {
      if (!b.reveals) {
        console.log(`  ${short(b.sel.id)} does not reveal (bond will be forfeited)`);
        return;
      }
      const res = await account(b.sel.id, b.sel.key).callFunctionRaw({
        contractId: s.market.id,
        methodName: 'reveal',
        args: { round_id: roundId, price: b.price.toString(), capacity: b.capacity, salt: b.salt },
        gas: GAS,
      });
      console.log(`  ${short(b.sel.id)} reveals ${formatUsdc(b.price)} × ${b.capacity}  ${txLink(res)}`);
    }),
  );

  await waitUntil(BigInt(r0.reveal_end), 'clear');

  const out = await p.callFunction<{ winner: string | null; price: string | null; demand: number; settlements: { account_id: string; included: boolean; pay: string; refund: string }[] }>({
    contractId: s.market.id,
    methodName: 'clear',
    args: { round_id: roundId },
    gas: teraToGas('100'),
  });
  console.log(out.winner ? `\nCleared: ${short(out.winner)} wins at ${formatUsdc(BigInt(out.price!))}, ${out.demand} units` : '\nNo seller qualified: all escrow refunded.');
  for (const st of out.settlements) {
    console.log(`  ${short(st.account_id)}: ${st.included ? `pays ${formatUsdc(BigInt(st.pay))}` : 'out'}, refund ${formatUsdc(BigInt(st.refund))}`);
  }

  // Everyone withdraws their credit.
  await Promise.all(
    [...s.buyers, ...s.sellers].map(async (a) => {
      const credit = BigInt(await view<string>(s.market.id, 'credit_of', { account_id: a.id }));
      if (credit === 0n) return;
      await account(a.id, a.key).callFunction({ contractId: s.market.id, methodName: 'withdraw', args: {}, gas: GAS_WITHDRAW });
      console.log(`  ${short(a.id)} withdrew ${formatUsdc(credit)}`);
    }),
  );
  console.log(`\nSee it on the live page: npm run dev, then open http://localhost:5173/?contract=${s.market.id}`);
}

async function status() {
  const s = loadState();
  const cfg = await view<{ next_round_id: number; treasury: string }>(s.market.id, 'get_config');
  console.log(`Coordinator ${s.market.id} · token ${s.token} · rounds opened: ${cfg.next_round_id - 1}`);
  for (const a of [...s.buyers, ...s.sellers]) {
    const bal = BigInt(await view<string>(s.token, 'ft_balance_of', { account_id: a.id }));
    console.log(`  ${short(a.id).padEnd(10)} ${formatUsdc(bal).padStart(9)} USDC`);
  }
}

async function waitUntil(endNs: bigint, label: string) {
  const ms = Number(endNs / 1_000_000n) - Date.now() + 3_000;
  if (ms > 0) {
    console.log(`Waiting ${Math.ceil(ms / 1000)}s for the ${label}…`);
    await sleep(ms);
  }
}

const cmd = process.argv[2];
const run = cmd === 'setup' ? setup : cmd === 'round' ? round : cmd === 'status' ? status : null;
if (!run) {
  console.log('Usage: npm run testnet -- setup | round | status');
  process.exit(1);
}
run().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
