import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validatePolicy, type UserPolicyFile } from "../packages/cli/src/policyValidator.js";
import { NearOwnerClient } from "../packages/cli/src/nearOwnerClient.js";

const VALID_EXAMPLE_PATH = join(__dirname, "..", "packages", "cli", "policy.example.json");

describe("Policy Validator", () => {
  it("1. valid file: parses policy.example.json and converts USD to base units", () => {
    const raw = JSON.parse(readFileSync(VALID_EXAMPLE_PATH, "utf8"));
    const res = validatePolicy(raw);

    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.onChainPolicy).toBeDefined();

    // 6 decimals: $50.00 -> 50000000
    expect(res.onChainPolicy!.max_per_tx).toBe("50000000");
    // 6 decimals: $100.00 -> 100000000
    expect(res.onChainPolicy!.hourly_budget).toBe("100000000");
    // tee_required_above: 0 -> 0
    expect(res.onChainPolicy!.tee_required_above).toBe("0");
    // 10,000,000 Gwei -> 10,000,000 * 10^9 wei
    expect(res.onChainPolicy!.max_gas_cost_wei).toBe("10000000000000000");
    expect(res.onChainPolicy!.min_confidence_pct).toBe(80);
    expect(res.onChainPolicy!.max_calls_per_minute).toBe(20);
    expect(res.onChainPolicy!.allowed_chain_ids).toEqual([84532]);
  });

  it("2. token with 18 decimals: scales amounts correctly without floating point errors", () => {
    const policy: UserPolicyFile = {
      token: {
        symbol: "DAI",
        address: "0x1111111111111111111111111111111111111111",
        decimals: 18,
      },
      limits: {
        maxPerTxUsd: 1.5,
        hourlyBudgetUsd: 10.25,
        teeRequiredAboveUsd: 0.5,
        maxGasCostGwei: 5000000,
      },
      rules: {
        allowedTokens: ["0x1111111111111111111111111111111111111111"],
        allowedRecipients: ["0x2222222222222222222222222222222222222222"],
        allowedChains: [1],
        minConfidencePct: 90,
        maxCallsPerMinute: 15,
      },
    };

    const res = validatePolicy(policy);
    expect(res.valid).toBe(true);
    expect(res.onChainPolicy!.max_per_tx).toBe("1500000000000000000");
    expect(res.onChainPolicy!.hourly_budget).toBe("10250000000000000000");
    expect(res.onChainPolicy!.tee_required_above).toBe("500000000000000000");
  });

  it("3. invalid file: rejects missing blocks, malformed addresses and bad types", () => {
    expect(validatePolicy(null).valid).toBe(false);
    expect(validatePolicy({}).valid).toBe(false);

    // Missing token block
    const missingToken = validatePolicy({
      limits: { maxPerTxUsd: 10, hourlyBudgetUsd: 20 },
      rules: { allowedTokens: ["0x1111111111111111111111111111111111111111"], allowedRecipients: [], allowedChains: [1], minConfidencePct: 50, maxCallsPerMinute: 10 },
    });
    expect(missingToken.valid).toBe(false);
    expect(missingToken.errors).toContain("Missing required 'token' configuration block.");

    // Invalid Ethereum address
    const badAddress = validatePolicy({
      token: { address: "0xinvalidaddress", decimals: 6 },
      limits: { maxPerTxUsd: 10, hourlyBudgetUsd: 20 },
      rules: { allowedTokens: ["0xnotanaddress"], allowedRecipients: [], allowedChains: [1], minConfidencePct: 50, maxCallsPerMinute: 10 },
    });
    expect(badAddress.valid).toBe(false);
    expect(badAddress.errors.some((e) => e.includes("Invalid token address"))).toBe(true);
    expect(badAddress.errors.some((e) => e.includes("rules.allowedTokens"))).toBe(true);
  });

  it("4. boundary values: enforces invariants (hourlyBudget >= maxPerTx, confidence 0..100)", () => {
    const base: UserPolicyFile = {
      token: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
      limits: { maxPerTxUsd: 100, hourlyBudgetUsd: 50 }, // Invariant violation: budget < per-tx cap
      rules: {
        allowedTokens: ["0x036CbD53842c5426634e7929541eC2318f3dCF7e"],
        allowedRecipients: [],
        allowedChains: [84532],
        minConfidencePct: 105, // Out of bounds (> 100)
        maxCallsPerMinute: 0, // Out of bounds (must be > 0)
      },
    };

    const res = validatePolicy(base);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("Invariant violation"))).toBe(true);
    expect(res.errors.some((e) => e.includes("minConfidencePct must be an integer between 0 and 100"))).toBe(true);
    expect(res.errors.some((e) => e.includes("maxCallsPerMinute must be an integer greater than 0"))).toBe(true);

    // Test valid boundaries: minConfidence = 0 and 100, maxCalls = 1, budget == maxPerTx
    base.limits.hourlyBudgetUsd = 100;
    base.rules.minConfidencePct = 0;
    base.rules.maxCallsPerMinute = 1;
    const resBoundary0 = validatePolicy(base);
    expect(resBoundary0.valid).toBe(true);

    base.rules.minConfidencePct = 100;
    const resBoundary100 = validatePolicy(base);
    expect(resBoundary100.valid).toBe(true);
  });

  it("5. empty allowedRecipients: valid with explicit warning about open policy", () => {
    const raw = JSON.parse(readFileSync(VALID_EXAMPLE_PATH, "utf8"));
    raw.rules.allowedRecipients = [];

    const res = validatePolicy(raw);
    expect(res.valid).toBe(true);
    expect(res.onChainPolicy!.allowed_recipients).toEqual([]);
    expect(res.warnings.some((w) => w.includes("open allow-list mode active"))).toBe(true);
  });
});

