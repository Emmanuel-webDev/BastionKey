"use client";

import React, { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";

interface ContractConfig {
  owner: string;
  signer_contract: string;
  provider_tee_signer: string | null;
  gateway_signer: string | null;
  sign_format: string;
  sign_deposit: string;
  sign_gas_tgas: number;
}

interface AgentPolicy {
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

interface AgentView {
  policy: AgentPolicy;
  derivation_path: string;
  paused: boolean;
  tripped: boolean;
  rejections: number;
  approvals: number;
  spent_last_hour: string;
  remaining_hourly_budget: string;
  calls_last_minute: number;
}

interface IndexerTx {
  txHash: string;
  signerId: string;
  blockTimestamp: string;
  methodName: string;
}

const DEFAULT_CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID || "bastion-guard.testnet";
const DEFAULT_AGENT_ID = process.env.NEXT_PUBLIC_AGENT_ID || "agent-1.bastion-guard.testnet";
const DEFAULT_NETWORK = process.env.NEXT_PUBLIC_NEAR_NETWORK || "testnet";
const DEFAULT_RPC_URL = process.env.NEXT_PUBLIC_NEAR_RPC_URL || "https://rpc.testnet.near.org";
const DERIVED_EOA_CONFIG = process.env.NEXT_PUBLIC_DERIVED_EOA || "";
const INDEXER_API_URL = process.env.NEXT_PUBLIC_INDEXER_API_URL || "";

const TESTNET_FALLBACK_RPCS = [
  "https://rpc.testnet.near.org",
  "https://testnet.rpc.fastnear.com",
  "https://archival-rpc.testnet.fastnear.com",
];

const MAINNET_FALLBACK_RPCS = [
  "https://rpc.mainnet.near.org",
  "https://free.rpc.fastnear.com",
];

async function queryNearRpc<T>(
  customRpcUrl: string,
  network: string,
  contract: string,
  methodName: string,
  args: Record<string, unknown>,
): Promise<T> {
  const fallbackEndpoints =
    network === "mainnet" ? MAINNET_FALLBACK_RPCS : TESTNET_FALLBACK_RPCS;
  const endpoints = Array.from(
    new Set([customRpcUrl, ...fallbackEndpoints].filter((u) => u && u.trim() !== ""))
  );

  const errors: string[] = [];

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "bastion-view",
          method: "query",
          params: {
            request_type: "call_function",
            finality: "final",
            account_id: contract,
            method_name: methodName,
            args_base64: btoa(JSON.stringify(args)),
          },
        }),
        cache: "no-store",
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error.data || data.error.message || "RPC error response");

      if (data.result?.result) {
        const decoded = new TextDecoder().decode(new Uint8Array(data.result.result));
        return JSON.parse(decoded) as T;
      }
      throw new Error("Invalid response format");
    } catch (err: any) {
      errors.push(`${endpoint}: ${err?.message || String(err)}`);
    }
  }

  throw new Error(
    `All NEAR RPC endpoints failed (${endpoints.length} attempted):\n` +
      errors.map((e) => `• ${e}`).join("\n")
  );
}

function fmtUsd(baseUnits: string | number | undefined): string {
  if (baseUnits === undefined || baseUnits === null) return "no data";
  const num = Number(baseUnits) / 1_000_000;
  return isNaN(num) ? "no data" : `$${num.toFixed(2)}`;
}

const CAROUSEL_SLIDES = [
  {
    tag: "01 / KEYLESS PRINCIPLE",
    text: "The agent never holds a key. Spending rules and a TEE check decide every signature.",
  },
  {
    tag: "02 / HARD RULES FIRST",
    text: "On-chain contract bounds every parameter: max-per-tx cap, hourly budget, and token allow-lists.",
  },
  {
    tag: "03 / TEE & MPC PIPELINE",
    text: "The model signs a verdict and the contract verifies the signature against the pinned address before NEAR MPC signs.",
  },
];

