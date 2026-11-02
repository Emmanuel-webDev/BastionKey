use super::*;
use crate::evm::{rlp_bytes, rlp_uint};
use k256::ecdsa::SigningKey;
use near_sdk::json_types::Base64VecU8;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const USDC: &str = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const RPC_PROVIDER: &str = "0x1111111111111111111111111111111111111111";
const ATTACKER: &str = "0x6666666666666666666666666666666666666666";
const MODEL: &str = "test-model/verifier";
const NS_PER_SEC: u64 = 1_000_000_000;

fn owner() -> AccountId {
    "owner.testnet".parse().unwrap()
}
fn agent() -> AccountId {
    "agent-1.owner.testnet".parse().unwrap()
}
fn signer_contract() -> AccountId {
    "v1.signer-prod.testnet".parse().unwrap()
}

fn ctx(predecessor: &AccountId, ts_secs: u64) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor.clone())
        .current_account_id("bastion.owner.testnet".parse().unwrap())
        .block_timestamp(ts_secs * NS_PER_SEC)
        .build());
}

fn tee_key() -> SigningKey {
    SigningKey::from_slice(&[0x42u8; 32]).unwrap()
}
fn other_key() -> SigningKey {
    SigningKey::from_slice(&[0x77u8; 32]).unwrap()
}

fn address_of(sk: &SigningKey) -> String {
    let point = sk.verifying_key().to_encoded_point(false);
    let hash = env::keccak256(&point.as_bytes()[1..]);
    format!("0x{}", hex::encode(&hash[12..]))
}

fn usdc(dollars: u128) -> u128 {
    dollars * 1_000_000
}

/// Closed recipient list ($50 per tx, $50 per hour).
fn whitelist_policy() -> Policy {
    Policy {
        max_per_tx: U128(usdc(50)),
        hourly_budget: U128(usdc(50)),
        max_gas_cost_wei: U128(10_000_000_000_000_000), // 0.01 ETH
        allowed_tokens: vec![USDC.into()],
        allowed_recipients: vec![RPC_PROVIDER.into()],
        allowed_chain_ids: vec![84532],
        tee_required_above: U128(usdc(25)),
        min_confidence_pct: 80,
        max_calls_per_minute: 20,
    }
}

/// Open recipients: the TEE verdict is mandatory for every transfer.
fn open_policy() -> Policy {
    Policy { allowed_recipients: vec![], tee_required_above: U128(0), ..whitelist_policy() }
}

fn setup(policy: Policy) -> BastionKey {
    ctx(&owner(), 1_000);
    let mut c = BastionKey::new(owner(), signer_contract());
    c.set_provider_tee_signer(address_of(&tee_key()));
    c.register_agent(agent(), "agent-1".into(), policy);
    c
}

fn erc20_transfer_data(recipient: &str, amount: u128) -> Vec<u8> {
    let mut d = vec![0xa9, 0x05, 0x9c, 0xbb];
    d.extend_from_slice(&[0u8; 12]);
    d.extend_from_slice(&hex::decode(recipient.trim_start_matches("0x")).unwrap());
    d.extend_from_slice(&[0u8; 16]);
    d.extend_from_slice(&amount.to_be_bytes());
    d
}

fn make_tx(recipient: &str, amount: u128, nonce: u64) -> EvmTx {
    EvmTx {
        chain_id: 84532,
        nonce,
        max_priority_fee_per_gas: U128(1_000_000),
        max_fee_per_gas: U128(2_000_000_000),
        gas_limit: 100_000,
        to: USDC.into(),
        value: U128(0),
        data: Base64VecU8(erc20_transfer_data(recipient, amount)),
    }
}

fn digest_hex(c: &BastionKey, tx: &EvmTx) -> String {
    c.preview_digest(tx.clone()).trim_start_matches("0x").to_string()
}

fn attest_with(
    key: &SigningKey,
    digest_in_request: &str,
    digest_in_verdict: &str,
    aligned: bool,
    confidence: u64,
) -> TeeAttestation {
    let request = format!(
        r#"{{"model":"{MODEL}","messages":[{{"role":"user","content":"TASK: pay the RPC provider TX_DIGEST:0x{digest_in_request}"}}]}}"#
    );
    let verdict = format!(
        r#"{{"tx_digest":"0x{digest_in_verdict}","is_aligned":{aligned},"confidence_pct":{confidence}}}"#
    );
    let response = serde_json::to_string(&json!({
        "choices": [{ "message": { "role": "assistant", "content": verdict } }]
    }))
    .unwrap();
    let mut att = TeeAttestation {
        kind: "provider_tee".into(),
        model_id: Some(MODEL.into()),
        request: Base64VecU8(request.into_bytes()),
        response: Base64VecU8(response.into_bytes()),
        signature: String::new(),
    };
    let text = tee::signed_text(&att).unwrap();
    let hash = tee::eip191_hash(&text);
    let (sig, rid) = key.sign_prehash_recoverable(&hash).unwrap();
    let mut bytes = sig.to_bytes().to_vec();
    bytes.push(rid.to_byte() + 27);
    att.signature = format!("0x{}", hex::encode(bytes));
    att
}

