/**
 * Shared harness for the three judge-facing demos.
 *
 * What runs for real in every demo:
 *   - the BastionKey policy contract code (native build of the same Rust that compiles to wasm,
 *     under near-sdk's mock VM; see packages/near-contract/examples/sim.rs)
 *   - on-chain TEE-signature verification (EIP-191 recovery, digest binding)
 *   - EVM transaction construction and signature assembly, using viem and chainsig.js
 *
 * What is a local stand-in (clearly labelled in the output):
 *   - the NEAR MPC network (v1.signer-prod.testnet)  -> LocalMpc
 *   - the NEAR AI Cloud TEE verifier                 -> LocalAttestor (unless BASTION_VERIFIER=nearai)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

try { process.loadEnvFile?.(); } catch {}
import { keccak256, recoverTransactionAddress, type Address, type Hex } from "viem";
import {
  BASE_SEPOLIA,
  LocalMpc,
  SimBackend,
  buildErc20Transfer,
  decodeTransfer,
  signatureFromMpc,
  signedRawTx,
  unsignedDigest,
  usd,
  type PolicyJson,
} from "@bastionkey/relayer";
import { LocalAttestor, NearAiVerifier, fetchSigningAddress, type Verifier } from "@bastionkey/tee-verifier";

export const OWNER = "owner.testnet";
export const AGENT = "agent-1.bastion.testnet";
export const SIGNER_CONTRACT = "v1.signer-prod.testnet";
export const DERIVATION_PATH = "agent-session-1";
export const RPC_PROVIDER = "0x1111111111111111111111111111111111111111" as Address;
export const ATTACKER = "0xbadbadbadbadbadbadbadbadbadbadbadbadbad0" as Address;

export type Tag = "APPROVED" | "REJECTED_ON_CHAIN" | "BLOCKED_BY_TEE";

export interface Scenario {
  name: string;
  title: string;
  /** closed = recipient allow-list; open = any recipient, so only the TEE check can catch a bad one */
  recipients: "closed" | "open";
  task: string;
  actionLog: string[];
  recipient: Address;
  /** USDC, whole dollars */
  dollars: number;
  expect: Tag;
}

export function policyFor(kind: "closed" | "open"): PolicyJson {
  return {
    max_per_tx: "50000000", // $50.00
    hourly_budget: "100000000", // $100.00
    max_gas_cost_wei: "10000000000000000", // 0.01 ETH
    allowed_tokens: [BASE_SEPOLIA.usdc],
    allowed_recipients: kind === "closed" ? [RPC_PROVIDER] : [],
    allowed_chain_ids: [BASE_SEPOLIA.chainId],
    tee_required_above: "0", // every transfer needs a TEE verdict
    min_confidence_pct: 80,
    max_calls_per_minute: 20,
  };
}

async function pickVerifier(): Promise<{ verifier: Verifier; signer: string; mode: string }> {
  if (process.env.BASTION_VERIFIER === "nearai") {
    const apiKey = process.env.NEARAI_API_KEY;
    if (!apiKey) throw new Error("BASTION_VERIFIER=nearai needs NEARAI_API_KEY");
    const model = process.env.NEARAI_MODEL ?? "deepseek-ai/DeepSeek-V3.1";
    const { address } = await fetchSigningAddress({ apiKey, model });
    if (!address) throw new Error("could not read signing_address from the NEAR AI Cloud attestation report");
    return { verifier: new NearAiVerifier({ apiKey, model }), signer: address, mode: "NEAR AI Cloud (live)" };
  }
  const local = new LocalAttestor();
  return { verifier: local, signer: local.address, mode: "local stand-in" };
}

const line = (s = "") => console.log(s);

