/**
 * Hivebuy on NEAR testnet.
 *
 *   npm run testnet -- setup   one time: coordinator, (test token), buyer and seller sub-accounts
 *   npm run testnet -- round   one live round: open → join → commit → reveal → clear → withdraw
 *   npm run testnet -- status  balances and the latest round
 *   npm run testnet -- upgrade deploys a newer coordinator build in place (keeps every round)
 *
 * Reads PARENT_ACCOUNT (and optionally PARENT_PRIVATE_KEY, TOKEN, BUYERS, SELLERS, PHASE_SECS) from
 * the environment or `.env`. Agent keys are written to `.hivebuy/testnet.json`, which is gitignored.
 *
 * AGENTS=ai makes every agent decide with a model on NEAR AI Cloud (needs NEARAI_API_KEY); the
 * default is the scripted rules. Each round's reasoning is saved to apps/web/public/agent-notes/.
 *
 * BUYERS=10 npm run testnet -- setup adds buyer-6 … buyer-10 to an existing setup; the next round uses them all.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, getTransactionLastResult, nearToYocto, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { commitment, formatNear, formatUsdc } from '@hivebuy/core';
import { type Brain, NearAiClient, nearAiBrain, scripted } from '@hivebuy/agents';

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
const LIVE_SITE = process.env.LIVE_SITE ?? 'https://hivebuy-six.vercel.app';
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

/** Re-reads a view until `ready` accepts the result (RPC nodes can lag a moment behind a fresh transaction). */
async function viewUntil<T>(contractId: string, method: string, args: Record<string, unknown>, ready: (v: T) => boolean, label: string): Promise<T> {
  for (let i = 0; i < 15; i++) {
    const v = await view<T>(contractId, method, args);
    if (ready(v)) return v;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${label}`);
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

interface ContractRound {
  id: number;
  join_end: string;
  commit_end: string;
  reveal_end: string;
  buyers: { account_id: string; qty: number; max_price: string }[];
  outcome: {
    price: string | null;
    demand: number;
    settlements: { account_id: string; included: boolean; pay: string; refund: string }[];
  } | null;
  /** v2 coordinator: every seller that sells, cheapest first. */
  fills: { account_id: string; units: number; payout: string }[];
  price_set_by: string | null;
  /** v2.1: forfeited bonds paid to buyers, in yoctoNEAR. */
  bond_shares?: { account_id: string; amount: string }[];
}

/** Agent brain for this round: scripted rules, or NEAR AI Cloud when AGENTS=ai (key checked first). */
async function pickBrain(): Promise<Brain> {
  if ((process.env.AGENTS ?? 'scripted') !== 'ai') return scripted;
  const apiKey = process.env.NEARAI_API_KEY ?? '';
  if (!apiKey) {
    console.error('AGENTS=ai needs NEARAI_API_KEY in .env (create a key at https://cloud.near.ai).');
    process.exit(1);
  }
  const client = new NearAiClient({ apiKey, model: process.env.NEARAI_MODEL || undefined, baseUrl: process.env.NEARAI_BASE_URL || undefined });
  await client.check();
  return nearAiBrain(client);
}

async function round() {
  const s = loadState();
  const phase = Number(process.env.PHASE_SECS ?? 30);
  const brain = await pickBrain();
  const p = parent();
  const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
  const usdc = (dollars: number) => BigInt(Math.round(dollars * 100)) * 10_000n;

  // The previous clearing price is public; agents may use it.
  const previous = await view<ContractRound[]>(s.market.id, 'get_latest_rounds', { limit: 5 });
  const lastPriceRaw = previous.find((r) => r.outcome?.price)?.outcome?.price ?? null;
  const lastPrice = lastPriceRaw === null ? null : BigInt(lastPriceRaw);

  // Buyers decide before the round opens (they only need the last price), so slow model
  // answers never eat into the join phase.
  const notes: RoundNotes = { brain: brain.name, buyers: {}, sellers: {} };
  console.log(`Agents deciding (${brain.name})…`);
  const orders = (
    await Promise.all(
      s.buyers.map(async (b) => {
        const balance = BigInt(await view<string>(s.token, 'ft_balance_of', { account_id: b.id }));
        const need = Math.floor(rand(2, 9));
        const valuePerUnit = usdc(rand(1.0, 1.9));
        const budget = [balance, BigInt(need) * valuePerUnit].reduce((x, y) => (x < y ? x : y));
        if (budget < 100_000n) {
          console.log(`  ${short(b.id)} skips: balance ${formatUsdc(balance)} is too low`);
          return null;
        }
        const d = await brain.buyer({ id: b.id, need, valuePerUnit, budget }, { lastPrice });
        notes.buyers[b.id] = { reasoning: d.reasoning, source: d.source };
        return { b, d };
      }),
    )
  ).filter((x) => x !== null);

  console.log(`Opening a round on ${s.market.id} (${phase}s per phase, agents: ${brain.name})…`);
  const roundId = await p.callFunction<number>({
    contractId: s.market.id,
    methodName: 'open_round',
    args: { unit: '1M tokens', join_secs: phase, commit_secs: phase, reveal_secs: phase, seller_bond: BOND.toString() },
    gas: GAS,
  });
  const r0 = await viewUntil<ContractRound | null>(s.market.id, 'get_round', { round_id: roundId }, (r) => r !== null, `round ${roundId}`) as ContractRound;
  console.log(`Round ${roundId} open. Watch it live: ${LIVE_SITE}/?contract=${s.market.id}`);


  // Join: each buyer locks qty × max price with ft_transfer_call. All buyers send at once.
  let joinedCount = 0;
  await Promise.all(
    orders.map(async ({ b, d }) => {
      const amount = BigInt(d.qty) * d.maxPrice;
      const res = await account(b.id, b.key).callFunctionRaw({
        contractId: s.token,
        methodName: 'ft_transfer_call',
        args: {
          receiver_id: s.market.id,
          amount: amount.toString(),
          // The buyer's reasoning is public anyway (joins are public), so it is recorded on-chain in the memo.
          memo: d.reasoning.slice(0, 120),
          msg: JSON.stringify({ round_id: roundId, qty: d.qty, max_price: d.maxPrice.toString() }),
        },
        deposit: 1n,
        gas: GAS_FT_CALL,
      });
      // ft_transfer_call returns the amount the coordinator kept; 0 means the join was rejected and refunded.
      const used = BigInt((getTransactionLastResult(res) as string | null) ?? '0');
      if (used === amount) joinedCount++;
      console.log(
        used === amount
          ? `  ${short(b.id)} joins: ${d.qty} units, max ${formatUsdc(d.maxPrice)} [${d.source}] "${d.reasoning}"  ${txLink(res)}`
          : `  ${short(b.id)} was refunded: the coordinator rejected the join (late or invalid)  ${txLink(res)}`,
      );
    }),
  );

  // Sellers read the public demand as soon as the joins land and decide while the join phase
  // is still running, so their model calls don't eat into the commit phase either.
  const joined = await viewUntil<ContractRound>(s.market.id, 'get_round', { round_id: roundId }, (r) => r.buyers.length >= joinedCount, 'the joins');
  const demand = joined.buyers.map((x) => ({ qty: x.qty, maxPrice: BigInt(x.max_price) }));
  const bids = await Promise.all(
    s.sellers.map(async (sel, i) => {
      const profile = { id: sel.id, cost: usdc(rand(0.8, 1.2)), capacity: Math.floor(rand(15, 45)) };
      const d = await brain.seller(profile, { lastPrice, demand });
      return {
        sel,
        price: d.price,
        capacity: d.capacity,
        reasoning: d.reasoning,
        source: d.source,
        salt: crypto.randomUUID(),
        // The last seller sometimes skips the reveal, to show the bond forfeit (always with SKIP_REVEAL=1).
        reveals: i < s.sellers.length - 1 || s.sellers.length === 1 || (process.env.SKIP_REVEAL !== '1' && Math.random() < 0.5),
      };
    }),
  );

  await waitUntil(BigInt(r0.join_end), 'commit phase');

  // Commit: post only the hash of each sealed bid, plus the bond.
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
      console.log(`  ${short(b.sel.id)} reveals ${formatUsdc(b.price)} × ${b.capacity} [${b.source}] "${b.reasoning}"  ${txLink(res)}`);
    }),
  );

  await waitUntil(BigInt(r0.reveal_end), 'clear');

  await p.callFunction({ contractId: s.market.id, methodName: 'clear', args: { round_id: roundId }, gas: teraToGas('100') });
  const out = await viewUntil<ContractRound>(s.market.id, 'get_round', { round_id: roundId }, (r) => r.outcome !== null, 'the result');
  const o = out.outcome!;
  if (o.price === null) console.log('\nNo clearing price: all escrow refunded.');
  else {
    const setter = out.price_set_by ?? '';
    const named = s.buyers.some((b) => b.id === setter) ? `${short(setter)}'s max price` : `${short(setter)}'s ask`;
    console.log(`\nCleared at ${formatUsdc(BigInt(o.price))} for ${o.demand} units (the price is ${named}):`);
    for (const f of out.fills) console.log(`  ${short(f.account_id)} sells ${f.units} units, earns ${formatUsdc(BigInt(f.payout))}`);
  }
  for (const st of o.settlements) {
    console.log(`  ${short(st.account_id)}: ${st.included ? `pays ${formatUsdc(BigInt(st.pay))}` : 'out'}, refund ${formatUsdc(BigInt(st.refund))}`);
  }
  if (out.bond_shares?.length) {
    console.log('Forfeited bond paid to the buyers:');
    for (const b of out.bond_shares) console.log(`  ${short(b.account_id)} receives ${formatNear(BigInt(b.amount))} NEAR`);
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

  // Publish the agents' reasoning for the live page. Written only now: before the reveal,
  // a seller's reasoning would leak its sealed price.
  for (const b of bids) notes.sellers[b.sel.id] = { reasoning: b.reasoning, source: b.source };
  const file = saveNotes(s.market.id, roundId, notes);
  console.log(`\nAgent reasoning saved to ${file}. Commit and push it to show it on the live page.`);
  console.log(`See it: https://hivebuy-six.vercel.app/?contract=${s.market.id} (or npm run dev, then http://localhost:5173/?contract=${s.market.id})`);
}

interface RoundNotes {
  brain: string;
  buyers: Record<string, { reasoning: string; source: string }>;
  sellers: Record<string, { reasoning: string; source: string }>;
}

/** apps/web/public/agent-notes/<contract>.json, one entry per round. Served by the live page. */
function saveNotes(contract: string, roundId: number, notes: RoundNotes): string {
  const dir = resolve('apps', 'web', 'public', 'agent-notes');
  const file = join(dir, `${contract}.json`);
  mkdirSync(dir, { recursive: true });
  const all = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { contract: string; rounds: Record<string, RoundNotes> }) : { contract, rounds: {} };
  all.rounds[String(roundId)] = notes;
  writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
  return file;
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

/** Deploys the current build over the running coordinator. No init call: the stored state is kept. */
async function upgrade() {
  const s = loadState();
  if (!existsSync(MARKET_WASM)) throw new Error('Build the contract first: cd contracts/market; cargo near build non-reproducible-wasm');
  const before = await view<ContractRound[]>(s.market.id, 'get_latest_rounds', { limit: 20 });
  console.log(`Upgrading ${s.market.id} (${before.length} rounds stored)…`);
  const res = await account(s.market.id, s.market.key).signAndSendTransaction({
    receiverId: s.market.id,
    actions: [actions.deployContract(readFileSync(MARKET_WASM))],
  });
  console.log(`  deployed  ${txLink(res)}`);
  const after = await viewUntil<ContractRound[]>(s.market.id, 'get_latest_rounds', { limit: 20 }, (r) => r.every((x) => 'fills' in x), 'the new code');
  if (after.length !== before.length) throw new Error(`Round count changed: ${before.length} → ${after.length}`);
  for (const r of after) {
    const old = before.find((x) => x.id === r.id)!;
    if (JSON.stringify(old.outcome) !== JSON.stringify(r.outcome)) throw new Error(`Round ${r.id} changed during the upgrade`);
  }
  console.log(`Done. All ${after.length} rounds read back unchanged, now with per-seller fills.`);
}

async function waitUntil(endNs: bigint, label: string) {
  const ms = Number(endNs / 1_000_000n) - Date.now() + 3_000;
  if (ms > 0) {
    console.log(`Waiting ${Math.ceil(ms / 1000)}s for the ${label}…`);
    await sleep(ms);
  }
}

const cmd = process.argv[2];
const run = cmd === 'setup' ? setup : cmd === 'round' ? round : cmd === 'status' ? status : cmd === 'upgrade' ? upgrade : null;
if (!run) {
  console.log('Usage: npm run testnet -- setup | round | status | upgrade');
  process.exit(1);
}
run().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
