//! BastionKey policy contract.
//!
//! An AI agent holds only a NEAR Function Call Key restricted to `request_signature` on this
//! contract. The contract is the only account allowed to ask the NEAR MPC signer for signatures
//! on the agent's derived foreign-chain address, so every rule below is enforced before any
//! signature can exist.
//!
//! Rules enforced here, deterministically:
//!   * chain and token allow-lists, ERC-20 `transfer` only, zero native value
//!   * per-transaction cap, rolling one-hour budget, gas-cost cap
//!   * recipient allow-list; an empty list means "open", which makes a TEE verdict mandatory
//!   * velocity circuit breaker that freezes the agent on call-rate spikes
//!   * TEE semantic verdict (NEAR AI Cloud signed response) bound to the exact tx digest
//!
//! The contract builds the bytes that get signed from structured fields, so the agent cannot
//! describe one transaction and sign another.

pub mod evm;
pub mod tee;

use evm::{decode_erc20_transfer, parse_address, unsigned_eip1559, EvmTx};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupSet};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};
use tee::TeeAttestation;

const HOUR_NS: u64 = 3_600_000_000_000;
const MINUTE_NS: u64 = 60_000_000_000;
/// Hard cap on stored log entries per agent so storage cannot be inflated.
const MAX_LOG_ENTRIES: usize = 256;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Agents,
    UsedDigests,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Policy {
    /// Per-transaction cap in token base units (USDC has 6 decimals, so $50 = 50_000_000)
    pub max_per_tx: U128,
    /// Rolling one-hour budget in token base units
    pub hourly_budget: U128,
    /// Upper bound on gas_limit * max_fee_per_gas, in wei. Stops the agent draining the gas balance.
    pub max_gas_cost_wei: U128,
    /// Lower-case 0x ERC-20 contract addresses the agent may call
    pub allowed_tokens: Vec<String>,
    /// Lower-case 0x recipients. Empty means open recipients, which makes a TEE verdict mandatory.
    pub allowed_recipients: Vec<String>,
    pub allowed_chain_ids: Vec<u64>,
    /// A TEE verdict is required when amount is above this (0 = always required)
    pub tee_required_above: U128,
    /// Minimum verdict confidence, 0..=100
    pub min_confidence_pct: u8,
    /// More attempts than this inside one minute freezes the agent
    pub max_calls_per_minute: u32,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub policy: Policy,
    /// MPC derivation path. Fixed by the owner so one agent cannot use another agent's address.
    pub derivation_path: String,
    pub paused: bool,
    pub tripped: bool,
    pub rejections: u64,
    pub approvals: u64,
    /// (timestamp_ns, amount) of spends inside the rolling window
    pub spend_log: Vec<(u64, u128)>,
    /// timestamps of recent attempts, for the circuit breaker
    pub call_log: Vec<u64>,
}