function CommandCenterBento() {
  const searchParams = useSearchParams();

  const [contractId, setContractId] = useState<string>(DEFAULT_CONTRACT_ID);
  const [agentId, setAgentId] = useState<string>(DEFAULT_AGENT_ID);
  const [network, setNetwork] = useState<string>(DEFAULT_NETWORK);
  const [rpcUrl, setRpcUrl] = useState<string>(DEFAULT_RPC_URL);
  const [inputContract, setInputContract] = useState<string>(DEFAULT_CONTRACT_ID);
  const [inputAgent, setInputAgent] = useState<string>(DEFAULT_AGENT_ID);
  const [inputNetwork, setInputNetwork] = useState<string>(DEFAULT_NETWORK);
  const [inputRpcUrl, setInputRpcUrl] = useState<string>(DEFAULT_RPC_URL);

  const [config, setConfig] = useState<ContractConfig | null>(null);
  const [agent, setAgent] = useState<AgentView | null>(null);
  const [indexerTxns, setIndexerTxns] = useState<IndexerTx[]>([]);
  const [indexerAvailable, setIndexerAvailable] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(10);
  const [slideIdx, setSlideIdx] = useState(0);

  // Sync with URL search params (overriding NEXT_PUBLIC_* defaults)
  useEffect(() => {
    const qContract = searchParams.get("contract");
    const qAgent = searchParams.get("agent");
    const qNetwork = searchParams.get("network");
    const qRpc = searchParams.get("rpc");
    if (qContract) {
      setContractId(qContract);
      setInputContract(qContract);
    }
    if (qAgent) {
      setAgentId(qAgent);
      setInputAgent(qAgent);
    }
    if (qNetwork) {
      setNetwork(qNetwork);
      setInputNetwork(qNetwork);
    }
    if (qRpc) {
      setRpcUrl(qRpc);
      setInputRpcUrl(qRpc);
    }
  }, [searchParams]);

  const fetchOnChainData = useCallback(async () => {
    if (!contractId || !agentId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [fetchedConfig, fetchedAgent] = await Promise.all([
        queryNearRpc<ContractConfig>(rpcUrl, network, contractId, "get_config", {}),
        queryNearRpc<AgentView>(rpcUrl, network, contractId, "get_agent", { agent_account: agentId }),
      ]);
      setConfig(fetchedConfig);
      setAgent(fetchedAgent);
      setRpcError(null);

      // Attempt indexer fetch only if configured
      if (INDEXER_API_URL) {
        try {
          const idxRes = await fetch(`${INDEXER_API_URL}/account/${contractId}/txns`, { cache: "no-store" });
          if (idxRes.ok) {
            const idxData = await idxRes.json();
            if (Array.isArray(idxData)) {
              setIndexerTxns(idxData.slice(0, 5));
              setIndexerAvailable(true);
            }
          }
        } catch {
          setIndexerAvailable(false);
        }
      } else {
        setIndexerAvailable(false);
      }
    } catch (err) {
      console.warn("RPC fetch failed:", err);
      setRpcError((err as Error).message || "RPC query failed");
    } finally {
      setLoading(false);
      setCountdown(10);
    }
  }, [contractId, agentId, network, rpcUrl]);

  // Initial load
  useEffect(() => {
    fetchOnChainData();
  }, [fetchOnChainData]);

  // 10-second auto-refresh ticker
  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          fetchOnChainData();
          return 10;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [fetchOnChainData]);

  // Carousel slide timer
  useEffect(() => {
    const slideTimer = setInterval(() => {
      setSlideIdx((prev) => (prev + 1) % CAROUSEL_SLIDES.length);
    }, 7000);
    return () => clearInterval(slideTimer);
  }, []);

  const isFrozen = agent ? agent.tripped || agent.paused : false;
  const statusLabel = isFrozen ? "FROZEN" : "ACTIVE";
  const explorerHost = network === "mainnet" ? "explorer.near.org" : "explorer.testnet.near.org";

  // Calculations from live RPC
  const spentNum = agent ? Number(agent.spent_last_hour) / 1_000_000 : 0;
  const budgetNum = agent ? Number(agent.policy.hourly_budget) / 1_000_000 : 1;
  const remainingNum = agent ? Number(agent.remaining_hourly_budget) / 1_000_000 : 0;
  const maxPerTxNum = agent ? Number(agent.policy.max_per_tx) / 1_000_000 : 0;

  const budgetSharePct: number | null =
    agent && budgetNum > 0 ? Math.min(100, Math.max(0, Math.round((spentNum / budgetNum) * 100))) : null;

  const totalAttempts = agent ? agent.approvals + agent.rejections : null;
  const teeSigner = config?.provider_tee_signer || null;
  const derivedEoa = DERIVED_EOA_CONFIG || (agent ? `path: "${agent.derivation_path}"` : null);

  // SVG Ring calculation: Radius 38, Circumference = 2 * PI * 38 ≈ 238.76
  const ringRadius = 38;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringDashoffset = ringCircumference - ((budgetSharePct ?? 0) / 100) * ringCircumference;

  // Dynamic bar chart calculation from live values
  const maxChartVal = Math.max(budgetNum, spentNum + remainingNum, maxPerTxNum, 1);
  const spentBarHeight = Math.max(4, Math.round((spentNum / maxChartVal) * 55));
  const remainingBarHeight = Math.max(4, Math.round((remainingNum / maxChartVal) * 55));
  const maxCapBarHeight = Math.max(4, Math.round((maxPerTxNum / maxChartVal) * 55));

  return (
    <div className="bento-container">
      {/* Top Ticker Bar */}
      <header className="ticker-bar">
        <div className="ticker-item">
          <span className="ticker-label">NETWORK</span>
          <span className="ticker-value">{network}</span>
        </div>
        <span className="ticker-sep">|</span>

        <div className="ticker-item">
          <span className="ticker-label">CONTRACT</span>
          <a
            href={`https://${explorerHost}/accounts/${contractId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ticker-link"
          >
            {contractId}
          </a>
        </div>
        <span className="ticker-sep">|</span>

        <div className="ticker-item">
          <span className="ticker-label">AGENT</span>
          <a
            href={`https://${explorerHost}/accounts/${agentId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ticker-link"
          >
            {agentId}
          </a>
        </div>
        <span className="ticker-sep">|</span>

        <div className="ticker-item">
          <span className="ticker-label">TEE SIGNER</span>
          <span className="ticker-value" title={teeSigner || "Not pinned"}>
            {teeSigner ? `${teeSigner.slice(0, 6)}...${teeSigner.slice(-4)}` : "NOT PINNED"}
          </span>
        </div>
        <span className="ticker-sep">|</span>

        <div className="ticker-item">
          <span className="ticker-label">DERIVED EOA</span>
          {DERIVED_EOA_CONFIG ? (
            <a
              href={`https://sepolia.basescan.org/address/${DERIVED_EOA_CONFIG}`}
              target="_blank"
              rel="noopener noreferrer"
              className="ticker-link"
              title={DERIVED_EOA_CONFIG}
            >
              {DERIVED_EOA_CONFIG.slice(0, 6)}...{DERIVED_EOA_CONFIG.slice(-4)}
            </a>
          ) : (
            <span className="ticker-value">{derivedEoa || "DERIVING..."}</span>
          )}
        </div>
        <span className="ticker-sep">|</span>

        <div className="ticker-item">
          <span className="ticker-label">STATUS</span>
          <span className={isFrozen ? "status-tag frozen" : "status-tag active"}>
            {loading ? "SYNCING..." : statusLabel}
          </span>
        </div>

        <div className="ticker-refresh">
          <span className="ticker-sync">AUTO-SYNC IN {countdown}S</span>
          <button onClick={fetchOnChainData} className="ticker-btn" title="Refresh on-chain data now">
            ↻
          </button>
        </div>
      </header>

      {/* Target Deployment Controls */}
      <form
        className="deployment-bar"
        onSubmit={(e) => {
          e.preventDefault();
          const c = inputContract.trim();
          const a = inputAgent.trim();
          const n = inputNetwork.trim() || "testnet";
          const r = inputRpcUrl.trim() || (n === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org");
          setContractId(c);
          setAgentId(a);
          setNetwork(n);
          setRpcUrl(r);
          if (typeof window !== "undefined") {
            const url = new URL(window.location.href);
            url.searchParams.set("contract", c);
            url.searchParams.set("agent", a);
            url.searchParams.set("network", n);
            url.searchParams.set("rpc", r);
            window.history.replaceState({}, "", url.toString());
          }
        }}
      >
        <div className="deployment-field">
          <label className="deployment-label">Policy Contract ID</label>
          <input
            className="deployment-input"
            value={inputContract}
            onChange={(e) => setInputContract(e.target.value)}
            placeholder="e.g. your-contract.testnet"
          />
        </div>
        <div className="deployment-field">
          <label className="deployment-label">Agent Account ID</label>
          <input
            className="deployment-input"
            value={inputAgent}
            onChange={(e) => setInputAgent(e.target.value)}
            placeholder="e.g. your-agent.testnet"
          />
        </div>
        <div className="deployment-field" style={{ maxWidth: 140 }}>
          <label className="deployment-label">Network</label>
          <input
            className="deployment-input"
            value={inputNetwork}
            onChange={(e) => setInputNetwork(e.target.value)}
            placeholder="testnet"
          />
        </div>
        <div className="deployment-field">
          <label className="deployment-label">NEAR RPC URL</label>
          <input
            className="deployment-input"
            value={inputRpcUrl}
            onChange={(e) => setInputRpcUrl(e.target.value)}
            placeholder="https://rpc.testnet.near.org"
          />
        </div>
        <button type="submit" className="deployment-btn">
          Inspect Deployment
        </button>
      </form>

      {/* Target Deployment Notice if RPC error */}
      {rpcError && (
        <div className="deployment-error-card">
          <div className="deployment-error-title">Target Deployment Notice</div>
          <div>Could not query NEAR contract &apos;{contractId}&apos; or agent &apos;{agentId}&apos;:</div>
          <div style={{ marginTop: 6, fontFamily: "monospace", fontSize: "0.8rem", color: "#f87171" }}>
            {rpcError}
          </div>
          <div style={{ marginTop: 8, fontSize: "0.75rem", color: "#8a8d93" }}>
            Ensure the contract is deployed on NEAR Testnet and agent account is registered. You can enter any contract or agent above.
          </div>
        </div>
      )}

      {/* Visible RPC Error Banner (never a blank page) */}
      {rpcError && (
        <div className="error-tile">
          <div className="error-title">⚠️ RPC VIEW CALL WARNING</div>
          <div className="error-desc">
            {rpcError}. Displaying cached snapshot from testnet. Retrying in {countdown}s...
          </div>
          <button onClick={fetchOnChainData} className="error-btn">
            RETRY NOW
          </button>
        </div>
      )}

      {/* Bento Grid */}
      <main className="bento-grid">
        {/* TILE 1: Blue Tile "SPENT THIS HOUR" */}
        <div className="tile tile-blue tile-col-1">
          <div className="tile-header">
            <span className="tile-label label-white">SPENT THIS HOUR</span>
            <span className="tile-badge badge-blue-dark">LIVE RPC</span>
          </div>
          <div className="tile-hero num-hero">
            {loading ? "..." : agent ? fmtUsd(agent.spent_last_hour) : "no data"}
          </div>
          <div className="tile-sub sub-white">
            / {loading ? "$100.00" : agent ? fmtUsd(agent.policy.hourly_budget) : "$100.00"} CAP
          </div>
        </div>

        {/* TILE 2: Small Tile "APPROVED" */}
        <div className="tile tile-col-1">
          <div className="tile-header">
            <span className="tile-label">APPROVED</span>
            <span className="dot dot-green" />
          </div>
          <div className="tile-hero num-hero text-green">
            {loading ? "..." : agent?.approvals !== undefined ? agent.approvals : "no data"}
          </div>
          <div className="tile-sub">
            / {loading ? "..." : totalAttempts !== null ? `${totalAttempts} TOTAL ATTEMPTS` : "no data"}
          </div>
        </div>

        {/* TILE 3: Small Tile "REJECTED" */}
        <div className="tile tile-col-1">
          <div className="tile-header">
            <span className="tile-label">REJECTED</span>
            <span className="dot dot-red" />
          </div>
          <div className="tile-hero num-hero text-red">
            {loading ? "..." : agent?.rejections !== undefined ? agent.rejections : "no data"}
          </div>
          <div className="tile-sub">POLICY & TEE BLOCKS</div>
        </div>

        {/* TILE 4: Tile "MAX PER TX" */}
        <div className="tile tile-col-1">
          <div className="tile-header">
            <span className="tile-label">MAX PER TX</span>
            <span className="tile-tag-small">HARD CAP</span>
          </div>
          <div className="tile-hero num-hero">
            {loading ? "..." : agent ? fmtUsd(agent.policy.max_per_tx) : "no data"}
          </div>
          <div className="tile-divider" />
          <div className="tile-sub-metric">
            <span className="sub-metric-label">HOURLY BUDGET</span>
            <span className="sub-metric-val">
              {loading ? "..." : agent ? fmtUsd(agent.policy.hourly_budget) : "no data"}
            </span>
          </div>
        </div>

        {/* TILE 5: Large Tile "BUDGET REMAINING" + Live Telemetry Chart */}
        <div className="tile tile-col-2">
          <div className="tile-header">
            <div>
              <span className="tile-label">BUDGET REMAINING</span>
              <div className="tile-hero num-hero text-accent">
                {loading ? "..." : agent ? fmtUsd(agent.remaining_hourly_budget) : "no data"}
              </div>
            </div>
            <div className="barchart-legend">
              <span className="legend-tag">LIVE TELEMETRY</span>
            </div>
          </div>

          {/* SVG Bar Chart Computed from Live On-Chain Values */}
          <div className="chart-wrapper">
            <svg viewBox="0 0 460 90" className="bar-chart-svg" preserveAspectRatio="none">
              {/* Baseline grid */}
              <line x1="0" y1="70" x2="460" y2="70" stroke="#22242a" strokeWidth="1" />

              {/* Bar 1: Spent This Hour */}
              <g className="chart-group">
                <rect
                  x="35"
                  y={70 - spentBarHeight}
                  width="90"
                  height={spentBarHeight}
                  fill="#55688f"
                  rx="1"
                />
                <text x="80" y={Math.max(12, 65 - spentBarHeight)} textAnchor="middle" fill="#e8e8e3" fontSize="10" fontFamily="inherit">
                  {loading ? "..." : fmtUsd(agent?.spent_last_hour)}
                </text>
                <text x="80" y="84" textAnchor="middle" fill="#8a8d93" fontSize="9" fontFamily="inherit">
                  SPENT (1H)
                </text>
              </g>

              {/* Bar 2: Remaining Hourly Budget */}
              <g className="chart-group">
                <rect
                  x="185"
                  y={70 - remainingBarHeight}
                  width="90"
                  height={remainingBarHeight}
                  fill="#23272e"
                  stroke="#3fb950"
                  strokeWidth="1"
                  rx="1"
                />
                <text x="230" y={Math.max(12, 65 - remainingBarHeight)} textAnchor="middle" fill="#3fb950" fontSize="10" fontFamily="inherit">
                  {loading ? "..." : fmtUsd(agent?.remaining_hourly_budget)}
                </text>
                <text x="230" y="84" textAnchor="middle" fill="#8a8d93" fontSize="9" fontFamily="inherit">
                  REMAINING
                </text>
              </g>

              {/* Bar 3: Max Per-Tx Cap */}
              <g className="chart-group">
                <rect
                  x="335"
                  y={70 - maxCapBarHeight}
                  width="90"
                  height={maxCapBarHeight}
                  fill="#2c2518"
                  stroke="#d29922"
                  strokeWidth="1"
                  rx="1"
                />
                <text x="380" y={Math.max(12, 65 - maxCapBarHeight)} textAnchor="middle" fill="#d29922" fontSize="10" fontFamily="inherit">
                  {loading ? "..." : fmtUsd(agent?.policy.max_per_tx)}
                </text>
                <text x="380" y="84" textAnchor="middle" fill="#8a8d93" fontSize="9" fontFamily="inherit">
                  MAX / TX
                </text>
              </g>
            </svg>
          </div>
          <div className="chart-caption">
            * Bars computed dynamically from live on-chain contract state (`get_agent`).
          </div>
        </div>

        {/* TILE 6: Tall Blue Tile with Carousel */}
        <div className="tile tile-blue-tall tile-col-2">
          <div className="tile-header">
            <span className="tile-label label-white">
              {CAROUSEL_SLIDES[slideIdx].tag}
            </span>
            <span className="tile-tag-outline">PRINCIPLE</span>
          </div>
          <div className="carousel-body">
            <p className="carousel-quote">
              &ldquo;{CAROUSEL_SLIDES[slideIdx].text}&rdquo;
            </p>
          </div>
          <div className="carousel-footer">
            <div className="carousel-dots">
              {CAROUSEL_SLIDES.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setSlideIdx(i)}
                  className={`dot-btn ${i === slideIdx ? "active" : ""}`}
                  aria-label={`Slide ${i + 1}`}
                />
              ))}
            </div>
            <span className="carousel-counter">
              0{slideIdx + 1} / 0{CAROUSEL_SLIDES.length}
            </span>
          </div>
        </div>

        {/* TILE 7: Tile "TEE VERDICT" */}
        <div className="tile tile-col-2">
          <div className="tile-header">
            <span className="tile-label">TEE VERDICT REQUIREMENT</span>
            <span className="badge-confidence">ON-CHAIN POLICY</span>
          </div>
          <div className="tee-hero-row">
            <div className="tile-hero num-hero text-accent">
              {loading ? "..." : agent ? `${agent.policy.min_confidence_pct}%` : "no data"}
            </div>
            <div className="tee-meter-box">
              <div className="meter-label-row">
                <span>MIN REQUIRED CONFIDENCE</span>
                <span>{loading ? "..." : agent ? `${agent.policy.min_confidence_pct} / 100` : "no data"}</span>
              </div>
              <div className="tee-meter-bg">
                <div
                  className="tee-meter-fill"
                  style={{ width: `${agent?.policy.min_confidence_pct ?? 0}%` }}
                />
              </div>
            </div>
          </div>
          <div className="tee-reason-box">
            <span className="reason-label">ENFORCEMENT MODE</span>
            <p className="reason-text">
              {config?.provider_tee_signer
                ? `Provider signer is pinned on-chain (${config.provider_tee_signer.slice(0, 10)}...). Contract strictly checks verdict signature before MPC signing.`
                : "No provider TEE signer is currently pinned on this contract."}
            </p>
          </div>
        </div>

        {/* TILE 8: Gauge Tile "BUDGET UTILIZATION" */}
        <div className="tile tile-col-1">
          <div className="tile-header">
            <span className="tile-label">UTILIZATION</span>
            <span className="tile-tag-small">ROLLING 1H</span>
          </div>
          <div className="gauge-center">
            <svg width="100" height="100" viewBox="0 0 100 100" className="gauge-svg">
              <circle
                cx="50"
                cy="50"
                r={ringRadius}
                fill="none"
                stroke="#22242a"
                strokeWidth="7"
              />
              <circle
                cx="50"
                cy="50"
                r={ringRadius}
                fill="none"
                stroke={(budgetSharePct ?? 0) > 80 ? "#f85149" : "#55688f"}
                strokeWidth="7"
                strokeDasharray={ringCircumference}
                strokeDashoffset={ringDashoffset}
                strokeLinecap="butt"
                transform="rotate(-90 50 50)"
                style={{ transition: "stroke-dashoffset 0.5s ease" }}
              />
              <text
                x="50"
                y="55"
                textAnchor="middle"
                fill="#e8e8e3"
                fontSize="18"
                fontWeight="700"
                fontFamily="inherit"
              >
                {loading ? "..." : budgetSharePct !== null ? `${budgetSharePct}%` : "no data"}
              </text>
            </svg>
          </div>
          <div className="tile-sub text-center">SHARE OF HOURLY BUDGET USED</div>
        </div>

        {/* TILE 9: Circuit Breaker Tile */}
        <div className="tile tile-col-1">
          <div className="tile-header">
            <span className="tile-label">CIRCUIT BREAKER</span>
            <span className={isFrozen ? "dot dot-red" : "dot dot-green"} />
          </div>
          <div className="tile-hero num-hero">
            {loading ? "..." : agent ? `${agent.calls_last_minute} / ${agent.policy.max_calls_per_minute}` : "no data"}
          </div>
          <div className="tile-sub">CALLS IN LAST MINUTE</div>
          <div className="cb-status-box">
            {isFrozen ? (
              <span className="cb-frozen">🛑 STATE: FROZEN (HALTED)</span>
            ) : (
              <span className="cb-healthy">✓ STATE: ARMED & HEALTHY</span>
            )}
          </div>
        </div>

        {/* TILE 10: Warm-Gray Action Tile "VIEW ON EXPLORER" */}
        <div className="tile tile-action tile-col-2">
          <div className="tile-header">
            <span className="tile-label label-dark">VIEW ON EXPLORER</span>
            <span className="action-arrow">↗</span>
          </div>
          <a
            href={`https://explorer.testnet.near.org/accounts/${contractId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="action-link-cover"
          >
            <div className="action-contract-text">CONTRACT: {contractId}</div>
            <div className="action-tx-box">
              <span className="action-tx-label">ON-CHAIN TRANSACTIONS:</span>
              <span className="action-tx-code">
                explorer.testnet.near.org/accounts/{contractId}
              </span>
            </div>
          </a>
        </div>

        {/* TILE 11: Live On-Chain Policy Rules & Indexer Telemetry */}
        <div className="tile tile-col-2">
          <div className="tile-header">
            <span className="tile-label">ON-CHAIN POLICY & INDEXER TELEMETRY</span>
            <span className="tile-tag-small">LIVE RPC</span>
          </div>
          <div className="policy-matrix">
            <div className="matrix-row">
              <span className="matrix-key">ALLOWED TOKENS:</span>
              <span className="matrix-val mono">
                {agent?.policy.allowed_tokens.length
                  ? agent.policy.allowed_tokens.join(", ")
                  : "None configured"}
              </span>
            </div>
            <div className="matrix-row">
              <span className="matrix-key">ALLOWED RECIPIENTS:</span>
              <span className="matrix-val">
                {agent?.policy.allowed_recipients.length
                  ? agent.policy.allowed_recipients.join(", ")
                  : "Open allow-list (TEE semantic verdict mandatory for every spend)"}
              </span>
            </div>
            <div className="matrix-row">
              <span className="matrix-key">ALLOWED CHAINS:</span>
              <span className="matrix-val mono">
                {agent?.policy.allowed_chain_ids.length
                  ? agent.policy.allowed_chain_ids.map((c) => `Chain ID ${c}`).join(", ")
                  : "None configured"}
              </span>
            </div>
            <div className="matrix-row">
              <span className="matrix-key">RECENT OUTCOMES:</span>
              <span className="matrix-val text-muted">
                {indexerAvailable && indexerTxns.length > 0
                  ? `${indexerTxns.length} recent transactions indexed`
                  : "History unavailable (no indexer API configured on NEAR Testnet)"}
              </span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense
      fallback={
        <div
          className="bento-container"
          style={{ padding: "3rem", textAlign: "center", color: "#8a8d93" }}
        >
          <div>Loading BastionKey Command Center...</div>
        </div>
      }
    >
      <CommandCenterBento />
    </Suspense>
  );
}
