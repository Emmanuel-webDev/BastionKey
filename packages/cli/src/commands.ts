import { readFileSync, existsSync } from "node:fs";
import { NearOwnerClient } from "./nearOwnerClient.js";
import { validatePolicy, type UserPolicyFile, type OnChainPolicy } from "./policyValidator.js";

const line = (s = "") => console.log(s);

import { loadBastionConfig } from "@bastionkey/client";

function getCliContext() {
  const config = loadBastionConfig();
  const contractId = config.contractId;
  const agentId = config.agentId;
  const nodeUrl = config.nearRpcUrl;
  const networkId = config.networkId;

  if (!contractId || !agentId) {
    throw new Error(
      "Missing contract or agent configuration. Set BASTION_CONTRACT_ID and AGENT_ACCOUNT_ID, or configure bastion.config.json.",
    );
  }

  const client = new NearOwnerClient({ contractId, nodeUrl, networkId, ownerPrivateKey: config.ownerPrivateKey });
  return { contractId, agentId, client, config };
}

export async function cmdStatus(): Promise<void> {
  const { contractId, agentId, client } = getCliContext();
  line(`================================================================================`);
  line(`  BastionKey System Status`);
  line(`================================================================================`);
  line(`Contract ID : ${contractId}`);
  line(`Agent ID    : ${agentId}`);

  try {
    const [cfg, agent] = await Promise.all([
      client.getContractConfig(),
      client.getAgentState(agentId),
    ]);

    line(`Contract Owner  : ${cfg.owner}`);
    line(`MPC Signer      : ${cfg.signer_contract}`);
    line(`Pinned TEE Signer: ${cfg.provider_tee_signer || "NOT PINNED"}`);
    line();

    if (!agent) {
      line(`Agent '${agentId}' is not registered on contract.`);
      return;
    }

    const isFrozen = agent.tripped || agent.paused;
    line(`Agent State     : ${isFrozen ? "FROZEN" : "ACTIVE"}`);
    line(`  Paused        : ${agent.paused}`);
    line(`  Tripped       : ${agent.tripped}`);
    line(`  Derivation Path: "${agent.derivation_path}"`);
    line(`  Approvals     : ${agent.approvals}`);
    line(`  Rejections    : ${agent.rejections}`);
    line(`  Spent (1h)    : ${agent.spent_last_hour}`);
    line(`  Remaining (1h): ${agent.remaining_hourly_budget}`);
    line(`  Calls (last min): ${agent.calls_last_minute} / ${agent.policy.max_calls_per_minute}`);
  } catch (err) {
    line(`Error querying status: ${(err as Error).message}`);
  }
}

export async function cmdPolicyShow(): Promise<void> {
  const { contractId, agentId, client } = getCliContext();
  line(`================================================================================`);
  line(`  On-Chain Policy for '${agentId}' on '${contractId}'`);
  line(`================================================================================`);

  const agent = await client.getAgentState(agentId);
  if (!agent) {
    line(`Agent '${agentId}' not found on contract.`);
    return;
  }

  const p = agent.policy;
  line(`Max Per Tx (base units)     : ${p.max_per_tx}`);
  line(`Hourly Budget (base units)   : ${p.hourly_budget}`);
  line(`Gas Cap (wei)               : ${p.max_gas_cost_wei}`);
  line(`TEE Required Above (base)   : ${p.tee_required_above}`);
  line(`Min TEE Confidence          : ${p.min_confidence_pct}%`);
  line(`Max Calls / Minute          : ${p.max_calls_per_minute}`);
  line(`Allowed Tokens              : ${p.allowed_tokens.join(", ") || "None"}`);
  line(`Allowed Recipients          : ${p.allowed_recipients.length ? p.allowed_recipients.join(", ") : "Open allow-list (TEE mandatory)"}`);
  line(`Allowed Chains              : ${p.allowed_chain_ids.join(", ") || "None"}`);
}

