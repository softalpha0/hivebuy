# Hivebuy

**Group buying for AI agents on NEAR.** Buyer agents pool their demand for AI inference, provider agents submit sealed bids, and a coordinator contract on NEAR picks the winner and settles each buyer's share in USDC.

Built for NEAR Hackathon 2026, **AI Swarms track** (`swarms`).

- **Live demo:** _add your hosted link here (see docs/DEPLOY.md)_
- **Market rules:** [RULES.md](RULES.md)
- **Demo video:** _add your X post link here_

![Hivebuy live page: a cleared round with sealed and revealed bids](docs/screenshots/simulation.png)

---

## The problem

AI agents increasingly buy compute for the people and apps they serve. Each agent alone buys a small amount at list price from one provider: it has no leverage, and providers never compete for its demand. Providers, in turn, can't see the demand that exists across many small buyers.

## What Hivebuy does

Agents form a market round:

1. **Join.** Buyer agents say how many units they want (1 unit = 1M tokens of open-model inference) and the most they'll pay per unit. Each locks `qty × max price` in USDC in the coordinator contract.
2. **Commit.** Provider agents see the pooled demand and submit a **sealed** price and capacity (a sha256 commitment) with a NEAR bond.
3. **Reveal.** Providers reveal; the contract checks each reveal against its commitment. A provider that doesn't reveal loses its bond.
4. **Clear.** The contract checks providers from cheapest up. The first one with enough capacity for every buyer willing to pay its price wins at that price. Each included buyer pays exactly `qty × clearing price`; everyone gets the rest of their escrow back. Buyers who aren't included get everything back.

Every agent signs with its own NEAR sub-account (`buyer-1.hivebuy.testnet`, `seller-3.hivebuy.testnet`, …), so every on-chain action traces back to one agent.

## Try it (no wallet, no setup)

1. Open the live demo → see 10 simulated rounds between 20 buyer agents and 5 provider agents.
2. Click a round → see the sealed bids, the revealed prices, the winner, and each buyer's payment and refund.
3. Read **Why this result** → see the clearing rule applied step by step (which provider was skipped and why).
4. Click **Replay round** → watch Join → Commit → Reveal → Clear.
5. Change the seed and press **Run simulation** → a new, replayable market.
6. Open the **Testnet contract** tab and enter a coordinator account → see real on-chain rounds.

## Run it locally

Requires Node.js 20 or newer. Works on Windows (PowerShell), macOS and Linux.

```powershell
npm install
npm test                  # 18 TypeScript tests: clearing rule, shared vectors, simulation
npm run sim -- --seed 42  # the market in your terminal: 20 buyers, 5 sellers, no LLM calls
npm run dev               # live page at http://localhost:5173
```

Contract tests (Rust, see [docs/TESTNET.md](docs/TESTNET.md) for installing Rust):

```powershell
npm run contract:test     # 16 tests, including the same shared vectors as TypeScript
```

Run real rounds on NEAR testnet: [docs/TESTNET.md](docs/TESTNET.md).

![A real round read from a NEAR testnet coordinator](docs/screenshots/testnet-round.png)

## What works today

| Feature | Status |
|---|---|
| Coordinator contract (Rust, near-sdk 5): rounds, USDC escrow via `ft_transfer_call`, sealed commit + bond, reveal, clear, withdraw | ✅ unit-tested, deployed and run on testnet |
| Same clearing rule in TypeScript, checked against shared test vectors with the contract | ✅ |
| Simulation: 20 buyers, 5 sellers, scripted strategies, seeded and replayable, no LLM calls | ✅ |
| Live page: rounds, sealed and revealed bids, clearing price chart, who paid what | ✅ simulation and testnet |
| Testnet script: creates the coordinator and agent sub-accounts, runs live rounds | ✅ |
| NEAR Intents settlement, dry run against the real mainnet Verifier | ✅ (`npm run intents:dry-run`) |
| Delivery of inference credits (API key with a spending limit) | ⏳ off-chain, not in v1 |

## How NEAR is used

| NEAR feature | How Hivebuy uses it |
|---|---|
| Smart contract (Rust, near-sdk 5) | The coordinator: escrow, sealed bids, clearing and settlement in one atomic step |
| Sub-accounts | One account per agent under one parent, so every bid and payment traces to an agent |
| NEP-141 + `ft_transfer_call` | Buyers join and fund escrow in one transaction; a failed join is refunded automatically |
| NEAR bonds (`#[payable]`) | Providers stake a bond with each sealed bid, forfeited if they don't reveal |
| NEAR Intents | Mainnet settlement path: one signed `transfer` intent per buyer to the winner, verified with `simulate_intents` on `intents.near` |

**About the NEAR Intents dry run.** NEAR Intents has no testnet, so the live market settles inside the coordinator on testnet. `npm run intents:dry-run` takes a cleared round, signs one NEP-413 `transfer` intent per included buyer, and sends the batch to `simulate_intents` on the real mainnet Verifier. The Verifier accepts the signatures and nonces and rejects only for missing balance (the fresh agent accounts hold no USDC). With a corrupted signature it answers `invalid signature`, which shows the signatures really are checked.

## Repository layout

| Path | What |
|---|---|
| [RULES.md](RULES.md) | Market rules (written before any code) |
| [fixtures/clearing-vectors.json](fixtures/clearing-vectors.json) | Test cases shared by the Rust and TypeScript tests |
| [contracts/market](contracts/market) | Coordinator contract |
| [contracts/test-token](contracts/test-token) | tUSDC, a test-only USDC stand-in for testnet |
| [packages/core](packages/core) | Clearing rule, commitment hash, USDC formatting |
| [packages/sim](packages/sim) | Agent simulation |
| [apps/web](apps/web) | Live page |
| [scripts](scripts) | Testnet runner and NEAR Intents dry run |
| [docs](docs) | Plan, testnet guide, deployment, demo script, submission checklist |

## Hackathon disclosure

- Built during NEAR Hackathon 2026 (Nov 1–14). No code from before the event.
- AI-assisted: written with an AI coding assistant, reviewed and tested by the author.
- Libraries used: near-sdk and near-contract-standards (Rust), near-api-js, @noble/hashes, Vite, Vitest, tsx. `contracts/test-token` is adapted from the near-sdk-rs fungible-token example.
- Testnet only. No real funds are used.

## What's next

- Rounds with several winners at one uniform price.
- Delivery receipts: the winner posts a reference for each buyer's API key; buyers confirm.
- Buyer agents that turn a plain-language request into a bid with NEAR AI Cloud.
- Mainnet settlement through NEAR Intents (`execute_intents`).

## License

[MIT](LICENSE)
