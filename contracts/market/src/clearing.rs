//! Clearing rule, RULES.md section 4. Pure; mirrors `packages/core/src/index.ts`.
//!
//! Candidate prices are every revealed ask and every buyer's max price, from the cheapest ask
//! up. The first candidate where the providers asking that much or less can together make every
//! unit wanted at that price becomes the clearing price. Units go to the cheapest providers first (ties: earlier commit), and
//! everyone trades at that one price.

pub struct BuyerIn {
    pub qty: u32,
    pub max_price: u128,
}

pub struct BidIn {
    /// Index of the seller in the round.
    pub seller: usize,
    pub price: u128,
    pub capacity: u32,
    pub commit_index: u32,
}

pub struct SettlementOut {
    pub included: bool,
    pub pay: u128,
    pub refund: u128,
}

pub struct FillOut {
    /// Index of the seller in the round.
    pub seller: usize,
    pub units: u32,
    pub payout: u128,
}

/// Who named the clearing price.
#[derive(Debug, PartialEq)]
pub enum PriceSetBy {
    /// A seller's ask (index in the round); that seller may sell nothing.
    Seller(usize),
    /// A buyer's max price (index in the round); that buyer is included and pays its max.
    Buyer(usize),
}

pub struct Cleared {
    pub price: u128,
    pub demand: u32,
    pub price_set_by: PriceSetBy,
    /// Sellers that sell, cheapest first. Payouts add up to what the included buyers pay.
    pub fills: Vec<FillOut>,
}

pub struct ClearOut {
    pub cleared: Option<Cleared>,
    /// One per buyer, same order as the input.
    pub settlements: Vec<SettlementOut>,
}

pub fn escrow_for(qty: u32, max_price: u128) -> u128 {
    (qty as u128) * max_price
}

fn demand_at(buyers: &[BuyerIn], price: u128) -> u64 {
    buyers.iter().filter(|b| b.max_price >= price).map(|b| b.qty as u64).sum()
}

pub fn clear(buyers: &[BuyerIn], bids: &[BidIn]) -> ClearOut {
    let mut ordered: Vec<&BidIn> = bids.iter().collect();
    ordered.sort_by(|a, b| a.price.cmp(&b.price).then(a.commit_index.cmp(&b.commit_index)));

    // Candidate prices and who named them: the earliest-committed ask, else the first buyer.
    let mut candidates: Vec<(u128, PriceSetBy)> = Vec::new();
    if let Some(floor) = ordered.first().map(|b| b.price) {
        for b in &ordered {
            if !candidates.iter().any(|(p, _)| *p == b.price) {
                candidates.push((b.price, PriceSetBy::Seller(b.seller)));
            }
        }
        for (i, b) in buyers.iter().enumerate() {
            if b.max_price >= floor && !candidates.iter().any(|(p, _)| *p == b.max_price) {
                candidates.push((b.max_price, PriceSetBy::Buyer(i)));
            }
        }
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0));

    for (price, price_set_by) in candidates {
        let demand = demand_at(buyers, price);
        if demand == 0 {
            break;
        }
        let supply: u64 = ordered.iter().filter(|b| b.price <= price).map(|b| b.capacity as u64).sum();
        if supply < demand {
            continue;
        }

        let mut left = demand;
        let mut fills = Vec::new();
        for b in ordered.iter().take_while(|b| b.price <= price) {
            if left == 0 {
                break;
            }
            let units = (b.capacity as u64).min(left);
            left -= units;
            fills.push(FillOut { seller: b.seller, units: units as u32, payout: (units as u128) * price });
        }
        let settlements = buyers
            .iter()
            .map(|b| {
                let escrow = escrow_for(b.qty, b.max_price);
                if b.max_price < price {
                    SettlementOut { included: false, pay: 0, refund: escrow }
                } else {
                    let pay = (b.qty as u128) * price;
                    SettlementOut { included: true, pay, refund: escrow - pay }
                }
            })
            .collect();
        return ClearOut {
            cleared: Some(Cleared { price, demand: demand as u32, price_set_by, fills }),
            settlements,
        };
    }

    ClearOut {
        cleared: None,
        settlements: buyers
            .iter()
            .map(|b| SettlementOut { included: false, pay: 0, refund: escrow_for(b.qty, b.max_price) })
            .collect(),
    }
}

/// Splits forfeited bonds among the round's buyers by the units each one locked (RULES.md section 6).
/// Rounds down; the second value is the dust that goes to the treasury. Overflow-safe for any bond
/// amount: `forfeited % total` < total <= 50 * u32::MAX, so the product fits in u128.
pub fn bond_shares(qtys: &[u32], forfeited: u128) -> (Vec<u128>, u128) {
    let total: u128 = qtys.iter().map(|q| *q as u128).sum();
    if total == 0 {
        return (vec![0; qtys.len()], forfeited);
    }
    let (per_unit, rest) = (forfeited / total, forfeited % total);
    let shares: Vec<u128> = qtys.iter().map(|q| per_unit * (*q as u128) + rest * (*q as u128) / total).collect();
    let paid: u128 = shares.iter().sum();
    (shares, forfeited - paid)
}

/// One buyer's units bought from one seller (RULES.md section 9). Mirrors `payments` in packages/core.
#[derive(Debug, PartialEq)]
pub struct PaymentOut {
    /// Index of the buyer in the round.
    pub buyer: usize,
    /// Index into `fills` (cheapest first).
    pub fill: usize,
    pub units: u32,
}

/// Matches included buyers (round order) to fills (cheapest first), splitting a buyer across two
/// sellers when needed. Per buyer the units add up to its qty; per fill, to the fill's units.
pub fn payments(buyers: &[BuyerIn], price: u128, fill_units: &[u32]) -> Vec<PaymentOut> {
    let mut left: Vec<u32> = fill_units.to_vec();
    let mut out = Vec::new();
    let mut i = 0;
    for (b, buyer) in buyers.iter().enumerate() {
        if buyer.max_price < price {
            continue;
        }
        let mut need = buyer.qty;
        while need > 0 && i < left.len() {
            let units = need.min(left[i]);
            if units > 0 {
                out.push(PaymentOut { buyer: b, fill: i, units });
            }
            need -= units;
            left[i] -= units;
            if left[i] == 0 {
                i += 1;
            }
        }
    }
    out
}
