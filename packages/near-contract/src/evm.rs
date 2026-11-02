//! Minimal EVM helpers: EIP-1559 unsigned transaction encoding and ERC-20 `transfer` decoding.
//!
//! The contract builds the bytes that get signed itself, from structured fields. The agent never
//! supplies a raw payload hash, so it cannot claim "this is a $5 transfer" while signing something else.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::near;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct EvmTx {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: U128,
    pub max_fee_per_gas: U128,
    pub gas_limit: u64,
    /// 0x-prefixed 20 byte address of the contract being called
    pub to: String,
    pub value: U128,
    pub data: Base64VecU8,
}

pub const ERC20_TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];

/// Decoded ERC-20 `transfer(address,uint256)` call.
#[derive(Debug, PartialEq, Eq)]
pub struct Erc20Transfer {
    pub recipient: [u8; 20],
    pub amount: u128,
}

pub fn decode_erc20_transfer(data: &[u8]) -> Result<Erc20Transfer, String> {
    if data.len() != 4 + 32 + 32 {
        return Err(format!("calldata must be exactly 68 bytes, got {}", data.len()));
    }
    if data[..4] != ERC20_TRANSFER_SELECTOR {
        return Err("calldata is not ERC-20 transfer(address,uint256)".to_string());
    }
    let to_word = &data[4..36];
    if to_word[..12].iter().any(|b| *b != 0) {
        return Err("recipient word has non-zero padding".to_string());
    }
    let mut recipient = [0u8; 20];
    recipient.copy_from_slice(&to_word[12..]);
    let amount_word = &data[36..68];
    if amount_word[..16].iter().any(|b| *b != 0) {
        return Err("amount does not fit in u128".to_string());
    }
    let mut a = [0u8; 16];
    a.copy_from_slice(&amount_word[16..]);
    Ok(Erc20Transfer { recipient, amount: u128::from_be_bytes(a) })
}

pub fn parse_address(s: &str) -> Result<[u8; 20], String> {
    let raw = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s);
    let bytes = hex::decode(raw).map_err(|_| format!("invalid hex address: {s}"))?;
    if bytes.len() != 20 {
        return Err(format!("address must be 20 bytes: {s}"));
    }
    let mut out = [0u8; 20];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn trim_be(bytes: &[u8]) -> &[u8] {
    let first = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    &bytes[first..]
}

fn rlp_length_prefix(len: usize, offset: u8) -> Vec<u8> {
    if len < 56 {
        vec![offset + len as u8]
    } else {
        let len_bytes = (len as u64).to_be_bytes();
        let len_bytes = trim_be(&len_bytes);
        let mut out = vec![offset + 55 + len_bytes.len() as u8];
        out.extend_from_slice(len_bytes);
        out
    }
}

pub fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 0x80 {
        return b.to_vec();
    }
    let mut out = rlp_length_prefix(b.len(), 0x80);
    out.extend_from_slice(b);
    out
}

pub fn rlp_uint(n: u128) -> Vec<u8> {
    let be = n.to_be_bytes();
    rlp_bytes(trim_be(&be))
}

pub fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = items.iter().flatten().copied().collect();
    let mut out = rlp_length_prefix(payload.len(), 0xc0);
    out.extend_from_slice(&payload);
    out
}

/// EIP-1559 (type 2) unsigned transaction: `0x02 || rlp([chainId, nonce, maxPriorityFee, maxFee,
/// gasLimit, to, value, data, accessList])`. The keccak256 of this is what the MPC network signs.
pub fn unsigned_eip1559(tx: &EvmTx) -> Result<Vec<u8>, String> {
    let to = parse_address(&tx.to)?;
    let fields = vec![
        rlp_uint(tx.chain_id as u128),
        rlp_uint(tx.nonce as u128),
        rlp_uint(tx.max_priority_fee_per_gas.0),
        rlp_uint(tx.max_fee_per_gas.0),
        rlp_uint(tx.gas_limit as u128),
        rlp_bytes(&to),
        rlp_uint(tx.value.0),
        rlp_bytes(&tx.data.0),
        rlp_list(&[]),
    ];
    let mut out = vec![0x02];
    out.extend(rlp_list(&fields));
    Ok(out)
}
