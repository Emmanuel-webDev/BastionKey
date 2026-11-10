import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import type { OnChainPolicy } from "./policyValidator.js";

export interface OwnerClientConfig {
  contractId: string;
  ownerId?: string;
  nodeUrl?: string;
  networkId?: string;
  ownerPrivateKey?: string;
}

export class NearOwnerClient {
  public readonly contractId: string;
  public readonly ownerId?: string;
  public readonly nodeUrl: string;
  public readonly networkId: string;
  private readonly explicitPrivateKey?: string;

  constructor(cfg: OwnerClientConfig) {
    this.contractId = cfg.contractId;
    this.ownerId = cfg.ownerId;
    this.nodeUrl = cfg.nodeUrl ?? "https://rpc.testnet.near.org";
    this.networkId = cfg.networkId ?? "testnet";
    this.explicitPrivateKey = cfg.ownerPrivateKey;
  }

  /**
   * Resolves the owner private key strictly from environment variables or the NEAR CLI keychain.
   * NEVER reads secrets from repository files.
   */
  public resolveOwnerKey(ownerAccountId: string): string {
    // 1. Check environment variables
    const envKey =
      this.explicitPrivateKey ||
      process.env.BASTION_OWNER_PRIVATE_KEY ||
      process.env.NEAR_OWNER_KEY ||
      process.env.NEAR_MASTER_KEY;

    if (envKey && envKey.trim() !== "") {
      return envKey.trim();
    }

    // 2. Check NEAR CLI keychain (~/.near-credentials/testnet/<accountId>.json)
    const keyPath = join(homedir(), ".near-credentials", this.networkId, `${ownerAccountId}.json`);
    if (existsSync(keyPath)) {
      try {
        const data = JSON.parse(readFileSync(keyPath, "utf8"));
        if (data.private_key) return data.private_key;
        if (data.secret_key) return data.secret_key;
      } catch {
        // failed to parse keychain file
      }
    }

    throw new Error(
      `Owner private key for '${ownerAccountId}' was not found.\n` +
      `Provide it securely via the BASTION_OWNER_PRIVATE_KEY environment variable or in the NEAR keychain (${keyPath}).\n` +
      `Agent-side credentials and repository files cannot execute administrative owner commands.`
    );
  }

  public async getContractConfig(): Promise<{ owner: string; signer_contract: string; provider_tee_signer: string | null }> {
    const res = await fetch(this.nodeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "owner-view-config",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: this.contractId,
          method_name: "get_config",
          args_base64: "e30=",
        },
      }),
    });
    const data = await res.json();
    if (data.result?.result) {
      return JSON.parse(Buffer.from(data.result.result).toString("utf8"));
    }
    throw new Error(data.error?.data || data.error?.message || "Failed to query contract get_config");
  }

  public async getAgentState(agentId: string): Promise<any> {
    const res = await fetch(this.nodeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "owner-view-agent",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: this.contractId,
          method_name: "get_agent",
          args_base64: Buffer.from(JSON.stringify({ agent_account: agentId })).toString("base64"),
        },
      }),
    });
    const data = await res.json();
    if (data.result?.result) {
      return JSON.parse(Buffer.from(data.result.result).toString("utf8"));
    }
    return null;
  }

  private async getOwnerAccount(): Promise<{ account: Account; ownerId: string }> {
    const cfg = await this.getContractConfig();
    const ownerId = this.ownerId || cfg.owner;
    const privateKey = this.resolveOwnerKey(ownerId);

    const keyPair = KeyPair.fromString(privateKey as any);
    const signer = new KeyPairSigner(keyPair);
    const provider = new JsonRpcProvider({ url: this.nodeUrl });
    const account = new Account(ownerId, provider, signer);

    return { account, ownerId };
  }

  public async updatePolicy(agentId: string, policy: OnChainPolicy): Promise<{ txHash?: string }> {
    const { account } = await this.getOwnerAccount();
    const outcome = await account.callFunctionRaw({
      contractId: this.contractId,
      methodName: "update_policy",
      args: { agent_account: agentId, policy },
      gas: 50_000_000_000_000n,
      deposit: 0n,
    });
    return {
      txHash: (outcome as any)?.transaction?.hash || (outcome as any)?.transaction_outcome?.id,
    };
  }

  public async setPaused(agentId: string, paused: boolean): Promise<{ txHash?: string }> {
    const { account } = await this.getOwnerAccount();
    const outcome = await account.callFunctionRaw({
      contractId: this.contractId,
      methodName: "set_paused",
      args: { agent_account: agentId, paused },
      gas: 30_000_000_000_000n,
      deposit: 0n,
    });
    return {
      txHash: (outcome as any)?.transaction?.hash || (outcome as any)?.transaction_outcome?.id,
    };
  }

  public async resetBreaker(agentId: string): Promise<{ txHash?: string }> {
    const { account } = await this.getOwnerAccount();
    const outcome = await account.callFunctionRaw({
      contractId: this.contractId,
      methodName: "reset_breaker",
      args: { agent_account: agentId },
      gas: 30_000_000_000_000n,
      deposit: 0n,
    });
    return {
      txHash: (outcome as any)?.transaction?.hash || (outcome as any)?.transaction_outcome?.id,
    };
  }
}