fn attest(c: &BastionKey, tx: &EvmTx, aligned: bool, confidence: u64) -> TeeAttestation {
    let d = digest_hex(c, tx);
    attest_with(&tee_key(), &d, &d, aligned, confidence)
}

fn outcome(p: PromiseOrValue<SignOutcome>) -> Option<SignOutcome> {
    match p {
        PromiseOrValue::Value(v) => Some(v),
        PromiseOrValue::Promise(_) => None,
    }
}

fn call(c: &mut BastionKey, ts: u64, tx: EvmTx, tee: Option<TeeAttestation>) -> Option<SignOutcome> {
    ctx(&agent(), ts);
    outcome(c.request_signature(tx, tee))
}

fn assert_rejected(o: Option<SignOutcome>, code: &str) {
    let o = o.unwrap_or_else(|| panic!("expected rejection {code}, but the call was approved"));
    assert_eq!(o.code.as_deref(), Some(code), "reason: {:?}", o.reason);
    assert!(o.signature.is_none());
}

// ---------------------------------------------------------------- encoding

#[test]
fn rlp_primitives() {
    assert_eq!(rlp_uint(0), vec![0x80]);
    assert_eq!(rlp_uint(1), vec![0x01]);
    assert_eq!(rlp_uint(127), vec![0x7f]);
    assert_eq!(rlp_uint(128), vec![0x81, 0x80]);
    assert_eq!(rlp_uint(1024), vec![0x82, 0x04, 0x00]);
    assert_eq!(rlp_bytes(&[]), vec![0x80]);
}

#[test]
fn digest_matches_viem_for_erc20_transfer() {
    ctx(&owner(), 1_000);
    let v: Value = serde_json::from_str(include_str!("../tests/vectors.json")).unwrap();
    let t = &v["tx"];
    let tx = EvmTx {
        chain_id: t["chain_id"].as_u64().unwrap(),
        nonce: t["nonce"].as_u64().unwrap(),
        max_priority_fee_per_gas: U128(t["max_priority_fee_per_gas"].as_str().unwrap().parse().unwrap()),
        max_fee_per_gas: U128(t["max_fee_per_gas"].as_str().unwrap().parse().unwrap()),
        gas_limit: t["gas_limit"].as_u64().unwrap(),
        to: t["to"].as_str().unwrap().into(),
        value: U128(t["value"].as_str().unwrap().parse().unwrap()),
        data: Base64VecU8(hex::decode(t["data_hex"].as_str().unwrap().trim_start_matches("0x")).unwrap()),
    };
    let unsigned = unsigned_eip1559(&tx).unwrap();
    assert_eq!(format!("0x{}", hex::encode(&unsigned)), v["unsigned_hex"].as_str().unwrap());
    let c = BastionKey::new(owner(), signer_contract());
    assert_eq!(c.preview_digest(tx), v["digest"].as_str().unwrap());
}

#[test]
fn digest_matches_viem_for_long_calldata() {
    ctx(&owner(), 1_000);
    let v: Value = serde_json::from_str(include_str!("../tests/vectors.json")).unwrap();
    let l = &v["long_data"];
    let tx = EvmTx {
        chain_id: 1,
        nonce: 0,
        max_priority_fee_per_gas: U128(0),
        max_fee_per_gas: U128(1),
        gas_limit: 21_000,
        to: USDC.into(),
        value: U128(0),
        data: Base64VecU8(hex::decode(l["hex"].as_str().unwrap().trim_start_matches("0x")).unwrap()),
    };
    let unsigned = unsigned_eip1559(&tx).unwrap();
    assert_eq!(format!("0x{}", hex::encode(&unsigned)), l["unsigned_hex"].as_str().unwrap());
}

