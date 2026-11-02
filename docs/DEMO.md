# Demo video script (target 2:40, limit 3:00)

Structure from *Hackathon 101*, chapter 16: problem → solution → one journey → how it works → what's next. About 130 words per minute. Record the screen first, then the voice-over. Add captions.

**Setup before recording:** clean browser window, notifications off, zoom 125%. Open the live page and have a testnet round ready (`npm run testnet -- round` a few minutes before).

---

### 1. The problem (0:00–0:25)

*Screen: the Hivebuy page, top section.*

> "Picture an AI agent that needs a few million tokens of inference this week. It buys alone, at list price, from whichever provider it already uses. Twenty agents like it each do the same thing. Together they're a big customer, but nobody makes the providers compete for them."

### 2. The solution (0:25–0:40)

> "Hivebuy lets those agents buy together. They pool their demand, providers bid blind, and a NEAR contract picks the winner and settles every share in USDC."

### 3. The demo (0:40–2:00)

*Screen: click **Replay round** on round 1 of the simulation.*

> "Here are twenty buyer agents. Each one locks the most it would pay for what it needs. That's the escrow."

*Commit step: point at the sealed bids.*

> "Five provider agents see the pooled demand and submit sealed bids: just a hash, plus a NEAR bond. Nobody can see anyone's price."

*Reveal step.*

> "Now they reveal. The contract checks every reveal against its hash. This provider didn't reveal, so it loses its bond."

*Clear step: point at "Why this result".*

> "The contract checks the cheapest provider first. It can't serve everyone who'd pay its price, so it's skipped. The next one can, so it wins. Every included buyer pays exactly quantity times the clearing price, and gets the rest back."

*Switch to the Testnet contract tab, load your contract, show a cleared round.*

> "This isn't only a simulation. This is a real round on NEAR testnet: five buyer agents and three providers, each on its own sub-account, and every payment matches to the cent."

### 4. How it works (2:00–2:25)

*Screen: README "How NEAR is used" table, or the contract code.*

> "The coordinator is a Rust contract. Buyers join and fund escrow in one ft_transfer_call. Bids are sealed with sha256 and backed by a bond. Clearing and settlement happen in one atomic step. For mainnet, each payment becomes a signed NEAR Intents transfer, already verified against the real Verifier."

### 5. What's next (2:25–2:40)

> "Next: rounds with several winners, delivery receipts for the inference credits, and buyer agents that bid from a plain-language request. So agents don't have to buy alone."

---

**Checklist:** under 3:00 · captions on · public or unlisted · link tested in a private window.
