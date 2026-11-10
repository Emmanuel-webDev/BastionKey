import http from "node:http";
import { isAddress, parseUnits, type Address } from "viem";
import {
  BastionClient,
  BastionConfigError,
  BastionKeySecurityError,
  BastionTrustError,
  getTokenDecimals,
  loadBastionConfig,
  resolveToken,
  validateBastionConfig,
  type BastionAppConfig,
} from "@bastionkey/client";
import { appendAuditLog, readAuditLog } from "./auditLog.js";
import { assertFunctionCallKeyOnly } from "./keyValidator.js";

export interface ServerInstance {
  server: http.Server;
  close: () => Promise<void>;
  port: number;
}

export interface ServeOptions {
  configFile?: string;
  host?: string;
  port?: number;
  bearerToken?: string;
  rateLimitPerMinute?: number;
  skipKeyValidation?: boolean; // For testing with mock keys
  client?: BastionClient; // Optional injected BastionClient for testing
  decimalsFetcher?: typeof getTokenDecimals;
}

class RateLimiter {
  private requests = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests = 60, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  public isAllowed(clientIp: string): boolean {
    const now = Date.now();
    const timestamps = (this.requests.get(clientIp) || []).filter((t) => now - t < this.windowMs);
    if (timestamps.length >= this.maxRequests) {
      return false;
    }
    timestamps.push(now);
    this.requests.set(clientIp, timestamps);
    return true;
  }
}

