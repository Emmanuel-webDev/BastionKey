import fs from "node:fs";
import path from "node:path";
import { type Address, isAddress } from "viem";
import { BastionConfigError } from "./errors.js";

export interface TokenConfig {
  symbol: string;
  address: Address;
  decimals?: number;
}

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl?: string;
  tokens: TokenConfig[];
}

export interface ServerConfig {
  host: string;
  port: number;
  bearerToken?: string;
  maxRequestBytes?: number;
  rateLimitPerMinute?: number;
}

export interface BastionAppConfig {
  networkId: string;
  nearRpcUrl: string;
  contractId: string;
  agentId: string;
  agentPrivateKey?: string;
  ownerPrivateKey?: string;
  nearAiApiKey?: string;
  nearAiModel: string;
  signerContract: string;
  derivationPath: string;
  chain: ChainConfig;
  auditLogPath: string;
  server: ServerConfig;
}

export const DEFAULT_NEAR_NETWORK = "testnet";
export const DEFAULT_NEAR_RPC = "https://rpc.testnet.near.org";
export const DEFAULT_SIGNER_CONTRACT = "v1.signer-prod.testnet";
export const DEFAULT_DERIVATION_PATH = "agent-session-1";
export const DEFAULT_NEARAI_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
export const DEFAULT_AUDIT_LOG = "./bastion-audit.jsonl";

export const DEFAULT_BASE_SEPOLIA_CHAIN: ChainConfig = {
  chainId: 84532,
  name: "Base Sepolia",
  rpcUrl: "https://sepolia.base.org",
  explorerUrl: "https://sepolia.basescan.org",
  tokens: [
    {
      symbol: "USDC",
      address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Address,
      decimals: 6,
    },
  ],
};

/**
 * Loads and validates BastionKey configuration from file and environment variables.
 * Does NOT hardcode personal account defaults; missing required fields throw clear BastionConfigError.
 */
export function loadBastionConfig(customConfigPath?: string): BastionAppConfig {
  let fileConfig: Partial<BastionAppConfig> = {};

  const resolvedPath =
    customConfigPath ||
    process.env.BASTION_CONFIG_FILE ||
    (fs.existsSync("bastion.config.json") ? "bastion.config.json" : null);

  if (resolvedPath && fs.existsSync(resolvedPath)) {
    try {
      const content = fs.readFileSync(resolvedPath, "utf8");
      fileConfig = JSON.parse(content);
    } catch (err: any) {
      throw new BastionConfigError(`Failed to parse configuration file at '${resolvedPath}': ${err.message}`);
    }
  }

  const networkId =
    process.env.NEAR_NETWORK ||
    fileConfig.networkId ||
    DEFAULT_NEAR_NETWORK;

  const nearRpcUrl =
    process.env.NEAR_NODE_URL ||
    fileConfig.nearRpcUrl ||
    DEFAULT_NEAR_RPC;

  const contractId =
    process.env.BASTION_CONTRACT_ID ||
    fileConfig.contractId ||
    "";

  const agentId =
    process.env.AGENT_ACCOUNT_ID ||
    fileConfig.agentId ||
    "";

  const agentPrivateKey =
    process.env.AGENT_PRIVATE_KEY ||
    fileConfig.agentPrivateKey;

  const ownerPrivateKey =
    process.env.BASTION_OWNER_PRIVATE_KEY ||
    process.env.NEAR_OWNER_KEY ||
    fileConfig.ownerPrivateKey;

  const nearAiApiKey =
    process.env.NEARAI_API_KEY ||
    fileConfig.nearAiApiKey;

  const nearAiModel =
    process.env.NEARAI_MODEL ||
    fileConfig.nearAiModel ||
    DEFAULT_NEARAI_MODEL;

  const signerContract =
    fileConfig.signerContract ||
    DEFAULT_SIGNER_CONTRACT;

  const derivationPath =
    fileConfig.derivationPath ||
    DEFAULT_DERIVATION_PATH;

  const auditLogPath =
    process.env.BASTION_AUDIT_LOG ||
    fileConfig.auditLogPath ||
    DEFAULT_AUDIT_LOG;

  // Build ChainConfig
  const fileChain = fileConfig.chain;
  const chainId =
    (process.env.BASTION_CHAIN_ID ? parseInt(process.env.BASTION_CHAIN_ID, 10) : undefined) ??
    fileChain?.chainId ??
    DEFAULT_BASE_SEPOLIA_CHAIN.chainId;

  const rpcUrl =
    process.env.BASTION_EVM_RPC ||
    process.env.BASE_SEPOLIA_RPC ||
    fileChain?.rpcUrl ||
    DEFAULT_BASE_SEPOLIA_CHAIN.rpcUrl;

  const chainName = fileChain?.name || "EVM Chain";
  const explorerUrl = fileChain?.explorerUrl || DEFAULT_BASE_SEPOLIA_CHAIN.explorerUrl;
  const tokens: TokenConfig[] = fileChain?.tokens && fileChain.tokens.length > 0
    ? fileChain.tokens
    : DEFAULT_BASE_SEPOLIA_CHAIN.tokens;

  // Build ServerConfig
  const serverConfig: ServerConfig = {
    host: process.env.BASTION_SERVER_HOST || fileConfig.server?.host || "127.0.0.1",
    port: (process.env.BASTION_SERVER_PORT ? parseInt(process.env.BASTION_SERVER_PORT, 10) : undefined) ??
      fileConfig.server?.port ??
      8443,
    bearerToken: process.env.BASTION_SERVER_BEARER || fileConfig.server?.bearerToken,
    maxRequestBytes: fileConfig.server?.maxRequestBytes ?? 65536,
    rateLimitPerMinute: fileConfig.server?.rateLimitPerMinute ?? 60,
  };

  const config: BastionAppConfig = {
    networkId,
    nearRpcUrl,
    contractId,
    agentId,
    agentPrivateKey,
    ownerPrivateKey,
    nearAiApiKey,
    nearAiModel,
    signerContract,
    derivationPath,
    chain: {
      chainId,
      name: chainName,
      rpcUrl,
      explorerUrl,
      tokens,
    },
    auditLogPath,
    server: serverConfig,
  };

  return config;
}