#[test]
fn attestation_from_viem_verifies() {
    ctx(&owner(), 1_000);
    let v: Value = serde_json::from_str(include_str!("../tests/vectors.json")).unwrap();
    let a = &v["attestation"];
    let att = TeeAttestation {
        kind: a["kind"].as_str().unwrap().into(),
        model_id: Some(a["model_id"].as_str().unwrap().into()),
        request: Base64VecU8(a["request"].as_str().unwrap().as_bytes().to_vec()),
        response: Base64VecU8(a["response"].as_str().unwrap().as_bytes().to_vec()),
        signature: a["signature"].as_str().unwrap().into(),
    };
    assert_eq!(tee::signed_text(&att).unwrap(), a["signed_text"].as_str().unwrap());
    let signer = parse_address(a["signer_address"].as_str().unwrap()).unwrap();
    let digest = v["digest"].as_str().unwrap().trim_start_matches("0x");
    let verdict = tee::verify(&att, &signer, digest).unwrap();
    assert_eq!(verdict, tee::Verdict { is_aligned: true, confidence_pct: 97 });
}

#[test]
fn erc20_decoder_rejects_malformed_calldata() {
    assert!(decode_erc20_transfer(&[0u8; 10]).is_err());
    let mut bad_selector = erc20_transfer_data(RPC_PROVIDER, 1);
    bad_selector[0] = 0x09; // approve() is a different selector family
    assert!(decode_erc20_transfer(&bad_selector).is_err());
    let mut dirty_pad = erc20_transfer_data(RPC_PROVIDER, 1);
    dirty_pad[5] = 1;
    assert!(decode_erc20_transfer(&dirty_pad).is_err());
    let mut huge = erc20_transfer_data(RPC_PROVIDER, 1);
    huge[36] = 1;
    assert!(decode_erc20_transfer(&huge).is_err());
}

// ---------------------------------------------------------------- demo 1: valid

#[test]
fn valid_aligned_spend_is_approved_and_calls_the_mpc_signer() {
    let mut c = setup(whitelist_policy());
    let tx = make_tx(RPC_PROVIDER, usdc(5), 1);
    // $5 is under tee_required_above ($25) so no attestation is needed
    assert!(call(&mut c, 2_000, tx, None).is_none(), "expected a promise to the MPC signer");
    ctx(&owner(), 2_001);
    let view = c.get_agent(agent()).unwrap();
    assert_eq!(view.approvals, 1);
    assert_eq!(view.spent_last_hour.0, usdc(5));
    assert_eq!(view.remaining_hourly_budget.0, usdc(45));
}

#[test]
fn large_transfer_needs_a_tee_verdict_and_passes_with_one() {
    let mut c = setup(whitelist_policy());
    let tx = make_tx(RPC_PROVIDER, usdc(30), 1);
    assert_rejected(call(&mut c, 2_000, tx.clone(), None), "TEE_REQUIRED");
    ctx(&owner(), 2_001);
    let att = attest(&c, &tx, true, 95);
    assert!(call(&mut c, 2_002, tx, Some(att)).is_none());
}

// ---------------------------------------------------------------- demo 2: over budget

#[test]
fn over_cap_transfer_is_rejected_on_chain() {
    let mut c = setup(whitelist_policy());
    let tx = make_tx(RPC_PROVIDER, usdc(150), 1);
    let o = call(&mut c, 2_000, tx, None).expect("rejection");
    assert_eq!(o.status, "REJECTED");
    assert_eq!(o.code.as_deref(), Some("MAX_PER_TX"));
    assert!(o.reason.unwrap().contains("NearPolicyError: Exceeds max_per_tx limit"));
}

#[test]
fn rolling_hourly_budget_blocks_then_frees_up() {
    let mut c = setup(whitelist_policy());
    // three $20 payments: the third would reach $60 against a $50/hour budget
    for (i, ts) in [(1u64, 2_000u64), (2, 2_010)] {
        assert!(call(&mut c, ts, make_tx(RPC_PROVIDER, usdc(20), i), None).is_none());
    }
    assert_rejected(call(&mut c, 2_020, make_tx(RPC_PROVIDER, usdc(20), 3), None), "HOURLY_BUDGET");
    // the oldest spend leaves the rolling window after an hour
    assert!(call(&mut c, 2_000 + 3_601, make_tx(RPC_PROVIDER, usdc(20), 4), None).is_none());
}

// ---------------------------------------------------------------- demo 3: injected

#[test]
fn injected_transfer_to_attacker_is_blocked_by_tee_verdict() {
    // Open recipients: no list can catch the attacker, only the semantic check can.
    let mut c = setup(open_policy());
    let tx = make_tx(ATTACKER, usdc(10), 1);
    let att = attest(&c, &tx, false, 99);
    assert_rejected(call(&mut c, 2_000, tx, Some(att)), "SEMANTIC_MISMATCH");
}