export async function createServer(opts: ServeOptions = {}): Promise<ServerInstance> {
  const config = loadBastionConfig(opts.configFile);

  // SECURITY: Never hold or load the owner key in the agent service daemon
  delete (config as any).ownerPrivateKey;

  validateBastionConfig(config, true);

  const host = opts.host ?? config.server.host ?? "127.0.0.1";
  const port = opts.port !== undefined ? opts.port : (config.server.port ?? 8443);
  const bearerToken = opts.bearerToken || config.server.bearerToken;
  const maxBytes = config.server.maxRequestBytes || 65536;
  const rateLimiter = new RateLimiter(opts.rateLimitPerMinute || config.server.rateLimitPerMinute || 60, 60000);

  if (!bearerToken || bearerToken.trim() === "") {
    throw new BastionConfigError(
      "Missing required 'bearerToken' for bastion serve. Set BASTION_SERVER_BEARER or server.bearerToken in bastion.config.json.",
    );
  }
  if (!opts.skipKeyValidation && config.agentPrivateKey) {
    await assertFunctionCallKeyOnly(
      config.nearRpcUrl,
      config.contractId,
      config.agentId,
      config.agentPrivateKey,
    );
  }

  const client =
    opts.client ??
    new BastionClient({
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

  const sendJson = (res: http.ServerResponse, statusCode: number, data: unknown, requestId?: string) => {
    const payload = JSON.stringify(data, null, 2);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload).toString(),
      Connection: "close",
      ...(requestId ? { "X-Request-Id": requestId } : {}),
    });
    res.end(payload);
  };

  const server = http.createServer(async (req, res) => {
    req.setTimeout(30_000, () => {
      if (!res.headersSent) {
        sendJson(res, 408, { error: "Request timeout" });
      }
    });
    res.setTimeout(60_000, () => {
      if (!res.headersSent) {
        sendJson(res, 504, { error: "Gateway timeout" });
      }
    });
    const requestId = (req.headers["x-request-id"] as string) || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const clientIp = req.socket.remoteAddress || "127.0.0.1";

    // Rate Limiting
    if (!rateLimiter.isAllowed(clientIp)) {
      return sendJson(res, 429, { error: "Rate limit exceeded. Try again in 60 seconds." }, requestId);
    }

    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    // Liveness probe (public)
    if (pathname === "/healthz" && req.method === "GET") {
      return sendJson(res, 200, { status: "ok", timestamp: new Date().toISOString() }, requestId);
    }

    // Bearer Token Authentication
    if (bearerToken) {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${bearerToken}`) {
        return sendJson(res, 401, { error: "Unauthorized: valid Bearer token required" }, requestId);
      }
    }

    try {
      // GET /v1/status
      if (pathname === "/v1/status" && req.method === "GET") {
        const [contractCfg, agentState] = await Promise.all([
          client.getConfig(),
          client.getAgent(),
        ]);
        return sendJson(
          res,
          200,
          {
            contractId: config.contractId,
            agentId: config.agentId,
            networkId: config.networkId,
            chainId: config.chain.chainId,
            paused: agentState.paused,
            tripped: agentState.tripped,
            approvals: agentState.approvals,
            rejections: agentState.rejections,
            spentLastHour: agentState.spent_last_hour,
            remainingHourlyBudget: agentState.remaining_hourly_budget,
            callsLastMinute: agentState.calls_last_minute,
            maxCallsPerMinute: agentState.policy.max_calls_per_minute,
          },
          requestId,
        );
      }

      // GET /v1/policy
      if (pathname === "/v1/policy" && req.method === "GET") {
        const agentState = await client.getAgent();
        return sendJson(res, 200, agentState.policy, requestId);
      }

      // GET /v1/history
      if (pathname === "/v1/history" && req.method === "GET") {
        const limit = parseInt(parsedUrl.searchParams.get("limit") || "20", 10);
        const entries = readAuditLog(config.auditLogPath, limit);
        return sendJson(res, 200, entries, requestId);
      }

      // POST /v1/transfer
      if (pathname === "/v1/transfer" && req.method === "POST") {
        let bodyRaw = "";
        let bodyBytes = 0;

        req.setEncoding("utf8");
        for await (const chunk of req) {
          bodyBytes += Buffer.byteLength(chunk);
          if (bodyBytes > maxBytes) {
            return sendJson(res, 413, { error: `Payload too large. Max request size is ${maxBytes} bytes.` }, requestId);
          }
          bodyRaw += chunk;
        }

        let body: any;
        try {
          body = JSON.parse(bodyRaw);
        } catch {
          return sendJson(res, 400, { error: "Invalid JSON in request body" }, requestId);
        }

        // TRUST RULE ENFORCEMENT IN HTTP API:
        // `task` must be supplied separately from model proposal.
        if (!body.task || typeof body.task !== "string" || body.task.trim() === "") {
          return sendJson(
            res,
            400,
            { error: "Missing required top-level trusted field: 'task'. The human/app task must be specified separately from model proposal." },
            requestId,
          );
        }

        if (!body.proposal || typeof body.proposal !== "object") {
          return sendJson(
            res,
            400,
            { error: "Missing required 'proposal' object containing model's proposed transfer parameters." },
            requestId,
          );
        }

        if ("task" in body.proposal) {
          return sendJson(
            res,
            400,
            {
              error: "Trust Rule Violation: 'task' cannot be provided within model 'proposal'. Task is trusted caller input; model proposal is untrusted.",
            },
            requestId,
          );
        }

        const to = body.proposal.to || body.proposal.recipient;
        if (!to || !isAddress(to)) {
          return sendJson(res, 400, { error: `Invalid recipient in proposal: '${to}'. Must be a valid 0x address.` }, requestId);
        }

        const amountStr = body.proposal.amount?.toString();
        if (!amountStr || isNaN(Number(amountStr)) || Number(amountStr) <= 0) {
          return sendJson(res, 400, { error: `Invalid amount in proposal: '${amountStr}'. Must be a positive number.` }, requestId);
        }

        const tokenStr = body.proposal.token || body.proposal.tokenSymbol;
        const tokenConfig = resolveToken(config, tokenStr || config.chain.tokens[0]?.symbol || "USDC");
        let decimals = tokenConfig.decimals;
        if (decimals === undefined) {
          const fetchDec = opts.decimalsFetcher ?? getTokenDecimals;
          decimals = await fetchDec({
            tokenAddress: tokenConfig.address,
            chainId: config.chain.chainId,
            rpcUrl: config.chain.rpcUrl,
          });
        }

        const baseAmount = parseUnits(amountStr.trim(), decimals);
        const actionLog = Array.isArray(body.proposal.actionLog)
          ? body.proposal.actionLog.map(String)
          : [];
        const broadcast = body.broadcast !== false;

        const spendRes = await client.executeSpend({
          requestId,
          task: body.task.trim(),
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

        const apiStatus = spendRes.status === "REJECTED_ON_CHAIN" ? "REJECTED" : spendRes.status;

        // Append to audit log
        appendAuditLog(config.auditLogPath, {
          timestamp: new Date().toISOString(),
          requestId,
          status: apiStatus,
          code: spendRes.code,
          reason: spendRes.reason,
          task: body.task.trim(),
          recipient: to.toLowerCase(),
          amountHuman: amountStr,
          tokenSymbol: tokenConfig.symbol,
          tokenAddress: tokenConfig.address,
          digest: spendRes.digest,
          nearTxHash: spendRes.nearTxHash,
          baseTxHash: spendRes.broadcastHash,
          confidence: spendRes.verdictConfidence,
        });

        const statusHttpCode =
          apiStatus === "APPROVED"
            ? 200
            : apiStatus === "BLOCKED_BY_TEE" || apiStatus === "REJECTED" || apiStatus === "FROZEN"
            ? 422
            : 500;

        return sendJson(
          res,
          statusHttpCode,
          {
            requestId,
            status: apiStatus,
            code: spendRes.code ?? apiStatus,
            reason: spendRes.reason,
            digest: spendRes.digest,
            nearTxHash: spendRes.nearTxHash,
            baseTxHash: spendRes.broadcastHash,
            confidence: spendRes.verdictConfidence,
            verdictReason: spendRes.verdictReason,
          },
          requestId,
        );
      }

      // Not Found
      return sendJson(res, 404, { error: `Route not found: ${req.method} ${pathname}` }, requestId);
    } catch (err: any) {
      if (err instanceof BastionConfigError || err instanceof BastionTrustError) {
        return sendJson(
          res,
          400,
          {
            error: err.message,
            code: err.code,
          },
          requestId,
        );
      }
      return sendJson(
        res,
        500,
        {
          error: "Internal server error",
          message: err.message,
          code: err.code || "INTERNAL_ERROR",
        },
        requestId,
      );
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        server,
        port: actualPort,
        close: () =>
          new Promise((resClose) => {
            server.close(() => resClose());
          }),
      });
    });
    server.on("error", reject);
  });
}

export async function runServe(rawArgs: string[]): Promise<void> {
  let host = "127.0.0.1";
  let port = 8443;
  let configFile: string | undefined;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--host" && rawArgs[i + 1]) {
      host = rawArgs[++i];
    } else if (arg === "--port" && rawArgs[i + 1]) {
      port = parseInt(rawArgs[++i], 10) || 8443;
    } else if (arg === "--config" && rawArgs[i + 1]) {
      configFile = rawArgs[++i];
    }
  }

  console.log(`================================================================================`);
  console.log(`  Starting BastionKey Local Agent Daemon (bastion serve)`);
  console.log(`================================================================================`);
  console.log(`[SECURITY WARNING] This service provides signature access via the agent's FunctionCall`);
  console.log(`key. It is bound to ${host}:${port} for local agent access ONLY.`);
  console.log(`DO NOT expose this port to the public internet or external network interfaces.\n`);

  const instance = await createServer({ host, port, configFile });
  console.log(`BastionKey service listening on http://${host}:${instance.port}`);
  console.log(`Health check: http://${host}:${instance.port}/healthz`);
  console.log(`Ready for POST /v1/transfer calls.\n`);

  const shutdown = async () => {
    console.log("\nShutting down BastionKey agent daemon...");
    await instance.close();
    console.log("Daemon stopped.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
