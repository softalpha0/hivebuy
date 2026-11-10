/**
 * Vercel function: the providers' delivery endpoint (RULES.md section 9). POST /api/provider.
 * All checks live in packages/delivery/src/provider.ts; this file only wires them to the outside.
 *
 * Environment (Vercel → Project → Settings → Environment Variables; mark the keys as Secret):
 *   PROVIDER_KEYS    JSON {"seller-1.hivebuy.testnet":"ed25519:…", …}: testnet seller keys only.
 *   NEARAI_API_KEY   NEAR AI Cloud key used for the buyers' inference calls.
 *   MARKET_CONTRACT  optional, default market.hivebuy.testnet
 *   NEARAI_MODEL, NEARAI_BASE_URL, NEAR_RPC_URL   optional overrides.
 */
import { Account, JsonRpcProvider, KeyPairSigner, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { type ChainRound, handleProvider } from '../packages/delivery/src/provider.js';

const RPC = process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com';
const CONTRACT = process.env.MARKET_CONTRACT || 'market.hivebuy.testnet';
const NEARAI = process.env.NEARAI_BASE_URL || 'https://cloud-api.near.ai/v1';
const MODEL = process.env.NEARAI_MODEL || 'z-ai/glm-5.3-flash';

async function rpc(params: object): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'provider', method: 'query', params: { finality: 'final', ...params } }),
    signal: AbortSignal.timeout(15_000),
  });
  return (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
}

async function getRound(roundId: number): Promise<ChainRound | null> {
  const body = await rpc({
    request_type: 'call_function',
    account_id: CONTRACT,
    method_name: 'get_round',
    args_base64: Buffer.from(JSON.stringify({ round_id: roundId })).toString('base64'),
  });
  const bytes = body.result?.result as number[] | undefined;
  if (!bytes) throw new Error('could not read the round from NEAR testnet');
  return JSON.parse(Buffer.from(bytes).toString()) as ChainRound | null;
}

async function hasAccessKey(accountId: string, publicKey: string): Promise<boolean> {
  const body = await rpc({ request_type: 'view_access_key', account_id: accountId, public_key: publicKey });
  return !!body.result && !body.error && !('error' in (body.result ?? {}));
}

async function infer(prompt: string) {
  const key = process.env.NEARAI_API_KEY;
  if (!key) throw new Error('NEARAI_API_KEY is not set on this deployment');
  const res = await fetch(`${NEARAI}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      // GLM-5.3 Flash reasons by default; cap it so each delivery stays cheap.
      thinking_token_budget: 256,
      max_tokens: 400,
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) throw new Error(`NEAR AI answered ${res.status}`);
  const body = (await res.json()) as {
    model?: string;
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const completion = body.choices?.[0]?.message?.content?.trim();
  if (!completion) throw new Error('NEAR AI returned no completion');
  return { model: body.model ?? MODEL, completion, promptTokens: body.usage?.prompt_tokens ?? 0, completionTokens: body.usage?.completion_tokens ?? 0 };
}

async function postDelivery(seller: string, key: KeyPairString, roundId: number, buyer: string, receiptHash: string) {
  const account = new Account(seller, new JsonRpcProvider({ url: RPC }), KeyPairSigner.fromSecretKey(key));
  const res = await account.callFunctionRaw({
    contractId: CONTRACT,
    methodName: 'post_delivery',
    args: { round_id: roundId, buyer, receipt_hash: receiptHash },
    gas: teraToGas('30'),
  });
  return { tx: res.transaction.hash };
}

function sellerKeys(): Record<string, KeyPairString> {
  try {
    return JSON.parse(process.env.PROVIDER_KEYS || '{}') as Record<string, KeyPairString>;
  } catch {
    return {};
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'GET') {
      // Health check: which sellers this endpoint serves (account names only, never keys).
      return Response.json({ contract: CONTRACT, sellers: Object.keys(sellerKeys()), model: MODEL, inference: !!process.env.NEARAI_API_KEY });
    }
    if (request.method !== 'POST') return Response.json({ error: 'use POST' }, { status: 405 });
    try {
      const input = await request.json().catch(() => null);
      const out = await handleProvider(input, { contract: CONTRACT, sellerKeys: sellerKeys(), getRound, hasAccessKey, infer, postDelivery });
      return Response.json(out.body, { status: out.status });
    } catch (e) {
      // Never echo keys or env: only the error message.
      return Response.json({ error: e instanceof Error ? e.message : 'provider error' }, { status: 502 });
    }
  },
};
