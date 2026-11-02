//! Native simulator harness for the demo scripts.
//!
//! Runs the *actual* `BastionKey` contract code (the same code that compiles to wasm) under
//! near-sdk's mock VM, driven by JSON lines on stdin. It exists so the demos are reproducible by
//! anyone with just `cargo` and `node`, with no NEAR account or API key.
//!
//! It is NOT a blockchain: there is no consensus and no real MPC network. When the contract
//! approves a request, this harness reports the cross-contract `sign` call the contract created
//! (receiver, method, args, deposit), and the TypeScript side plays the MPC signer.
//!
//! Protocol: one JSON object per input line, one JSON object per output line.
//!   {"op":"init","owner":..,"signer":..}
//!   {"op":"set_signer","address":"0x.."}
//!   {"op":"register","agent":..,"path":..,"policy":{..}}
//!   {"op":"call","agent":..,"ts":<secs>,"tx":{..},"tee":{..}|null}
//!   {"op":"view","agent":..,"ts":<secs>}
//!   {"op":"preview","tx":{..}}
//!   {"op":"reset_breaker","agent":..}

use bastionkey_policy::evm::EvmTx;
use bastionkey_policy::tee::TeeAttestation;
use bastionkey_policy::{BastionKey, Policy};
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, AccountId, PromiseOrValue};
use std::io::{self, BufRead, Write};

const NS: u64 = 1_000_000_000;

fn set_ctx(predecessor: &str, ts_secs: u64) {
    let id: AccountId = predecessor.parse().expect("bad account id");
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(id.clone())
        .signer_account_id(id)
        .current_account_id("bastion.testnet".parse().unwrap())
        .block_timestamp(ts_secs * NS)
        .build());
}

fn handle(contract: &mut Option<BastionKey>, owner: &mut String, req: Value) -> Result<Value, String> {
    let op = req["op"].as_str().ok_or("missing op")?.to_string();
    let get = |k: &str| -> Result<String, String> {
        req[k].as_str().map(str::to_string).ok_or(format!("missing {k}"))
    };
    match op.as_str() {
        "init" => {
            *owner = get("owner")?;
            set_ctx(owner, 0);
            *contract = Some(BastionKey::new(
                owner.parse().map_err(|_| "bad owner")?,
                get("signer")?.parse().map_err(|_| "bad signer")?,
            ));
            Ok(json!({ "ok": true }))
        }
        "set_signer" => {
            set_ctx(owner, 0);
            contract.as_mut().ok_or("not initialised")?.set_provider_tee_signer(get("address")?);
            Ok(json!({ "ok": true }))
        }
        "register" => {
            set_ctx(owner, 0);
            let policy: Policy = serde_json::from_value(req["policy"].clone()).map_err(|e| e.to_string())?;
            contract.as_mut().ok_or("not initialised")?.register_agent(
                get("agent")?.parse().map_err(|_| "bad agent")?,
                get("path")?,
                policy,
            );
            Ok(json!({ "ok": true }))
        }
        "reset_breaker" => {
            set_ctx(owner, 0);
            contract
                .as_mut()
                .ok_or("not initialised")?
                .reset_breaker(get("agent")?.parse().map_err(|_| "bad agent")?);
            Ok(json!({ "ok": true }))
        }
        "call" => {
            let agent = get("agent")?;
            set_ctx(&agent, req["ts"].as_u64().ok_or("missing ts")?);
            let tx: EvmTx = serde_json::from_value(req["tx"].clone()).map_err(|e| format!("tx: {e}"))?;
            let tee: Option<TeeAttestation> = if req["tee"].is_null() {
                None
            } else {
                Some(serde_json::from_value(req["tee"].clone()).map_err(|e| format!("tee: {e}"))?)
            };
            match contract.as_mut().ok_or("not initialised")?.request_signature(tx, tee) {
                PromiseOrValue::Value(outcome) => {
                    Ok(json!({ "kind": "value", "outcome": serde_json::to_value(&outcome).unwrap() }))
                }
                PromiseOrValue::Promise(promise) => {
                    // near-sdk schedules a Promise's receipts when it is dropped
                    drop(promise);
                    let receipts = get_created_receipts();
                    for r in receipts {
                        for a in r.actions {
                            if let MockAction::FunctionCallWeight {
                                method_name, args, attached_deposit, ..
                            } = a
                            {
                                let method = String::from_utf8_lossy(&method_name).to_string();
                                // the receipt list also holds the on_signed callback; we want the MPC call
                                if method != "sign" {
                                    continue;
                                }
                                let args: Value = serde_json::from_slice(&args).map_err(|e| e.to_string())?;
                                return Ok(json!({
                                    "kind": "promise",
                                    "receiver": r.receiver_id.to_string(),
                                    "method": method,
                                    "args": args,
                                    "deposit_yocto": attached_deposit.as_yoctonear().to_string(),
                                }));
                            }
                        }
                    }
                    Err("promise had no function call".into())
                }
            }
        }
        "view" => {
            set_ctx(owner, req["ts"].as_u64().unwrap_or(0));
            let v = contract
                .as_ref()
                .ok_or("not initialised")?
                .get_agent(get("agent")?.parse().map_err(|_| "bad agent")?);
            Ok(serde_json::to_value(&v).unwrap())
        }
        "preview" => {
            set_ctx(owner, 0);
            let tx: EvmTx = serde_json::from_value(req["tx"].clone()).map_err(|e| e.to_string())?;
            Ok(json!({ "digest": contract.as_ref().ok_or("not initialised")?.preview_digest(tx) }))
        }
        other => Err(format!("unknown op {other}")),
    }
}

fn main() {
    let stdin = io::stdin();
    let mut out = io::stdout().lock();
    let mut contract: Option<BastionKey> = None;
    let mut owner = String::from("owner.testnet");
    for line in stdin.lock().lines() {
        let line = line.expect("stdin");
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Err(e) => json!({ "error": format!("bad json: {e}") }),
            Ok(req) => match handle(&mut contract, &mut owner, req) {
                Ok(v) => v,
                Err(e) => json!({ "error": e }),
            },
        };
        writeln!(out, "{reply}").unwrap();
        out.flush().unwrap();
    }
}
