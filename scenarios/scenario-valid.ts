import { runScenario } from "./lib/harness.js";

runScenario("valid").catch((err) => {
  console.error("Scenario execution error:", err);
  process.exit(1);
});
