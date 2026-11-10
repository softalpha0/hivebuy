# Mechanism notes

How Hivebuy's market is designed, what can go wrong with it, and what we saw in the live rounds on NEAR testnet. The rules themselves are in [RULES.md](../RULES.md); every live round is listed in [LIVE.md](LIVE.md).

## 1. Why one uniform price

Every included buyer pays the same price per unit, and every provider that sells is paid that same price (RULES.md section 4).

- **Fair and easy to check.** Nobody pays more than their neighbour for the same unit. Anyone can recompute the result from the revealed bids; the live page does it in your browser for every round ("Verified in your browser").
- **Providers can bid close to cost.** A provider that sells below the clearing price earns the clearing price, not its own ask. So asking low never costs a sale it would otherwise make at a good price.
- **Several providers can share an order.** The price is the lowest candidate at which the cheapest providers can together serve everyone still willing to pay. Across 200 simulated rounds this buys 17% more compute than a market where one provider must serve everyone ([RESULTS.md](RESULTS.md)). In the 12 live rounds as of 2026-11-10 it was +34%, with 4 rounds shared by two providers ([LIVE.md](LIVE.md), regenerated from the contract by `npm run live:report`).

## 2. Why sealed bids with bonds

- **No copying.** During the commit phase providers post only `sha256(round:seller:price:capacity:salt)`. Nobody can see a rival's price and undercut it by a cent.
- **No free options.** A provider must attach a NEAR bond to commit. If it then hides its bid (for example because rivals look cheaper), it forfeits the bond.
- **The harmed side is paid.** A forfeited bond goes to the round's buyers, whose money was frozen for nothing, split by units locked (RULES.md section 6).

## 3. Known risks

### Tacit price convergence

Providers see the previous clearing price (it is public on-chain), so in repeated rounds they can anchor on it instead of on their costs, and drift towards one shared price without ever talking to each other.

**Observed live.** In 9 of the 10 rounds that had a previous price and showed it to providers (rounds 2 to 9, 11 and 12), at least one AI provider asked within 0.01 of the previous clearing price or of another provider ([LIVE.md](LIVE.md), "Convergence" column):

- seller-2 asked within 0.01 of the previous clearing price in rounds 2, 3, 4, 7, 8, 9 and 11; seller-3 did in round 12.
- Two providers asked exactly the same price in round 3 (1.28), round 6 (1.33), round 9 (1.52), round 10 (1.53) and round 11 (1.62). The tie rule (earlier on-chain commit fills first) decided each one. In round 11 the script's log printed seller-1's commit before seller-3's, but on-chain seller-3 committed first (`commit_index` 1 vs 2), so seller-3 filled first, as the rule says.
- The AI providers' own reasoning says it out loud: "Bidding just under last round's 1.33 clearing price…" (round 7), "Pricing just under last round's 1.44…" (round 8).

### Bid shading

Under a uniform price, a provider that expects to be inframarginal (cheaper than the price-setting ask) gains by asking more, up to just below the expected price. Live, in rounds 7 to 9 seller-2 stated costs of 1.11, 1.06 and 0.80 and asked 1.32, 1.43 and 1.42: it priced near the previous clearing price, not near cost. This raises prices for buyers but never above any included buyer's max.

### All-or-nothing buyer orders

A buyer is either included with its whole quantity or excluded; orders are never partly filled. In small rounds this makes the price jump. Round 12: seller-2 asked 1.12 with capacity 24, but 51 units were wanted at 1.12. At 1.58, 26 units were still wanted, 2 more than seller-2 could make, and buyer-7's 8-unit order could not be split. The price rose to 1.61, where 18 units fit; seller-2 sold all 18 at 1.61 and seven buyers were refunded in full. Every included buyer still paid less than its max. Allowing partial fills for buyers who opt in is a possible next step.

### Small rounds

Live rounds have 5 to 10 buyers and 3 providers. With so few providers, one large provider can serve everyone (round 8: seller-3 alone), and any single provider's choice moves the price. The simulation uses 20 buyers and 5 providers; the gap between the simulated and live columns on the landing page is mostly this.

### Agents run by one operator

On testnet, one script runs every buyer and provider agent (each with its own NEAR account and its own model call). They do not share information inside the script beyond what is public on-chain, but they are not independent businesses. A real deployment needs providers run by different parties.