export async function cmdPolicyDiff(filePath: string): Promise<void> {
  const { contractId, agentId, client } = getCliContext();
  line(`Comparing policy file '${filePath}' against on-chain agent '${agentId}'...`);

  if (!existsSync(filePath)) {
    throw new Error(`Policy file not found: '${filePath}'`);
  }

  const fileContent = JSON.parse(readFileSync(filePath, "utf8"));
  const validation = validatePolicy(fileContent);

  if (!validation.valid) {
    line(`\n[VALIDATION FAILED] Policy file has errors:`);
    validation.errors.forEach((e) => line(` - ${e}`));
    process.exit(1);
  }

  const agent = await client.getAgentState(agentId);
  if (!agent) {
    line(`Agent '${agentId}' is not yet registered on-chain.`);
    return;
  }

  const onChain = agent.policy;
  const target = validation.onChainPolicy!;

  line();
  line(`Field                    | Current On-Chain             | Target Policy File`);
  line(`-------------------------+------------------------------+------------------------------`);

  const fields: Array<[string, any, any]> = [
    ["max_per_tx", onChain.max_per_tx, target.max_per_tx],
    ["hourly_budget", onChain.hourly_budget, target.hourly_budget],
    ["max_gas_cost_wei", onChain.max_gas_cost_wei, target.max_gas_cost_wei],
    ["tee_required_above", onChain.tee_required_above, target.tee_required_above],
    ["min_confidence_pct", `${onChain.min_confidence_pct}%`, `${target.min_confidence_pct}%`],
    ["max_calls_per_minute", onChain.max_calls_per_minute, target.max_calls_per_minute],
    ["allowed_tokens", onChain.allowed_tokens.join(","), target.allowed_tokens.join(",")],
    [
      "allowed_recipients",
      onChain.allowed_recipients.length ? onChain.allowed_recipients.join(",") : "Open (0)",
      target.allowed_recipients.length ? target.allowed_recipients.join(",") : "Open (0)",
    ],
    ["allowed_chain_ids", onChain.allowed_chain_ids.join(","), target.allowed_chain_ids.join(",")],
  ];

  for (const [name, curr, tgt] of fields) {
    const match = String(curr).toLowerCase() === String(tgt).toLowerCase();
    const tag = match ? " " : "*";
    line(`${tag} ${name.padEnd(23)} | ${String(curr).padEnd(28)} | ${String(tgt).padEnd(28)}`);
  }

  line();
  line(`* Indicates field changes.`);
}

export async function cmdPolicySet(filePath: string, dryRun: boolean): Promise<void> {
  const { contractId, agentId, client } = getCliContext();

  if (!existsSync(filePath)) {
    throw new Error(`Policy file not found: '${filePath}'`);
  }

  line(`Reading and validating policy file '${filePath}'...`);
  const fileContent = JSON.parse(readFileSync(filePath, "utf8"));
  const validation = validatePolicy(fileContent);

  if (!validation.valid) {
    line(`\n[VALIDATION FAILED] Policy file has errors:`);
    validation.errors.forEach((e) => line(` - ${e}`));
    process.exit(1);
  }

  if (validation.warnings.length > 0) {
    line(`\n[WARNINGS]:`);
    validation.warnings.forEach((w) => line(` - ${w}`));
  }

  const targetPolicy = validation.onChainPolicy!;
  line(`\nValidated Policy Payload (Token Decimals: ${fileContent.token.decimals}):`);
  line(JSON.stringify(targetPolicy, null, 2));

  if (dryRun) {
    line(`\n[DRY RUN COMPLETE] No transaction was sent to NEAR Testnet.`);
    return;
  }

  line(`\nSubmitting update_policy for agent '${agentId}' on '${contractId}'...`);
  const { txHash } = await client.updatePolicy(agentId, targetPolicy);
  line(`[SUCCESS] Policy updated on-chain! Tx Hash: ${txHash || "confirmed"}`);
}

export async function cmdAgentPause(paused: boolean): Promise<void> {
  const { contractId, agentId, client } = getCliContext();
  const action = paused ? "pause" : "resume";
  line(`Submitting ${action} for agent '${agentId}' on '${contractId}'...`);
  const { txHash } = await client.setPaused(agentId, paused);
  line(`[SUCCESS] Agent ${action}d! Tx Hash: ${txHash || "confirmed"}`);
}

export async function cmdBreakerReset(): Promise<void> {
  const { contractId, agentId, client } = getCliContext();
  line(`Submitting reset_breaker for agent '${agentId}' on '${contractId}'...`);
  const { txHash } = await client.resetBreaker(agentId);
  line(`[SUCCESS] Circuit breaker reset on-chain! Tx Hash: ${txHash || "confirmed"}`);
}
