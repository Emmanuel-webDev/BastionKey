import type { Address, Hex } from "viem";
import type { BastionTx, MpcSignature } from "@bastionkey/relayer";
import type { Attestation, Verifier } from "@bastionkey/tee-verifier";
import type { ChainConfig } from "./config.js";

export type SpendStatus =
  | "APPROVED"
  | "REJECTED"
  | "REJECTED_ON_CHAIN"
  | "BLOCKED_BY_TEE"
  | "FROZEN"
  | "SIGN_FAILED"
  | "ERROR";

export interface ContractConfig {
  owner: string;
  signer_contract: string;
  provider_tee_signer: string | null;
  gateway_signer: string | null;
  sign_format: string;
  sign_deposit: string;
  sign_gas_tgas: number;
}

export interface AgentPolicy {
  max_per_tx: string;
  hourly_budget: string;
  max_gas_cost_wei: string;
  allowed_tokens: string[];
  allowed_recipients: string[];
  allowed_chain_ids: number[];
  tee_required_above: string;
  min_confidence_pct: number;
  max_calls_per_minute: number;
}

export interface AgentView {
  policy: AgentPolicy;
  derivation_path: string;
  paused: boolean;
  tripped: boolean;
  rejections: number;
  approvals: number;
  spent_last_hour: string;
  remaining_hourly_budget: string;
  calls_last_minute: number;
}

export interface SignOutcomeResponse {
  status: "APPROVED" | "REJECTED" | "FROZEN" | "SIGN_FAILED";
  code?: string;
  reason?: string;
  digest?: string;
  signature?: MpcSignature;
}

export interface NearAccountLike {
  callFunctionRaw(params: {
    contractId: string;
    methodName: string;
    args: Record<string, unknown>;
    gas?: bigint;
    deposit?: bigint;
  }): Promise<unknown>;
}

export interface EvmClientLike {
  getTransactionCount(args: { address: Address }): Promise<number>;
  estimateFeesPerGas?(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null>;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
  waitForTransactionReceipt(args: { hash: Hex }): Promise<{ blockNumber: bigint | number; status: string }>;
}

export interface BastionClientConfig {
  contractId: string;
  agentId: string;
  agentPrivateKey?: string;
  signerContract?: string;
  derivationPath?: string;
  networkId?: string;
  nodeUrl?: string;
  chain?: ChainConfig;
  nearAiApiKey?: string;
  nearAiModel?: string;

  // Injected dependencies for testing / offline mode
  verifier?: Verifier;
  nearAccount?: NearAccountLike;
  evmClient?: EvmClientLike;
  viewCaller?: <T>(nodeUrl: string, contractId: string, methodName: string, args?: Record<string, unknown>) => Promise<T>;
  addressDeriver?: (contractId: string, path: string) => Promise<{ address: Address }>;
}

/**
 * TRUST RULE:
 * ModelProposal contains untrusted data produced by the AI model.
 * It MUST NOT contain the trusted human `task` specification.
 */
export interface ModelProposal {
  recipient: Address;
  amount: bigint;
  token?: Address;
  tokenSymbol?: string;
  decimals?: number;
  actionLog?: string[];
}

/**
 * Execution input enforcing separation of trusted task vs untrusted model proposal.
 */
export interface SpendExecutionInput {
  requestId?: string;
  task: string; // TRUSTED: from human operator or integrating application only
  proposal: ModelProposal; // UNTRUSTED: proposed by the model
  broadcast?: boolean;
  gasLimit?: number;
  chainId?: number;
}

export interface SpendParams {
  requestId?: string;
  task: string;
  actionLog?: string[];
  recipient: Address;
  amount?: bigint;
  dollars?: number;
  token?: Address;
  tokenSymbol?: string;
  decimals?: number;
  chainId?: number;
  broadcast?: boolean;
  gasLimit?: number;
}

export interface SpendResult {
  requestId?: string;
  status: SpendStatus;
  code?: string;
  reason?: string;
  digest?: string;
  tx?: BastionTx;
  signedRaw?: Hex;
  txHash?: Hex;
  nearTxHash?: string;
  broadcastHash?: Hex;
  blockNumber?: string;
  eoa: Address;
  broadcastAttempted: boolean;
  verdictConfidence?: number;
  verdictReason?: string;
  events: Array<Record<string, unknown>>;
}
