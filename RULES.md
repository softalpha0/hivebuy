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

Inputs: buyers `(qty_i, max_i)` and revealed sellers `(price_j, capacity_j)`.

1. Sort revealed sellers by `price` ascending; ties go to the earlier commit.
2. For each seller `s` in that order:
   - `demand(s)` = sum of `qty_i` over buyers with `max_i >= s.price`.
   - If `demand(s) > 0` and `s.capacity >= demand(s)`: **`s` wins at `s.price`**. Stop.
3. If no seller qualifies, the round **fails**.

Result: one winner, one clearing price `p`, and the included buyers (those with `max_i >= p`). Each included buyer pays exactly `qty_i × p`.

**Worked example.** Buyers: A (10 @ ≤2.00), B (5 @ ≤1.50), C (20 @ ≤1.20). Sellers reveal: S1 (1.10, cap 20), S2 (1.40, cap 40), S3 (1.90, cap 100).
- S1 @ 1.10: demand = 35 > 20 → skip.
- S2 @ 1.40: demand = A 10 + B 5 = 15 ≤ 40 → **S2 wins at 1.40**. A pays 14.00 (refund 6.00), B pays 7.00 (refund 0.50), C pays nothing (refund 24.00).

## 5. Settlement

Settlement happens inside the coordinator in one step, so it cannot partly fail:

- Included buyer: `qty_i × p` is credited to the winner; `escrow_i − qty_i × p` is credited back to the buyer.
- Excluded buyer: the full escrow is credited back.
- Failed round: every buyer's full escrow is credited back.

Credits are withdrawn with `withdraw()`, which sends USDC to the caller. If the token transfer fails (for example the receiver is not registered with the USDC contract), the credit is restored and can be withdrawn again.

## 6. Bonds

- A seller that commits but does not reveal **forfeits its bond** to the market treasury (stops price-fishing and griefing).
- Every revealed seller gets its bond back at Clear, winner or not.

## 7. Simulation mode

- 20 buyers and 5 sellers with scripted strategies, no LLM calls, seeded so a run can be replayed exactly.
- Buyer strategies: fixed budget, value-based, bargain hunter. Seller strategies: cost-plus, undercutter (adapts to the last clearing price), premium, never-reveals (exercises the bond forfeit).
- Uses the same clearing code as the TypeScript engine, which is tested against the same vectors as the contract.

## 8. NEAR Intents (mainnet-ready, dry run)

NEAR Intents has no testnet. The live market therefore settles in the coordinator on testnet. For mainnet, `npm run intents:dry-run` turns a cleared round into one `transfer` intent per included buyer (`qty_i × p` USDC to the winner) and checks the batch against the real Verifier (`intents.near`) with `simulate_intents`, which changes no state.
