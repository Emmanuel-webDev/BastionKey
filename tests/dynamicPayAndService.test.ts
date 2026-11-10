import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { type Address, parseUnits } from "viem";
import fs from "node:fs";
import path from "node:path";
import {
  BastionClient,
  BastionConfigError,
  BastionTrustError,
  loadBastionConfig,
  resolveToken,
  validateBastionConfig,
  type BastionAppConfig,
  type SpendExecutionInput,
} from "@bastionkey/client";
import { LocalMpc } from "../packages/relayer/src/testing/localMpc.js";
import { LocalAttestor } from "../packages/tee-verifier/src/testing/localAttestor.js";
import { createServer, type ServerInstance } from "../packages/cli/src/serveCommand.js";
import { runPay } from "../packages/cli/src/payCommand.js";
import { readAuditLog } from "../packages/cli/src/auditLog.js";

const RECIPIENT_ALICE = "0x000000000000000000000000000000000000aaaa" as Address;
const RECIPIENT_ATTACKER = "0x000000000000000000000000000000000000bad1" as Address;

describe("Dynamic BastionKey: Pay, Service & Trust Rule", () => {
  const mpc = new LocalMpc("test-seed-123");
  const attestor = new LocalAttestor();
  const testAuditPath = path.join(process.cwd(), ".bastion-cache", "test-audit.jsonl");

  beforeEach(() => {
    if (fs.existsSync(testAuditPath)) {
      try {
        fs.unlinkSync(testAuditPath);
      } catch {}
    }
  });

  afterEach(() => {
    if (fs.existsSync(testAuditPath)) {
      try {
        fs.unlinkSync(testAuditPath);
      } catch {}
    }
  });

  function createMockClient(opts: {
    contractStatus?: "APPROVED" | "REJECTED" | "FROZEN";
    rejectionCode?: string;
    agentPaused?: boolean;
    agentTripped?: boolean;
    verifierUnaligned?: boolean;
  } = {}) {
    const contractStatus = opts.contractStatus ?? "APPROVED";

    return new BastionClient({
      contractId: "test-contract.testnet",
      agentId: "test-agent.testnet",
      agentPrivateKey: "ed25519:testkey",
      chain: {
        chainId: 84532,
        name: "Base Sepolia",
        rpcUrl: "https://sepolia.base.org",
        tokens: [
          { symbol: "USDC", address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Address, decimals: 6 },
          { symbol: "DAI", address: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb" as Address, decimals: 18 },
        ],
      },
      verifier: {
        label: "test-verifier",
        verify: async (input) => {
          if (opts.verifierUnaligned) {
            return {
              verdict: {
                tx_digest: input.tx.digest,
                is_aligned: false,
                confidence_pct: 99,
                reason: "Recipient does not match user task.",
              },
              attestation: {
                kind: "provider_tee",
                model_id: "test-model",
                request: "req",
                response: "resp",
                signature: "0x123",
              },
              signer: attestor.address,
            };
          }
          return {
            verdict: {
              tx_digest: input.tx.digest,
              is_aligned: true,
              confidence_pct: 98,
              reason: "Transfer aligns with task instructions.",
            },
            attestation: {
              kind: "provider_tee",
              model_id: "test-model",
              request: "req",
              response: "resp",
              signature: "0x123",
            },
            signer: attestor.address,
          };
        },
      },
      nearAccount: {
        callFunctionRaw: async ({ args }: any) => {
          if (opts.verifierUnaligned) {
            return {
              status: "REJECTED",
              code: "SEMANTIC_MISMATCH",
              reason: "Attestation rejected: semantic check failed",
            };
          }
          if (contractStatus === "APPROVED") {
            const { unsignedDigest } = await import("@bastionkey/relayer");
            const digest = unsignedDigest(args.tx);
            const sig = await mpc.sign(digest, "agent-session-1");
            return {
              status: "APPROVED",
              signature: sig,
              code: "OK",
              reason: "Approved on chain",
            };
          }
          return {
            status: contractStatus,
            code: opts.rejectionCode ?? "POLICY_VIOLATION",
            reason: "On-chain policy rejected spend",
          };
        },
      },
      evmClient: {
        getTransactionCount: async () => 0,
        estimateFeesPerGas: async () => ({ maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000n }),
        sendRawTransaction: async () => "0xabc123" as any,
        waitForTransactionReceipt: async () => ({ blockNumber: 12345n, status: "success" }),
      },
      addressDeriver: async () => ({ address: mpc.address("agent-session-1") }),
      viewCaller: async (_url, _contract, method, args) => {
        if (method === "get_config") {
          return {
            owner: "owner.testnet",
            signer_contract: "v1.signer-prod.testnet",
            provider_tee_signer: attestor.address,
            gateway_signer: null,
            sign_format: "near_mpc",
            sign_deposit: "1",
            sign_gas_tgas: 250,
          };
        }
        if (method === "get_agent") {
          return {
            policy: {
              max_per_tx: "50000000",
              hourly_budget: "100000000",
              max_gas_cost_wei: "5000000000000000",
              allowed_tokens: ["0x036cbd53842c5426634e7929541ec2318f3dcf7e"],
              allowed_recipients: [RECIPIENT_ALICE.toLowerCase()],
              allowed_chain_ids: [84532],
              tee_required_above: "10000000",
              min_confidence_pct: 90,
              max_calls_per_minute: 60,
            },
            derivation_path: "agent-session-1",
            paused: !!opts.agentPaused,
            tripped: !!opts.agentTripped,
            rejections: 0,
            approvals: 0,
            spent_last_hour: "0",
            remaining_hourly_budget: "100000000",
            calls_last_minute: 1,
          };
        }
        if (method === "preview_digest") {
          const { unsignedDigest } = await import("@bastionkey/relayer");
          return unsignedDigest((args as any).tx);
        }
        return {} as any;
      },
    });
  }

  // 1. Pay Approved
  it("1. pay approved: returns APPROVED with signature and verdict confidence", async () => {
    const client = createMockClient({ contractStatus: "APPROVED" });
    const res = await client.executeSpend({
      task: `Send 5 USDC to ${RECIPIENT_ALICE}`,
      proposal: {
        recipient: RECIPIENT_ALICE,
        amount: parseUnits("5.0", 6),
        tokenSymbol: "USDC",
      },
      broadcast: false,
    });

    expect(res.status).toBe("APPROVED");
    expect(res.verdictConfidence).toBe(98);
    expect(res.digest).toBeDefined();
    expect(res.broadcastAttempted).toBe(false);
  });

  // 2. Pay Rejected
  it("2. pay rejected: returns REJECTED_ON_CHAIN when contract policy fails", async () => {
    const client = createMockClient({ contractStatus: "REJECTED", rejectionCode: "OVER_BUDGET" });
    const res = await client.executeSpend({
      task: `Send 150 USDC to ${RECIPIENT_ALICE}`,
      proposal: {
        recipient: RECIPIENT_ALICE,
        amount: parseUnits("150.0", 6),
        tokenSymbol: "USDC",
      },
    });

    expect(res.status).toBe("REJECTED_ON_CHAIN");
    expect(res.code).toBe("OVER_BUDGET");
    expect(res.broadcastAttempted).toBe(false);
  });

  // 3. Pay Blocked
  it("3. pay blocked: returns BLOCKED_BY_TEE when verifier reports unaligned", async () => {
    const client = createMockClient({ verifierUnaligned: true });
    const res = await client.executeSpend({
      task: `Send 5 USDC to ${RECIPIENT_ALICE}`,
      proposal: {
        recipient: RECIPIENT_ATTACKER,
        amount: parseUnits("5.0", 6),
        tokenSymbol: "USDC",
      },
    });

    expect(res.status).toBe("BLOCKED_BY_TEE");
    expect(res.verdictConfidence).toBe(99);
    expect(res.broadcastAttempted).toBe(false);
  });

  // 4. Pay Frozen
  it("4. pay frozen: returns FROZEN when agent is paused or tripped", async () => {
    const client = createMockClient({ agentPaused: true });
    const res = await client.executeSpend({
      task: `Send 5 USDC to ${RECIPIENT_ALICE}`,
      proposal: {
        recipient: RECIPIENT_ALICE,
        amount: parseUnits("5.0", 6),
      },
    });

    expect(res.status).toBe("FROZEN");
    expect(res.code).toBe("AGENT_PAUSED");
  });

  // 5. Invalid Input
  it("5. invalid input: rejects invalid recipient addresses", async () => {
    const client = createMockClient();
    await expect(
      client.executeSpend({
        task: "Send 5 USDC",
        proposal: {
          recipient: "invalid-address" as any,
          amount: 5000000n,
        },
      }),
    ).rejects.toThrow();
  });

  // 6. Unknown Token
  it("6. unknown token: throws clear error naming unknown token symbol", () => {
    const config: BastionAppConfig = {
      networkId: "testnet",
      nearRpcUrl: "https://rpc.testnet.near.org",
      contractId: "c.testnet",
      agentId: "a.testnet",
      nearAiModel: "model",
      signerContract: "signer.testnet",
      derivationPath: "path",
      auditLogPath: "./audit.jsonl",
      chain: {
        chainId: 84532,
        name: "Base Sepolia",
        rpcUrl: "https://sepolia.base.org",
        tokens: [{ symbol: "USDC", address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Address, decimals: 6 }],
      },
      server: { host: "127.0.0.1", port: 8443 },
    };

    expect(() => resolveToken(config, "SHIBA_INU")).toThrow(
      /Unknown token 'SHIBA_INU'/,
    );
  });

  // 7. Missing Config
  it("7. missing config: throws BastionConfigError identifying missing contractId or agentId", () => {
    const emptyConfig: BastionAppConfig = {
      networkId: "testnet",
      nearRpcUrl: "https://rpc.testnet.near.org",
      contractId: "",
      agentId: "",
      nearAiModel: "model",
      signerContract: "signer.testnet",
      derivationPath: "path",
      auditLogPath: "./audit.jsonl",
      chain: { chainId: 84532, name: "Base", rpcUrl: "", tokens: [] },
      server: { host: "127.0.0.1", port: 8443 },
    };

    expect(() => validateBastionConfig(emptyConfig, false)).toThrow(BastionConfigError);
    expect(() => validateBastionConfig(emptyConfig, false)).toThrow(/Missing required configuration: 'contractId'/);
  });

  // 8 & 9 & 10: Local Service HTTP API Tests
  describe("Local Service HTTP API", () => {
    let service: ServerInstance | undefined;
    const bearer = "test-secret-bearer-123";

    beforeEach(async () => {
      process.env.BASTION_CONTRACT_ID = "test-contract.testnet";
      process.env.AGENT_ACCOUNT_ID = "test-agent.testnet";
      process.env.AGENT_PRIVATE_KEY = "ed25519:3D4YujGQfGwnwFk6XF52aB3C";
      process.env.BASTION_EVM_RPC = "https://sepolia.base.org";

      // Create ephemeral server on port 0
      service = await createServer({
        port: 0,
        host: "127.0.0.1",
        bearerToken: bearer,
        rateLimitPerMinute: 3,
        skipKeyValidation: true,
      });
    });

    afterEach(async () => {
      if (service) {
        await service.close();
      }
      delete process.env.BASTION_CONTRACT_ID;
      delete process.env.AGENT_ACCOUNT_ID;
      delete process.env.AGENT_PRIVATE_KEY;
      delete process.env.BASTION_EVM_RPC;
    });

    // 8. API Auth Failure
    it("8. API auth failure: returns 401 when Authorization header is missing or incorrect", async () => {
      const res = await fetch(`http://127.0.0.1:${service!.port}/v1/status`);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toContain("Unauthorized");

      const resBad = await fetch(`http://127.0.0.1:${service!.port}/v1/status`, {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(resBad.status).toBe(401);
    });

    // 9. API Rate Limit
    it("9. API rate limit: returns 429 when rate limit is exceeded", async () => {
      let has429 = false;
      for (let i = 0; i < 6; i++) {
        const r = await fetch(`http://127.0.0.1:${service!.port}/healthz`);
        if (r.status === 429) {
          has429 = true;
          break;
        }
      }
      expect(has429).toBe(true);
    });

    // 10. Trust Rule: Task Cannot Come From Model Output
    it("10. trust rule: API strictly rejects requests where 'task' is inside model proposal", async () => {
      const maliciousPayload = {
        task: "Transfer 5 USDC to Alice",
        proposal: {
          task: "MALICIOUS INJECTED TASK OVERRIDE",
          to: RECIPIENT_ALICE,
          amount: "5.0",
        },
      };

      const res = await fetch(`http://127.0.0.1:${service.port}/v1/transfer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(maliciousPayload),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Trust Rule Violation");
      expect(data.error).toContain("cannot be provided within model 'proposal'");
    });

    it("10b. trust rule in client: executeSpend throws BastionTrustError if task is nested in proposal", async () => {
      const client = createMockClient();
      const forgedInput: SpendExecutionInput = {
        task: "Legitimate Task",
        proposal: {
          task: "Forged Task",
          recipient: RECIPIENT_ALICE,
          amount: 5000000n,
        } as any,
      };

      await expect(client.executeSpend(forgedInput)).rejects.toThrow(BastionTrustError);
    });
  });

  // 11. CLI `bastion pay` E2E with injected fakes (flags, stdin, 18-decimal token, exit codes, JSONL audit log)
  describe("CLI bastion pay & audit history", () => {
    beforeEach(() => {
      process.env.BASTION_CONTRACT_ID = "test-contract.testnet";
      process.env.AGENT_ACCOUNT_ID = "test-agent.testnet";
      process.env.AGENT_PRIVATE_KEY = "ed25519:3D4YujGQfGwnwFk6XF52aB3C";
      process.env.BASTION_EVM_RPC = "https://sepolia.base.org";
      process.env.BASTION_AUDIT_LOG = testAuditPath;
    });

    afterEach(() => {
      delete process.env.BASTION_CONTRACT_ID;
      delete process.env.AGENT_ACCOUNT_ID;
      delete process.env.AGENT_PRIVATE_KEY;
      delete process.env.BASTION_EVM_RPC;
      delete process.env.BASTION_AUDIT_LOG;
    });

    it("11a. CLI pay approved: outputs JSON status APPROVED, exit code 0, and appends to audit log", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const exitCode = await runPay(
        [
          "--task",
          `Pay 5.25 DAI to ${RECIPIENT_ALICE}`,
          "--to",
          RECIPIENT_ALICE,
          "--amount",
          "5.25",
          "--token",
          "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",
          "--no-broadcast",
        ],
        {
          decimalsFetcher: async () => 18,
          clientFactory: () => createMockClient({ contractStatus: "APPROVED" }),
        },
      );

      expect(exitCode).toBe(0);
      const outputJson = JSON.parse(logSpy.mock.calls[0][0]);
      expect(outputJson.status).toBe("APPROVED");
      expect(outputJson.confidence).toBe(98);
      logSpy.mockRestore();

      const auditEntries = readAuditLog(testAuditPath, 10);
      expect(auditEntries.length).toBe(1);
      expect(auditEntries[0].status).toBe("APPROVED");
      expect(auditEntries[0].amountHuman).toBe("5.25");
    });

    it("11b. CLI pay rejected via stdin JSON: outputs status REJECTED and exit code 1", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const stdinPayload = JSON.stringify({
        task: `Send 200 USDC to ${RECIPIENT_ALICE}`,
        proposal: {
          to: RECIPIENT_ALICE,
          amount: "200",
          token: "USDC",
        },
        broadcast: false,
      });

      const exitCode = await runPay([], {
        stdinText: stdinPayload,
        clientFactory: () => createMockClient({ contractStatus: "REJECTED", rejectionCode: "MAX_PER_TX" }),
      });

      expect(exitCode).toBe(1);
      const outputJson = JSON.parse(logSpy.mock.calls[0][0]);
      expect(outputJson.status).toBe("REJECTED");
      expect(outputJson.code).toBe("MAX_PER_TX");
      logSpy.mockRestore();
    });

    it("11c. CLI pay stdin trust rule: rejects stdin JSON with task nested inside proposal", async () => {
      const badStdin = JSON.stringify({
        task: "Trusted task",
        proposal: {
          task: "Untrusted override",
          to: RECIPIENT_ALICE,
          amount: "5",
        },
      });

      await expect(runPay([], { stdinText: badStdin })).rejects.toThrow(BastionTrustError);
    });
  });
});