#[near(serializers = [json])]
pub struct AgentView {
    pub policy: Policy,
    pub derivation_path: String,
    pub paused: bool,
    pub tripped: bool,
    pub rejections: u64,
    pub approvals: u64,
    pub spent_last_hour: U128,
    pub remaining_hourly_budget: U128,
    pub calls_last_minute: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SignFormat {
    /// `{"request":{"payload":[u8;32],"path":..,"key_version":0}}`
    Legacy,
    /// `{"request":{"payload_v2":{"Ecdsa":"<hex>"},"path":..,"domain_id":0}}`
    V2,
}

#[near(serializers = [json])]
#[derive(Debug)]
pub struct SignOutcome {
    /// "APPROVED", "REJECTED", "FROZEN" or "SIGN_FAILED"
    pub status: String,
    pub code: Option<String>,
    pub reason: Option<String>,
    /// 0x-prefixed keccak256 of the unsigned transaction that was (or would have been) signed
    pub digest: Option<String>,
    /// Raw response of the MPC signer (big_r, s, recovery_id)
    pub signature: Option<Value>,
}

impl SignOutcome {
    fn rejected(code: &str, reason: String, digest: Option<String>) -> Self {
        Self {
            status: "REJECTED".into(),
            code: Some(code.into()),
            reason: Some(format!("NearPolicyError: {reason}")),
            digest,
            signature: None,
        }
    }
}

struct Reject {
    code: &'static str,
    reason: String,
}

fn reject<T>(code: &'static str, reason: impl Into<String>) -> Result<T, Reject> {
    Err(Reject { code, reason: reason.into() })
}

struct Approved {
    amount: u128,
    digest: [u8; 32],
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct BastionKey {
    owner: AccountId,
    signer_contract: AccountId,
    /// ECDSA address of the NEAR AI Cloud model signer, pinned by the contract owner
    provider_tee_signer: Option<[u8; 20]>,
    /// ECDSA address of the NEAR AI Cloud gateway TEE. Unset by default, which rejects gateway kind.
    gateway_signer: Option<[u8; 20]>,
    sign_format: SignFormat,
    /// Deposit attached to the MPC `sign` call, paid from this contract's balance
    sign_deposit: U128,
    sign_gas_tgas: u64,
    agents: IterableMap<AccountId, Agent>,
    used_digests: LookupSet<[u8; 32]>,
}

#[near]
impl BastionKey {
    #[init]
    pub fn new(owner: AccountId, signer_contract: AccountId) -> Self {
        Self {
            owner,
            signer_contract,
            provider_tee_signer: None,
            gateway_signer: None,
            sign_format: SignFormat::Legacy,
            sign_deposit: U128(1),
            sign_gas_tgas: 200,
            agents: IterableMap::new(StorageKey::Agents),
            used_digests: LookupSet::new(StorageKey::UsedDigests),
        }
    }

    // ---------------------------------------------------------------- owner

    pub fn register_agent(&mut self, agent_account: AccountId, derivation_path: String, policy: Policy) {
        self.assert_owner();
        Self::validate_policy(&policy);
        require!(!derivation_path.is_empty(), "derivation_path is required");
        self.agents.insert(
            agent_account,
            Agent {
                policy,
                derivation_path,
                paused: false,
                tripped: false,
                rejections: 0,
                approvals: 0,
                spend_log: vec![],
                call_log: vec![],
            },
        );
    }

    pub fn update_policy(&mut self, agent_account: AccountId, policy: Policy) {
        self.assert_owner();
        Self::validate_policy(&policy);
        let agent = self.agents.get_mut(&agent_account).expect("unknown agent");
        agent.policy = policy;
    }

    pub fn set_paused(&mut self, agent_account: AccountId, paused: bool) {
        self.assert_owner();
        self.agents.get_mut(&agent_account).expect("unknown agent").paused = paused;
    }

    /// Clears a tripped circuit breaker after the owner has looked at what happened.
    pub fn reset_breaker(&mut self, agent_account: AccountId) {
        self.assert_owner();
        let agent = self.agents.get_mut(&agent_account).expect("unknown agent");
        agent.tripped = false;
        agent.call_log.clear();
    }

    pub fn set_provider_tee_signer(&mut self, address: String) {
        self.assert_owner();
        self.provider_tee_signer = Some(parse_address(&address).unwrap_or_else(|e| env::panic_str(&e)));
    }

    pub fn set_gateway_signer(&mut self, address: Option<String>) {
        self.assert_owner();
        self.gateway_signer =
            address.map(|a| parse_address(&a).unwrap_or_else(|e| env::panic_str(&e)));
    }

    pub fn set_sign_config(&mut self, format: SignFormat, deposit: U128, gas_tgas: u64) {
        self.assert_owner();
        require!(gas_tgas >= 50 && gas_tgas <= 250, "gas_tgas must be 50..=250");
        self.sign_format = format;
        self.sign_deposit = deposit;
        self.sign_gas_tgas = gas_tgas;
    }

    // ---------------------------------------------------------------- agent

