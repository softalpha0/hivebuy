# AGENTS.md — briefing for AI coding assistants

Read this first, then `RULES.md` and `docs/PLAN.md`.

## Project

**Hivebuy** — a group-buying swarm on NEAR. Buyer agents pool demand for AI inference credits, provider agents submit sealed bids, and a coordinator contract clears the round and settles each buyer's share in USDC.

- Hackathon: NEAR Hackathon, AI Swarms track (`swarms`). Deadline 2026-11-14 23:59 UTC.
- Network: NEAR **testnet** only (no paid services, no mainnet funds).
- Developer machine: Windows + PowerShell. Every script must also run on Windows.

## Layout

| Path | What |
|---|---|
| `RULES.md` | Market rules. Source of truth for the clearing rule and settlement. |
| `fixtures/clearing-vectors.json` | Shared test cases. Rust and TypeScript must both pass them. |
| `contracts/market` | Rust coordinator contract (near-sdk 5). |
| `contracts/test-token` | tUSDC, test-only USDC stand-in for testnet. |
| `packages/core` | TypeScript clearing rule, commitment hash, types. |
| `packages/sim` | Simulation: 20 buyers, 5 sellers, scripted strategies, seeded. |
| `apps/web` | Live page (Vite). Runs the simulation in the browser or reads a testnet contract. |
| `scripts/testnet.ts` | Testnet runner: `npm run testnet -- setup`, `round`, `status` (docs/TESTNET.md). |
| `scripts/intents-dry-run.ts` | NEAR Intents settlement checked with `simulate_intents` on mainnet. |

## Rules for changes

- Change `RULES.md` first, then the code, then the vectors. Never change one implementation of the clearing rule without the other.
- Build one feature at a time. After each: `npm test`, `npm run typecheck`, `cargo test` in `contracts/market`.
- Amounts are integers in the smallest USDC unit (6 decimals), as strings in JSON. Never use floats for money.
- Never commit keys, seed phrases or `.env`. Add new variables to `.env.example`.
- Read the official docs before using a NEAR API: https://docs.near.org/llms.txt and https://docs.near-intents.org/llms.txt.
- Explain errors before fixing them. Keep the README honest: only list features that work.