### AI reasoning is not always consistent

The reasoning published next to each bid is the model's own explanation, unedited. It is usually consistent with the bid, but not always: in round 7 seller-3 wrote "Bidding below last round's 1.33 clear…" and bid 1.75. Bids are checked against the rules (price at least cost, capacity within limits); the reasoning is not.

## 4. Mitigations

| Mitigation | Status |
|---|---|
| Buyers' max prices act as reserve prices: nobody pays above their own max, and the price can never exceed the highest included max | Implemented (contract) |
| Ties at the clearing price go to the earlier commit, so equal asks cannot be split by bargaining | Implemented (contract) |
| Sealed bids and bonds: no copying, no hiding a bid for free | Implemented (contract) |
| Forfeited bonds go to the buyers | Implemented (contract) |
| Several providers share one order, so a cartel must include every provider needed to cover demand | Implemented (contract) |
| **Minimal information for providers**: `--info minimal` shows providers only the aggregate demand curve (units wanted at or above each price), not the previous clearing price or single orders | Implemented in the agents (`InfoPolicy`, tested in `packages/agents/test/agents.test.ts`). It limits what *our* agents are told; past results stay public on-chain, so it is not a defence against an agent that reads the chain itself |
| Randomised round timing, so providers cannot plan around a fixed schedule | Next |
| Open entry for new providers, and more providers per round | Next |
| A random reserve price per round, unknown to providers | Next |

## 5. What we measured

Live AI rounds on `market.hivebuy.testnet` as of 2026-11-10. Full rows, including every ask: [LIVE.md](LIVE.md).

| Round | Setup | Previous price | Clearing price | Sold by | Convergence |
|---|---|---|---|---|---|
| 1 | scripted, default | — | 1.28 | seller-3 | no |
| 2 | AI, default | 1.28 | 1.29 | seller-2 | seller-2 ≈ previous price |
| 3 | AI, default | 1.29 | 1.28 | seller-2 | tie at 1.28; both ≈ previous price |
| 4 | AI, default | 1.28 | 1.60 | seller-2 (price named by buyer-8's max) | seller-2 ≈ previous price |
| 5 | AI, default | 1.60 | 1.28 | seller-2 | no |
| 6 | AI, default | 1.28 | 1.33 | seller-2 | tie at 1.33 |
| 7 | AI, multi | 1.33 | 1.44 | seller-2 + seller-1 | seller-2 ≈ previous price |
| 8 | AI, multi | 1.44 | 1.43 | seller-3 | seller-2 ≈ previous price |
| 9 | AI, multi | 1.43 | 1.52 | seller-2 + seller-3 | tie at 1.52; seller-2 ≈ previous price |
| 10 | AI, multi, **minimal info** | 1.52 (not shown to providers) | 1.53 | seller-2 + seller-3 | tie at 1.53, just under buyer-5's max of 1.54 |
| 11 | AI, multi, delivery | 1.53 | 1.62 | seller-2 + seller-3 | tie at 1.62; seller-2 ≈ previous price |
| 12 | AI, multi, delivery | 1.62 | 1.61 | seller-2 (asked 1.12; see all-or-nothing orders) | seller-3 ≈ previous price |

In rounds 2 to 6 the test agent (seller-3) skipped its reveal on purpose to show the bond forfeit; rounds 7 to 12 ran with `SKIP_REVEAL=never`, so every provider revealed. Rounds 11 and 12 also ran delivery: 12 of 12 deliveries confirmed on-chain (RULES.md section 9).

### The minimal-information round (round 10)

With `--info minimal`, providers saw only the demand curve, not the previous clearing price (1.52). Their reasoning no longer mentions any previous price. But two of them still landed on the same ask: seller-2 and seller-3 both bid **1.53**, and both explain it as "just under 1.54", which is a step in the demand curve (buyer-5's max). The tie went to seller-2, which committed first.

So in this round, hiding the previous price removed anchoring on it, and the providers converged on a different focal point instead: the price just below a step in the demand curve. The 1.53 is within 0.01 of the hidden previous price only by coincidence (LIVE.md's automatic "Convergence" column flags it anyway). One round is not evidence either way. It does suggest that information policy alone moves where providers coordinate rather than stopping it. That is why the "next" mitigations above change the market itself (more providers, open entry, a random reserve price) rather than only what providers are told.
