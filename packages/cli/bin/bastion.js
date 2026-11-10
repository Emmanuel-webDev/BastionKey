#!/usr/bin/env node
import { runCli } from "../src/index.js";

try { process.loadEnvFile?.(); } catch {}

runCli().catch((err) => {
  console.error(err);
  process.exit(1);
});