describe("NearOwnerClient (with injected fakes)", () => {
  it("6. owner command execution: sends formatted payload and updates on-chain policy", async () => {
    const raw = JSON.parse(readFileSync(VALID_EXAMPLE_PATH, "utf8"));
    const { onChainPolicy } = validatePolicy(raw);

    const client = new NearOwnerClient({
      contractId: "bastion-guard.testnet",
      ownerId: "bastion-guard.testnet",
      ownerPrivateKey: "ed25519:mock_owner_key_for_unit_test",
    });

    // Mock contract config call
    vi.spyOn(client, "getContractConfig").mockResolvedValue({
      owner: "bastion-guard.testnet",
      signer_contract: "v1.signer-prod.testnet",
      provider_tee_signer: "0xfe0071895500a9755c18044948ab4f4e1a7f337e",
    });

    // Mock internal account call
    const mockCallRaw = vi.fn().mockResolvedValue({
      transaction: { hash: "3WmjAXopc2ASXo9XNGnq95reu1hETcrEmyJCuYKtQM8c" },
    });

    (client as any).getOwnerAccount = vi.fn().mockResolvedValue({
      account: { callFunctionRaw: mockCallRaw },
      ownerId: "bastion-guard.testnet",
    });

    const res = await client.updatePolicy("agent-1.bastion-guard.testnet", onChainPolicy!);
    expect(res.txHash).toBe("3WmjAXopc2ASXo9XNGnq95reu1hETcrEmyJCuYKtQM8c");
    expect(mockCallRaw).toHaveBeenCalledWith({
      contractId: "bastion-guard.testnet",
      methodName: "update_policy",
      args: {
        agent_account: "agent-1.bastion-guard.testnet",
        policy: onChainPolicy,
      },
      gas: 50_000_000_000_000n,
      deposit: 0n,
    });
  });

  it("7. owner key guard: refuses to run owner commands if owner key is missing", async () => {
    const client = new NearOwnerClient({
      contractId: "bastion-guard.testnet",
      ownerId: "some-owner.testnet",
      // No explicit key, no env vars
    });

    // Ensure environment is clear of owner key overrides
    delete process.env.BASTION_OWNER_PRIVATE_KEY;
    delete process.env.NEAR_OWNER_KEY;

    vi.spyOn(client, "getContractConfig").mockResolvedValue({
      owner: "some-owner.testnet",
      signer_contract: "v1.signer-prod.testnet",
      provider_tee_signer: null,
    });

    await expect(client.setPaused("agent-1.bastion-guard.testnet", true)).rejects.toThrow(
      /Owner private key for 'some-owner.testnet' was not found/,
    );
  });
});
