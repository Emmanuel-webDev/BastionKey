import { KeyPair } from "near-api-js";
import { BastionKeySecurityError, BastionRpcError, fetchWithTimeoutAndRetry } from "@bastionkey/client";

export interface KeyInspectionResult {
  valid: boolean;
  publicKey: string;
  isFunctionCall: boolean;
  receiverId?: string;
  methodNames?: string[];
  allowance?: string;
  error?: string;
}

/**
 * Inspects a NEAR private key on-chain to verify whether it is strictly a Function Call key.
 * Refuses FullAccess keys to ensure the agent daemon cannot execute arbitrary account mutations.
 */
export async function inspectNearKey(
  nodeUrl: string,
  accountId: string,
  privateKey: string,
): Promise<KeyInspectionResult> {
  let publicKeyStr: string;
  try {
    const keyPair = KeyPair.fromString(privateKey as any);
    publicKeyStr = keyPair.getPublicKey().toString();
  } catch (err: any) {
    return {
      valid: false,
      publicKey: "",
      isFunctionCall: false,
      error: `Invalid private key format: ${err.message}`,
    };
  }

  const res = await fetchWithTimeoutAndRetry(nodeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "inspect-key",
      method: "query",
      params: {
        request_type: "view_access_key",
        finality: "final",
        account_id: accountId,
        public_key: publicKeyStr,
      },
    }),
  });

  const data = await res.json();
  if (data.error) {
    return {
      valid: false,
      publicKey: publicKeyStr,
      isFunctionCall: false,
      error: data.error.data || data.error.message || "Failed to query access key",
    };
  }

  const permission = data.result?.permission;
  if (!permission) {
    return {
      valid: false,
      publicKey: publicKeyStr,
      isFunctionCall: false,
      error: "No permission found for access key",
    };
  }

  if (permission === "FullAccess") {
    return {
      valid: true,
      publicKey: publicKeyStr,
      isFunctionCall: false,
    };
  }

  if (typeof permission === "object" && permission.FunctionCall) {
    const fc = permission.FunctionCall;
    return {
      valid: true,
      publicKey: publicKeyStr,
      isFunctionCall: true,
      receiverId: fc.receiver_id,
      methodNames: fc.method_names,
      allowance: fc.allowance,
    };
  }

  return {
    valid: false,
    publicKey: publicKeyStr,
    isFunctionCall: false,
    error: `Unknown permission structure: ${JSON.stringify(permission)}`,
  };
}

/**
 * Asserts that the configured agent private key is strictly a Function Call key for the target contract.
 */
export async function assertFunctionCallKeyOnly(
  nodeUrl: string,
  contractId: string,
  agentId: string,
  privateKey: string,
): Promise<void> {
  const result = await inspectNearKey(nodeUrl, agentId, privateKey);
  if (!result.valid) {
    throw new BastionKeySecurityError(
      `Key verification failed for agent '${agentId}' on NEAR RPC: ${result.error}`,
    );
  }

  if (!result.isFunctionCall) {
    throw new BastionKeySecurityError(
      `SECURITY INVARIANT VIOLATION: Agent key ${result.publicKey} has FullAccess permissions! 'bastion serve' strictly requires a restricted FunctionCall access key. Create a key restricted to '${contractId}' calling 'request_signature'.`,
    );
  }

  if (result.receiverId && result.receiverId !== contractId) {
    throw new BastionKeySecurityError(
      `SECURITY INVARIANT VIOLATION: Agent FunctionCall key is scoped to '${result.receiverId}', but BastionKey contract is '${contractId}'.`,
    );
  }
}
