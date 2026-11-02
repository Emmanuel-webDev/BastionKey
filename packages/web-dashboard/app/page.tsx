import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const dynamic = "force-dynamic";

type Ev = { kind: string; [k: string]: any };
type Run = { scenario: { name: string; title: string; task: string; actionLog: string[] }; result: string; events: Ev[] };

const COLORS: Record<string, string> = { APPROVED: "#3fb950", REJECTED_ON_CHAIN: "#f85149", BLOCKED_BY_TEE: "#d29922", ERROR: "#f85149" };
const usd = (v: string | number) => `$${(Number(v) / 1e6).toFixed(2)}`;

function load(): Run[] {
  const dir = join(process.cwd(), "..", "..", "demo-output");
  return ["valid", "overbudget", "injected"]
    .map((n) => join(dir, `${n}.json`))
    .filter(existsSync)
    .map((p) => JSON.parse(readFileSync(p, "utf8")) as Run);
}

function steps(run: Run): Array<[string, string]> {
  const e = (k: string) => run.events.find((x) => x.kind === k);
  const out: Array<[string, string]> = [];
  const p = e("proposed");
  const v = e("verdict");
  const c = e("contract_result");
  const s = e("signed");
  if (p) out.push(["1 agent proposes", `transfer ${usd(p.amount)} USDC -> ${p.recipient}`]);
  if (p) out.push(["2 tx digest", p.digest]);
  if (v) out.push(["3 TEE verdict", `aligned=${v.is_aligned} confidence=${v.confidence_pct}% (${v.reason})`]);
  if (c) out.push(["4 policy contract", c.kind === "promise" ? "PASS -> cross-contract call to MPC signer" : `${c.outcome.status} ${c.outcome.code}: ${c.outcome.reason}`]);
  if (s) out.push(["5 MPC signature", `signed tx ${s.txHash}`]);
  return out;
}

export default function Page() {
  const runs = load();
  const first = runs[0]?.events.find((x) => x.kind === "setup");
  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "32px 20px" }}>
      <h1 style={{ margin: 0 }}>BastionKey Command Center</h1>
      <p style={{ color: "#8b98a5" }}>
        Replay of the three demo runs. Contract = real BastionKey code under a mock VM; MPC signer and verifier are local
        stand-ins unless noted.
      </p>
      {first && (
        <section style={{ border: "1px solid #223", padding: 12, marginBottom: 24 }}>
          <div>agent: {first.agent}</div>
          <div>derived EOA (Base Sepolia): {first.eoa}</div>
          <div>max_per_tx: {usd(first.policy.max_per_tx)} · hourly budget: {usd(first.policy.hourly_budget)}</div>
        </section>
      )}
      {runs.length === 0 && (
        <p>
          No runs yet. In the repo root run <code>npm run demo:all</code>, then refresh.
        </p>
      )}
      {runs.map((r) => (
        <section key={r.scenario.name} style={{ border: `1px solid ${COLORS[r.result] ?? "#555"}`, padding: 16, marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <strong>{r.scenario.title}</strong>
            <span style={{ color: COLORS[r.result] ?? "#fff", fontWeight: 700 }}>{r.result}</span>
          </div>
          <div style={{ color: "#8b98a5", margin: "8px 0" }}>task: {r.scenario.task}</div>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {steps(r).map(([k, v]) => `${k.padEnd(20)} ${v}`).join("\n")}
          </pre>
        </section>
      ))}
    </main>
  );
}
