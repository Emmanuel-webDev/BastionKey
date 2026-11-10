import fs from "node:fs";
import { isAddress, parseUnits, type Address } from "viem";
import {
  BastionClient,
  BastionConfigError,
  BastionTrustError,
  getTokenDecimals,
  loadBastionConfig,
  resolveToken,
  validateBastionConfig,
  type BastionAppConfig,
} from "@bastionkey/client";
import { appendAuditLog } from "./auditLog.js";

export interface PayOptions {
  task?: string;
  taskFile?: string;
  token?: string;
  to?: string;
  amount?: string;
  logFile?: string;
  broadcast?: boolean;
  noBroadcast?: boolean;
  configFile?: string;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data.trim());
    });
    process.stdin.on("error", (err) => {
      reject(err);
    });
  });
}

export interface RunPayDependencies {
  clientFactory?: (config: BastionAppConfig) => BastionClient;
  decimalsFetcher?: typeof getTokenDecimals;
  stdinText?: string;
}

export async function runPay(rawArgs: string[], deps: RunPayDependencies = {}): Promise<number> {
  // Parse CLI flags
  const opts: PayOptions = {};
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--task" && rawArgs[i + 1]) {
      opts.task = rawArgs[++i];
    } else if (arg === "--task-file" && rawArgs[i + 1]) {
      opts.taskFile = rawArgs[++i];
    } else if (arg === "--token" && rawArgs[i + 1]) {
      opts.token = rawArgs[++i];
    } else if (arg === "--to" && rawArgs[i + 1]) {
      opts.to = rawArgs[++i];
    } else if (arg === "--amount" && rawArgs[i + 1]) {
      opts.amount = rawArgs[++i];
    } else if (arg === "--log-file" && rawArgs[i + 1]) {
      opts.logFile = rawArgs[++i];
    } else if (arg === "--no-broadcast") {
      opts.noBroadcast = true;
    } else if (arg === "--broadcast") {
      opts.broadcast = true;
    } else if (arg === "--config" && rawArgs[i + 1]) {
      opts.configFile = rawArgs[++i];
    }
  }

  // If no task or recipient on flags and stdin is available, read from stdin
  let task = opts.task;
  let to = opts.to;
  let amountStr = opts.amount;
  let tokenStr = opts.token;
  let actionLog: string[] = [];
  let broadcast = opts.broadcast ?? (!opts.noBroadcast);

  if (!task && !to && (deps.stdinText !== undefined || !process.stdin.isTTY)) {
    const stdinContent = deps.stdinText !== undefined ? deps.stdinText.trim() : await readStdin();
    if (stdinContent.length > 0) {
      try {
        const parsed = JSON.parse(stdinContent);

        // TRUST RULE ENFORCEMENT ON STDIN
        if (parsed.proposal && typeof parsed.proposal === "object" && "task" in parsed.proposal) {
          throw new BastionTrustError(
            "Trust Rule Violation: 'task' is trusted human/application input and cannot be nested inside 'proposal'.",
          );
        }

        task = parsed.task;
        if (parsed.proposal) {
          to = parsed.proposal.to || parsed.proposal.recipient;
          amountStr = parsed.proposal.amount?.toString();
          tokenStr = parsed.proposal.token || parsed.proposal.tokenSymbol;
          actionLog = parsed.proposal.actionLog || parsed.proposal.log || [];
        } else {
          to = parsed.to || parsed.recipient;
          amountStr = parsed.amount?.toString();
          tokenStr = parsed.token;
          actionLog = parsed.actionLog || parsed.log || [];
        }

        if (typeof parsed.broadcast === "boolean") {
          broadcast = parsed.broadcast;
        }
      } catch (err: any) {
        if (err instanceof BastionTrustError) throw err;
        throw new BastionConfigError(`Failed to parse stdin JSON: ${err.message}`);
      }
    }
  }

  // Resolve task if from file
  if (!task && opts.taskFile) {
    if (!fs.existsSync(opts.taskFile)) {
      throw new BastionConfigError(`Task file not found: '${opts.taskFile}'`);
    }
    task = fs.readFileSync(opts.taskFile, "utf8").trim();
  }

  // Resolve action log if from file
  if (opts.logFile) {
    if (!fs.existsSync(opts.logFile)) {
      throw new BastionConfigError(`Log file not found: '${opts.logFile}'`);
    }
    const raw = fs.readFileSync(opts.logFile, "utf8").trim();
    try {
      const parsedLog = JSON.parse(raw);
      if (Array.isArray(parsedLog)) {
        actionLog = parsedLog.map(String);
      } else {
        actionLog = [raw];
      }
    } catch {
      actionLog = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    }
  }

  // Input validation
  if (!task || task.trim() === "") {
    throw new BastionConfigError("Missing required task: provide --task or --task-file or task in stdin JSON.");
  }

  if (!to || !isAddress(to.trim())) {
    throw new BastionConfigError(`Missing or invalid recipient address: '${to}'. Must be a valid 0x EVM address.`);
  }

  if (!amountStr || isNaN(Number(amountStr)) || Number(amountStr) <= 0) {
    throw new BastionConfigError(`Missing or invalid amount: '${amountStr}'. Must be a positive number in human units.`);
  }

  // Load and validate config
  const config: BastionAppConfig = loadBastionConfig(opts.configFile);
  validateBastionConfig(config, true);

  // Resolve token and decimals
  const tokenConfig = resolveToken(config, tokenStr || config.chain.tokens[0]?.symbol || "USDC");
  let decimals = tokenConfig.decimals;
  if (decimals === undefined) {
    const fetchDecimals = deps.decimalsFetcher ?? getTokenDecimals;
    decimals = await fetchDecimals({
      tokenAddress: tokenConfig.address,
      chainId: config.chain.chainId,
      rpcUrl: config.chain.rpcUrl,
    });
  }

  const baseAmount = parseUnits(amountStr.trim(), decimals);

  const client = deps.clientFactory
    ? deps.clientFactory(config)
    : new BastionClient({
        contractId: config.contractId,
        agentId: config.agentId,
        agentPrivateKey: config.agentPrivateKey,
        nodeUrl: config.nearRpcUrl,
        networkId: config.networkId,
        chain: config.chain,
        signerContract: config.signerContract,
        derivationPath: config.derivationPath,
        nearAiApiKey: config.nearAiApiKey,
        nearAiModel: config.nearAiModel,
      });

  const res = await client.executeSpend({
    task,
    proposal: {
      recipient: to.toLowerCase() as Address,
      amount: baseAmount,
      token: tokenConfig.address,
      tokenSymbol: tokenConfig.symbol,
      decimals,
      actionLog,
    },
    broadcast,
  });

  // Output one JSON object
  const cliStatus = res.status === "REJECTED_ON_CHAIN" ? "REJECTED" : res.status;
  const output = {
    requestId: res.requestId,
    status: cliStatus,
    code: res.code ?? cliStatus,
    reason: res.reason,
    digest: res.digest,
    nearTxHash: res.nearTxHash,
    baseTxHash: res.broadcastHash,
    confidence: res.verdictConfidence,
    verdictReason: res.verdictReason,
  };

  console.log(JSON.stringify(output, null, 2));

  // Append to local JSONL audit log
  appendAuditLog(config.auditLogPath, {
    timestamp: new Date().toISOString(),
    requestId: res.requestId,
    status: cliStatus,
    code: res.code,
    reason: res.reason,
    task,
    recipient: to.toLowerCase(),
    amountHuman: amountStr,
    tokenSymbol: tokenConfig.symbol,
    tokenAddress: tokenConfig.address,
    digest: res.digest,
    nearTxHash: res.nearTxHash,
    baseTxHash: res.broadcastHash,
    confidence: res.verdictConfidence,
  });

  if (res.status === "APPROVED") {
    return 0;
  }
  return 1;
}
