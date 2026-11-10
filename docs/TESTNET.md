# Running Hivebuy on NEAR testnet

Everything here is free. Commands are for **Windows PowerShell**; they also work on macOS and Linux unless noted.

Time needed: about 30 minutes the first time, mostly installing Rust.

## 1. Install the tools (once)

1. **Node.js 20 or newer:** https://nodejs.org (LTS). Check: `node -v`
2. **Rust:** download and run `rustup-init.exe` from https://rustup.rs. On Windows it asks to install the Visual Studio C++ build tools; accept. Close and reopen PowerShell, then check: `cargo --version`
   - If Rust gives you trouble on Windows, use WSL (Ubuntu) for the contract steps instead.
3. **NEAR CLI:**
   ```powershell
   npm install -g near-cli-rs@latest
   near --version
   ```
4. **cargo-near** (builds NEAR contracts):
   ```powershell
   npm install -g cargo-near
   cargo near --version
   ```
   If that fails, install from source instead: `cargo install --locked cargo-near`

## 2. Install and test the project

From the project folder:

```powershell
npm install
npm test
npm run contract:test
```

The first `contract:test` downloads Rust 1.86 (pinned in `contracts/market/rust-toolchain.toml`) and takes a few minutes.

## 3. Create the parent account

The faucet creates a funded testnet account (10 NEAR) for free:

```powershell
near account create-account sponsor-by-faucet-service hivebuy.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

If `hivebuy.testnet` is taken, pick another name and use it everywhere below.

The key is saved in `%USERPROFILE%\.near-credentials\testnet\hivebuy.testnet.json`. The scripts read it from there. Never commit or share this file.

## 4. Build the contracts

```powershell
cd contracts\market
cargo near build non-reproducible-wasm
cd ..\test-token
cargo near build non-reproducible-wasm
cd ..\..
```

## 5. Configure

```powershell
Copy-Item .env.example .env
notepad .env
```

Set `PARENT_ACCOUNT=hivebuy.testnet`. Leave `TOKEN=test` to use the test token (tUSDC).

**Using Circle's testnet USDC instead (optional):** get 20 USDC from https://faucet.circle.com (choose NEAR testnet, send to `hivebuy.testnet`), then set `TOKEN=circle`. Each buyer receives 4 USDC.

## 6. Set up the market (once)

```powershell
npm run testnet -- setup
```

This creates, under your parent account:

- `market.hivebuy.testnet`: the coordinator contract, deployed and initialized
- `tusdc.hivebuy.testnet`: the test token (only with `TOKEN=test`)
- `buyer-1` … `buyer-5` and `seller-1` … `seller-3`: one sub-account per agent, registered with the token; buyers are funded

Agent keys are saved in `.hivebuy\testnet.json` (gitignored). Setup is safe to run again: it skips what already exists and saves after every step.

## 7. Run a live round

```powershell
npm run testnet -- round
```

The script opens a round (30 seconds per phase by default; change with `PHASE_SECS` in `.env`), then:

1. buyers join and lock USDC (`ft_transfer_call`)
2. sellers commit sealed bids with a 0.1 NEAR bond
3. sellers reveal (the last seller sometimes skips the reveal, to show the bond forfeit)
4. the round is cleared and everyone withdraws

Each step prints a testnet explorer link. Check balances any time with `npm run testnet -- status`.

**Watch it live.** When the round opens, the script prints a link to the live page for your contract. Open it: joins, sealed bids, reveals and the result appear by themselves while the round runs, with a countdown for each phase. No push or redeploy is needed for that; only the agents' reasoning (step 8) needs a push.

## 7b. Upgrade the coordinator and grow the swarm

The coordinator is now v3: several providers share a round at one price (v2), forfeited bonds go to the buyers (v2.1), and sellers post delivery receipts that buyers confirm (v3, section 7c). `upgrade` deploys the latest build over the running contract in place: every stored round stays readable and unchanged.

```powershell
npm run testnet -- upgrade
```

The script deploys `contracts/market/target/near/hivebuy_market.wasm` to your coordinator (no init call), then reads every round back and stops with an error if anything changed.

To add buyers 6 to 10 (about 1.6 testnet NEAR from the parent account):

```powershell
$env:BUYERS = "10"; npm run testnet -- setup; Remove-Item Env:BUYERS
```

The next `npm run testnet -- round` uses all ten buyers.

**Round options.**

- `npm run testnet -- round --scenario multi`: each provider may offer only 40-70% of the units buyers locked, so no single provider can serve everyone and several share the round.
- `SKIP_REVEAL` decides whether the test agent (the last seller) skips its reveal to show the bond forfeit: `never`, `random` (default, half the time) or `always`. In PowerShell: `$env:SKIP_REVEAL = "never"; npm run testnet -- round --scenario multi; Remove-Item Env:SKIP_REVEAL`. Every other seller always reveals.
- `--info minimal`: providers are told only the aggregate demand curve, not the previous clearing price or single orders (see [MECHANISM.md](MECHANISM.md)). Default `full`.
- After rounds, `npm run live:report` reads every round from the contract and rewrites `docs/LIVE.md` and the dated live line in the README.

## 7c. Delivery receipts (contract v3, Vercel)

After a round clears, every buyer redeems a voucher from each provider it bought from with one real inference call, and both sides leave evidence on-chain (RULES.md section 9). The providers' endpoint is the Vercel function `api/provider.ts`, deployed with the site.

**One-time setup in Vercel** (Project → Settings → Environment Variables, environment **Production**, type **Secret**):

1. `PROVIDER_KEYS`: the sellers' testnet keys. Copy them to the clipboard without showing them on screen:
   ```powershell
   npm run -s testnet -- provider-keys | Set-Clipboard
   ```
   Paste into the value field. These are the testnet seller accounts only, never your mainnet wallet.
2. `NEARAI_API_KEY`: your NEAR AI Cloud key (the same as in `.env`). Set a spending limit on it at cloud.near.ai.
3. Redeploy (Deployments → … → Redeploy), because environment changes apply only to new deployments.

Check it: open `https://hivebuy-six.vercel.app/api/provider`. It should list your three sellers and `"inference": true` (it never shows keys).

