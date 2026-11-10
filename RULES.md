# RULES.md — Hivebuy market rules (v2)

These are the market rules. The contract (`contracts/market`) and the TypeScript engine (`packages/core`) implement this file, and both are tested against the same vectors in `fixtures/clearing-vectors.json`. If code and this file disagree, this file wins until it is changed on purpose.

**Proof for each rule.** Rules end with *Tested by* and the test that checks them. `tests.rs::name` is a Rust test in `contracts/market/src/tests.rs` (run with `npm run contract:test`); `clearing.test.ts › name` is a TypeScript test in `packages/core/test/clearing.test.ts` (run with `npm test`). `npm run verify` runs all of them.

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

A round has an id, a unit label, and three deadlines set when the owner opens it: **`join_end < commit_end < reveal_end`**. Each phase must last more than zero seconds, so the order is always strict. *Tested by* `tests.rs::deadlines_are_strictly_ordered`.

| Phase | When | What happens |
|---|---|---|
| **Join** | until `join_end` | Buyers join by sending exactly `qty × max_price` USDC to the coordinator (`ft_transfer_call`). That amount is held in escrow. A buyer may leave before `join_end` and get it back. |
| **Commit** | from `join_end` until `commit_end` | Sellers submit a commitment (below) and attach exactly `seller_bond` NEAR. Nobody can see prices. |
| **Reveal** | from `commit_end` until `reveal_end` | Sellers reveal `(price, capacity, salt)`. The contract recomputes the hash and accepts only an exact match. |
| **Clear** | anyone, after `reveal_end` | The contract runs the clearing rule (section 4) and books every payment (section 5). |

*Tested by* `tests.rs::commit_during_join_is_rejected`, `tests.rs::commit_without_bond_is_rejected`, `tests.rs::clear_too_early_is_rejected`, `tests.rs::clear_twice_is_rejected`, `tests.rs::leave_before_join_end_credits_escrow`, `tests.rs::join_with_wrong_amount_is_rejected`, `tests.rs::join_from_other_token_is_rejected`, `tests.rs::only_owner_opens_rounds`.

**Commitment encoding.** `commitment = sha256("<round_id>:<seller_id>:<price>:<capacity>:<salt>")`, written as 64 lowercase hex characters.
- `price` is an integer in **micro-USDC** (6 decimals, no separators): 1.40 USDC is `1400000`.
- `capacity` is an integer number of units.
- `salt` is any UTF-8 string of **1 to 64 characters**; 32 random hex characters are recommended. A reveal with a longer or empty salt is rejected.
- Example: round 7, `seller-2.hivebuy.testnet`, price `1400000`, capacity 40, salt `s3cret-salt` → `4bf31ff2…2a17f25` (full value in `fixtures/clearing-vectors.json`).

*Tested by* `tests.rs::shared_commitment_vectors`, `tests.rs::salt_longer_than_64_chars_is_rejected`, `clearing.test.ts › commitment hash (shared vectors)`, `clearing.test.ts › commitment salt`.

**Invalid reveal.** A reveal that doesn't match the commitment is rejected and changes nothing, so the seller can try again until `reveal_end`. There is no penalty for a wrong attempt; the bond is forfeited only if no valid reveal arrives by `reveal_end` (section 6). *Tested by* `tests.rs::wrong_reveal_is_rejected`, `tests.rs::reveal_mismatch_can_retry`.

**If nobody calls `clear()`.** `clear()` is permissionless after `reveal_end`, and escrow stays safe in the contract until someone calls it. The operator's script (`npm run testnet -- round`) clears every round it opens. As a fallback, if a round is still open more than one hour after its `reveal_end`, a buyer agent of that round clears it (the script checks before each new round and on `npm run testnet -- status`). *Tested by* `tests.rs::clear_is_permissionless_after_reveal_end`.

**Limits per round.** At most 50 buyers and 10 sellers; one join per buyer, one commit per seller.
- A 51st buyer's join panics inside `ft_on_transfer`, so the USDC token contract refunds the full amount automatically (NEP-141).
- An 11th commit panics, so the attached bond is never taken.

*Tested by* `tests.rs::round_full_rejects_51st_buyer`, `tests.rs::round_full_rejects_11th_seller`.

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

*Tested by* `tests.rs::worked_example_end_to_end`, `tests.rs::shared_clearing_vectors` (13 cases shared with TypeScript), `clearing.test.ts › clearing rule (shared vectors)`, `clearing.test.ts › never charges more than the one-winner rule did, on 2,000 random rounds`.

## 5. Settlement

Settlement happens inside the coordinator in one step, so it cannot partly fail:

- Included buyer: `escrow_i − qty_i × p` is credited back to the buyer.
- Each filled seller: `units_j × p` is credited to the seller. The contract checks that these add up to what the included buyers pay.
- Excluded buyer: the full escrow is credited back.
- Failed round: every buyer's full escrow is credited back.

Credits are withdrawn with `withdraw()`, which sends USDC to the caller. If the token transfer fails (for example the receiver is not registered with the USDC contract), the credit is restored and can be withdrawn again.

*Tested by* `tests.rs::escrow_is_conserved`, `tests.rs::failed_round_refunds_everyone`, `tests.rs::failed_withdraw_restores_credit`, `clearing.test.ts › settlement invariants`.

## 6. Bonds

- A seller that commits but has no valid reveal by `reveal_end` **forfeits its bond to the round's buyers**: their money was frozen for nothing, and the forfeit stops price-fishing and griefing.
- **Who shares it:** every buyer still in the round at Clear, included or not, in proportion to the `qty` each one locked, rounded down. Buyers who left before `join_end` are not counted. The few yoctoNEAR of rounding dust go to the market treasury; with no buyers, the whole bond goes to the treasury.
- **Failed rounds too:** if no price clears, non-revealing sellers still forfeit to the buyers present (who also get their full escrow back).
- Every revealed seller gets its bond back at Clear, whether it sells or not.

*Tested by* `tests.rs::unrevealed_seller_forfeits_bond`, `tests.rs::forfeited_bond_is_split_by_units_and_dust_goes_to_treasury`, `tests.rs::bond_split_ignores_buyers_who_left`, `tests.rs::failed_round_still_pays_forfeited_bonds_to_buyers`, `tests.rs::bond_split_never_overflows_or_overpays`, `clearing.test.ts › bond shares`.

## 7. Simulation mode

- 20 buyers and 5 sellers with scripted strategies, no LLM calls, seeded so a run can be replayed exactly.
- Buyer strategies: fixed budget, value-based, bargain hunter. Seller strategies: cost-plus, undercutter (adapts to the last clearing price), premium, never-reveals (exercises the bond forfeit).
- Uses the same clearing code as the TypeScript engine, which is tested against the same vectors as the contract.

## 8. NEAR Intents (mainnet-ready, dry run)

NEAR Intents has no testnet. The live market therefore settles in the coordinator on testnet. For mainnet, `npm run intents:dry-run` turns a cleared round into one signed intent per included buyer, paying `units × p` USDC to each seller that sold that buyer's units and checks the batch against the real Verifier (`intents.near`) with `simulate_intents`, which changes no state.
