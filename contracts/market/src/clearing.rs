//! Clearing rule, RULES.md section 4. Pure; mirrors `packages/core/src/index.ts`.

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

pub struct ClearOut {
    /// `(seller index, price, demand)` when the round clears.
    pub winner: Option<(usize, u128, u32)>,
    /// One per buyer, same order as the input.
    pub settlements: Vec<SettlementOut>,
}

pub fn escrow_for(qty: u32, max_price: u128) -> u128 {
    (qty as u128) * max_price
}

pub fn clear(buyers: &[BuyerIn], bids: &[BidIn]) -> ClearOut {
    let mut ordered: Vec<&BidIn> = bids.iter().collect();
    ordered.sort_by(|a, b| a.price.cmp(&b.price).then(a.commit_index.cmp(&b.commit_index)));

    for bid in ordered {
        let demand: u64 = buyers
            .iter()
            .filter(|b| b.max_price >= bid.price)
            .map(|b| b.qty as u64)
            .sum();
        if demand > 0 && (bid.capacity as u64) >= demand {
            let settlements = buyers
                .iter()
                .map(|b| {
                    let escrow = escrow_for(b.qty, b.max_price);
                    if b.max_price < bid.price {
                        SettlementOut { included: false, pay: 0, refund: escrow }
                    } else {
                        let pay = (b.qty as u128) * bid.price;
                        SettlementOut { included: true, pay, refund: escrow - pay }
                    }
                })
                .collect();
            return ClearOut { winner: Some((bid.seller, bid.price, demand as u32)), settlements };
        }
    }

    ClearOut {
        winner: None,
        settlements: buyers
            .iter()
            .map(|b| SettlementOut { included: false, pay: 0, refund: escrow_for(b.qty, b.max_price) })
            .collect(),
    }
}
