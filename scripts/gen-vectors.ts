/**
 * Generates cross-language test vectors for the Rust contract.
 *
 * The EIP-1559 digest is computed by viem, an independent implementation, so the contract's
 * hand-written RLP encoder is checked against it. The attestation is signed with a fixed test
 * key in the same format NEAR AI Cloud uses (EIP-191 over "<model>:<sha256 req>:<sha256 resp>").
 *
 * Run: npm run gen:vectors
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, keccak256, parseAbi, serializeTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "packages", "near-contract", "tests");
mkdirSync(outDir, { recursive: true });

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Base Sepolia USDC
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as const;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const abi = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

const data = encodeFunctionData({ abi, functionName: "transfer", args: [RECIPIENT, 5_000_000n] });
const tx = {
  chain_id: 84532,
  nonce: 7,
  max_priority_fee_per_gas: "1000000",
  max_fee_per_gas: "2000000000",
  gas_limit: 100000,
  to: USDC,
  value: "0",
  data_hex: data,
};

const unsigned = serializeTransaction({
  type: "eip1559",
  chainId: tx.chain_id,
  nonce: tx.nonce,
  maxPriorityFeePerGas: BigInt(tx.max_priority_fee_per_gas),
  maxFeePerGas: BigInt(tx.max_fee_per_gas),
  gas: BigInt(tx.gas_limit),
  to: USDC,
  value: 0n,
  data,
  accessList: [],
});
const digest = keccak256(unsigned);

// A long-calldata case to exercise the RLP long-string branch (not a valid ERC-20 call).
const longData = ("0x" + "ab".repeat(120)) as `0x${string}`;
const unsignedLong = serializeTransaction({
  type: "eip1559",
  chainId: 1,
  nonce: 0,
  maxPriorityFeePerGas: 0n,
  maxFeePerGas: 1n,
  gas: 21000n,
  to: USDC,
  value: 0n,
  data: longData,
  accessList: [],
});

// Attestation signed by a fixed, public, test-only key.
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(TEST_KEY);
const model = "test-model/verifier";
const request = JSON.stringify({
  model,
  messages: [{ role: "user", content: `TASK: pay the RPC provider\nTX_DIGEST:${digest}` }],
});
const response = JSON.stringify({
  id: "chatcmpl-test",
  choices: [
    {
      message: {
        role: "assistant",
        content: JSON.stringify({ tx_digest: digest, is_aligned: true, confidence_pct: 97 }),
      },
    },
  ],
});
const text = `${model}:${sha256(request)}:${sha256(response)}`;
const signature = await account.signMessage({ message: text });

const out = {
  tx,
  unsigned_hex: unsigned,
  digest,
  long_data: { hex: longData, unsigned_hex: unsignedLong, digest: keccak256(unsignedLong) },
  attestation: {
    signer_address: account.address.toLowerCase(),
    kind: "provider_tee",
    model_id: model,
    request,
    response,
    signed_text: text,
    signature,
  },
};
writeFileSync(join(outDir, "vectors.json"), JSON.stringify(out, null, 2) + "\n");
console.log("wrote", join(outDir, "vectors.json"));
console.log("digest", digest);