#[test]
fn open_recipients_always_require_a_verdict() {
    let mut c = setup(open_policy());
    assert_rejected(call(&mut c, 2_000, make_tx(RPC_PROVIDER, usdc(1), 1), None), "TEE_REQUIRED");
}

#[test]
fn aligned_open_recipient_transfer_passes() {
    let mut c = setup(open_policy());
    let tx = make_tx(RPC_PROVIDER, usdc(10), 1);
    let att = attest(&c, &tx, true, 92);
    assert!(call(&mut c, 2_000, tx, Some(att)).is_none());
}

#[test]
fn low_confidence_verdict_is_rejected() {
    let mut c = setup(open_policy());
    let tx = make_tx(RPC_PROVIDER, usdc(10), 1);
    let att = attest(&c, &tx, true, 60);
    assert_rejected(call(&mut c, 2_000, tx, Some(att)), "LOW_CONFIDENCE");
}

#[test]
fn closed_list_catches_attacker_without_needing_the_tee() {
    let mut c = setup(whitelist_policy());
    assert_rejected(call(&mut c, 2_000, make_tx(ATTACKER, usdc(10), 1), None), "RECIPIENT_NOT_ALLOWED");
}

// ---------------------------------------------------------------- attestation forgery

#[test]
fn verdict_for_a_different_transaction_cannot_be_reused() {
    let mut c = setup(open_policy());
    let approved_tx = make_tx(RPC_PROVIDER, usdc(10), 1);
    let attack_tx = make_tx(ATTACKER, usdc(10), 2);
    // a genuine "aligned" verdict, but for the harmless transaction
    let att = attest(&c, &approved_tx, true, 99);
    assert_rejected(call(&mut c, 2_000, attack_tx, Some(att)), "TEE_INVALID");
}

#[test]
fn verdict_signed_by_the_wrong_key_is_rejected() {
    let mut c = setup(open_policy());
    let tx = make_tx(ATTACKER, usdc(10), 1);
    let d = digest_hex(&c, &tx);
    let att = attest_with(&other_key(), &d, &d, true, 99);
    assert_rejected(call(&mut c, 2_000, tx, Some(att)), "TEE_INVALID");
}

#[test]
fn tampering_with_the_signed_response_breaks_the_signature() {
    let mut c = setup(open_policy());
    let tx = make_tx(ATTACKER, usdc(10), 1);
    let d = digest_hex(&c, &tx);
    // the TEE said "not aligned"; the attacker flips the bytes after signing
    let mut att = attest_with(&tee_key(), &d, &d, false, 99);
    let flipped = String::from_utf8(att.response.0.clone()).unwrap().replace("false", "true ");
    att.response = Base64VecU8(flipped.into_bytes());
    assert_rejected(call(&mut c, 2_000, tx, Some(att)), "TEE_INVALID");
}

#[test]
fn verdict_that_echoes_a_different_digest_is_rejected() {
    let mut c = setup(open_policy());
    let tx = make_tx(ATTACKER, usdc(10), 1);
    let d = digest_hex(&c, &tx);
    let att = attest_with(&tee_key(), &d, &"00".repeat(32), true, 99);
    assert_rejected(call(&mut c, 2_000, tx, Some(att)), "TEE_INVALID");
}

#[test]
fn gateway_attestation_is_rejected_unless_its_signer_is_pinned() {
    let mut c = setup(open_policy());
    let tx = make_tx(RPC_PROVIDER, usdc(10), 1);
    let mut att = attest(&c, &tx, true, 99);
    att.kind = "gateway".into();
    assert_rejected(call(&mut c, 2_000, tx, Some(att)), "TEE_SIGNER_NOT_CONFIGURED");
}

// ---------------------------------------------------------------- structural rules

#[test]
fn identical_transaction_cannot_be_approved_twice() {
    let mut c = setup(whitelist_policy());
    let tx = make_tx(RPC_PROVIDER, usdc(5), 1);
    assert!(call(&mut c, 2_000, tx.clone(), None).is_none());
    assert_rejected(call(&mut c, 2_001, tx, None), "REPLAY");
}

