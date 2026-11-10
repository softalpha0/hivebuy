# Hivebuy

[![CI](https://github.com/softalpha0/hivebuy/actions/workflows/ci.yml/badge.svg)](https://github.com/softalpha0/hivebuy/actions/workflows/ci.yml)

**Group buying for AI agents on NEAR.** Buyer agents pool their demand for AI inference, provider agents submit sealed bids, and a coordinator contract on NEAR finds one fair price, splits the order across the cheapest providers, and settles every share in USDC.

**17% more compute bought than a one-winner market, and buyers paid 40% less than the most they offered (200 simulated rounds, seeds 42, 7, 123, 2026).** Reproduce: `npm run sim -- --report` · full table: [docs/RESULTS.md](docs/RESULTS.md).

<!-- live:start -->
**Live on NEAR testnet:** +34% more compute than a one-winner market, buyers paid 13% below their max, 4 of 12 rounds shared by 2+ providers (12 live testnet rounds on market.hivebuy.testnet, as of 2026-11-10). Every round: [docs/LIVE.md](docs/LIVE.md).
<!-- live:end -->

### Beyond the sample prompt

NEAR's own [AI Swarms example](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/05-swarms.md) describes a group-buying swarm with sealed bids. Hivebuy starts there and adds:

| The sample prompt describes | Hivebuy adds |
|---|---|
| A coordinator that picks **a winner** | **Several providers fill one order at one uniform price** (RULES.md §4). Live: 4 of 12 testnet rounds were shared by two providers |
| Buyers pooling demand | **Buyer demand curves**: each buyer locks its own quantity and max price, so the clearing price can be a buyer's own max |
| Scripted strategies for the simulation | **Real AI agents on NEAR AI Cloud** for live rounds, with each agent's reasoning published next to its bid (the scripted simulation stays, for reproducible numbers) |
| Sealed bids | **A provider that never reveals forfeits its NEAR bond to the buyers** it kept waiting (RULES.md §6) |
| Settlement | **Delivery receipts**: each buyer redeems a provider-signed voucher with a real inference call; the receipt is posted on-chain and the buyer confirms it (RULES.md §9). Live: 12 of 12 deliveries confirmed in rounds 11 and 12 |
| Not specified | **Verified in your browser**: the live page re-runs the clearing rule on every on-chain round and checks each payment against the contract |
| Not specified | **[Mechanism notes](docs/MECHANISM.md)** with live data: providers anchoring on the last price, measured round by round, and a minimal-information experiment |
| Not specified | **A live view** that follows each testnet round as it runs |

Built for NEAR Hackathon 2026: **AI Swarms** (`swarms`) and **Agent Economy** (`agents`) tracks.

- **Live demo:** https://hivebuy-six.vercel.app
- **Live round on NEAR testnet:** https://hivebuy-six.vercel.app/?contract=market.hivebuy.testnet
- **Market rules:** [RULES.md](RULES.md) · **Mechanism notes (design, risks, live data):** [docs/MECHANISM.md](docs/MECHANISM.md)
- **Demo video:** https://youtu.be/fybUcsyByqI

![Hivebuy live page: a cleared round with sealed and revealed bids](docs/screenshots/simulation.png)

---

## The problem

AI agents increasingly buy compute for the people and apps they serve. Each agent alone buys a small amount at list price from one provider: it has no leverage, and providers never compete for its demand. Providers, in turn, can't see the demand that exists across many small buyers.

## What Hivebuy does

Agents form a market round:

1. **Join.** Buyer agents say how many units they want (1 unit = 1M tokens of open-model inference) and the most they'll pay per unit. Each locks `qty × max price` in USDC in the coordinator contract.
2. **Commit.** Provider agents see the pooled demand and submit a **sealed** price and capacity (a sha256 commitment) with a NEAR bond.
3. **Reveal.** Providers reveal; the contract checks each reveal against its commitment. A provider that doesn't reveal loses its bond.
4. **Clear.** The contract tries prices from the cheapest up (every provider's ask and every buyer's max) and stops at the first one where the providers asking that much or less can together make every unit wanted at that price. Units go to the cheapest providers first, so **several providers can win**, all at the same price. Each included buyer pays exactly `qty × clearing price` and gets the rest of its escrow back; buyers who aren't included get everything back. Full rules: [RULES.md](RULES.md).

Every agent signs with its own NEAR sub-account (`buyer-1.hivebuy.testnet`, `seller-3.hivebuy.testnet`, …), so every on-chain action traces back to one agent.

## The agents

In live rounds the agents can think with a model on **NEAR AI Cloud** (`AGENTS=ai`, default model `z-ai/glm-5.3-flash`, which runs as private inference in a TEE):

- **Buyer agents** get their need, the value of a unit to them and a budget, and choose how many units to request and the most they'll pay. Their one-line reasoning is written on-chain in the memo of their `ft_transfer_call`.
- **Provider agents** see the public pooled demand, their own cost and capacity, and the last clearing price, and choose a sealed price. Their reasoning stays private until the round is over, because it would reveal the sealed price; it is then published next to the round on the live page.
- Every answer must match a JSON schema and is checked in code (budget, cost floor, capacity, price range). An invalid answer is retried once with the error; if it is still invalid, the agent falls back to its scripted rule and the page says so.

The simulation on the live page uses scripted agents only, so it runs in the browser with no API key.

## Try it (no wallet, no setup)

1. Open the live demo → see 10 simulated rounds between 20 buyer agents and 5 provider agents.
2. Click a round → see the sealed bids, the revealed prices, which providers sold how many units, and each buyer's payment and refund.
3. Read **Why this result** → see the clearing rule applied step by step (each price tried, and why it did or didn't clear).
4. Click **Replay round** → watch Join → Commit → Reveal → Clear.
5. Change the seed and press **Run simulation** → a new, replayable market.
6. Open **Live on testnet** → see real on-chain rounds decided by AI agents. While a round is running, the page follows it live: joins, sealed bids, reveals and the result appear by themselves, with a countdown for each phase.

## Run it locally

Requires Node.js 20 or newer and Rust (for the contract tests; see [docs/TESTNET.md](docs/TESTNET.md)). Works on Windows (PowerShell), macOS and Linux. One command checks everything:

```powershell
npm ci
npm run verify   # 57 TypeScript tests, typecheck, 32 contract tests, then reprints the README's simulated numbers
```

`npm run verify` ends by printing the headline above and regenerating [docs/RESULTS.md](docs/RESULTS.md); a test fails if the README, the landing page or that file disagree with the simulation. CI runs the same command on every push.

Other commands:

```powershell
npm run sim -- --seed 42  # the market in your terminal: 20 buyers, 5 sellers, no LLM calls
npm run dev               # live page at http://localhost:5173
npm test                  # TypeScript tests only (no Rust needed)
npm run contract:test     # contract tests only
```

Run real rounds on NEAR testnet: [docs/TESTNET.md](docs/TESTNET.md).

![A real round read from a NEAR testnet coordinator](docs/screenshots/testnet-round.png)

## What works today

| Feature | Status |
|---|---|
| Coordinator contract (Rust, near-sdk 5): rounds, USDC escrow via `ft_transfer_call`, sealed commit + bond, reveal, clear, withdraw | ✅ unit-tested, deployed and run on testnet |
| Same clearing rule in TypeScript, checked against shared test vectors with the contract | ✅ |
| Simulation: 20 buyers, 5 sellers, scripted strategies, seeded and replayable, no LLM calls | ✅ |
| Live page: rounds, sealed and revealed bids, clearing price chart, who paid what; follows running testnet rounds live; re-checks every on-chain round in the browser | ✅ simulation and testnet |
| Several providers per round on testnet, with AI agents (`--scenario multi`) | ✅ 4 of 12 live rounds shared ([docs/LIVE.md](docs/LIVE.md)) |
| Testnet script: creates the coordinator and agent sub-accounts, runs live rounds | ✅ |
| NEAR Intents settlement, dry run against the real mainnet Verifier | ✅ (`npm run intents:dry-run`) |
| AI agents on NEAR AI Cloud: buyers bid from their need and budget, providers price from demand and cost; schema-checked with a scripted fallback; reasoning shown on the live page | ✅ (`AGENTS=ai`, 8 unit tests with a mocked API) |
| Delivery receipts (contract v3): each provider signs a voucher per buyer; the buyer redeems it with one real NEAR AI Cloud call through the providers' endpoint (`api/provider.ts` on Vercel); the receipt hash goes on-chain (`post_delivery`) and the buyer confirms it (`confirm_delivery`) | ✅ live in rounds 11 and 12: 12 of 12 deliveries confirmed on-chain. Each voucher is redeemed with one call; metering a buyer's full units is next |

## How NEAR is used

| NEAR feature | How Hivebuy uses it |
|---|---|
| Smart contract (Rust, near-sdk 5) | The coordinator: escrow, sealed bids, clearing and settlement in one atomic step. Upgraded in place to v2 (several providers per round) without losing any stored round |
| Sub-accounts | One account per agent under one parent, so every bid and payment traces to an agent |
| NEP-141 + `ft_transfer_call` | Buyers join and fund escrow in one transaction; a failed join is refunded automatically |
| NEAR bonds (`#[payable]`) | Providers stake a bond with each sealed bid, forfeited if they don't reveal |
| NEAR Intents | Mainnet settlement path: one signed intent per buyer, paying each provider that sold its units, verified with `simulate_intents` on `intents.near` |
| NEAR AI Cloud | The agents' decisions (`z-ai/glm-5.3-flash`, private inference in a TEE) through the OpenAI-compatible API, and the inference each buyer receives on delivery |

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
| [packages/agents](packages/agents) | Agent brains: scripted rules and NEAR AI Cloud |
| [packages/delivery](packages/delivery) | Delivery vouchers, receipts and the provider endpoint's checks |
| [api/provider.ts](api/provider.ts) | The providers' delivery endpoint (a Vercel function) |
| [apps/web](apps/web) | Live page |
| [scripts](scripts) | Testnet runner and NEAR Intents dry run |
| [docs](docs) | Plan, testnet guide, deployment, demo script, submission checklist |

## How this was built

- **Dates:** November 1–14, 2026, during NEAR Hackathon 2026. Repository history: 26 commits from November 2 to November 10 so far.
- **First commit (Nov 2):** a large initial scaffold (46 files) produced with AI assistance from the plan in [docs/PLAN.md](docs/PLAN.md): the rules, the contract, the TypeScript engine, the simulation and the live page, all with tests. About half of its lines are `package-lock.json`.
- **Every later commit is incremental:** live testnet rounds, AI agents, several providers per round, browser verification, bonds to buyers, the live view, CI and the reproducible report, the rules mapped to tests, the mechanism notes, delivery receipts.
- **The contract was upgraded in place four times** on testnet (v1 → v2 several providers → v2.1 bonds to buyers → v3 delivery receipts). Each upgrade reads every stored round back and stops if one changed; the 12 live rounds are all still there.

## Hackathon disclosure

- Built during NEAR Hackathon 2026 (Nov 1–14). No code from before the event.
- AI-assisted: written with an AI coding assistant, reviewed and tested by the author.
- Libraries used: near-sdk and near-contract-standards (Rust), near-api-js, @noble/hashes, Vite, Vitest, tsx. Agent decisions use NEAR AI Cloud. `contracts/test-token` is adapted from the near-sdk-rs fungible-token example.
- Testnet only. No real funds are used.

## What's next

- Metering a buyer's full units through the provider endpoint, and disputes that move money (today they are recorded on-chain, not enforced).
- Mainnet settlement through NEAR Intents (`execute_intents`).

## License

[MIT](LICENSE)
