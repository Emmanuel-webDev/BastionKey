import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, getTransactionLastResult } from "near-api-js";
import { chainAdapters, contracts } from "chainsig.js";
import {
  createPublicClient,
  http,
  keccak256,
  recoverTransactionAddress,
  type Address,
  type Hex,
} from "viem";
import {
  buildErc20Transfer,
  decodeTransfer,
  signatureFromMpc,
  signedRawTx,
  unsignedDigest,
  type BastionTx,
} from "@bastionkey/relayer";
import {
  NearAiVerifier,
  fetchSigningAddress,
  type Verifier,
} from "@bastionkey/tee-verifier";
import {
  DEFAULT_BASE_SEPOLIA_CHAIN,
  DEFAULT_DERIVATION_PATH,
  DEFAULT_NEARAI_MODEL,
  DEFAULT_NEAR_NETWORK,
  DEFAULT_NEAR_RPC,
  DEFAULT_SIGNER_CONTRACT,
  type ChainConfig,
  type TokenConfig,
} from "./config.js";
import {
  BastionConfigError,
  BastionRpcError,
  BastionTrustError,
} from "./errors.js";
import { getTokenDecimals } from "./tokenDecimals.js";
import { fetchWithTimeoutAndRetry } from "./rpcUtils.js";
import type {
  AgentView,
  BastionClientConfig,
  ContractConfig,
  EvmClientLike,
  ModelProposal,
  NearAccountLike,
  SignOutcomeResponse,
  SpendExecutionInput,
  SpendParams,
  SpendResult,
  SpendStatus,
} from "./types.js";

export async function defaultViewCall<T>(
  nodeUrl: string,
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetchWithTimeoutAndRetry(nodeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "bastion-client-view",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });

  const data = await res.json();
  if (data.result?.result) {
    return JSON.parse(Buffer.from(data.result.result).toString("utf8")) as T;
  }
  throw new BastionRpcError(
    data.error?.data || data.error?.message || `View call to ${contractId}.${methodName} failed`,
  );
}

export class BastionClient {
  public readonly contractId: string;
  public readonly agentId: string;
  public readonly signerContract: string;
  public readonly derivationPath: string;
  public readonly networkId: string;
  public readonly nodeUrl: string;
  public readonly chain: ChainConfig;
  public readonly nearAiModel: string;

  private readonly agentPrivateKey?: string;
  private readonly nearAiApiKey?: string;

  // Injected dependencies
  private verifier?: Verifier;
  private nearAccount?: NearAccountLike;
  private evmClient?: EvmClientLike;
  private viewCaller: <T>(nodeUrl: string, contractId: string, methodName: string, args?: Record<string, unknown>) => Promise<T>;
  private addressDeriver?: (contractId: string, path: string) => Promise<{ address: Address }>;

  private derivedAddressCache: Address | null = null;

  constructor(config: BastionClientConfig) {
    if (!config.contractId || config.contractId.trim() === "") {
      throw new BastionConfigError("BastionClient configuration error: missing required 'contractId'.");
    }
    if (!config.agentId || config.agentId.trim() === "") {
      throw new BastionConfigError("BastionClient configuration error: missing required 'agentId'.");
    }

    this.contractId = config.contractId.trim();
    this.agentId = config.agentId.trim();
    this.agentPrivateKey = config.agentPrivateKey;
    this.signerContract = config.signerContract ?? "";
    this.derivationPath = config.derivationPath ?? "";
    this.networkId = config.networkId ?? DEFAULT_NEAR_NETWORK;
    this.nodeUrl = config.nodeUrl ?? DEFAULT_NEAR_RPC;
    this.chain = config.chain ?? DEFAULT_BASE_SEPOLIA_CHAIN;
    this.nearAiModel = config.nearAiModel ?? DEFAULT_NEARAI_MODEL;
    this.nearAiApiKey = config.nearAiApiKey;

    this.verifier = config.verifier;
    this.nearAccount = config.nearAccount;
    this.evmClient = config.evmClient;
    this.viewCaller = config.viewCaller ?? defaultViewCall;
    this.addressDeriver = config.addressDeriver;
  }

  private getNearAccount(): NearAccountLike {
    if (this.nearAccount) return this.nearAccount;
    if (!this.agentPrivateKey) {
      throw new BastionConfigError(
        "Agent private key required for contract signing calls. Set AGENT_PRIVATE_KEY.",
      );
    }

    const keyPair = KeyPair.fromString(this.agentPrivateKey as any);
    const keyStore = new KeyPairSigner(keyPair);
    const connection = new JsonRpcProvider({ url: this.nodeUrl });
    const acc = new Account(this.agentId, connection, keyStore);

    return {
      callFunctionRaw: async ({ contractId, methodName, args, gas, deposit }) => {
        return acc.callFunctionRaw({
          contractId,
          methodName,
          args,
          gas: gas ?? 250_000_000_000_000n,
          deposit: deposit ?? 0n,
        });
      },
    };
  }

