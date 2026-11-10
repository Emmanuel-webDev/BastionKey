//! Verification of NEAR AI Cloud response signatures, on chain.
//!
//! NEAR AI Cloud signs `text` with an ECDSA key whose address is reported by its attestation
//! endpoint. The signed text, per the NEAR AI Cloud docs, is:
//!   provider_tee: "<MODEL_ID>:<sha256(request_body)>:<sha256(response_body)>"
//!   gateway:      "<sha256(request_body)>:<sha256(response_body)>"
//! and the signature is an Ethereum EIP-191 personal-message signature.
//!
//! This module re-derives that text from the raw request and response bytes it is handed, recovers
//! the signer, and compares it with the provider signing address the contract owner pinned.
//! It then reads the verdict out of the signed response and checks it is bound to the exact
//! transaction digest being signed.

use near_sdk::json_types::Base64VecU8;
use near_sdk::serde_json::{self, Value};
use near_sdk::{env, near};

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct TeeAttestation {
    /// "provider_tee" or "gateway"
    pub kind: String,
    /// Canonical model id. Required for "provider_tee".
    pub model_id: Option<String>,
    /// Exact request body bytes that were sent to NEAR AI Cloud
    pub request: Base64VecU8,
    /// Exact response body bytes that were received
    pub response: Base64VecU8,
    /// 0x-prefixed 65 byte signature (r || s || v) from GET /v1/signature/{chat_id}
    pub signature: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Verdict {
    pub is_aligned: bool,
    pub confidence_pct: u64,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(env::sha256(bytes))
}

pub fn signed_text(att: &TeeAttestation) -> Result<String, String> {
    let req = sha256_hex(&att.request.0);
    let resp = sha256_hex(&att.response.0);
    match att.kind.as_str() {
        "provider_tee" => {
            let model = att
                .model_id
                .as_ref()
                .ok_or_else(|| "provider_tee attestation needs model_id".to_string())?;
            Ok(format!("{model}:{req}:{resp}"))
        }
        "gateway" => Ok(format!("{req}:{resp}")),
        other => Err(format!("unknown attestation kind: {other}")),
    }
}

pub fn eip191_hash(text: &str) -> Vec<u8> {
    let mut msg = format!("\u{19}Ethereum Signed Message:\n{}", text.len()).into_bytes();
    msg.extend_from_slice(text.as_bytes());
    env::keccak256(&msg)
}

pub fn recover_signer(text: &str, signature_hex: &str) -> Result<[u8; 20], String> {
    let raw = signature_hex.strip_prefix("0x").unwrap_or(signature_hex);
    let sig = hex::decode(raw).map_err(|_| "signature is not hex".to_string())?;
    if sig.len() != 65 {
        return Err(format!("signature must be 65 bytes, got {}", sig.len()));
    }
    let v = if sig[64] >= 27 { sig[64] - 27 } else { sig[64] };
    if v > 1 {
        return Err("invalid recovery id".to_string());
    }
    let hash = eip191_hash(text);
    // malleability flag false: replay is already prevented by the per-digest nonce set.
    let pubkey = env::ecrecover(&hash, &sig[..64], v, false)
        .ok_or_else(|| "signature recovery failed".to_string())?;
    let addr_hash = env::keccak256(&pubkey);
    let mut out = [0u8; 20];
    out.copy_from_slice(&addr_hash[12..]);
    Ok(out)
}

/// Pull the first `{...}` object out of model output. Models sometimes wrap JSON in prose or fences.
fn extract_json_object(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let end = s.rfind('}')?;
    (end > start).then(|| &s[start..=end])
}

/// Full verification. Returns the verdict only if the signature, the digest binding and the
/// response format all check out. The caller applies the policy's confidence threshold.
pub fn verify(
    att: &TeeAttestation,
    expected_signer: &[u8; 20],
    digest_hex: &str,
) -> Result<Verdict, String> {
    let text = signed_text(att)?;
    let signer = recover_signer(&text, &att.signature)?;
    if &signer != expected_signer {
        return Err("signature was not made by the pinned TEE signing key".to_string());
    }

    let request = std::str::from_utf8(&att.request.0).map_err(|_| "request is not utf-8")?;
    let marker = format!("TX_DIGEST:0x{digest_hex}");
    if !request.contains(&marker) {
        return Err("attested request does not cover this transaction digest".to_string());
    }

    let body: Value = serde_json::from_slice(&att.response.0)
        .map_err(|_| "response body is not json".to_string())?;
    let content = body["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| "response has no message content".to_string())?;
    let obj = extract_json_object(content).ok_or_else(|| "no json verdict in content".to_string())?;
    let verdict: Value =
        serde_json::from_str(obj).map_err(|_| "verdict is not valid json".to_string())?;

    let echoed = verdict["tx_digest"].as_str().unwrap_or_default();
    if echoed.to_lowercase() != format!("0x{digest_hex}") {
        return Err("verdict does not echo this transaction digest".to_string());
    }
    let is_aligned = verdict["is_aligned"]
        .as_bool()
        .ok_or_else(|| "verdict missing is_aligned".to_string())?;
    let confidence_pct = verdict["confidence_pct"]
        .as_u64()
        .ok_or_else(|| "verdict missing integer confidence_pct".to_string())?;
    Ok(Verdict { is_aligned, confidence_pct })
}
