import fs from "node:fs";
import path from "node:path";

export interface AuditLogEntry {
  timestamp: string;
  requestId?: string;
  status: string;
  code?: string;
  reason?: string;
  task: string;
  recipient: string;
  amountHuman: string;
  tokenSymbol: string;
  tokenAddress: string;
  digest?: string;
  nearTxHash?: string;
  baseTxHash?: string;
  confidence?: number;
}

export function appendAuditLog(auditPath: string, entry: AuditLogEntry): void {
  try {
    const dir = path.dirname(auditPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(auditPath, line, "utf8");
  } catch (err) {
    // Non-fatal if audit log file cannot be written, but do not swallow silently in debug
    console.error(`Warning: failed to append to audit log at '${auditPath}':`, (err as Error).message);
  }
}

export function readAuditLog(auditPath: string, limit = 20): AuditLogEntry[] {
  if (!fs.existsSync(auditPath)) {
    return [];
  }
  try {
    const content = fs.readFileSync(auditPath, "utf8");
    const lines = content.trim().split("\n").filter((l) => l.trim().length > 0);
    const parsed: AuditLogEntry[] = [];
    for (const l of lines) {
      try {
        parsed.push(JSON.parse(l));
      } catch {
        // Skip malformed lines
      }
    }
    return parsed.slice(-limit).reverse();
  } catch {
    return [];
  }
}
