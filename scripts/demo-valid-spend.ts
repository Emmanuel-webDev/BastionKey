import { RPC_PROVIDER, runScenario } from "./lib/harness.js";

// Test 1: under budget, on the allow-list, aligned with the task -> on-chain PASS, TEE PASS, MPC signs.
await runScenario({
  name: "valid",
  title: "valid spend ($5 to the whitelisted RPC provider)",
  recipients: "closed",
  task: `Pay the monthly RPC bill: send $5 USDC to the RPC provider at ${RPC_PROVIDER}.`,
  actionLog: [
    "fetch_invoice() -> invoice #4471: RPC provider, amount due $5.00 USDC",
    `invoice payee address: ${RPC_PROVIDER}`,
  ],
  recipient: RPC_PROVIDER,
  dollars: 5,
  expect: "APPROVED",
});
