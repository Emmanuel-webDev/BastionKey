import { loadBastionConfig } from "@bastionkey/client";
import { readAuditLog, type AuditLogEntry } from "./auditLog.js";

export function runHistory(rawArgs: string[]): number {
  let limit = 20;
  let jsonOutput = false;
  let configFile: string | undefined;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--limit" && rawArgs[i + 1]) {
      limit = parseInt(rawArgs[++i], 10) || 20;
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--config" && rawArgs[i + 1]) {
      configFile = rawArgs[++i];
    }
  }

  const config = loadBastionConfig(configFile);
  const entries = readAuditLog(config.auditLogPath, limit);

  if (jsonOutput) {
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }

  console.log(`================================================================================`);
  console.log(`  BastionKey Local Audit Log (${entries.length} recent entries)`);
  console.log(`  Path: ${config.auditLogPath}`);
  console.log(`================================================================================`);

  if (entries.length === 0) {
    console.log("No transactions recorded yet.");
    return 0;
  }

  for (const entry of entries) {
    const statusColor =
      entry.status === "APPROVED"
        ? "[APPROVED]"
        : entry.status === "BLOCKED_BY_TEE"
        ? "[BLOCKED_BY_TEE]"
        : entry.status === "FROZEN"
        ? "[FROZEN]"
        : `[${entry.status}]`;

    console.log(`${entry.timestamp} | ${entry.requestId || "no-id"} | ${statusColor}`);
    console.log(`  Task      : ${entry.task}`);
    console.log(`  Transfer  : ${entry.amountHuman} ${entry.tokenSymbol} -> ${entry.recipient}`);
    if (entry.code) {
      console.log(`  Result    : ${entry.code} - ${entry.reason || "No reason given"}`);
    }
    if (entry.nearTxHash) {
      console.log(`  NEAR Tx   : ${entry.nearTxHash}`);
    }
    if (entry.baseTxHash) {
      console.log(`  Base Tx   : ${entry.baseTxHash}`);
    }
    console.log("--------------------------------------------------------------------------------");
  }

  return 0;
}
