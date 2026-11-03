/**
 * Shared harness for BastionKey demos running against NEAR Testnet.
 *
 * Runs exclusively in live mode against the deployed BastionKey policy contract,
 * NEAR MPC network (v1.signer-prod.testnet), and NEAR AI Cloud (TEE).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

try { process.loadEnvFile?.(); } catch {}

import { connect, keyStores, KeyPair, providers } from "near-api-js";
import { chainAdapters, contracts } from "chainsig.js";
import { keccak256, recoverTransactionAddress, type Address, type Hex } from "viem";
import {
  BASE_SEPOLIA,
  buildErc20Transfer,
  decodeTransfer,
  signatureFromMpc,
  signedRawTx,
  unsignedDigest,
  usd,
  type EvmTx,
  type MpcSignature,
  type PolicyJson,
} from "@bastionkey/relayer";
import {
  NearAiVerifier,
  fetchSigningAddress,
  type Attestation,
  type Verifier,
} from "@bastionkey/tee-verifier";

export const SIGNER_CONTRACT = "v1.signer-prod.testnet";
export const DERIVATION_PATH = "agent-session-1";
export const RPC_PROVIDER = "0x1111111111111111111111111111111111111111" as Address;
export const ATTACKER = "0xbadbadbadbadbadbadbadbadbadbadbadbadbad0" as Address;

export type Tag = "APPROVED" | "REJECTED_ON_CHAIN" | "BLOCKED_BY_TEE";

export interface Scenario {
  name: string;
  title: string;
  recipients: "closed" | "open";
  task: string;
  actionLog: string[];
  recipient: Address;
  dollars: number;
  expect: Tag;
}

export interface ContractConfig {
  owner: string;
  signer_contract: string;
  provider_tee_signer: string | null;
  gateway_signer: string | null;
  sign_format: string;
  sign_deposit: string;
  sign_gas_tgas: number;
}

export interface SignOutcomeResponse {
  status: "APPROVED" | "REJECTED" | "FROZEN" | "SIGN_FAILED";
  code?: string;
  reason?: string;
  digest?: string;
  signature?: MpcSignature;
}

const line = (s = "") => console.log(s);

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val || val.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. Set it in .env to run against testnet. Local simulation is disabled.`,
    );
  }
  return val.trim();
}

export async function runScenario(s: Scenario): Promise<void> {
  const mode = process.env.BASTION_MODE ?? "testnet";
  if (mode !== "testnet") {
    throw new Error(`BASTION_MODE="${mode}" is unsupported. BastionKey runs only against the live testnet contract.`);
  }

  const contractId = requireEnv("BASTION_CONTRACT_ID");
  const agentId = requireEnv("AGENT_ACCOUNT_ID");
  const agentPrivateKey = requireEnv("AGENT_PRIVATE_KEY");
  const apiKey = requireEnv("NEARAI_API_KEY");
  const model = process.env.NEARAI_MODEL ?? "deepseek-ai/DeepSeek-V3.1";
  const networkId = process.env.NEAR_NETWORK ?? "testnet";
  const nodeUrl = `https://rpc.${networkId}.near.org`;

  const events: Array<Record<string, unknown>> = [];
  const log = (kind: string, data: Record<string, unknown>) => events.push({ t: new Date().toISOString(), kind, ...data });

  let finalTag: Tag | "ERROR" = "ERROR";

  try {
    line(`=== BastionKey demo: ${s.title} ===`);
    line(`mode: LIVE TESTNET | contract=${contractId} | MPC=${SIGNER_CONTRACT} | verifier=NEAR AI Cloud`);

    // 1. Connect to NEAR Testnet with the agent's Function Call Key
    const keyStore = new keyStores.InMemoryKeyStore();
    const keyPair = KeyPair.fromString(agentPrivateKey);
    await keyStore.setKey(networkId, agentId, keyPair);
    const near = await connect({ networkId, nodeUrl, keyStore });
    const agentAccount = await near.account(agentId);

    // 2. Fetch contract configuration and check TEE signer pin
    const config = (await agentAccount.viewFunction({
      contractId,
      methodName: "get_config",
      args: {},
    })) as ContractConfig;
    log("contract_config", config as unknown as Record<string, unknown>);

    const { address: liveTeeSigner } = await fetchSigningAddress({ apiKey, model });
    if (!liveTeeSigner) {
      throw new Error(`Could not obtain signing_address from NEAR AI Cloud attestation report for ${model}`);
    }

    if (config.provider_tee_signer) {
      const pinned = "0x" + config.provider_tee_signer.toLowerCase().replace(/^0x/, "");
      if (pinned !== liveTeeSigner.toLowerCase()) {
        throw new Error(
          `Contract pinned TEE signer (${pinned}) does not match current NEAR AI Cloud attestation report signer (${liveTeeSigner}).`,
        );
      }
    }

    const verifier: Verifier = new NearAiVerifier({ apiKey, model });

    // 3. Derive agent's foreign EVM address via chainsig.js
    const csContract = new contracts.ChainSignatureContract({
      network: networkId,
      contractId: config.signer_contract || SIGNER_CONTRACT,
    });
    const evmAdapter = new chainAdapters.evm.EVM({ contract: csContract });
    const { address: eoa } = await evmAdapter.deriveAddressAndPublicKey(DERIVATION_PATH, contractId);

    line(`[INFO] agent account : ${agentId} (holds a Function Call Key on ${contractId})`);
    line(`[INFO] derived EOA   : ${eoa} on Base Sepolia (${BASE_SEPOLIA.chainId}), path "${DERIVATION_PATH}"`);
    line(`[INFO] task          : ${s.task}`);
    s.actionLog.forEach((l) => line(`[INFO] agent log     : ${l}`));
    log("setup", { agent: agentId, eoa, task: s.task, actionLog: s.actionLog });

    // 4. Build proposed ERC-20 transfer
    const tx: EvmTx = buildErc20Transfer({
      nonce: 1,
      recipient: s.recipient,
      amount: BigInt(s.dollars) * 1_000_000n,
    });
    const digest = unsignedDigest(tx);
    const decoded = decodeTransfer(tx);

    // Verify relayer and contract agreement on transaction digest
    const onChainDigest = (await agentAccount.viewFunction({
      contractId,
      methodName: "preview_digest",
      args: { tx },
    })) as string;

    if (onChainDigest.toLowerCase() !== digest.toLowerCase()) {
      throw new Error(`Digest mismatch: relayer ${digest} vs on-chain contract ${onChainDigest}`);
    }
    line(`[INFO] proposed tx   : transfer ${usd(decoded.amount)} USDC -> ${decoded.recipient}`);
    line(`[CHECK] relayer and contract compute the same tx digest: ${digest}`);
    log("proposed", { recipient: decoded.recipient, amount: decoded.amount.toString(), digest });

    // 5. Verifier checks semantic alignment against the task
    const v = await verifier.verify({
      task: s.task,
      actionLog: s.actionLog,
      tx: {
        chainId: tx.chain_id,
        token: tx.to,
        recipient: decoded.recipient,
        amount: decoded.amount,
        decimals: BASE_SEPOLIA.usdcDecimals,
        digest,
      },
    });
    line(
      `[INFO] TEE verdict   : aligned=${v.verdict.is_aligned} confidence=${v.verdict.confidence_pct}% (${v.verdict.reason ?? "no reason given"})`,
    );
    log("verdict", { ...v.verdict, signer: v.signer, label: verifier.label });

    // 6. Call request_signature on the deployed contract
    line(`[INFO] calling ${contractId}.request_signature as ${agentId}...`);
    const txResult = await agentAccount.functionCall({
      contractId,
      methodName: "request_signature",
      args: {
        tx,
        tee: v.attestation,
      },
      gas: 300_000_000_000_000n, // 300 Tgas
      attachedDeposit: 0n,
    });

    const outcome = providers.getTransactionLastResult(txResult) as SignOutcomeResponse;
    log("contract_result", outcome as unknown as Record<string, unknown>);

    if (outcome.status === "APPROVED") {
      finalTag = "APPROVED";
      if (!outcome.signature) {
        throw new Error("Contract returned APPROVED status but no MPC signature was provided.");
      }
      const raw = signedRawTx(tx, signatureFromMpc(outcome.signature));
      const recovered = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` });
      if (recovered.toLowerCase() !== eoa.toLowerCase()) {
        throw new Error(`Recovered address ${recovered} does not match derived EOA ${eoa}`);
      }
      const txHash = keccak256(raw);
      line(`[APPROVED] On-chain rules PASSED. TEE semantic alignment PASSED.`);
      line(`[APPROVED] Base Sepolia Tx Signed via NEAR MPC: ${txHash}`);
      line(`[INFO] signature recovers to derived EOA ${recovered}`);
      log("signed", { raw, txHash, recovered });
    } else if (outcome.code === "SEMANTIC_MISMATCH") {
      finalTag = "BLOCKED_BY_TEE";
      line(
        `[BLOCKED_BY_TEE] SemanticMismatch: ${outcome.reason ?? v.verdict.reason ?? "calldata does not serve the task"}. Attestation DENIED. No signature was produced.`,
      );
    } else if (outcome.code === "MAX_PER_TX") {
      finalTag = "REJECTED_ON_CHAIN";
      line(`[REJECTED_ON_CHAIN] NearPolicyError: ${outcome.reason ?? "Exceeds max_per_tx limit"}. MPC signing HALTED.`);
    } else {
      finalTag = "REJECTED_ON_CHAIN";
      line(`[REJECTED_ON_CHAIN] ${outcome.reason ?? outcome.status} (code ${outcome.code ?? "UNKNOWN"}). MPC signing HALTED.`);
    }

    // 7. Query updated agent state on-chain
    try {
      const view = await agentAccount.viewFunction({
        contractId,
        methodName: "get_agent",
        args: { agent_account: agentId },
      });
      line(
        `[INFO] agent state   : approvals=${view.approvals} rejections=${view.rejections} spent_last_hour=${usd(
          view.spent_last_hour,
        )} remaining=${usd(view.remaining_hourly_budget)}`,
      );
      log("final_state", view);
    } catch {
      // view query might fail if agent view is omitted
    }
  } catch (e) {
    line(`[ERROR] ${(e as Error).message}`);
    log("error", { message: (e as Error).message });
  }

  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "demo-output");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${s.name}.json`), JSON.stringify({ scenario: s, result: finalTag, events }, null, 2));

  if (finalTag !== s.expect) {
    line(`[FAIL] expected ${s.expect}, got ${finalTag}`);
    process.exit(1);
  }
  line(`[PASS] outcome ${finalTag} is what this scenario demonstrates`);
}
