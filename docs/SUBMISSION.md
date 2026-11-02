# Submission checklist

Deadline: **2026-11-14 23:59 UTC**. Plan: submit on **Nov 13**. Re-read https://nearhackathon.com/HACKATHON.md first, since the rules can change.

## Before submitting

- [ ] `npm test`, `npm run typecheck` and `npm run contract:test` pass
- [ ] Coordinator deployed on testnet and at least one live round cleared (`npm run testnet -- round`)
- [ ] Live page online (docs/DEPLOY.md); link added to the README
- [ ] Opened the live link on a phone using mobile data, and in a private window
- [ ] README: live link, video link, "What works today" is accurate
- [ ] No secrets in the repo: `.env`, `.hivebuy/` and any key files are not committed (`git status` before pushing)
- [ ] `LICENSE` present
- [ ] Repository is **public**

## Demo post on X (you write and publish it)

Must say it was built at NEAR HACKATHON, tag **@NEARProtocol** and **#NEARHackathon**, and attach the video. Optional: @NearLegion, @NearBuilders.

Draft:

> AI agents shouldn't have to buy compute alone.
>
> Hivebuy: buyer agents pool demand for inference, providers bid blind, and a NEAR contract picks the winner and settles every share in USDC. Each agent has its own sub-account; settlement is ready for NEAR Intents.
>
> Built at NEAR HACKATHON for the AI Swarms track @NEARProtocol #NEARHackathon
>
> Live demo: <link> · Code: <repo>
> What would you want agents to buy together?

## Submission fields (you decide every value)

| Field | Value |
|---|---|
| Project name | Hivebuy |
| Team lead name | _you_ |
| Contact email | _you_ |
| Team size | `1` |
| Tracks | `swarms` (optionally `agents`) |
| NEAR account for the payout | `softalpha.near` |
| Repository | `https://github.com/softalpha0/hivebuy` |
| Demo post | _your X post link_ |
| What you built (20–2000 characters) | see below |
| Consent | "I agree that the organizers may use these details to review our submission and contact us about this hackathon." |

Draft for "what you built":

> AI agents buy compute alone, at list price, with no leverage. Hivebuy is a group-buying market for agents on NEAR. Buyer agents join a round and lock USDC in escrow for the inference they want; provider agents see the pooled demand and submit sealed bids (sha256 commitment + NEAR bond); after reveal, a Rust coordinator contract picks the cheapest provider that can serve every buyer willing to pay its price, and settles in one atomic step: each included buyer pays exactly quantity × clearing price and gets the rest back. Every agent signs from its own sub-account. The same clearing rule runs in TypeScript and Rust against shared test vectors, a simulation runs 20 buyers and 5 sellers with no LLM calls, the live page shows every round, and a script runs real rounds on NEAR testnet. For mainnet, each payment becomes a signed NEAR Intents transfer, already verified with simulate_intents on intents.near.

The submission is sent once and can't be edited, so double-check every value.
