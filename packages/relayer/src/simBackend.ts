/**
 * Talks to the native simulator (packages/near-contract/examples/sim.rs), which runs the real
 * BastionKey contract code under near-sdk's mock VM. See that file for what it is and is not.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { BastionTx } from "./evmTx.js";

const here = dirname(fileURLToPath(import.meta.url));
const contractDir = join(here, "..", "..", "near-contract");
const simBin = join(contractDir, "target", "debug", "examples", "sim");

export interface PolicyJson {
  max_per_tx: string;
  hourly_budget: string;
  max_gas_cost_wei: string;
  allowed_tokens: string[];
  allowed_recipients: string[];
  allowed_chain_ids: number[];
  tee_required_above: string;
  min_confidence_pct: number;
  max_calls_per_minute: number;
}

export interface TeeAttestationJson {
  kind: string;
  model_id: string | null;
  /** base64 of the exact request body bytes */
  request: string;
  /** base64 of the exact response body bytes */
  response: string;
  signature: string;
}

export interface SignOutcomeJson {
  status: "APPROVED" | "REJECTED" | "FROZEN" | "SIGN_FAILED";
  code: string | null;
  reason: string | null;
  digest: string | null;
  signature: unknown;
}

export type CallResult =
  | { kind: "value"; outcome: SignOutcomeJson }
  | { kind: "promise"; receiver: string; method: string; args: any; deposit_yocto: string };

export class SimBackend {
  private pending: Array<(v: any) => void> = [];

  private constructor(private proc: ChildProcessWithoutNullStreams) {
    createInterface({ input: proc.stdout }).on("line", (line) => this.pending.shift()?.(JSON.parse(line)));
  }

  static start(): SimBackend {
    if (!existsSync(simBin)) {
      const r = spawnSync("cargo", ["build", "--quiet", "--example", "sim"], { cwd: contractDir, stdio: "inherit" });
      if (r.status !== 0) throw new Error("failed to build the contract simulator (is the Rust toolchain installed?)");
    }
    // the mock VM prints contract logs to stderr; they are noise for the demos
    return new SimBackend(spawn(simBin, [], { stdio: ["pipe", "pipe", "ignore"] }));
  }

  private send<T = any>(req: object): Promise<T> {
    return new Promise((resolve, reject) => {
      this.pending.push((v) => (v?.error ? reject(new Error(v.error)) : resolve(v)));
      this.proc.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  init(owner: string, signer: string) {
    return this.send({ op: "init", owner, signer });
  }
  setTeeSigner(address: string) {
    return this.send({ op: "set_signer", address });
  }
  registerAgent(agent: string, path: string, policy: PolicyJson) {
    return this.send({ op: "register", agent, path, policy });
  }
  resetBreaker(agent: string) {
    return this.send({ op: "reset_breaker", agent });
  }
  call(agent: string, ts: number, tx: BastionTx, tee: TeeAttestationJson | null): Promise<CallResult> {
    return this.send({ op: "call", agent, ts, tx, tee });
  }
  async view(agent: string, ts: number): Promise<any> {
    return this.send({ op: "view", agent, ts });
  }
  async previewDigest(tx: BastionTx): Promise<string> {
    return (await this.send<{ digest: string }>({ op: "preview", tx })).digest;
  }
  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}