    /// Called by the agent through its Function Call Key.
    ///
    /// Policy violations are returned as a REJECTED outcome rather than panicking. A panic would
    /// revert state, so a flood of rejected calls would never reach the circuit breaker.
    pub fn request_signature(
        &mut self,
        tx: EvmTx,
        tee: Option<TeeAttestation>,
    ) -> PromiseOrValue<SignOutcome> {
        let agent_id = env::predecessor_account_id();
        let mut agent = self
            .agents
            .get(&agent_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("NearPolicyError: agent is not registered"));
        let now = env::block_timestamp();

        // Velocity circuit breaker: every attempt counts, approved or not.
        agent.call_log.retain(|t| now.saturating_sub(*t) < MINUTE_NS);
        agent.call_log.push(now);
        if agent.call_log.len() > MAX_LOG_ENTRIES {
            agent.call_log.remove(0);
        }
        if !agent.tripped && agent.call_log.len() as u32 > agent.policy.max_calls_per_minute {
            agent.tripped = true;
            env::log_str("BASTION_CIRCUIT_BREAKER_TRIPPED");
        }
        if agent.tripped || agent.paused {
            agent.rejections += 1;
            let reason = if agent.tripped {
                "velocity circuit breaker tripped, agent is frozen until the owner resets it"
            } else {
                "agent is paused by the owner"
            };
            let out = SignOutcome {
                status: "FROZEN".into(),
                code: Some(if agent.tripped { "CIRCUIT_BREAKER" } else { "PAUSED" }.into()),
                reason: Some(format!("NearPolicyError: {reason}")),
                digest: None,
                signature: None,
            };
            self.agents.insert(agent_id, agent);
            return PromiseOrValue::Value(out);
        }

        match self.evaluate(&agent, now, &tx, &tee) {
            Err(r) => {
                agent.rejections += 1;
                let digest = unsigned_eip1559(&tx)
                    .ok()
                    .map(|b| format!("0x{}", hex::encode(env::keccak256(&b))));
                env::log_str(&format!("BASTION_REJECT {} {}", r.code, r.reason));
                self.agents.insert(agent_id, agent);
                PromiseOrValue::Value(SignOutcome::rejected(r.code, r.reason, digest))
            }
            Ok(ok) => {
                agent.approvals += 1;
                agent.spend_log.retain(|(t, _)| now.saturating_sub(*t) < HOUR_NS);
                agent.spend_log.push((now, ok.amount));
                let path = agent.derivation_path.clone();
                self.used_digests.insert(ok.digest);
                self.agents.insert(agent_id.clone(), agent);

                let digest_hex = hex::encode(ok.digest);
                env::log_str(&format!("BASTION_APPROVE amount={} digest=0x{}", ok.amount, digest_hex));
                let args = self.sign_args(&ok.digest, &path);
                let promise = Promise::new(self.signer_contract.clone())
                    .function_call(
                        "sign".to_string(),
                        args,
                        NearToken::from_yoctonear(self.sign_deposit.0),
                        Gas::from_tgas(self.sign_gas_tgas),
                    )
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(Gas::from_tgas(10))
                            .on_signed(agent_id, now, U128(ok.amount), digest_hex),
                    );
                PromiseOrValue::Promise(promise)
            }
        }
    }

    #[private]
    pub fn on_signed(
        &mut self,
        agent_id: AccountId,
        charged_at: u64,
        amount: U128,
        digest_hex: String,
        #[callback_result] result: Result<Value, PromiseError>,
    ) -> SignOutcome {
        let digest = format!("0x{digest_hex}");
        match result {
            Ok(signature) => SignOutcome {
                status: "APPROVED".into(),
                code: None,
                reason: None,
                digest: Some(digest),
                signature: Some(signature),
            },
            Err(_) => {
                // Signing did not happen: give the budget back and allow the digest to be retried.
                if let Some(agent) = self.agents.get_mut(&agent_id) {
                    if let Some(i) = agent
                        .spend_log
                        .iter()
                        .position(|(t, a)| *t == charged_at && *a == amount.0)
                    {
                        agent.spend_log.remove(i);
                    }
                    agent.approvals = agent.approvals.saturating_sub(1);
                }
                if let Ok(bytes) = hex::decode(&digest_hex) {
                    if let Ok(d) = <[u8; 32]>::try_from(bytes.as_slice()) {
                        self.used_digests.remove(&d);
                    }
                }
                SignOutcome {
                    status: "SIGN_FAILED".into(),
                    code: Some("MPC_FAILED".into()),
                    reason: Some("the MPC signer call failed; budget refunded".into()),
                    digest: Some(digest),
                    signature: None,
                }
            }
        }
    }

