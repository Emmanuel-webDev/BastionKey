/**
 * BastionKey Offline Simulation (TEST-ONLY)
 *
 * NOTE: This is an OFFLINE TEST-ONLY SIMULATION, not the live system.
 * It runs entirely locally with zero external network calls, zero NEAR testnet keys,
 * and zero NEAR AI Cloud API keys using deterministic local stand-ins (LocalMpc and LocalAttestor).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import { unsignedDigest, usd } from "@bastionkey/relayer";
import { LocalMpc } from "../packages/relayer/src/testing/localMpc.js";
import { LocalAttestor } from "../packages/tee-verifier/src/testing/localAttestor.js";
import { BastionClient } from "../packages/client/src/bastionClient.js";
import type {
  AgentView,
  ContractConfig,
  EvmClientLike,
  NearAccountLike,
  SignOutcomeResponse,
} from "../packages/client/src/types.js";

const line = (s = "") => console.log(s);

async function runOfflineScenarios() {
  line("================================================================================");
  line("  [TEST-ONLY] BastionKey Offline Simulation");
  line("  (offline simulation, not the live system - no network calls or keys required)");
  line("================================================================================");
  line();

  const configPath = join(dirname(fileURLToPath(import.meta.url)), "config", "scenarios.json");
  const scenariosData = JSON.parse(readFileSync(configPath, "utf8"));

  const mpc = new LocalMpc("offline-sim-seed");
  const attestor = new LocalAttestor();
  const eoa = mpc.address("agent-session-1");

  const contractConfig: ContractConfig = {
    owner_id: "bastion-owner.testnet",
    mpc_contract_id: "v1.signer-prod.testnet",
    provider_tee_signer: attestor.address,
    gateway_signer: null,
    sign_format: "v2",
    sign_deposit: "0",
    sign_gas_tgas: 250,
  };

  const agentPolicy: AgentView = {
    account_id: "agent-1.bastion-guard.testnet",
    policy: {
      per_tx_cap: "50000000", // $50.00
      lifetime_cap: "500000000", // $500.00
      allowed_recipients: ["0x1111111111111111111111111111111111111111" as Address],
      allowed_tokens: ["0x036CbD53842c5426634e7929541eC2318f3dCF7e"],
    },
    metrics: {
      lifetime_spent: "5000000",
      rejections_in_window: 0,
      window_started_at: "0",
    },
    paused: false,
    tripped: false,
    tripped_at: null,
    trip_reason: null,
  };

  const evmClient: EvmClientLike = {
    getTransactionCount: async () => 42,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 2_100_000_000n,
      maxPriorityFeePerGas: 1_100_000n,
    }),
    sendRawTransaction: async () => "0xoffline_tx_hash_simulated" as Hex,
    waitForTransactionReceipt: async () => ({
      status: "success",
      blockNumber: 18920442n,
    }),
  };

  const nearAccount: NearAccountLike = {
    callFunctionRaw: async ({ args }: { args: any }) => {
      const { tx, tee } = args;
      const amount = BigInt(tx.data ? "0x" + Buffer.from(tx.data, "base64").toString("hex").slice(72) : "0");
      const perTxCap = BigInt(agentPolicy.policy.per_tx_cap);

      // Check per-tx limit
      if (amount > perTxCap) {
        return {
          status: "REJECTED",
          code: "OVER_BUDGET",
          reason: `Amount ${usd(amount)} exceeds per-tx cap of ${usd(perTxCap)}`,
        } as SignOutcomeResponse;
      }

      // Check TEE semantic verdict
      const verdict = JSON.parse(
        JSON.parse(Buffer.from(tee.response, "base64").toString("utf8")).choices[0].message.content,
      );
      if (!verdict.is_aligned) {
        return {
          status: "REJECTED",
          code: "SEMANTIC_MISMATCH",
          reason: `Semantic alignment check failed: ${verdict.reason}`,
        } as SignOutcomeResponse;
      }

      // Check recipient whitelist
      const recipient = ("0x" + Buffer.from(tx.data, "base64").toString("hex").slice(32, 72)).toLowerCase();
      if (!agentPolicy.policy.allowed_recipients.map((r) => r.toLowerCase()).includes(recipient)) {
        return {
          status: "REJECTED",
          code: "UNAUTHORIZED_RECIPIENT",
          reason: `Recipient ${recipient} is not on the policy whitelist`,
        } as SignOutcomeResponse;
      }

      const digest = unsignedDigest(tx);
      const signature = await mpc.sign(digest, "agent-session-1");
      return {
        status: "APPROVED",
        signature,
        reason: "Policy checks passed and attestation verified",
      } as SignOutcomeResponse;
    },
  };

  const viewCaller = async <T>(_nodeUrl: string, _contractId: string, methodName: string, args?: Record<string, unknown>): Promise<T> => {
    if (methodName === "get_config") return contractConfig as unknown as T;
    if (methodName === "get_agent") return agentPolicy as unknown as T;
    if (methodName === "preview_digest") {
      return unsignedDigest((args as any).tx) as unknown as T;
    }
    throw new Error(`Unknown view method: ${methodName}`);
  };

  const client = new BastionClient({
    contractId: "bastion-guard.testnet",
    agentId: "agent-1.bastion-guard.testnet",
    verifier: attestor,
    nearAccount,
    evmClient,
    viewCaller,
    addressDeriver: async () => ({ address: eoa }),
  });

  line(`[INFO] Derived EOA on Base Sepolia (local simulation): ${eoa}`);
  line();

  for (const [key, s] of Object.entries(scenariosData) as [string, any][]) {
    line(`--- ${s.title} ---`);
    line(`Task: "${s.task}"`);
    line(`Recipient: ${s.recipient} | Amount: $${s.dollars}.00`);

    const result = await client.executeSpend({
      task: s.task,
      actionLog: s.actionLog,
      recipient: s.recipient,
      dollars: s.dollars,
      broadcast: s.expectedStatus === "APPROVED",
    });

    line(`Response Status: ${result.status}${result.code ? ` (${result.code})` : ""}`);
    if (result.status === "APPROVED") {
      line(`Signed Tx Hash : ${result.txHash}`);
    } else {
      line(`Rejection Code : ${result.code}`);
      line(`Reason         : ${result.reason}`);
    }

    if (result.status === s.expectedStatus) {
      line(`[ASSERTION PASSED] Outcome matches expected: ${s.expectedStatus}`);
    } else {
      line(`[ASSERTION FAILED] Expected ${s.expectedStatus}, got ${result.status}`);
      process.exit(1);
    }
    line();
  }

  line("================================================================================");
  line("  [TEST-ONLY] Simulation Complete: All scenarios verified.");
  line("================================================================================");
}

runOfflineScenarios().catch((err) => {
  console.error("Simulation error:", err);
  process.exit(1);
});
