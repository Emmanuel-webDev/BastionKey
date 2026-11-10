import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { unsignedDigest } from "@bastionkey/relayer";
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

const RECIPIENT_GOOD = "0x1111111111111111111111111111111111111111" as Address;
const RECIPIENT_BAD = "0xbadbadbadbadbadbadbadbadbadbadbadbadbad0" as Address;

interface SetupOptions {
  agentState?: Partial<AgentView>;
  contractConfig?: Partial<ContractConfig>;
  rawOutcome?: SignOutcomeResponse;
  verifierSignerOverride?: string;
}

function createSetup(opts: SetupOptions = {}) {
  const mpc = new LocalMpc("test-seed");
  const attestor = new LocalAttestor();
  const eoa = mpc.address("agent-session-1");

  const baseConfig: ContractConfig = {
    owner_id: "bastion-owner.testnet",
    mpc_contract_id: "v1.signer-prod.testnet",
    provider_tee_signer: opts.contractConfig?.provider_tee_signer ?? attestor.address,
    ...opts.contractConfig,
  };

  const baseAgentState: AgentView = {
    account_id: "agent-1.bastion-guard.testnet",
    policy: {
      per_tx_cap: "50000000",
      lifetime_cap: "500000000",
      allowed_recipients: [RECIPIENT_GOOD],
      allowed_tokens: ["0x036CbD53842c5426634e7929541eC2318f3dCF7e"],
    },
    metrics: {
      lifetime_spent: "0",
      rejections_in_window: 0,
      window_started_at: "0",
    },
    paused: false,
    tripped: false,
    tripped_at: null,
    trip_reason: null,
    ...opts.agentState,
  };

  const sendRawTransaction = vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
    return "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex;
  });

  const waitForTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }) => {
    return {
      status: "success",
      blockNumber: 1234567n,
    };
  });

  const evmClient: EvmClientLike = {
    getTransactionCount: vi.fn(async () => 0),
    estimateFeesPerGas: vi.fn(async () => ({
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    })),
    sendRawTransaction,
    waitForTransactionReceipt,
  };

  const callFunctionRaw = vi.fn(async ({ methodName, args }: { methodName: string; args: any }) => {
    if (opts.rawOutcome) {
      return opts.rawOutcome;
    }
    // Default outcome: APPROVED with valid MPC signature for tx
    const digest = unsignedDigest(args.tx);
    const mpcSig = await mpc.sign(digest, "agent-session-1");
    return {
      status: "APPROVED",
      signature: mpcSig,
      reason: "Policy checks passed and attestation verified",
    } as SignOutcomeResponse;
  });

  const nearAccount: NearAccountLike = {
    callFunctionRaw,
  };

  const viewCaller = vi.fn(async (nodeUrl: string, contractId: string, methodName: string, args?: Record<string, unknown>) => {
    if (methodName === "get_config") return baseConfig;
    if (methodName === "get_agent") return baseAgentState;
    if (methodName === "preview_digest") {
      return unsignedDigest((args as any).tx);
    }
    throw new Error(`Unexpected view method: ${methodName}`);
  });

  const addressDeriver = vi.fn(async () => ({ address: eoa }));

  const client = new BastionClient({
    contractId: "bastion-guard.testnet",
    agentId: "agent-1.bastion-guard.testnet",
    verifier: attestor,
    nearAccount,
    evmClient,
    viewCaller,
    addressDeriver,
  });

  return {
    client,
    mpc,
    attestor,
    eoa,
    evmClient,
    nearAccount,
    sendRawTransaction,
    callFunctionRaw,
    viewCaller,
  };
}