**Run a round with delivery:**

```powershell
$env:SKIP_REVEAL = "never"; npm run testnet -- round --scenario multi --delivery; Remove-Item Env:SKIP_REVEAL
```

If delivery failed (for example the endpoint wasn't configured yet), rerun it for that round: `npm run testnet -- deliver <round>`.

## 8. Let the agents think with NEAR AI (optional)

1. Create an API key at https://cloud.near.ai (your NEAR Builders credits work here). Set a spending limit on the key.
2. In `.env`, set `AGENTS=ai` and `NEARAI_API_KEY=<your key>`. Never commit `.env`.
3. Run a round as before: `npm run testnet -- round`. The script first checks the key with a tiny request, then every agent decides with `z-ai/glm-5.3-flash` and prints its reasoning. Cost: well under one cent per round.
4. When the round ends, the reasoning is saved to `apps/web/public/agent-notes/market.hivebuy.testnet.json`. Commit and push it, and the live page shows each agent's reasoning next to its bid:
   ```powershell
   git add apps/web/public/agent-notes
   git commit -m "Agent reasoning for round N"
   git push
   ```

## 9. See it on the live page

```powershell
npm run dev
```

Open `http://localhost:5173/?contract=market.hivebuy.testnet`, or open the **Testnet contract** tab and enter the account.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Missing PARENT_ACCOUNT` | Create `.env` (step 5). |
| `No key for hivebuy.testnet` | Create the account with the command in step 3, or set `PARENT_PRIVATE_KEY` in `.env`. |
| `Build the contract first` | Run step 4. |
| `Not enough balance for buyer-…` | Run `npm run testnet -- setup` again; it tops agents up. If the parent runs low, create a new faucet account. |
| A buyer "was refunded" | Its join arrived after the join phase. Increase `PHASE_SECS`. |
| `NEAR AI rejected the API key` | Check `NEARAI_API_KEY` in `.env` (no quotes, no spaces). No round was opened. |
| An agent shows `fallback` | The model's answer broke a rule twice (for example over budget), so the agent used its scripted rule. The round is still valid. |
| RPC errors or 429 | The scripts use `https://test.rpc.fastnear.com` (the old `rpc.testnet.near.org` is deprecated). Set `NEAR_RPC_URL` in `.env` to another provider from https://docs.near.org/api/rpc/providers. |
