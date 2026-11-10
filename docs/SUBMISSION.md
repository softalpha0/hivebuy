# Submission checklist

Deadline: **2026-11-14 23:59 UTC**. Plan: submit on **Nov 13**. Re-read https://nearhackathon.com/HACKATHON.md first, since the rules can change.

## Fresh-clone check

Run on 2026-11-10 against `main` at commit `0486f51`, in an empty folder on Linux with Node 20.20.2 (the version CI uses):

```
git clone https://github.com/softalpha0/hivebuy && cd hivebuy
npm ci                # ok
npm run verify        # 57 TypeScript tests, typecheck, 32 contract tests, report = README headline: ok
npm run build         # ok
npm run dev           # serves the live page at http://localhost:5173: ok
git status            # clean: the report regenerated docs/RESULTS.md byte for byte
```

Repeat after the final commit: CI runs the same steps on every push.

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

Draft (thread; post 1 carries the video and everything the rules require):

> **1/** AI agents buy compute alone, at list price. Hivebuy lets them buy together on NEAR, and goes further than a plain group buy: 🧵
>
> Built at NEAR HACKATHON (AI Swarms + Agent Economy) @NEARProtocol #NEARHackathon
>
> **2/** Several providers share one order at one fair price, and every buyer names its own max. 17% more compute than a one-winner market over 200 simulated rounds; +34% over 12 live testnet rounds.
>
> **3/** Every agent is a real AI on NEAR AI Cloud with its own NEAR account, and its reasoning is published next to its bid. A provider that hides its sealed bid loses its bond to the buyers.
>
> **4/** Buyers actually get something: each redeems a provider-signed voucher with a real inference call, and the receipt is posted and confirmed on-chain.
>
> **5/** Don't trust us: the page re-runs the clearing rule on every on-chain round in your browser. Risks we measured live (providers anchoring on the last price) are in the mechanism notes.
>
> Live: https://hivebuy-six.vercel.app · Code: https://github.com/softalpha0/hivebuy

## Submission fields (you decide every value)

| Field | Value |
|---|---|
| Project name | Hivebuy |
| Team lead name | _you_ |
| Contact email | _you_ |
| Team size | `1` |
| Tracks | `swarms`, `agents` |
| NEAR account for the payout | `softalpha.near` (checked on mainnet on 2026-11-10: exists) |
| Repository | `https://github.com/softalpha0/hivebuy` |
| Demo post | _your X post link_ |
| What you built (20–2000 characters) | see below |
| Consent | "I agree that the organizers may use these details to review our submission and contact us about this hackathon." |

Draft for "what you built":

> Hivebuy is a group-buying market where AI agents buy inference together on NEAR. It goes beyond NEAR's AI Swarms example in five ways. (1) Several providers share one order at one uniform price, and each buyer names its own quantity and max, so the market clears a real demand curve: 17% more compute than a one-winner market across 200 simulated rounds, +34% across 12 live testnet rounds. (2) Every buyer and provider is a real AI agent on NEAR AI Cloud with its own NEAR sub-account, and its reasoning is published next to its bid. (3) Buyers get delivery: each redeems a provider-signed voucher with a real inference call, and the receipt is posted on-chain and confirmed by the buyer (12 of 12 confirmed live). (4) A provider that commits and never reveals forfeits its NEAR bond to the buyers. (5) Nothing is taken on trust: the live page re-runs the clearing rule on every on-chain round in the browser, and the mechanism notes measure risks we saw live, like providers anchoring on the last price. Under the hood: buyers lock USDC with ft_transfer_call; providers post sha256-sealed bids with a bond; a Rust coordinator clears and settles every payment in one step and was upgraded in place to v3 without losing a round. The same rule runs in Rust and TypeScript against shared test vectors (89 tests, CI green), and npm run verify reproduces every simulated number. Each payment is also prepared as a NEAR Intents transfer, checked with simulate_intents on intents.near.

The submission is sent once and can't be edited, so double-check every value.
