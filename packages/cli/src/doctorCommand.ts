import { createPublicClient, formatEther, formatUnits, http, parseAbi, type Address } from "viem";
import {
  BastionClient,
  fetchSigningAddress,
  getTokenDecimals,
  loadBastionConfig,
  type BastionAppConfig,
} from "@bastionkey/client";
import { inspectNearKey } from "./keyValidator.js";

const ERC20_BALANCE_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

export interface DoctorCheck {
  name: string;
  passed: boolean;
  details: string;
  fix?: string;
}

export async function runDoctor(rawArgs: string[]): Promise<number> {
  let configFile: string | undefined;
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--config" && rawArgs[i + 1]) {
      configFile = rawArgs[++i];
    }
  }

  console.log(`================================================================================`);
  console.log(`  BastionKey Diagnostic Doctor (bastion doctor)`);
  console.log(`================================================================================\n`);

  const checks: DoctorCheck[] = [];
  let config: BastionAppConfig;

  // 1. Config Validation
  try {
    config = loadBastionConfig(configFile);
    const missing: string[] = [];
    if (!config.contractId) missing.push("contractId / BASTION_CONTRACT_ID");
    if (!config.agentId) missing.push("agentId / AGENT_ACCOUNT_ID");
    if (!config.chain?.rpcUrl) missing.push("chain.rpcUrl / BASTION_EVM_RPC");
    if (!config.chain?.chainId) missing.push("chain.chainId / BASTION_CHAIN_ID");

    if (missing.length > 0) {
      checks.push({
        name: "Configuration Validity",
        passed: false,
        details: `Missing fields: ${missing.join(", ")}`,
        fix: "Configure the missing parameters in bastion.config.json or environment variables (.env).",
      });
    } else {
      checks.push({
        name: "Configuration Validity",
        passed: true,
        details: `Contract: '${config.contractId}', Agent: '${config.agentId}', Chain: ${config.chain.chainId}`,
      });
    }
  } catch (err: any) {
    checks.push({
      name: "Configuration Validity",
      passed: false,
      details: err.message,
      fix: "Fix configuration file syntax or environment variables.",
    });
    printResults(checks);
    return 1;
  }

  // 2. NEAR RPC Reachability
  let rpcReachable = false;
  try {
    const res = await fetch(config.nearRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "doctor-rpc-check",
        method: "status",
        params: [],
      }),
    });
    const data = await res.json();
    if (data.result?.chain_id) {
      rpcReachable = true;
      checks.push({
        name: "NEAR RPC Reachability",
        passed: true,
        details: `Connected to '${config.nearRpcUrl}' (Chain: ${data.result.chain_id})`,
      });
    } else {
      checks.push({
        name: "NEAR RPC Reachability",
        passed: false,
        details: `RPC returned unexpected response from ${config.nearRpcUrl}`,
        fix: "Check your NEAR_NODE_URL or verify your internet connection.",
      });
    }
  } catch (err: any) {
    checks.push({
      name: "NEAR RPC Reachability",
      passed: false,
      details: err.message,
      fix: "Check your NEAR_NODE_URL or verify your internet connection.",
    });
  }

  // 3. Contract Reachable & Initialized
  let contractConfig: any = null;
  if (rpcReachable && config.contractId) {
    try {
      const client = new BastionClient({
        contractId: config.contractId,
        agentId: config.agentId,
        nodeUrl: config.nearRpcUrl,
        chain: config.chain,
      });
      contractConfig = await client.getConfig();
      checks.push({
        name: "Contract Initialization",
        passed: true,
        details: `Owner: ${contractConfig.owner}, Signer: ${contractConfig.signer_contract}`,
      });
    } catch (err: any) {
      checks.push({
        name: "Contract Initialization",
        passed: false,
        details: err.message,
        fix: `Deploy BastionKey contract to '${config.contractId}' and call initialize().`,
      });
    }
  }

  // 4. Agent Registered On-Chain
  if (rpcReachable && contractConfig && config.agentId) {
    try {
      const client = new BastionClient({
        contractId: config.contractId,
        agentId: config.agentId,
        nodeUrl: config.nearRpcUrl,
        chain: config.chain,
      });
      const agentState = await client.getAgent();
      const statusStr = agentState.tripped ? "TRIPPED" : agentState.paused ? "PAUSED" : "ACTIVE";
      checks.push({
        name: "Agent Registration & Policy",
        passed: true,
        details: `Status: ${statusStr}, Derivation: "${agentState.derivation_path}", Spent: ${agentState.spent_last_hour}`,
      });
    } catch (err: any) {
      checks.push({
        name: "Agent Registration & Policy",
        passed: false,
        details: `Agent '${config.agentId}' not registered on contract: ${err.message}`,
        fix: `Run owner contract method register_agent({ agent_account: "${config.agentId}" }).`,
      });
    }
  }

  // 5. Agent Function-Call-Only Key Check
  if (config.agentPrivateKey && config.agentId && rpcReachable) {
    try {
      const keyInfo = await inspectNearKey(config.nearRpcUrl, config.agentId, config.agentPrivateKey);
      if (!keyInfo.valid) {
        checks.push({
          name: "Agent Access Key Permissions",
          passed: false,
          details: keyInfo.error || "Key inspection failed",
          fix: `Verify that AGENT_PRIVATE_KEY belongs to '${config.agentId}'.`,
        });
      } else if (!keyInfo.isFunctionCall) {
        checks.push({
          name: "Agent Access Key Permissions",
          passed: false,
          details: `Public key ${keyInfo.publicKey} has FullAccess!`,
          fix: `SECURITY RISK: Delete this FullAccess key from '${config.agentId}' and add a FunctionCall key restricted to '${config.contractId}'.`,
        });
      } else if (keyInfo.receiverId !== config.contractId) {
        checks.push({
          name: "Agent Access Key Permissions",
          passed: false,
          details: `FunctionCall key receiver is '${keyInfo.receiverId}', expected '${config.contractId}'`,
          fix: `Add a FunctionCall key to '${config.agentId}' targeting receiver '${config.contractId}'.`,
        });
      } else {
        checks.push({
          name: "Agent Access Key Permissions",
          passed: true,
          details: `Restricted FunctionCall key verified: ${keyInfo.publicKey.slice(0, 16)}... -> ${keyInfo.receiverId}`,
        });
      }
    } catch (err: any) {
      checks.push({
        name: "Agent Access Key Permissions",
        passed: false,
        details: err.message,
        fix: "Check agent private key in configuration.",
      });
    }
  } else if (!config.agentPrivateKey) {
    checks.push({
      name: "Agent Access Key Permissions",
      passed: false,
      details: "AGENT_PRIVATE_KEY not configured",
      fix: "Set AGENT_PRIVATE_KEY in .env or bastion.config.json to allow spend execution.",
    });
  }

  // 6. NEAR AI Key & TEE Signer Pinning Match
  if (config.nearAiApiKey) {
    try {
      const liveReport = await fetchSigningAddress({
        apiKey: config.nearAiApiKey,
        model: config.nearAiModel,
      });
      checks.push({
        name: "NEAR AI Cloud API Key",
        passed: true,
        details: `Authenticated with cloud-api.near.ai (Model: ${config.nearAiModel})`,
      });

      if (contractConfig?.provider_tee_signer) {
        const pinned = "0x" + contractConfig.provider_tee_signer.toLowerCase().replace(/^0x/, "");
        const live = (liveReport.address || "").toLowerCase();

        if (pinned === live) {
          checks.push({
            name: "TEE Signer Pinning Match",
            passed: true,
            details: `Contract pinned TEE signer (${pinned}) matches NEAR AI Cloud report`,
          });
        } else {
          checks.push({
            name: "TEE Signer Pinning Match",
            passed: false,
            details: `Mismatch! Pinned: ${pinned}, Reported: ${live}`,
            fix: `Update contract provider_tee_signer to '${live}' via owner set_provider_tee_signer call.`,
          });
        }
      } else {
        checks.push({
          name: "TEE Signer Pinning Match",
          passed: false,
          details: `provider_tee_signer is not pinned on contract '${config.contractId}' (NEAR AI reported: ${liveReport.address})`,
          fix: `Call set_provider_tee_signer({ address: "${liveReport.address}" }) on the contract.`,
        });
      }
    } catch (err: any) {
      checks.push({
        name: "NEAR AI Cloud API Key",
        passed: false,
        details: `Failed to authenticate or query NEAR AI Cloud: ${err.message}`,
        fix: "Verify NEARAI_API_KEY and network access to cloud-api.near.ai.",
      });
      checks.push({
        name: "TEE Signer Pinning Match",
        passed: false,
        details: `Cannot verify live TEE signer without a valid NEARAI_API_KEY`,
        fix: "Fix NEARAI_API_KEY first.",
      });
    }
  } else {
    checks.push({
      name: "NEAR AI Cloud API Key",
      passed: false,
      details: "NEARAI_API_KEY not configured",
      fix: "Set NEARAI_API_KEY from https://cloud.near.ai to verify TEE attestations.",
    });
    checks.push({
      name: "TEE Signer Pinning Match",
      passed: false,
      details: contractConfig?.provider_tee_signer
        ? `Contract pinned: ${contractConfig.provider_tee_signer} (unverified against live NEAR AI Cloud without NEARAI_API_KEY)`
        : "Neither provider_tee_signer nor NEARAI_API_KEY is configured",
      fix: "Set NEARAI_API_KEY to verify the contract's pinned TEE signer against NEAR AI Cloud.",
    });
  }

  // 7. Derived Address & EVM Balances
  if (rpcReachable && contractConfig && config.chain?.rpcUrl) {
    try {
      const client = new BastionClient({
        contractId: config.contractId,
        agentId: config.agentId,
        nodeUrl: config.nearRpcUrl,
        chain: config.chain,
      });

      const eoa = await client.getDerivedAddress();
      const publicClient = createPublicClient({
        transport: http(config.chain.rpcUrl, { timeout: 10000 }),
      });

      const ethBalanceWei = await publicClient.getBalance({ address: eoa });
      const ethBalance = formatEther(ethBalanceWei);

      const tokenBalances: string[] = [];
      for (const tok of config.chain.tokens) {
        try {
          let dec = tok.decimals;
          if (dec === undefined) {
            dec = await getTokenDecimals({
              tokenAddress: tok.address,
              chainId: config.chain.chainId,
              rpcUrl: config.chain.rpcUrl,
            });
          }
          const rawBal = await publicClient.readContract({
            address: tok.address,
            abi: ERC20_BALANCE_ABI,
            functionName: "balanceOf",
            args: [eoa],
          });
          tokenBalances.push(`${formatUnits(rawBal, dec)} ${tok.symbol}`);
        } catch {
          tokenBalances.push(`? ${tok.symbol} (query failed)`);
        }
      }

      const balSummary = `ETH: ${ethBalance}, Tokens: [${tokenBalances.join(", ")}]`;
      const hasEth = ethBalanceWei > 0n;

      checks.push({
        name: "Derived EVM Address & Balances",
        passed: hasEth,
        details: `EOA: ${eoa} | ${balSummary}`,
        fix: hasEth ? undefined : `Fund derived address ${eoa} with testnet ETH on chain ${config.chain.chainId} to pay gas fees.`,
      });
    } catch (err: any) {
      checks.push({
        name: "Derived EVM Address & Balances",
        passed: false,
        details: `Failed to derive address or query balances: ${err.message}`,
        fix: "Check EVM RPC URL and contract signer configuration.",
      });
    }
  }

  printResults(checks);

  const allPassed = checks.every((c) => c.passed);
  return allPassed ? 0 : 1;
}

function printResults(checks: DoctorCheck[]) {
  for (const c of checks) {
    const badge = c.passed ? "[PASS]" : "[FAIL]";
    console.log(`${badge} ${c.name}`);
    console.log(`       ${c.details}`);
    if (!c.passed && c.fix) {
      console.log(`       -> FIX: ${c.fix}`);
    }
    console.log();
  }
}