#[test]
fn wrong_chain_token_value_gas_and_calldata_are_rejected() {
    let mut c = setup(whitelist_policy());

    let mut tx = make_tx(RPC_PROVIDER, usdc(1), 1);
    tx.chain_id = 1;
    assert_rejected(call(&mut c, 2_000, tx, None), "CHAIN_NOT_ALLOWED");

    let mut tx = make_tx(RPC_PROVIDER, usdc(1), 2);
    tx.to = "0x2222222222222222222222222222222222222222".into();
    assert_rejected(call(&mut c, 2_001, tx, None), "TOKEN_NOT_ALLOWED");

    let mut tx = make_tx(RPC_PROVIDER, usdc(1), 3);
    tx.value = U128(1);
    assert_rejected(call(&mut c, 2_002, tx, None), "NATIVE_VALUE");

    let mut tx = make_tx(RPC_PROVIDER, usdc(1), 4);
    tx.max_fee_per_gas = U128(1_000_000_000_000);
    assert_rejected(call(&mut c, 2_003, tx, None), "GAS_CAP");

    let mut tx = make_tx(RPC_PROVIDER, usdc(1), 5);
    tx.data = Base64VecU8(vec![0x09, 0x5e, 0xa7, 0xb3]); // approve selector, truncated
    assert_rejected(call(&mut c, 2_004, tx, None), "BAD_CALLDATA");
}

#[test]
#[should_panic(expected = "agent is not registered")]
fn unregistered_account_cannot_request_signatures() {
    let mut c = setup(whitelist_policy());
    let stranger: AccountId = "stranger.testnet".parse().unwrap();
    ctx(&stranger, 2_000);
    let _ = c.request_signature(make_tx(RPC_PROVIDER, usdc(1), 1), None);
}

#[test]
#[should_panic(expected = "only the owner")]
fn only_the_owner_can_register_agents() {
    let mut c = setup(whitelist_policy());
    ctx(&agent(), 2_000);
    c.register_agent(agent(), "x".into(), whitelist_policy());
}

// ---------------------------------------------------------------- circuit breaker

#[test]
fn call_flood_trips_the_breaker_even_when_every_call_is_rejected() {
    let mut p = whitelist_policy();
    p.max_calls_per_minute = 5;
    let mut c = setup(p);

    // five rejected attempts inside one minute: allowed to fail, not yet frozen
    for i in 0..5u64 {
        assert_rejected(call(&mut c, 2_000 + i, make_tx(ATTACKER, usdc(1), i), None), "RECIPIENT_NOT_ALLOWED");
    }
    // the sixth attempt trips it
    let o = call(&mut c, 2_006, make_tx(RPC_PROVIDER, usdc(1), 100), None).unwrap();
    assert_eq!(o.status, "FROZEN");
    assert_eq!(o.code.as_deref(), Some("CIRCUIT_BREAKER"));

    // frozen means frozen, even for a perfectly valid request, and even after the minute passes
    let o = call(&mut c, 2_200, make_tx(RPC_PROVIDER, usdc(1), 101), None).unwrap();
    assert_eq!(o.status, "FROZEN");

    ctx(&owner(), 2_201);
    assert!(c.get_agent(agent()).unwrap().tripped);

    // only the owner can lift it
    c.reset_breaker(agent());
    assert!(call(&mut c, 2_300, make_tx(RPC_PROVIDER, usdc(1), 102), None).is_none());
}

#[test]
fn paused_agent_is_frozen() {
    let mut c = setup(whitelist_policy());
    ctx(&owner(), 1_500);
    c.set_paused(agent(), true);
    let o = call(&mut c, 2_000, make_tx(RPC_PROVIDER, usdc(1), 1), None).unwrap();
    assert_eq!(o.status, "FROZEN");
    assert_eq!(o.code.as_deref(), Some("PAUSED"));
}

// ---------------------------------------------------------------- signer call shape

#[test]
fn sign_args_cover_both_signer_interfaces() {
    ctx(&owner(), 1_000);
    let mut c = BastionKey::new(owner(), signer_contract());
    let digest = [0xabu8; 32];

    let legacy: Value = serde_json::from_slice(&c.sign_args(&digest, "agent-1")).unwrap();
    assert_eq!(legacy["request"]["path"], "agent-1");
    assert_eq!(legacy["request"]["key_version"], 0);
    assert_eq!(legacy["request"]["payload"].as_array().unwrap().len(), 32);

    c.set_sign_config(SignFormat::V2, U128(1), 200);
    let v2: Value = serde_json::from_slice(&c.sign_args(&digest, "agent-1")).unwrap();
    assert_eq!(v2["request"]["payload_v2"]["Ecdsa"], hex::encode(digest));
    assert_eq!(v2["request"]["domain_id"], 0);
}