    // ---------------------------------------------------------------- views

    pub fn get_agent(&self, agent_account: AccountId) -> Option<AgentView> {
        let now = env::block_timestamp();
        self.agents.get(&agent_account).map(|a| {
            let spent: u128 =
                a.spend_log.iter().filter(|(t, _)| now.saturating_sub(*t) < HOUR_NS).map(|(_, v)| *v).sum();
            AgentView {
                policy: a.policy.clone(),
                derivation_path: a.derivation_path.clone(),
                paused: a.paused,
                tripped: a.tripped,
                rejections: a.rejections,
                approvals: a.approvals,
                spent_last_hour: U128(spent),
                remaining_hourly_budget: U128(a.policy.hourly_budget.0.saturating_sub(spent)),
                calls_last_minute: a
                    .call_log
                    .iter()
                    .filter(|t| now.saturating_sub(**t) < MINUTE_NS)
                    .count() as u32,
            }
        })
    }

    /// The digest the contract will ask the MPC network to sign for this transaction.
    /// Off-chain code uses this to check it builds the same transaction the contract sees.
    pub fn preview_digest(&self, tx: EvmTx) -> String {
        let bytes = unsigned_eip1559(&tx).unwrap_or_else(|e| env::panic_str(&e));
        format!("0x{}", hex::encode(env::keccak256(&bytes)))
    }

    pub fn get_config(&self) -> Value {
        json!({
            "owner": self.owner,
            "signer_contract": self.signer_contract,
            "provider_tee_signer": self.provider_tee_signer.map(|a| format!("0x{}", hex::encode(a))),
            "gateway_signer": self.gateway_signer.map(|a| format!("0x{}", hex::encode(a))),
            "sign_format": self.sign_format,
            "sign_deposit": self.sign_deposit,
            "sign_gas_tgas": self.sign_gas_tgas,
        })
    }
}

// -------------------------------------------------------------------- internals

impl BastionKey {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can call this");
    }

    fn validate_policy(p: &Policy) {
        require!(p.max_per_tx.0 > 0, "max_per_tx must be > 0");
        require!(p.hourly_budget.0 >= p.max_per_tx.0, "hourly_budget must be >= max_per_tx");
        require!(p.min_confidence_pct <= 100, "min_confidence_pct must be 0..=100");
        require!(p.max_calls_per_minute > 0, "max_calls_per_minute must be > 0");
        require!(!p.allowed_tokens.is_empty(), "allowed_tokens must not be empty");
        require!(!p.allowed_chain_ids.is_empty(), "allowed_chain_ids must not be empty");
        for a in p.allowed_tokens.iter().chain(p.allowed_recipients.iter()) {
            parse_address(a).unwrap_or_else(|e| env::panic_str(&e));
        }
    }

    fn sign_args(&self, digest: &[u8; 32], path: &str) -> Vec<u8> {
        let v = match self.sign_format {
            SignFormat::Legacy => json!({
                "request": { "payload": digest.to_vec(), "path": path, "key_version": 0 }
            }),
            SignFormat::V2 => json!({
                "request": {
                    "payload_v2": { "Ecdsa": hex::encode(digest) },
                    "path": path,
                    "domain_id": 0
                }
            }),
        };
        serde_json::to_vec(&v).unwrap()
    }