/**
 * Validates that required configuration is present before running client operations.
 */
export function validateBastionConfig(config: BastionAppConfig, requireKeys = true): void {
  if (!config.contractId || config.contractId.trim() === "") {
    throw new BastionConfigError(
      "Missing required configuration: 'contractId'. Set BASTION_CONTRACT_ID in environment or contractId in bastion.config.json.",
    );
  }

  if (!config.agentId || config.agentId.trim() === "") {
    throw new BastionConfigError(
      "Missing required configuration: 'agentId'. Set AGENT_ACCOUNT_ID in environment or agentId in bastion.config.json.",
    );
  }

  if (!config.chain?.rpcUrl || config.chain.rpcUrl.trim() === "") {
    throw new BastionConfigError(
      "Missing required configuration: 'chain.rpcUrl'. Set BASTION_EVM_RPC in environment or chain.rpcUrl in bastion.config.json.",
    );
  }

  if (!config.chain?.chainId || Number.isNaN(config.chain.chainId)) {
    throw new BastionConfigError(
      "Invalid or missing 'chain.chainId'. Configure chain.chainId in bastion.config.json or BASTION_CHAIN_ID.",
    );
  }

  if (requireKeys && (!config.agentPrivateKey || config.agentPrivateKey.trim() === "")) {
    throw new BastionConfigError(
      "Missing required agent key: 'agentPrivateKey'. Set AGENT_PRIVATE_KEY in environment or agentPrivateKey in config.",
    );
  }
}

/**
 * Resolves token input (symbol or address) against chain configuration.
 */
export function resolveToken(config: BastionAppConfig, tokenInput: string): TokenConfig {
  const trimmed = tokenInput.trim();

  // 1. Check known symbols (case-insensitive)
  const match = config.chain.tokens.find(
    (t) => t.symbol.toLowerCase() === trimmed.toLowerCase(),
  );
  if (match) return match;

  // 2. Check if valid address
  if (isAddress(trimmed)) {
    const addressMatch = config.chain.tokens.find(
      (t) => t.address.toLowerCase() === trimmed.toLowerCase(),
    );
    if (addressMatch) return addressMatch;

    return {
      symbol: "CUSTOM",
      address: trimmed.toLowerCase() as Address,
    };
  }

  throw new BastionConfigError(
    `Unknown token '${tokenInput}'. Provide a valid 0x ERC-20 contract address or configure symbol in chain.tokens.`,
  );
}