  private getEvmClient(): EvmClientLike {
    if (this.evmClient) return this.evmClient;
    const client = createPublicClient({
      transport: http(this.chain.rpcUrl, { timeout: 15000 }),
    });

    return {
      getTransactionCount: async ({ address }) => {
        return client.getTransactionCount({ address });
      },
      estimateFeesPerGas: async () => {
        try {
          const fees = await client.estimateFeesPerGas();
          return {
            maxFeePerGas: fees.maxFeePerGas ?? 2_000_000_000n,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 1_000_000n,
          };
        } catch {
          return null;
        }
      },
      sendRawTransaction: async ({ serializedTransaction }) => {
        return client.sendRawTransaction({ serializedTransaction });
      },
      waitForTransactionReceipt: async ({ hash }) => {
        return client.waitForTransactionReceipt({ hash });
      },
    };
  }

  private getVerifier(): Verifier {
    if (this.verifier) return this.verifier;
    return new NearAiVerifier({
      apiKey: this.nearAiApiKey,
      model: this.nearAiModel,
    });
  }

  public async getDerivedAddress(): Promise<Address> {
    if (this.derivedAddressCache) return this.derivedAddressCache;

    let path = this.derivationPath;
    if (!path) {
      const agentState = await this.getAgent().catch(() => null);
      path = agentState?.derivation_path || DEFAULT_DERIVATION_PATH;
    }

    let signer = this.signerContract;
    if (!signer) {
      const contractCfg = await this.getConfig().catch(() => null);
      signer = contractCfg?.signer_contract || (contractCfg as any)?.mpc_contract_id || DEFAULT_SIGNER_CONTRACT;
    }

    if (this.addressDeriver) {
      const { address } = await this.addressDeriver(this.contractId, path);
      this.derivedAddressCache = address;
      return address;
    }

    const csContract = new contracts.ChainSignatureContract({
      network: this.networkId,
      contractId: signer,
    });
    const evmAdapter = new chainAdapters.evm.EVM({ contract: csContract });
    const { address } = await evmAdapter.deriveAddressAndPublicKey(this.contractId, path);
    this.derivedAddressCache = address as Address;
    return this.derivedAddressCache;
  }

  public async getConfig(): Promise<ContractConfig> {
    return this.viewCaller<ContractConfig>(this.nodeUrl, this.contractId, "get_config", {});
  }

  public async getAgent(): Promise<AgentView> {
    return this.viewCaller<AgentView>(this.nodeUrl, this.contractId, "get_agent", {
      agent_account: this.agentId,
    });
  }

