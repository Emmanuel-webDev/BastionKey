/**
 * Shared scenario harness for BastionKey live testnet runs.
 *
 * All outcomes printed come strictly from the contract response.
 * Inputs (task, recipient, amount) default from scenarios.json and can be overridden via CLI flags.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address } from "viem";
import { BastionClient } from "@bastionkey/client";
import { usd } from "@bastionkey/relayer";

try { process.loadEnvFile?.(); } catch {}

export interface ScenarioConfig {
  title: string;
  task: string;
  actionLog: string[];
  recipient: Address;
  dollars: number;
  expectedStatus: "APPROVED" | "REJECTED_ON_CHAIN" | "BLOCKED_BY_TEE";
}

const line = (s = "") => console.log(s);

function parseCliArgs(): { task?: string; recipient?: Address; dollars?: number } {
  const args = process.argv.slice(2);
  const result: { task?: string; recipient?: Address; dollars?: number } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--task" && args[i + 1]) {
      result.task = args[++i];
    } else if (args[i] === "--recipient" && args[i + 1]) {
      result.recipient = args[++i] as Address;
    } else if (args[i] === "--dollars" && args[i + 1]) {
      result.dollars = Number(args[++i]);
    }
  }
  return result;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val || val.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}. Set it in .env to run against testnet.`);
  }
  return val.trim();
}

export async function runScenario(scenarioKey: string): Promise<void> {
  const mode = process.env.BASTION_MODE ?? "testnet";
  if (mode !== "testnet") {
    throw new Error(`BASTION_MODE="${mode}" is unsupported. BastionKey runs against testnet.`);
  }

  const configPath = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "scenarios.json");
  const scenariosData = JSON.parse(readFileSync(configPath, "utf8"));
  const defaultScenario: ScenarioConfig = scenariosData[scenarioKey];
  if (!defaultScenario) {
    throw new Error(`Unknown scenario key: ${scenarioKey}. Available: ${Object.keys(scenariosData).join(", ")}`);
  }

  // Allow CLI overrides
  const cli = parseCliArgs();
  const task = cli.task ?? defaultScenario.task;
  const recipient = (cli.recipient ?? defaultScenario.recipient) as Address;
  const dollars = cli.dollars ?? defaultScenario.dollars;
  const actionLog = defaultScenario.actionLog;

  const contractId = requireEnv("BASTION_CONTRACT_ID");
  const agentId = requireEnv("AGENT_ACCOUNT_ID");
  const agentPrivateKey = requireEnv("AGENT_PRIVATE_KEY");
  const apiKey = requireEnv("NEARAI_API_KEY");
  const model = process.env.NEARAI_MODEL ?? "deepseek-ai/DeepSeek-V4.1-Flash-1017";
  const networkId = process.env.NEAR_NETWORK ?? "testnet";
  const nodeUrl = process.env.NEAR_NODE_URL ?? "https://rpc.testnet.near.org";
  const baseSepoliaRpc = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";

  line(`=== BastionKey Scenario: ${defaultScenario.title} ===`);
  line(`mode: LIVE TESTNET | contract=${contractId}`);

  const client = new BastionClient({
    contractId,
    agentId,
    agentPrivateKey,
    nearAiApiKey: apiKey,
    nearAiModel: model,
    networkId,
    nodeUrl,
    baseSepoliaRpc,
  });

  const eoa = await client.getDerivedAddress();
  line(`[INFO] Agent Account : ${agentId}`);
  line(`[INFO] Derived EOA   : ${eoa} on Base Sepolia`);
  line(`[INFO] Task          : ${task}`);
  line(`[INFO] Recipient     : ${recipient} | Amount: $${dollars}.00`);
  actionLog.forEach((l) => line(`[INFO] Agent Log     : ${l}`));

  const result = await client.executeSpend({
    task,
    actionLog,
    recipient,
    dollars,
    broadcast: defaultScenario.expectedStatus === "APPROVED",
    gasLimit: 65_000,
  });

  line();
  line(`--- Contract Execution Response ---`);
  line(`Status : ${result.status}`);
  if (result.code) line(`Code   : ${result.code}`);
  if (result.reason) line(`Reason : ${result.reason}`);
  if (result.nearTxHash) {
    line(`NEAR Tx: https://explorer.testnet.near.org/transactions/${result.nearTxHash}`);
  }

  if (result.status === "APPROVED") {
    line(`EVM Tx : ${result.txHash}`);
    if (result.broadcastHash) {
      line(`Base Tx: https://sepolia.basescan.org/tx/${result.broadcastHash}`);
      if (result.blockNumber) line(`Mined  : Block ${result.blockNumber}`);
    }
  }

  // Fetch telemetry
  try {
    const agentState = await client.getAgent();
    line(`Telemetry: approvals=${agentState.approvals} rejections=${agentState.rejections} spent_last_hour=${usd(agentState.spent_last_hour)} remaining=${usd(agentState.remaining_hourly_budget)}`);
  } catch {
    // telemetry query optional
  }

  // Assertion check
  line();
  if (result.status === defaultScenario.expectedStatus) {
    line(`[ASSERTION PASSED] Contract returned ${result.status}, matching expected assertion (${defaultScenario.expectedStatus}).`);
  } else {
    line(`[ASSERTION FAILED] Expected ${defaultScenario.expectedStatus}, but contract returned ${result.status}.`);
    process.exit(1);
  }
}