describe("BastionClient", () => {
  it("1. approved: signs and broadcasts when broadcast=true", async () => {
    const { client, sendRawTransaction, eoa } = createSetup();

    const res = await client.executeSpend({
      task: `send $5 USDC to ${RECIPIENT_GOOD}`,
      recipient: RECIPIENT_GOOD,
      dollars: 5,
      broadcast: true,
    });

    expect(res.status).toBe("APPROVED");
    expect(res.eoa).toBe(eoa);
    expect(res.broadcastAttempted).toBe(true);
    expect(res.broadcastHash).toBe("0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890");
    expect(res.blockNumber).toBe("1234567");
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("2. rejected: returns REJECTED_ON_CHAIN without broadcasting", async () => {
    const { client, sendRawTransaction } = createSetup({
      rawOutcome: {
        status: "REJECTED",
        code: "OVER_BUDGET",
        reason: "Amount $150.00 exceeds per-tx cap of $50.00",
      },
    });

    const res = await client.executeSpend({
      task: `send $150 USDC to ${RECIPIENT_GOOD}`,
      recipient: RECIPIENT_GOOD,
      dollars: 150,
      broadcast: true,
    });

    expect(res.status).toBe("REJECTED_ON_CHAIN");
    expect(res.code).toBe("OVER_BUDGET");
    expect(res.broadcastAttempted).toBe(false);
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it("3. blocked by TEE: returns BLOCKED_BY_TEE when verifier/policy detects mismatch", async () => {
    const { client, sendRawTransaction } = createSetup({
      rawOutcome: {
        status: "REJECTED",
        code: "SEMANTIC_MISMATCH",
        reason: "Prompt alignment failed: task never named attacker recipient",
      },
    });

    const res = await client.executeSpend({
      task: `send $10 USDC to ${RECIPIENT_GOOD}`,
      recipient: RECIPIENT_BAD,
      dollars: 10,
      broadcast: true,
    });

    expect(res.status).toBe("BLOCKED_BY_TEE");
    expect(res.code).toBe("SEMANTIC_MISMATCH");
    expect(res.broadcastAttempted).toBe(false);
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it("4. frozen: halts immediately in preflight if agent is tripped or paused", async () => {
    const { client, sendRawTransaction, callFunctionRaw } = createSetup({
      agentState: {
        tripped: true,
        trip_reason: "Velocity limit exceeded: 3 rejections within 300s window",
      },
    });

    const res = await client.executeSpend({
      task: `send $5 USDC to ${RECIPIENT_GOOD}`,
      recipient: RECIPIENT_GOOD,
      dollars: 5,
      broadcast: true,
    });

    expect(res.status).toBe("FROZEN");
    expect(res.code).toBe("CIRCUIT_BREAKER_TRIPPED");
    expect(res.broadcastAttempted).toBe(false);
    expect(callFunctionRaw).not.toHaveBeenCalled();
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it("5. signer mismatch: throws before requesting signature when pinned signer differs", async () => {
    const { client, callFunctionRaw, sendRawTransaction } = createSetup({
      contractConfig: {
        provider_tee_signer: "0x2222222222222222222222222222222222222222",
      },
    });

    await expect(
      client.executeSpend({
        task: `send $5 USDC to ${RECIPIENT_GOOD}`,
        recipient: RECIPIENT_GOOD,
        dollars: 5,
        broadcast: true,
      }),
    ).rejects.toThrow(/TEE signer mismatch/);

    expect(callFunctionRaw).not.toHaveBeenCalled();
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it("6. never broadcasts when not approved, even if broadcast=true", async () => {
    const { client, sendRawTransaction } = createSetup({
      rawOutcome: {
        status: "REJECTED",
        code: "UNAUTHORIZED_RECIPIENT",
        reason: "Recipient is not in the whitelist",
      },
    });

    const res = await client.executeSpend({
      task: `send $5 USDC to ${RECIPIENT_BAD}`,
      recipient: RECIPIENT_BAD,
      dollars: 5,
      broadcast: true,
    });

    expect(res.status).toBe("REJECTED_ON_CHAIN");
    expect(res.broadcastAttempted).toBe(false);
    expect(res.signedRaw).toBeUndefined();
    expect(res.broadcastHash).toBeUndefined();
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });
});
