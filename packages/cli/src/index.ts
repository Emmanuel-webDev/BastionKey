import {
  cmdStatus,
  cmdPolicyShow,
  cmdPolicySet,
  cmdPolicyDiff,
  cmdAgentPause,
  cmdBreakerReset,
} from "./commands.js";
import { runPay } from "./payCommand.js";
import { runHistory } from "./historyCommand.js";

export { validatePolicy, type UserPolicyFile, type OnChainPolicy } from "./policyValidator.js";
export { NearOwnerClient } from "./nearOwnerClient.js";
export { runPay } from "./payCommand.js";
export { runHistory } from "./historyCommand.js";

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [subcommand, action, ...rest] = argv;

  try {
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      printHelp();
      return;
    }

    if (subcommand === "status") {
      await cmdStatus();
      return;
    }

    if (subcommand === "pay") {
      const exitCode = await runPay(argv.slice(1));
      process.exit(exitCode);
    }

    if (subcommand === "history") {
      const exitCode = runHistory(argv.slice(1));
      process.exit(exitCode);
    }

    if (subcommand === "doctor") {
      const { runDoctor } = await import("./doctorCommand.js");
      const exitCode = await runDoctor(argv.slice(1));
      process.exit(exitCode);
    }

    if (subcommand === "serve") {
      const { runServe } = await import("./serveCommand.js");
      await runServe(argv.slice(1));
      return;
    }

    if (subcommand === "policy") {
      if (action === "show") {
        await cmdPolicyShow();
        return;
      }
      if (action === "set") {
        let filePath = "";
        let dryRun = false;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--file" && rest[i + 1]) {
            filePath = rest[++i];
          } else if (rest[i] === "--dry-run") {
            dryRun = true;
          } else if (!rest[i].startsWith("-") && !filePath) {
            filePath = rest[i];
          }
        }
        if (!filePath) {
          throw new Error("Usage: bastion policy set [--file] <path_to_policy.json> [--dry-run]");
        }
        await cmdPolicySet(filePath, dryRun);
        return;
      }
      if (action === "diff") {
        let filePath = "";
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--file" && rest[i + 1]) {
            filePath = rest[++i];
          } else if (!rest[i].startsWith("-") && !filePath) {
            filePath = rest[i];
          }
        }
        if (!filePath) {
          throw new Error("Usage: bastion policy diff [--file] <path_to_policy.json>");
        }
        await cmdPolicyDiff(filePath);
        return;
      }
      throw new Error(`Unknown policy action: '${action}'. Supported: show, set, diff.`);
    }

    if (subcommand === "agent") {
      if (action === "pause") {
        await cmdAgentPause(true);
        return;
      }
      if (action === "resume") {
        await cmdAgentPause(false);
        return;
      }
      throw new Error(`Unknown agent action: '${action}'. Supported: pause, resume.`);
    }

    if (subcommand === "breaker") {
      if (action === "reset") {
        await cmdBreakerReset();
        return;
      }
      throw new Error(`Unknown breaker action: '${action}'. Supported: reset.`);
    }

    throw new Error(`Unknown command: '${subcommand}'. Run 'bastion --help' for available commands.`);
  } catch (err: any) {
    console.error(`\n[ERROR] ${err.message}`);
    process.exit(2);
  }
}

function printHelp() {
  console.log(`
BastionKey Agent & Policy CLI ("bastion")

Agent Spend Execution:
  bastion pay [flags]                      Execute an authorized spend through BastionKey pipeline
    Flags:
      --task <text>                        Human / Application trusted task instruction (REQUIRED)
      --task-file <path>                   Read task instruction from file
      --to <address>                       Recipient EVM address (REQUIRED)
      --amount <number>                    Human units amount, e.g. 5.25 (REQUIRED)
      --token <symbol|address>             Token symbol or address (default: configured default token)
      --log-file <path>                    Optional action log file
      --no-broadcast                       Simulate signing without broadcasting raw EVM transaction
      --broadcast                          Broadcast signed transaction if approved (default)
      --config <path>                      Custom config file path (default: bastion.config.json)
    Note: Stdin JSON with {"task": "...", "to": "...", "amount": ...} is also accepted.

Audit History:
  bastion history [--limit <n>] [--json]   Inspect local JSONL audit trail of past operations

Operator Management:
  bastion status                           Display on-chain contract and agent metrics
  bastion policy show                      Inspect current agent policy on NEAR Testnet
  bastion policy set --file <path>         Update agent policy on-chain from a JSON file
  bastion policy set --file <p> --dry-run  Validate and preview policy payload without sending tx
  bastion policy diff --file <path>        Compare a local policy file against current on-chain rules
  bastion agent pause                      Pause the agent (halts all spend signature requests)
  bastion agent resume                     Resume a paused agent
  bastion breaker reset                    Reset a tripped velocity circuit breaker

Configuration:
  Set BASTION_CONTRACT_ID, AGENT_ACCOUNT_ID, AGENT_PRIVATE_KEY or configure bastion.config.json.
`);
}
