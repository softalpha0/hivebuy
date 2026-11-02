# Hivebuy — build plan

Working plan for NEAR Hackathon (Nov 1–14, 2026), AI Swarms track (`swarms`). Structure follows *Hackathon 101* (problem → MVP → schedule → submission).

## Problem

AI agents increasingly buy compute for the people and apps they serve. Each agent alone buys small amounts at list price from one provider, with no leverage and no way to make providers compete. Providers, in turn, cannot see pooled demand.

## User

A developer or small app that runs an agent needing a few million tokens of open-model inference per week, and inference providers who want to win that demand.

## Done statement

> Twenty buyer agents join a round on NEAR testnet and lock USDC for what they want; five provider agents submit sealed prices; after reveal, the coordinator contract picks the winner by the rules in `RULES.md`, each included buyer pays exactly `qty × clearing price`, the rest is refunded, and the live page shows the round from open to settlement.

## Scope (MoSCoW)

| | Feature |
|---|---|
| **Must** | `RULES.md` written before code |
| **Must** | Coordinator contract (Rust): open, join with USDC escrow, sealed commit with bond, reveal, clear, withdraw |
| **Must** | Same clearing rule in TypeScript, checked against shared test vectors |
| **Must** | Simulation: 20 buyers, 5 sellers, scripted strategies, no LLM, seeded and replayable |
| **Must** | Live page: rounds, bids, clearing price, who got what |
| **Must** | Each agent on its own sub-account (`buyer-1.hivebuy.testnet`, …) |
| **Should** | Script that runs one live round on testnet with real agent sub-accounts and testnet USDC |
| **Should** | NEAR Intents settlement adapter: builds the transfer intents for a cleared round and checks them with `simulate_intents` (dry run, no funds) |
| **Could** | Buyer agents that turn a plain-language request into `(qty, max_price)` with NEAR AI Cloud |
| **Could** | Winner posts a delivery reference per buyer (API key issued off-chain) |
| **Won't (now)** | Real provider integrations, mainnet deployment, reputation scores |

## User journey (judge)

1. Open the live page → press **Run simulation** → watch a round go Join → Commit → Reveal → Clear.
2. See sealed hashes turn into revealed prices, the clearing price, and each buyer's payment and refund.
3. Run more rounds → see sellers adapt and the clearing price move.
4. Optional: paste a testnet contract ID → see real on-chain rounds.

## Schedule (planned backwards from the deadline, Hackathon 101 ch. 13)

| Date | Work |
|---|---|
| Nov 2 | ✅ Rules, plan, clearing rule, contract, simulation, live page, testnet script, Intents dry run |
| Nov 3 | Create `hivebuy.testnet`, run `npm run testnet -- setup` and a first live round (docs/TESTNET.md) |
| Nov 4 | **Put the live page online** (first quarter of the event) |
| Nov 5–7 | Polish from your own testing; optional: rounds with several winners |
| Nov 8 | Optional NEAR AI buyer agents |
| Nov 9 | Polish, phone check, realistic demo data |
| **Nov 10** | **Feature freeze** — only fixes from here |
| Nov 11 | README pass for AI screeners, screenshots |
| Nov 12 | Demo video and X post (`@NEARProtocol #NEARHackathon`) |
| **Nov 13** | Repo public, submit (one day of buffer) |
| Nov 14 23:59 UTC | Deadline |
| until Nov 25 | Keep the live page online |

## Riskiest parts (build first)

1. Contract compiles and the escrow flow is correct (funds can't get stuck).
2. Rust and TypeScript clearing rules agree (shared vectors).
3. Testnet setup on a Windows machine (sub-accounts, USDC storage registration).

## Parking lot

- Multi-winner rounds (split demand across sellers at a uniform price).
- Buyer reputation for defaults; seller ratings after delivery.
- Mainnet settlement through NEAR Intents (`execute_intents`) once funds exist.
- Listing the coordinator as a service on Agent Market (market.near.ai).
