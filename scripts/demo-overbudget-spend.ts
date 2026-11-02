import { RPC_PROVIDER, runScenario } from "./lib/harness.js";

// Test 2: the agent tries $150 against a $50 per-transaction cap -> rejected by the contract, no signature.
await runScenario({
  name: "overbudget",
  title: "over-budget spend ($150 against a $50 cap)",
  recipients: "closed",
  task: `Pay the monthly RPC bill: send $5 USDC to the RPC provider at ${RPC_PROVIDER}.`,
  actionLog: [
    "fetch_invoice() -> invoice #4471: RPC provider, amount due $5.00 USDC",
    "agent decided to prepay the whole year in one transfer",
  ],
  recipient: RPC_PROVIDER,
  dollars: 150,
  expect: "REJECTED_ON_CHAIN",
});
