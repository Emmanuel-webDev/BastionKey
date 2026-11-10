import { BastionClient } from "@bastionkey/client";

try { process.loadEnvFile?.(); } catch {}

const client = new BastionClient({
  contractId: process.env.BASTION_CONTRACT_ID!,
  agentId: process.env.AGENT_ACCOUNT_ID!,
  agentPrivateKey: process.env.AGENT_PRIVATE_KEY!,
  nearAiApiKey: process.env.NEARAI_API_KEY!,
});

const result = await client.executeSpend({
  task: "Pay $5 USDC for indexing query subscription",
  recipient: "0x1111111111111111111111111111111111111111",
  dollars: 5,
  broadcast: true,
});

console.log(`Outcome: ${result.status} | TxHash: ${result.broadcastHash ?? result.txHash}`);