export async function runScenario(s: Scenario): Promise<void> {
  if ((process.env.BASTION_MODE ?? "local") !== "local") {
    console.error("BASTION_MODE=testnet is not implemented yet. Run with BASTION_MODE=local (default).");
    process.exit(2);
  }

  const events: Array<Record<string, unknown>> = [];
  const log = (kind: string, data: Record<string, unknown>) => events.push({ t: new Date().toISOString(), kind, ...data });

  const sim = SimBackend.start();
  let finalTag: Tag | "ERROR" = "ERROR";
  try {
    const { verifier, signer, mode } = await pickVerifier();
    const mpc = new LocalMpc("bastionkey-demo-seed");
    const policy = policyFor(s.recipients);

    await sim.init(OWNER, SIGNER_CONTRACT);
    await sim.setTeeSigner(signer);
    await sim.registerAgent(AGENT, DERIVATION_PATH, policy);

    const eoa = mpc.address(DERIVATION_PATH);
    line(`=== BastionKey demo: ${s.title} ===`);
    line(
      `mode: contract=real BastionKey code (native, near-sdk mock VM) | MPC signer=local stand-in for ${SIGNER_CONTRACT} | verifier=${mode}`,
    );
    line(`[INFO] agent account : ${AGENT} (holds a Function Call Key only; no private key on any chain)`);
    line(`[INFO] derived EOA   : ${eoa} on Base Sepolia (${BASE_SEPOLIA.chainId}), path "${DERIVATION_PATH}"`);
    line(
      `[INFO] policy        : max_per_tx ${usd(policy.max_per_tx)}, hourly ${usd(policy.hourly_budget)}, recipients ${
        s.recipients === "closed" ? "allow-list (1)" : "OPEN, TEE verdict mandatory"
      }`,
    );
    line(`[INFO] task          : ${s.task}`);
    s.actionLog.forEach((l) => line(`[INFO] agent log     : ${l}`));
    log("setup", { agent: AGENT, eoa, policy, task: s.task, actionLog: s.actionLog });

    // 1. the agent builds a transaction
    const tx = buildErc20Transfer({ nonce: 1, recipient: s.recipient, amount: BigInt(s.dollars) * 1_000_000n });
    const digest = unsignedDigest(tx);
    const onChainDigest = await sim.previewDigest(tx);
    if (onChainDigest !== digest) throw new Error(`digest mismatch: relayer ${digest} vs contract ${onChainDigest}`);
    const decoded = decodeTransfer(tx);
    line(`[INFO] proposed tx   : transfer ${usd(decoded.amount)} USDC -> ${decoded.recipient}`);
    line(`[CHECK] relayer and contract compute the same tx digest: ${digest}`);
    log("proposed", { recipient: decoded.recipient, amount: decoded.amount.toString(), digest });

    // 2. the verifier inspects the exact bytes against the task
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

    // 3. the agent asks the contract for a signature
    const res = await sim.call(AGENT, Math.floor(Date.now() / 1000), tx, v.attestation);
    log("contract_result", res as unknown as Record<string, unknown>);

    if (res.kind === "value") {
      const o = res.outcome;
      if (o.code === "SEMANTIC_MISMATCH") {
        finalTag = "BLOCKED_BY_TEE";
        line(`[BLOCKED_BY_TEE] SemanticMismatch: ${v.verdict.reason ?? "calldata does not serve the task"}. Attestation DENIED. No signature was produced.`);
      } else if (o.code === "MAX_PER_TX") {
        finalTag = "REJECTED_ON_CHAIN";
        line(
          `[REJECTED_ON_CHAIN] NearPolicyError: Exceeds max_per_tx limit (${usd(policy.max_per_tx)}); requested ${usd(decoded.amount)}. MPC signing HALTED.`,
        );
      } else {
        finalTag = "REJECTED_ON_CHAIN";
        line(`[REJECTED_ON_CHAIN] ${o.reason} (code ${o.code}). MPC signing HALTED.`);
      }
    } else {
      // approved: the contract asked the MPC signer to sign. Check it asked for the right thing.
      const req = res.args.request;
      const payload = "0x" + Buffer.from(req.payload).toString("hex");
      if (res.receiver !== SIGNER_CONTRACT || res.method !== "sign") throw new Error("contract called the wrong signer");
      if (payload !== digest || req.path !== DERIVATION_PATH) throw new Error("contract asked to sign the wrong payload");
      line(`[CHECK] contract called ${res.receiver}.${res.method} with the approved digest and path "${req.path}"`);

      const mpcResponse = await mpc.sign(digest as Hex, req.path);
      const raw = signedRawTx(tx, signatureFromMpc(mpcResponse));
      const recovered = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` });
      if (recovered.toLowerCase() !== eoa.toLowerCase()) throw new Error("signature does not recover to the derived EOA");
      finalTag = "APPROVED";
      line(
        `[APPROVED] On-chain rules PASSED. TEE semantic alignment PASSED. Base Sepolia Tx Signed via MPC (local stand-in): ${keccak256(raw)}`,
      );
      line(`[INFO] signature recovers to the derived EOA ${recovered}; transaction was not broadcast`);
      log("signed", { raw, txHash: keccak256(raw), recovered });
    }

    const view = await sim.view(AGENT, Math.floor(Date.now() / 1000));
    line(
      `[INFO] agent state   : approvals=${view.approvals} rejections=${view.rejections} spent_last_hour=${usd(view.spent_last_hour)} remaining=${usd(view.remaining_hourly_budget)}`,
    );
    log("final_state", view);
  } catch (e) {
    line(`[ERROR] ${(e as Error).message}`);
    log("error", { message: (e as Error).message });
  } finally {
    sim.close();
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
