import type { ViewRound } from './model.js';

// rpc.testnet.near.org is deprecated; FastNEAR is the free testnet endpoint listed in the NEAR docs.
const RPC = 'https://test.rpc.fastnear.com';

/** Contract JSON (see contracts/market/src/lib.rs `Round`). */
interface ContractRound {
  id: number;
  unit: string;
  join_end: string;
  commit_end: string;
  reveal_end: string;
  buyers: { account_id: string; qty: number; max_price: string; escrow: string }[];
  sellers: {
    account_id: string;
    commitment: string;
    commit_index: number;
    revealed: { price: string; capacity: number } | null;
  }[];
  status: 'Open' | 'Cleared' | 'Failed';
  outcome: {
    winner: string | null;
    price: string | null;
    demand: number;
    settlements: { account_id: string; included: boolean; pay: string; refund: string }[];
  } | null;
}

async function view<T>(contract: string, method: string, args: object): Promise<T> {
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
        account_id: contract,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`RPC answered ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.data ?? body.error.message ?? 'RPC error');
  if (body.result?.error) throw new Error(body.result.error);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result))) as T;
}

function phaseOf(r: ContractRound, nowNs: bigint): ViewRound['phase'] {
  if (r.status === 'Cleared') return 'cleared';
  if (r.status === 'Failed') return 'failed';
  if (nowNs < BigInt(r.join_end)) return 'join';
  if (nowNs < BigInt(r.commit_end)) return 'commit';
  if (nowNs < BigInt(r.reveal_end)) return 'reveal';
  return 'clearable';
}

export async function loadTestnetRounds(contract: string): Promise<ViewRound[]> {
  const rounds = await view<ContractRound[]>(contract, 'get_latest_rounds', { limit: 20 });
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  return rounds
    .map((r): ViewRound => {
      const phase = phaseOf(r, nowNs);
      const revealedIds = new Set(r.sellers.filter((s) => s.revealed).map((s) => s.account_id));
      return {
        id: r.id,
        unit: r.unit,
        source: 'testnet',
        phase,
        buyers: r.buyers.map((b) => ({
          id: b.account_id,
          qty: b.qty,
          maxPrice: BigInt(b.max_price),
          escrow: BigInt(b.escrow),
        })),
        sellers: r.sellers.map((s) => ({
          id: s.account_id,
          commitIndex: s.commit_index,
          commitment: s.commitment,
          revealed: s.revealed ? { price: BigInt(s.revealed.price), capacity: s.revealed.capacity } : null,
        })),
        result: r.outcome
          ? {
              winner: r.outcome.winner,
              price: r.outcome.price === null ? null : BigInt(r.outcome.price),
              demand: r.outcome.demand,
              settlements: r.outcome.settlements.map((s) => ({
                id: s.account_id,
                included: s.included,
                pay: BigInt(s.pay),
                refund: BigInt(s.refund),
              })),
            }
          : null,
        forfeited: r.outcome ? r.sellers.filter((s) => !revealedIds.has(s.account_id)).map((s) => s.account_id) : [],
      };
    })
    .sort((a, b) => a.id - b.id);
}
