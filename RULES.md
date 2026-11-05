# RULES.md — Hivebuy market rules (v1)

These are the market rules. The contract (`contracts/market`) and the TypeScript engine (`packages/core`) implement this file, and both are tested against the same vectors in `fixtures/clearing-vectors.json`. If code and this file disagree, this file wins until it is changed on purpose.

## 1. What is traded

One **unit** = 1 million tokens of open-model inference (for example Qwen, DeepSeek or GLM) on the winning provider's endpoint. Prices are in **USDC** (6 decimals), per unit.

Delivery (an API key with a spending limit matching the buyer's share) happens off-chain after settlement and is out of scope for v1.

## 2. Who takes part

| Role | Account | Does |
|---|---|---|
| Parent | `hivebuy.testnet` | Creates every agent account. |
| Coordinator | `market.hivebuy.testnet` | Contract. Runs rounds, holds escrow and bonds, clears, pays out. |
| Buyer agent | `buyer-<n>.hivebuy.testnet` | Wants `qty` units, pays at most `max_price` per unit. |
| Seller agent | `seller-<n>.hivebuy.testnet` | Offers up to `capacity` units at a sealed `price` per unit. |

Every action is signed by the agent's own account, so every on-chain action traces back to one agent.

## 3. One round

A round has an id, a unit label, and three deadlines (`join_end`, `commit_end`, `reveal_end`) set when it is opened.

| Phase | When | What happens |
|---|---|---|
| **Join** | until `join_end` | Buyers join by sending exactly `qty × max_price` USDC to the coordinator (`ft_transfer_call`). That amount is held in escrow. A buyer may leave before `join_end` and get it back. |
| **Commit** | until `commit_end` | Sellers submit `commitment = sha256("<round_id>:<seller_id>:<price>:<capacity>:<salt>")` (hex) and attach exactly `seller_bond` NEAR. Nobody can see prices. |
| **Reveal** | until `reveal_end` | Sellers reveal `(price, capacity, salt)`. The contract recomputes the hash and accepts only an exact match. |
| **Clear** | anyone, after `reveal_end` | The contract runs the clearing rule (section 4) and books every payment (section 5). |

Limits per round: at most 50 buyers and 10 sellers. One join per buyer, one commit per seller.

## 4. Clearing rule

Inputs: buyers `(qty_i, max_i)` and revealed sellers `(price_j, capacity_j)`. Several sellers can win a round; everyone trades at one price.

1. **Candidate prices**: every revealed `price_j`, plus every `max_i` at or above the cheapest revealed price. Sorted ascending.
2. For each candidate `p`, cheapest first:
   - `demand(p)` = sum of `qty_i` over buyers with `max_i >= p`.
   - `supply(p)` = sum of `capacity_j` over sellers with `price_j <= p`.
   - If `demand(p) = 0`: stop, the round **fails** (no buyer pays this much).
   - If `supply(p) >= demand(p)`: **`p` is the clearing price**. Stop.
3. If no candidate clears, the round **fails**.
4. **Fills**: the `demand(p)` units go to sellers with `price_j <= p`, cheapest first (ties: earlier commit), each up to its capacity. A seller can be partly filled, or get nothing if cheaper sellers already cover every unit.

Result: one clearing price `p`; the included buyers (those with `max_i >= p`), each paying exactly `qty_i × p`; and the fills, each seller paid `units × p`. What buyers pay always equals what sellers earn. The price is never higher than under a one-winner rule (cheapest single seller that can serve everyone at its own price).

**Worked example.** Buyers: A (10 @ ≤2.00), B (15 @ ≤1.50), C (20 @ ≤1.20). Sellers reveal: S1 (1.10, cap 20), S2 (1.40, cap 15), S3 (1.90, cap 100).
- 1.10 (S1's ask): demand 45, supply 20 → not enough.
- 1.20 (C's max): demand 45, supply 20 → not enough.
- 1.40 (S2's ask): demand A 10 + B 15 = 25, supply 20 + 15 = 35 → **clears at 1.40**.
- Fills: S1 sells 20 (earns 28.00), S2 sells 5 (earns 7.00). A pays 14.00 (refund 6.00), B pays 21.00 (refund 1.50), C pays nothing (refund 24.00).

With one winner only, S1 and S2 would both be too small and S3 would win at 1.90, serving just A. Sharing the round serves 25 units at 1.40 instead of 10 units at 1.90.

## 5. Settlement

Settlement happens inside the coordinator in one step, so it cannot partly fail:

- Included buyer: `escrow_i − qty_i × p` is credited back to the buyer.
- Each filled seller: `units_j × p` is credited to the seller. The contract checks that these add up to what the included buyers pay.
- Excluded buyer: the full escrow is credited back.
- Failed round: every buyer's full escrow is credited back.

Credits are withdrawn with `withdraw()`, which sends USDC to the caller. If the token transfer fails (for example the receiver is not registered with the USDC contract), the credit is restored and can be withdrawn again.

## 6. Bonds

- A seller that commits but does not reveal **forfeits its bond to the round's buyers**: their money was frozen for nothing, and the forfeit stops price-fishing and griefing.
- The forfeited NEAR is split among every buyer in the round (included or not) in proportion to the units each one locked, rounded down; the few yoctoNEAR of rounding dust go to the market treasury. With no buyers, the whole bond goes to the treasury.
- Every revealed seller gets its bond back at Clear, whether it sells or not.

## 7. Simulation mode

- 20 buyers and 5 sellers with scripted strategies, no LLM calls, seeded so a run can be replayed exactly.
- Buyer strategies: fixed budget, value-based, bargain hunter. Seller strategies: cost-plus, undercutter (adapts to the last clearing price), premium, never-reveals (exercises the bond forfeit).
- Uses the same clearing code as the TypeScript engine, which is tested against the same vectors as the contract.

## 8. NEAR Intents (mainnet-ready, dry run)

NEAR Intents has no testnet. The live market therefore settles in the coordinator on testnet. For mainnet, `npm run intents:dry-run` turns a cleared round into one signed intent per included buyer, paying `units × p` USDC to each seller that sold that buyer's units and checks the batch against the real Verifier (`intents.near`) with `simulate_intents`, which changes no state.