    fn evaluate(
        &self,
        agent: &Agent,
        now: u64,
        tx: &EvmTx,
        tee: &Option<TeeAttestation>,
    ) -> Result<Approved, Reject> {
        let p = &agent.policy;

        if !p.allowed_chain_ids.contains(&tx.chain_id) {
            return reject("CHAIN_NOT_ALLOWED", format!("chain {} is not allowed", tx.chain_id));
        }
        if tx.value.0 != 0 {
            return reject("NATIVE_VALUE", "native value transfers are not allowed");
        }
        let to = parse_address(&tx.to).map_err(|e| Reject { code: "BAD_TX", reason: e })?;
        let to_hex = format!("0x{}", hex::encode(to));
        if !p.allowed_tokens.iter().any(|t| t.to_lowercase() == to_hex) {
            return reject("TOKEN_NOT_ALLOWED", format!("contract {to_hex} is not an allowed token"));
        }
        let gas_cost = (tx.gas_limit as u128).saturating_mul(tx.max_fee_per_gas.0);
        if gas_cost > p.max_gas_cost_wei.0 {
            return reject(
                "GAS_CAP",
                format!("gas cost {} wei exceeds max_gas_cost_wei {}", gas_cost, p.max_gas_cost_wei.0),
            );
        }

        let transfer = decode_erc20_transfer(&tx.data.0)
            .map_err(|e| Reject { code: "BAD_CALLDATA", reason: e })?;
        let amount = transfer.amount;
        let recipient_hex = format!("0x{}", hex::encode(transfer.recipient));

        if amount > p.max_per_tx.0 {
            return reject(
                "MAX_PER_TX",
                format!("Exceeds max_per_tx limit (amount={} max={}). MPC signing HALTED", amount, p.max_per_tx.0),
            );
        }

        let spent: u128 = agent
            .spend_log
            .iter()
            .filter(|(t, _)| now.saturating_sub(*t) < HOUR_NS)
            .map(|(_, v)| *v)
            .sum();
        if spent.saturating_add(amount) > p.hourly_budget.0 {
            return reject(
                "HOURLY_BUDGET",
                format!(
                    "Exceeds rolling hourly budget (spent={} amount={} budget={})",
                    spent, amount, p.hourly_budget.0
                ),
            );
        }

        let open_recipients = p.allowed_recipients.is_empty();
        if !open_recipients
            && !p.allowed_recipients.iter().any(|r| r.to_lowercase() == recipient_hex)
        {
            return reject(
                "RECIPIENT_NOT_ALLOWED",
                format!("recipient {recipient_hex} is not on the allow-list"),
            );
        }

        let unsigned = unsigned_eip1559(tx).map_err(|e| Reject { code: "BAD_TX", reason: e })?;
        let digest: [u8; 32] = env::keccak256_array(&unsigned);
        if self.used_digests.contains(&digest) {
            return reject("REPLAY", "this exact transaction was already approved");
        }
        let digest_hex = hex::encode(digest);

        // A TEE verdict is mandatory for open recipients and for amounts above the threshold.
        let tee_needed = open_recipients || amount > p.tee_required_above.0;
        if tee_needed {
            let att = match tee {
                Some(a) => a,
                None => return reject("TEE_REQUIRED", "a TEE semantic verdict is required for this transfer"),
            };
            let signer = match att.kind.as_str() {
                "provider_tee" => self.provider_tee_signer,
                "gateway" => self.gateway_signer,
                _ => None,
            };
            let signer = match signer {
                Some(s) => s,
                None => {
                    return reject(
                        "TEE_SIGNER_NOT_CONFIGURED",
                        format!("no pinned signer for attestation kind {}", att.kind),
                    )
                }
            };
            let verdict = tee::verify(att, &signer, &digest_hex)
                .map_err(|e| Reject { code: "TEE_INVALID", reason: e })?;
            if !verdict.is_aligned {
                return reject(
                    "SEMANTIC_MISMATCH",
                    "SemanticMismatch: calldata does not serve the task. Attestation DENIED",
                );
            }
            if verdict.confidence_pct < p.min_confidence_pct as u64 {
                return reject(
                    "LOW_CONFIDENCE",
                    format!(
                        "verdict confidence {}% is below the required {}%",
                        verdict.confidence_pct, p.min_confidence_pct
                    ),
                );
            }
        }

        Ok(Approved { amount, digest })
    }
}

#[cfg(test)]
mod tests;