  /**
   * Execute an authorized spend through the full BastionKey pipeline.
   * Enforces the TRUST RULE:
   *  - `task` is trusted input from human or application only.
   *  - Rejects if `task` is provided inside model proposal.
   */
  public async executeSpend(params: SpendParams | SpendExecutionInput): Promise<SpendResult> {
    // 0. TRUST RULE ENFORCEMENT
    if ("proposal" in params) {
      if (params.proposal && "task" in (params.proposal as any)) {
        throw new BastionTrustError(
          "Trust Rule Violation: 'task' is a trusted application parameter and must NOT be supplied within the model proposal.",
        );
      }
    }

    const requestId = params.requestId ?? `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const task = "proposal" in params ? params.task : (params as SpendParams).task;
    const proposal: ModelProposal = "proposal" in params
      ? params.proposal
      : {
          recipient: (params as SpendParams).recipient,
          amount: (params as SpendParams).amount ?? 0n,
          token: (params as SpendParams).token,
          tokenSymbol: (params as SpendParams).tokenSymbol,
          decimals: (params as SpendParams).decimals,
          actionLog: (params as SpendParams).actionLog,
        };

    const broadcast = params.broadcast ?? false;
    const gasLimit = params.gasLimit ?? 65_000;
    const events: Array<Record<string, unknown>> = [];
    const log = (kind: string, data: Record<string, unknown>) =>
      events.push({ t: new Date().toISOString(), kind, ...data });

    const eoa = await this.getDerivedAddress();
    const actionLog = proposal.actionLog ?? [];

    // Resolve token address and decimals dynamically
    let tokenAddress: Address;
    let tokenDecimals = proposal.decimals;

    if (proposal.token) {
      tokenAddress = proposal.token.toLowerCase() as Address;
    } else if (proposal.tokenSymbol) {
      const match = this.chain.tokens.find(
        (t) => t.symbol.toLowerCase() === proposal.tokenSymbol!.toLowerCase(),
      );
      if (!match) {
        throw new BastionConfigError(`Unknown token symbol '${proposal.tokenSymbol}' for chain ${this.chain.chainId}`);
      }
      tokenAddress = match.address.toLowerCase() as Address;
      if (tokenDecimals === undefined) tokenDecimals = match.decimals;
    } else {
      // Default to first configured token
      const defaultToken = this.chain.tokens[0];
      if (!defaultToken) {
        throw new BastionConfigError(`No tokens configured for chain ${this.chain.chainId}`);
      }
      tokenAddress = defaultToken.address.toLowerCase() as Address;
      if (tokenDecimals === undefined) tokenDecimals = defaultToken.decimals;
    }

    if (tokenDecimals === undefined) {
      tokenDecimals = await getTokenDecimals({
        tokenAddress,
        chainId: this.chain.chainId,
        rpcUrl: this.chain.rpcUrl,
      });
    }

    let amount = proposal.amount;
    if (amount === 0n && "dollars" in params && (params as SpendParams).dollars !== undefined) {
      const multiplier = 10n ** BigInt(tokenDecimals);
      amount = BigInt(Math.round((params as SpendParams).dollars! * Number(multiplier)));
    }

    log("setup", {
      requestId,
      agent: this.agentId,
      eoa,
      task,
      token: tokenAddress,
      decimals: tokenDecimals,
      amount: amount.toString(),
      actionLog,
    });

    // 1. Preflight: Check contract config & agent status
    const config = await this.getConfig();
    log("contract_config", config as unknown as Record<string, unknown>);

    const agentState = await this.getAgent().catch(() => null);
    if (agentState) {
      log("preflight_agent_state", agentState as unknown as Record<string, unknown>);
      if (agentState.tripped || agentState.paused) {
        return {
          requestId,
          status: "FROZEN",
          code: agentState.tripped ? "CIRCUIT_BREAKER_TRIPPED" : "AGENT_PAUSED",
          reason: agentState.tripped
            ? "Circuit breaker is tripped. Velocity limit exceeded or repeated rejections."
            : "Agent is paused by the contract owner.",
          eoa,
          broadcastAttempted: false,
          events,
        };
      }
    }

    // 2. TEE Signer Pinning Check
    const verifier = this.getVerifier();
    let liveSigner: string | null = null;
    if (this.verifier) {
      liveSigner = (this.verifier as any).signer ?? (this.verifier as any).address ?? null;
    } else if (this.nearAiApiKey) {
      const res = await fetchSigningAddress({ apiKey: this.nearAiApiKey, model: this.nearAiModel });
      liveSigner = res.address;
    }

    if (config.provider_tee_signer && liveSigner) {
      const pinnedNormalized = "0x" + config.provider_tee_signer.toLowerCase().replace(/^0x/, "");
      if (pinnedNormalized !== liveSigner.toLowerCase()) {
        throw new BastionRpcError(
          `TEE signer mismatch: contract pinned (${pinnedNormalized}) does not match attestation report (${liveSigner})`,
        );
      }
    }

    // 3. EVM Client: query real nonce & fee estimates
    const evm = this.getEvmClient();
    const realNonce = await evm.getTransactionCount({ address: eoa });
    let maxFeePerGas = 2_100_000_000n;
    let maxPriorityFeePerGas = 1_100_000n;

    if (evm.estimateFeesPerGas) {
      const estimates = await evm.estimateFeesPerGas().catch(() => null);
      if (estimates) {
        maxPriorityFeePerGas = estimates.maxPriorityFeePerGas + 100_000n;
        maxFeePerGas = estimates.maxFeePerGas + 100_000n;
      }
    }

    // 4. Build EIP-1559 ERC-20 transfer
    const tx: BastionTx = buildErc20Transfer({
      chainId: this.chain.chainId,
      token: tokenAddress,
      nonce: realNonce,
      recipient: proposal.recipient,
      amount,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasLimit,
    });
    const digest = unsignedDigest(tx);
    const decoded = decodeTransfer(tx);

    // Verify relayer digest matches on-chain preview_digest
    const onChainDigest = await this.viewCaller<string>(this.nodeUrl, this.contractId, "preview_digest", { tx });
    if (onChainDigest.toLowerCase() !== digest.toLowerCase()) {
      throw new BastionRpcError(`Digest mismatch: local ${digest} vs on-chain contract ${onChainDigest}`);
    }
    log("proposed", { recipient: decoded.recipient, amount: decoded.amount.toString(), digest });

    // 5. Verifier checks semantic alignment against task
    const v = await verifier.verify({
      task,
      actionLog,
      tx: {
        chainId: tx.chain_id,
        token: tx.to,
        recipient: decoded.recipient,
        amount: decoded.amount,
        decimals: tokenDecimals,
        digest,
      },
    });
    log("verdict", { ...v.verdict, signer: v.signer, label: verifier.label });

    // 6. Call request_signature on the deployed NEAR contract
    const nearAcc = this.getNearAccount();
    const rawOutcome = await nearAcc.callFunctionRaw({
      contractId: this.contractId,
      methodName: "request_signature",
      args: {
        tx,
        tee: v.attestation,
      },
      gas: 250_000_000_000_000n,
      deposit: 0n,
    });

    const nearTxHash =
      (rawOutcome as any)?.transaction?.hash ||
      (rawOutcome as any)?.transaction_outcome?.id ||
      (rawOutcome as any)?.receipts_outcome?.[0]?.id;

    if (nearTxHash) {
      log("near_tx", { txHash: nearTxHash });
    }

    let outcome: SignOutcomeResponse | null = null;
    if (rawOutcome && typeof (rawOutcome as any).status === "string") {
      outcome = rawOutcome as SignOutcomeResponse;
    } else {
      try {
        outcome = getTransactionLastResult(rawOutcome) as SignOutcomeResponse;
      } catch {
        // Ignored
      }
    }
    if (!outcome && rawOutcome && (rawOutcome as any).status) {
      outcome = rawOutcome as SignOutcomeResponse;
    }
    if (!outcome) {
      throw new BastionRpcError("Unable to determine contract execution outcome from NEAR transaction receipt.");
    }

    log("contract_result", outcome as unknown as Record<string, unknown>);

    // 7. Process Outcome & Enforce Strict "NEVER Broadcast Unless APPROVED" Rule
    if (outcome.status === "APPROVED") {
      if (!outcome.signature) {
        throw new BastionRpcError("Contract returned APPROVED status but no MPC signature was provided.");
      }
      const raw = signedRawTx(tx, signatureFromMpc(outcome.signature));
      const recovered = await recoverTransactionAddress({ serializedTransaction: raw as Hex });
      if (recovered.toLowerCase() !== eoa.toLowerCase()) {
        throw new BastionRpcError(`Signature recovered address ${recovered} does not match derived EOA ${eoa}`);
      }
      const txHash = keccak256(raw);
      log("signed", { raw, txHash, recovered });

      let broadcastHash: Hex | undefined;
      let blockNumber: string | undefined;

      if (broadcast) {
        try {
          broadcastHash = await evm.sendRawTransaction({ serializedTransaction: raw as Hex });
          const receipt = await evm.waitForTransactionReceipt({ hash: broadcastHash });
          blockNumber = receipt.blockNumber.toString();
          log("broadcast", { broadcastHash, blockNumber, status: receipt.status });
        } catch (err: any) {
          log("broadcast_error", { message: err?.message || String(err) });
        }
      }

      return {
        requestId,
        status: "APPROVED",
        code: "OK",
        reason: "Contract and TEE verifier approved the transfer proposal.",
        digest,
        tx,
        signedRaw: raw as Hex,
        txHash,
        nearTxHash,
        broadcastHash,
        blockNumber,
        eoa,
        broadcastAttempted: !!broadcast,
        verdictConfidence: (v.verdict as any).confidence_pct ?? (v.verdict as any).confidence,
        verdictReason: v.verdict.reason,
        events,
      };
    }

    // NEVER broadcast when not approved
    let status: SpendStatus = "REJECTED_ON_CHAIN";
    if (outcome.status === "FROZEN") {
      status = "FROZEN";
    } else if (outcome.status === "SIGN_FAILED") {
      status = "SIGN_FAILED";
    } else if (
      outcome.code?.includes("TEE") ||
      outcome.code === "TEE_REJECTED" ||
      outcome.code === "SEMANTIC_MISMATCH" ||
      outcome.code === "LOW_CONFIDENCE"
    ) {
      status = "BLOCKED_BY_TEE";
    }

    return {
      requestId,
      status,
      code: outcome.code ?? outcome.status,
      reason: outcome.reason ?? `Contract returned status: ${outcome.status}`,
      digest,
      tx,
      nearTxHash,
      eoa,
      broadcastAttempted: false,
      verdictConfidence: (v.verdict as any).confidence_pct ?? (v.verdict as any).confidence,
      verdictReason: v.verdict.reason,
      events,
    };
  }
}
