use super::*;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const SEC: u64 = 1_000_000_000;
const START: u64 = 1_000 * SEC;
const BOND: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR

fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn ctx(predecessor: &str, now: u64, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("market.hivebuy.testnet"))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .block_timestamp(now)
        .attached_deposit(NearToken::from_yoctonear(deposit));
    testing_env!(b.build());
}

fn setup() -> Market {
    ctx("hivebuy.testnet", START, 0);
    let mut m = Market::new(acc("hivebuy.testnet"), acc("usdc.testnet"));
    // join: [START, START+60), commit: [+60, +120), reveal: [+120, +180)
    let id = m.open_round("1M tokens".into(), 60, 60, 60, U128(BOND));
    assert_eq!(id, 1);
    m
}

fn join(m: &mut Market, buyer: &str, qty: u32, max_price: u128) {
    ctx("usdc.testnet", START + SEC, 0);
    let msg = format!(r#"{{"round_id":1,"qty":{qty},"max_price":"{max_price}"}}"#);
    let _ = m.ft_on_transfer(acc(buyer), U128(qty as u128 * max_price), msg);
}

fn commit(m: &mut Market, seller: &str, price: u128, capacity: u32, salt: &str) {
    let hash = commitment_hex(1, &acc(seller), price, capacity, salt);
    ctx(seller, START + 61 * SEC, BOND);
    m.commit(1, hash);
}

fn reveal(m: &mut Market, seller: &str, price: u128, capacity: u32, salt: &str) {
    ctx(seller, START + 121 * SEC, 0);
    m.reveal(1, U128(price), capacity, salt.into());
}

fn clear_now(m: &mut Market) -> Outcome {
    ctx("anyone.testnet", START + 181 * SEC, 0);
    m.clear(1)
}

#[test]
fn worked_example_end_to_end() {
    // RULES.md section 4: two sellers split the order at 1.40.
    let mut m = setup();
    join(&mut m, "a.testnet", 10, 2_000_000);
    join(&mut m, "b.testnet", 15, 1_500_000);
    join(&mut m, "c.testnet", 20, 1_200_000);
    commit(&mut m, "s1.testnet", 1_100_000, 20, "x1");
    commit(&mut m, "s2.testnet", 1_400_000, 15, "x2");
    commit(&mut m, "s3.testnet", 1_900_000, 100, "x3");
    reveal(&mut m, "s1.testnet", 1_100_000, 20, "x1");
    reveal(&mut m, "s2.testnet", 1_400_000, 15, "x2");
    reveal(&mut m, "s3.testnet", 1_900_000, 100, "x3");

    let out = clear_now(&mut m);
    assert_eq!(out.winner, Some(acc("s1.testnet")));
    assert_eq!(out.price, Some(U128(1_400_000)));
    assert_eq!(out.demand, 25);
    assert_eq!(m.credit_of(acc("s1.testnet")).0, 28_000_000);
    assert_eq!(m.credit_of(acc("s2.testnet")).0, 7_000_000);
    assert_eq!(m.credit_of(acc("s3.testnet")).0, 0);
    assert_eq!(m.credit_of(acc("a.testnet")).0, 6_000_000);
    assert_eq!(m.credit_of(acc("b.testnet")).0, 1_500_000);
    assert_eq!(m.credit_of(acc("c.testnet")).0, 24_000_000);

    let view = m.get_round(1).unwrap();
    assert_eq!(view.round.status, RoundStatus::Cleared);
    assert_eq!(view.price_set_by, Some(acc("s2.testnet")));
    let fills: Vec<(String, u32, u128)> =
        view.fills.iter().map(|f| (f.account_id.to_string(), f.units, f.payout.0)).collect();
    assert_eq!(
        fills,
        vec![("s1.testnet".to_string(), 20, 28_000_000), ("s2.testnet".to_string(), 5, 7_000_000)]
    );
    assert_eq!(m.phase_of(1), "cleared");

    // The view flattens the round, so v1 clients that read `outcome`, `buyers`... still work.
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(json["id"], 1);
    assert_eq!(json["outcome"]["price"], "1400000");
    assert_eq!(json["fills"][1]["units"], 5);
}

#[test]
fn v1_round_without_stored_fills_is_rebuilt_from_its_outcome() {
    // Simulates a round cleared by the v1 contract: same stored layout, no fills key.
    let mut m = setup();
    join(&mut m, "a.testnet", 4, 1_500_000);
    commit(&mut m, "s1.testnet", 1_200_000, 10, "x1");
    reveal(&mut m, "s1.testnet", 1_200_000, 10, "x1");
    clear_now(&mut m);
    env::storage_remove(&fills_key(1));

    let view = m.get_round(1).unwrap();
    assert_eq!(view.price_set_by, Some(acc("s1.testnet")));
    assert_eq!(view.fills.len(), 1);
    assert_eq!(view.fills[0].units, 4);
    assert_eq!(view.fills[0].payout.0, 4_800_000);
    assert_eq!(m.get_latest_rounds(5)[0].fills.len(), 1);
}

#[test]
fn escrow_is_conserved() {
    let mut m = setup();
    join(&mut m, "a.testnet", 10, 2_000_000);
    join(&mut m, "b.testnet", 5, 1_500_000);
    commit(&mut m, "s1.testnet", 1_300_000, 100, "x1");
    reveal(&mut m, "s1.testnet", 1_300_000, 100, "x1");
    clear_now(&mut m);
    let total_in = 10 * 2_000_000 + 5 * 1_500_000;
    let total_out = m.credit_of(acc("s1.testnet")).0 + m.credit_of(acc("a.testnet")).0 + m.credit_of(acc("b.testnet")).0;
    assert_eq!(total_in, total_out);
}

#[test]
fn unrevealed_seller_forfeits_bond() {
    let mut m = setup();
    join(&mut m, "a.testnet", 1, 2_000_000);
    commit(&mut m, "s1.testnet", 1_000_000, 10, "x1");
    commit(&mut m, "ghost.testnet", 900_000, 10, "x2");
    reveal(&mut m, "s1.testnet", 1_000_000, 10, "x1");
    let out = clear_now(&mut m);
    assert_eq!(out.winner, Some(acc("s1.testnet")));
    assert_eq!(out.forfeited_bonds.0, BOND);
    // The only buyer receives the whole bond; nothing is left for the treasury.
    let view = m.get_round(1).unwrap();
    assert_eq!(view.bond_shares.len(), 1);
    assert_eq!(view.bond_shares[0].account_id, acc("a.testnet"));
    assert_eq!(view.bond_shares[0].amount.0, BOND);
    assert_eq!(m.get_config().treasury.0, 0);
}

#[test]
fn forfeited_bond_is_split_by_units_and_dust_goes_to_treasury() {
    let mut m = setup();
    join(&mut m, "a.testnet", 1, 2_000_000);
    join(&mut m, "b.testnet", 2, 1_000_000);
    commit(&mut m, "s1.testnet", 900_000, 10, "x1");
    commit(&mut m, "ghost.testnet", 800_000, 10, "x2");
    reveal(&mut m, "s1.testnet", 900_000, 10, "x1");
    clear_now(&mut m);
    let shares: Vec<u128> = m.get_round(1).unwrap().bond_shares.iter().map(|s| s.amount.0).collect();
    // 0.1 NEAR over 3 units: a gets 1/3, b gets 2/3, rounded down; 1 yocto of dust stays.
    assert_eq!(shares, vec![BOND / 3, BOND * 2 / 3]);
    assert_eq!(m.get_config().treasury.0, BOND - BOND / 3 - BOND * 2 / 3);
}

#[test]
fn bond_split_never_overflows_or_overpays() {
    let qtys = [u32::MAX; 50];
    let (shares, dust) = clearing::bond_shares(&qtys, u128::MAX);
    assert_eq!(shares.iter().sum::<u128>() + dust, u128::MAX);
    assert_eq!(clearing::bond_shares(&[], 5), (vec![], 5));
    assert_eq!(clearing::bond_shares(&[1, 1, 1], 10), (vec![3, 3, 3], 1));
}

#[test]
fn failed_round_refunds_everyone() {
    let mut m = setup();
    join(&mut m, "a.testnet", 50, 2_000_000);
    commit(&mut m, "s1.testnet", 1_000_000, 10, "x1");
    reveal(&mut m, "s1.testnet", 1_000_000, 10, "x1");
    let out = clear_now(&mut m);
    assert!(out.winner.is_none());
    assert_eq!(m.get_round(1).unwrap().round.status, RoundStatus::Failed);
    assert!(m.get_round(1).unwrap().fills.is_empty());
    assert_eq!(m.credit_of(acc("a.testnet")).0, 100_000_000);
    assert_eq!(m.credit_of(acc("s1.testnet")).0, 0);
}

#[test]
fn leave_before_join_end_credits_escrow() {
    let mut m = setup();
    join(&mut m, "a.testnet", 3, 1_000_000);
    ctx("a.testnet", START + 2 * SEC, 0);
    m.leave_round(1);
    assert_eq!(m.credit_of(acc("a.testnet")).0, 3_000_000);
    assert!(m.get_round(1).unwrap().round.buyers.is_empty());
}

#[test]
#[should_panic(expected = "Reveal does not match the commitment")]
fn wrong_reveal_is_rejected() {
    let mut m = setup();
    commit(&mut m, "s1.testnet", 1_000_000, 10, "x1");
    reveal(&mut m, "s1.testnet", 999_999, 10, "x1");
}

#[test]
#[should_panic(expected = "Send exactly qty * max_price")]
fn join_with_wrong_amount_is_rejected() {
    let mut m = setup();
    ctx("usdc.testnet", START + SEC, 0);
    let _ = m.ft_on_transfer(acc("a.testnet"), U128(1), r#"{"round_id":1,"qty":2,"max_price":"1000000"}"#.into());
}

#[test]
#[should_panic(expected = "Only the configured USDC token")]
fn join_from_other_token_is_rejected() {
    let mut m = setup();
    ctx("fake-usdc.testnet", START + SEC, 0);
    let _ = m.ft_on_transfer(acc("a.testnet"), U128(2_000_000), r#"{"round_id":1,"qty":2,"max_price":"1000000"}"#.into());
}

#[test]
#[should_panic(expected = "Not in the commit phase")]
fn commit_during_join_is_rejected() {
    let mut m = setup();
    let hash = commitment_hex(1, &acc("s1.testnet"), 1, 1, "x");
    ctx("s1.testnet", START + SEC, BOND);
    m.commit(1, hash);
}

#[test]
#[should_panic(expected = "Attach exactly the seller bond")]
fn commit_without_bond_is_rejected() {
    let mut m = setup();
    let hash = commitment_hex(1, &acc("s1.testnet"), 1, 1, "x");
    ctx("s1.testnet", START + 61 * SEC, 0);
    m.commit(1, hash);
}

#[test]
#[should_panic(expected = "The reveal phase is not over")]
fn clear_too_early_is_rejected() {
    let mut m = setup();
    ctx("anyone.testnet", START + 150 * SEC, 0);
    m.clear(1);
}

#[test]
#[should_panic(expected = "Round already cleared")]
fn clear_twice_is_rejected() {
    let mut m = setup();
    clear_now(&mut m);
    clear_now(&mut m);
}

#[test]
#[should_panic(expected = "Only the owner can open rounds")]
fn only_owner_opens_rounds() {
    let mut m = setup();
    ctx("someone.testnet", START, 0);
    m.open_round("x".into(), 1, 1, 1, U128(0));
}

#[test]
fn failed_withdraw_restores_credit() {
    let mut m = setup();
    join(&mut m, "a.testnet", 3, 1_000_000);
    ctx("a.testnet", START + 2 * SEC, 0);
    m.leave_round(1);
    ctx("a.testnet", START + 3 * SEC, 0);
    let _ = m.withdraw();
    assert_eq!(m.credit_of(acc("a.testnet")).0, 0);
    ctx("market.hivebuy.testnet", START + 4 * SEC, 0);
    assert!(!m.on_withdraw(acc("a.testnet"), U128(3_000_000), Err(PromiseError::Failed)));
    assert_eq!(m.credit_of(acc("a.testnet")).0, 3_000_000);
}

// ---------- shared vectors (fixtures/clearing-vectors.json) ----------

const VECTORS: &str = include_str!("../../../fixtures/clearing-vectors.json");

#[test]
fn shared_commitment_vectors() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    for c in v["commitments"].as_array().unwrap() {
        let got = commitment_hex(
            c["round_id"].as_u64().unwrap(),
            &acc(c["seller_id"].as_str().unwrap()),
            c["price"].as_str().unwrap().parse().unwrap(),
            c["capacity"].as_u64().unwrap() as u32,
            c["salt"].as_str().unwrap(),
        );
        assert_eq!(got, c["expected"].as_str().unwrap(), "{}", c["name"]);
    }
}

#[test]
fn shared_clearing_vectors() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    for case in v["clearing"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let buyers: Vec<&Value> = case["buyers"].as_array().unwrap().iter().collect();
        let sellers: Vec<&Value> = case["sellers"].as_array().unwrap().iter().collect();
        let buyers_in: Vec<clearing::BuyerIn> = buyers
            .iter()
            .map(|b| clearing::BuyerIn {
                qty: b["qty"].as_u64().unwrap() as u32,
                max_price: b["max_price"].as_str().unwrap().parse().unwrap(),
            })
            .collect();
        let bids_in: Vec<clearing::BidIn> = sellers
            .iter()
            .enumerate()
            .map(|(i, s)| clearing::BidIn {
                seller: i,
                price: s["price"].as_str().unwrap().parse().unwrap(),
                capacity: s["capacity"].as_u64().unwrap() as u32,
                commit_index: s["commit_index"].as_u64().unwrap() as u32,
            })
            .collect();
        let out = clearing::clear(&buyers_in, &bids_in);
        let exp = &case["expected"];
        match &out.cleared {
            Some(c) => {
                assert_eq!(exp["status"], "cleared", "{name}");
                assert_eq!(c.price.to_string(), exp["price"].as_str().unwrap(), "{name}");
                assert_eq!(c.demand as u64, exp["demand"].as_u64().unwrap(), "{name}");
                let setter = match c.price_set_by {
                    clearing::PriceSetBy::Seller(i) => &sellers[i]["id"],
                    clearing::PriceSetBy::Buyer(i) => &buyers[i]["id"],
                };
                assert_eq!(setter, &exp["price_set_by"], "{name}");
                let want = exp["fills"].as_array().unwrap();
                assert_eq!(c.fills.len(), want.len(), "{name}");
                for (got, w) in c.fills.iter().zip(want) {
                    assert_eq!(sellers[got.seller]["id"], w["id"], "{name}");
                    assert_eq!(got.units as u64, w["units"].as_u64().unwrap(), "{name}");
                    assert_eq!(got.payout.to_string(), w["payout"].as_str().unwrap(), "{name}");
                }
            }
            None => assert_eq!(exp["status"], "failed", "{name}"),
        }
        let exp_s = exp["settlements"].as_array().unwrap();
        assert_eq!(exp_s.len(), out.settlements.len(), "{name}");
        for (got, want) in out.settlements.iter().zip(exp_s) {
            assert_eq!(got.included, want["included"].as_bool().unwrap(), "{name}");
            assert_eq!(got.pay.to_string(), want["pay"].as_str().unwrap(), "{name}");
            assert_eq!(got.refund.to_string(), want["refund"].as_str().unwrap(), "{name}");
        }
    }
}
