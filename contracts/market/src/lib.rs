//! Hivebuy coordinator contract. Rules: see RULES.md in the repository root.
//!
//! Buyers join by sending USDC with `ft_transfer_call` (held in escrow), sellers
//! commit a sealed price with a NEAR bond and reveal it later, and `clear` books
//! every payment in one step. Several sellers can share a round at one clearing price.
//! Credits are withdrawn with `withdraw`.
//!
//! Upgrade note (v2, several sellers per round): the stored `Round`/`Outcome` layout is
//! unchanged so v1 rounds stay readable. Per-seller fills live under their own storage key
//! and are merged into the `get_round` / `get_latest_rounds` views.

pub mod clearing;

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{U64, U128};
use near_sdk::serde::Deserialize;
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
    env, near, require,
};

pub const MAX_BUYERS: usize = 50;
pub const MAX_SELLERS: usize = 10;
/// RULES.md section 3: the salt in a commitment is 1-64 characters (32 random hex characters recommended).
pub const MAX_SALT_CHARS: usize = 64;
const NANOS_PER_SEC: u64 = 1_000_000_000;
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_ON_WITHDRAW: Gas = Gas::from_tgas(10);

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Rounds,
    Credits,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct BuyerEntry {
    pub account_id: AccountId,
    pub qty: u32,
    pub max_price: U128,
    pub escrow: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Reveal {
    pub price: U128,
    pub capacity: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct SellerEntry {
    pub account_id: AccountId,
    pub commitment: String,
    pub bond: U128,
    pub commit_index: u32,
    pub revealed: Option<Reveal>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum RoundStatus {
    Open,
    Cleared,
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct SettlementView {
    pub account_id: AccountId,
    pub included: bool,
    pub pay: U128,
    pub refund: U128,
}

/// Units a seller sells in a cleared round, paid at the clearing price.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Fill {
    pub account_id: AccountId,
    pub units: u32,
    pub payout: U128,
}

/// NEAR a buyer received from forfeited seller bonds.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct BondShare {
    pub account_id: AccountId,
    pub amount: U128,
}

/// Stored next to a v2 round under `fills_key(round_id)`.
#[near(serializers = [borsh])]
struct Fills {
    fills: Vec<Fill>,
    price_set_by: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Outcome {
    /// The cheapest seller that sells (v1: the only winner). See `RoundView::fills` for all of them.
    pub winner: Option<AccountId>,
    pub price: Option<U128>,
    pub demand: u32,
    pub settlements: Vec<SettlementView>,
    pub forfeited_bonds: U128,
    pub cleared_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Round {
    pub id: u64,
    pub unit: String,
    pub join_end: U64,
    pub commit_end: U64,
    pub reveal_end: U64,
    pub seller_bond: U128,
    pub buyers: Vec<BuyerEntry>,
    pub sellers: Vec<SellerEntry>,
    pub status: RoundStatus,
    pub outcome: Option<Outcome>,
}

/// A round as returned by the views: the stored round plus every seller's fill.
#[near(serializers = [json])]
pub struct RoundView {
    #[serde(flatten)]
    pub round: Round,
    /// Sellers that sell, cheapest first. Empty until the round clears.
    pub fills: Vec<Fill>,
    /// Who named the clearing price: a seller's ask (that seller may sell nothing) or a buyer's max.
    pub price_set_by: Option<AccountId>,
    /// Forfeited bonds paid to the round's buyers, in yoctoNEAR. Empty for rounds cleared before v2.1.
    pub bond_shares: Vec<BondShare>,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner_id: AccountId,
    pub usdc_token_id: AccountId,
    pub next_round_id: u64,
    pub treasury: U128,
}

/// `msg` of the buyer's `ft_transfer_call`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct JoinMsg {
    round_id: u64,
    qty: u32,
    max_price: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Market {
    owner_id: AccountId,
    usdc_token_id: AccountId,
    rounds: LookupMap<u64, Round>,
    next_round_id: u64,
    /// USDC each account can withdraw (payments to winners, refunds to buyers).
    credits: LookupMap<AccountId, u128>,
    /// Rounding dust of forfeited bonds (v1: whole forfeited bonds), in yoctoNEAR.
    treasury: u128,
}

#[near]
impl Market {
    #[init]
    pub fn new(owner_id: AccountId, usdc_token_id: AccountId) -> Self {
        Self {
            owner_id,
            usdc_token_id,
            rounds: LookupMap::new(StorageKey::Rounds),
            next_round_id: 1,
            credits: LookupMap::new(StorageKey::Credits),
            treasury: 0,
        }
    }

    /// Opens a round. Owner only. Phases run back to back from now.
    pub fn open_round(
        &mut self,
        unit: String,
        join_secs: u64,
        commit_secs: u64,
        reveal_secs: u64,
        seller_bond: U128,
    ) -> u64 {
        require!(env::predecessor_account_id() == self.owner_id, "Only the owner can open rounds");
        require!(join_secs > 0 && commit_secs > 0 && reveal_secs > 0, "Every phase needs a duration");
        require!(!unit.is_empty() && unit.len() <= 64, "Unit must be 1-64 characters");
        let now = env::block_timestamp();
        let join_end = now + join_secs * NANOS_PER_SEC;
        let commit_end = join_end + commit_secs * NANOS_PER_SEC;
        let reveal_end = commit_end + reveal_secs * NANOS_PER_SEC;
        let id = self.next_round_id;
        self.next_round_id += 1;
        self.rounds.insert(
            id,
            Round {
                id,
                unit,
                join_end: U64(join_end),
                commit_end: U64(commit_end),
                reveal_end: U64(reveal_end),
                seller_bond,
                buyers: vec![],
                sellers: vec![],
                status: RoundStatus::Open,
                outcome: None,
            },
        );
        env::log_str(&format!("EVENT round_opened {id}"));
        id
    }

    /// Buyer leaves before the join phase ends; the full escrow becomes withdrawable.
    pub fn leave_round(&mut self, round_id: u64) {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let round = self.rounds.get_mut(&round_id).unwrap_or_else(|| env::panic_str("Unknown round"));
        require!(now < round.join_end.0, "The join phase is over");
        let pos = round
            .buyers
            .iter()
            .position(|b| b.account_id == caller)
            .unwrap_or_else(|| env::panic_str("You have not joined this round"));
        let buyer = round.buyers.remove(pos);
        self.add_credit(&caller, buyer.escrow.0);
        env::log_str(&format!("EVENT buyer_left {round_id} {caller}"));
    }

    /// Seller submits a sealed bid with exactly `seller_bond` NEAR attached.
    #[payable]
    pub fn commit(&mut self, round_id: u64, commitment: String) {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let deposit = env::attached_deposit().as_yoctonear();
        let round = self.rounds.get_mut(&round_id).unwrap_or_else(|| env::panic_str("Unknown round"));
        require!(round.status == RoundStatus::Open, "Round is closed");
        require!(now >= round.join_end.0 && now < round.commit_end.0, "Not in the commit phase");
        require!(deposit == round.seller_bond.0, "Attach exactly the seller bond");
        require!(
            commitment.len() == 64 && commitment.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "Commitment must be a lowercase hex sha256"
        );
        require!(round.sellers.len() < MAX_SELLERS, "Round is full");
        require!(!round.sellers.iter().any(|s| s.account_id == caller), "Already committed");
        let commit_index = round.sellers.len() as u32;
        round.sellers.push(SellerEntry {
            account_id: caller.clone(),
            commitment,
            bond: U128(deposit),
            commit_index,
            revealed: None,
        });
        env::log_str(&format!("EVENT seller_committed {round_id} {caller}"));
    }

    /// Seller reveals; the contract recomputes the commitment and accepts only an exact match.
    pub fn reveal(&mut self, round_id: u64, price: U128, capacity: u32, salt: String) {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let round = self.rounds.get_mut(&round_id).unwrap_or_else(|| env::panic_str("Unknown round"));
        require!(round.status == RoundStatus::Open, "Round is closed");
        require!(now >= round.commit_end.0 && now < round.reveal_end.0, "Not in the reveal phase");
        require!(price.0 > 0 && capacity > 0, "Price and capacity must be positive");
        require!(!salt.is_empty() && salt.chars().count() <= MAX_SALT_CHARS, "Salt must be 1-64 characters");
        let seller = round
            .sellers
            .iter_mut()
            .find(|s| s.account_id == caller)
            .unwrap_or_else(|| env::panic_str("No commitment from you in this round"));
        require!(seller.revealed.is_none(), "Already revealed");
        let expected = commitment_hex(round_id, &caller, price.0, capacity, &salt);
        require!(expected == seller.commitment, "Reveal does not match the commitment");
        seller.revealed = Some(Reveal { price, capacity });
        env::log_str(&format!("EVENT seller_revealed {round_id} {caller}"));
    }

    /// Clears a round after the reveal phase. Anyone can call it.
    pub fn clear(&mut self, round_id: u64) -> Outcome {
        let now = env::block_timestamp();
        let mut round = self
            .rounds
            .get(&round_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Unknown round"));
        require!(round.status == RoundStatus::Open, "Round already cleared");
        require!(now >= round.reveal_end.0, "The reveal phase is not over");

        let buyers_in: Vec<clearing::BuyerIn> = round
            .buyers
            .iter()
            .map(|b| clearing::BuyerIn { qty: b.qty, max_price: b.max_price.0 })
            .collect();
        let bids_in: Vec<clearing::BidIn> = round
            .sellers
            .iter()
            .enumerate()
            .filter_map(|(i, s)| {
                s.revealed.as_ref().map(|r| clearing::BidIn {
                    seller: i,
                    price: r.price.0,
                    capacity: r.capacity,
                    commit_index: s.commit_index,
                })
            })
            .collect();
        let result = clearing::clear(&buyers_in, &bids_in);

        // Book every payment and refund (RULES.md section 5).
        let mut settlements = Vec::with_capacity(round.buyers.len());
        let mut total_pay: u128 = 0;
        for (buyer, s) in round.buyers.iter().zip(result.settlements.iter()) {
            total_pay += s.pay;
            if s.refund > 0 {
                self.add_credit(&buyer.account_id, s.refund);
            }
            settlements.push(SettlementView {
                account_id: buyer.account_id.clone(),
                included: s.included,
                pay: U128(s.pay),
                refund: U128(s.refund),
            });
        }
        let (winner, price, demand) = match &result.cleared {
            Some(c) => {
                let fills: Vec<Fill> = c
                    .fills
                    .iter()
                    .map(|f| Fill {
                        account_id: round.sellers[f.seller].account_id.clone(),
                        units: f.units,
                        payout: U128(f.payout),
                    })
                    .collect();
                let paid_out: u128 = fills.iter().map(|f| f.payout.0).sum();
                require!(paid_out == total_pay, "Fills must add up to what buyers pay");
                for f in &fills {
                    self.add_credit(&f.account_id, f.payout.0);
                }
                let first = fills.first().map(|f| f.account_id.clone());
                let price_set_by = match c.price_set_by {
                    clearing::PriceSetBy::Seller(i) => round.sellers[i].account_id.clone(),
                    clearing::PriceSetBy::Buyer(i) => round.buyers[i].account_id.clone(),
                };
                env::storage_write(&fills_key(round_id), &near_sdk::borsh::to_vec(&Fills { fills, price_set_by }).unwrap());
                (first, Some(U128(c.price)), c.demand)
            }
            None => (None, None, 0),
        };

        // Bonds: returned to every revealed seller. An unrevealed bond is split among the
        // round's buyers by units locked, since their money was frozen for nothing (RULES.md section 6).
        let mut forfeited: u128 = 0;
        for s in &round.sellers {
            if s.revealed.is_some() {
                Promise::new(s.account_id.clone()).transfer(NearToken::from_yoctonear(s.bond.0)).detach();
            } else {
                forfeited += s.bond.0;
            }
        }
        let qtys: Vec<u32> = round.buyers.iter().map(|b| b.qty).collect();
        let (shares, dust) = clearing::bond_shares(&qtys, forfeited);
        let mut bond_shares = Vec::new();
        for (buyer, share) in round.buyers.iter().zip(shares) {
            if share > 0 {
                Promise::new(buyer.account_id.clone()).transfer(NearToken::from_yoctonear(share)).detach();
                bond_shares.push(BondShare { account_id: buyer.account_id.clone(), amount: U128(share) });
            }
        }
        self.treasury += dust;
        if !bond_shares.is_empty() {
            env::storage_write(&bonds_key(round_id), &near_sdk::borsh::to_vec(&bond_shares).unwrap());
        }

        let outcome = Outcome {
            winner,
            price,
            demand,
            settlements,
            forfeited_bonds: U128(forfeited),
            cleared_at: U64(now),
        };
        round.status = if outcome.winner.is_some() { RoundStatus::Cleared } else { RoundStatus::Failed };
        round.outcome = Some(outcome.clone());
        self.rounds.insert(round_id, round);
        env::log_str(&format!("EVENT round_cleared {round_id}"));
        outcome
    }

    /// Sends the caller's whole USDC credit. The credit is restored if the transfer fails.
    pub fn withdraw(&mut self) -> Promise {
        let caller = env::predecessor_account_id();
        let amount = self.credits.remove(&caller).unwrap_or(0);
        require!(amount > 0, "Nothing to withdraw");
        ext_ft_core::ext(self.usdc_token_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(caller.clone(), U128(amount), Some("Hivebuy withdrawal".to_string()))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_WITHDRAW)
                    .on_withdraw(caller, U128(amount)),
            )
    }

    #[private]
    pub fn on_withdraw(
        &mut self,
        account_id: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_err() {
            self.add_credit(&account_id, amount.0);
            env::log_str(&format!("EVENT withdraw_failed {account_id} {}", amount.0));
            return false;
        }
        true
    }

    /// Sends forfeited bonds to the owner.
    pub fn collect_treasury(&mut self) -> Promise {
        require!(env::predecessor_account_id() == self.owner_id, "Only the owner");
        let amount = self.treasury;
        require!(amount > 0, "Treasury is empty");
        self.treasury = 0;
        Promise::new(self.owner_id.clone()).transfer(NearToken::from_yoctonear(amount))
    }

    // ---------- views ----------

    pub fn get_config(&self) -> Config {
        Config {
            owner_id: self.owner_id.clone(),
            usdc_token_id: self.usdc_token_id.clone(),
            next_round_id: self.next_round_id,
            treasury: U128(self.treasury),
        }
    }

    pub fn get_round(&self, round_id: u64) -> Option<RoundView> {
        self.rounds.get(&round_id).map(view_of)
    }

    /// Newest first, `limit` at most 20.
    pub fn get_latest_rounds(&self, limit: u64) -> Vec<RoundView> {
        let limit = limit.clamp(1, 20);
        (1..self.next_round_id)
            .rev()
            .take(limit as usize)
            .filter_map(|id| self.rounds.get(&id).map(view_of))
            .collect()
    }

    pub fn credit_of(&self, account_id: AccountId) -> U128 {
        U128(self.credits.get(&account_id).copied().unwrap_or(0))
    }

    /// "join", "commit", "reveal", "clearable", "cleared" or "failed".
    pub fn phase_of(&self, round_id: u64) -> String {
        let round = self.rounds.get(&round_id).unwrap_or_else(|| env::panic_str("Unknown round"));
        let now = env::block_timestamp();
        match round.status {
            RoundStatus::Cleared => "cleared",
            RoundStatus::Failed => "failed",
            RoundStatus::Open if now < round.join_end.0 => "join",
            RoundStatus::Open if now < round.commit_end.0 => "commit",
            RoundStatus::Open if now < round.reveal_end.0 => "reveal",
            RoundStatus::Open => "clearable",
        }
        .to_string()
    }
}

impl Market {
    fn add_credit(&mut self, account_id: &AccountId, amount: u128) {
        let current = self.credits.get(account_id).copied().unwrap_or(0);
        self.credits.insert(account_id.clone(), current + amount);
    }
}

#[near]
impl FungibleTokenReceiver for Market {
    /// Buyer joins a round: `msg` = `{"round_id":1,"qty":10,"max_price":"2000000"}` and
    /// `amount` must equal `qty * max_price`. Any failure panics, and the token contract
    /// refunds the full amount to the sender.
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc_token_id, "Only the configured USDC token");
        let join: JoinMsg =
            near_sdk::serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("Invalid join message"));
        let now = env::block_timestamp();
        let round = self.rounds.get_mut(&join.round_id).unwrap_or_else(|| env::panic_str("Unknown round"));
        require!(round.status == RoundStatus::Open && now < round.join_end.0, "Not in the join phase");
        require!(join.qty > 0 && join.max_price.0 > 0, "Quantity and max price must be positive");
        require!(round.buyers.len() < MAX_BUYERS, "Round is full");
        require!(!round.buyers.iter().any(|b| b.account_id == sender_id), "Already joined");
        let escrow = clearing::escrow_for(join.qty, join.max_price.0);
        require!(amount.0 == escrow, "Send exactly qty * max_price");
        round.buyers.push(BuyerEntry {
            account_id: sender_id.clone(),
            qty: join.qty,
            max_price: join.max_price,
            escrow: U128(escrow),
        });
        env::log_str(&format!("EVENT buyer_joined {} {sender_id}", join.round_id));
        PromiseOrValue::Value(U128(0))
    }
}

fn fills_key(round_id: u64) -> Vec<u8> {
    [b"fills:".as_slice(), &round_id.to_le_bytes()].concat()
}

fn bonds_key(round_id: u64) -> Vec<u8> {
    [b"bonds:".as_slice(), &round_id.to_le_bytes()].concat()
}

/// Merges the stored fills into a round. v1 rounds (cleared before the upgrade) had one
/// seller take every unit, so their fill is rebuilt from the outcome.
fn view_of(round: &Round) -> RoundView {
    let stored: Option<Fills> = env::storage_read(&fills_key(round.id))
        .map(|raw| near_sdk::borsh::from_slice(&raw).unwrap_or_else(|_| env::panic_str("Corrupt fills")));
    let (fills, price_set_by) = match (stored, &round.outcome) {
        (Some(f), _) => (f.fills, Some(f.price_set_by)),
        (None, Some(o)) => match &o.winner {
            Some(w) => (
                vec![Fill {
                    account_id: w.clone(),
                    units: o.demand,
                    payout: U128(o.settlements.iter().map(|s| s.pay.0).sum()),
                }],
                Some(w.clone()),
            ),
            None => (vec![], None),
        },
        (None, None) => (vec![], None),
    };
    let bond_shares: Vec<BondShare> = env::storage_read(&bonds_key(round.id))
        .map(|raw| near_sdk::borsh::from_slice(&raw).unwrap_or_else(|_| env::panic_str("Corrupt bond shares")))
        .unwrap_or_default();
    RoundView { round: round.clone(), fills, price_set_by, bond_shares }
}

/// sha256("<round_id>:<seller_id>:<price>:<capacity>:<salt>") as lowercase hex (RULES.md section 3).
pub fn commitment_hex(round_id: u64, seller_id: &AccountId, price: u128, capacity: u32, salt: &str) -> String {
    let preimage = format!("{round_id}:{seller_id}:{price}:{capacity}:{salt}");
    env::sha256(preimage.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
