import { runScenario } from "./lib/harness.js";

runScenario("overbudget").catch((err) => {
  console.error("Scenario execution error:", err);
  process.exit(1);
});
