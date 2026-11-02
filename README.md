# BastionKey

**Track:** AI Security & Defense (NEAR Hackathon). Give an AI agent money without giving it the keys.

BastionKey is a NEAR smart contract that sits between an AI agent and its wallet. The agent holds no private key on any chain. It can only ask the contract for a signature. The contract checks hard spending rules, and for risky transfers it also requires a signed verdict from a TEE-hosted model (NEAR AI Cloud) saying the transaction actually matches the user's task. Only then does it call NEAR Chain Signatures (MPC) to sign.

## The problem

Spending caps stop an agent from losing a lot. They do not stop a prompt injection from sending a small, in-budget amount to an attacker. BastionKey adds a second check that looks at what the transaction does, not just how much it costs.

## How it works

```
agent (Function Call Key) -> BastionKey contract -> NEAR MPC signer -> Base Sepolia tx
                                  |  rules: per-tx cap, rolling hourly budget, token/chain/recipient
                                  |  allow-lists, gas cap, replay guard, velocity circuit breaker
                                  |  TEE verdict: signature recovered on chain, bound to this exact tx digest
```

- The contract builds the EIP-1559 bytes itself from structured fields, so the agent cannot describe one transaction and get another signed.
- A TEE verdict is only accepted if its signer matches the address the owner pinned, the signed request contains `TX_DIGEST:<this tx>`, and the verdict echoes the same digest. A verdict for a harmless transaction cannot be reused for a malicious one.
- Rejections return an outcome instead of panicking, so a flood of bad requests still counts toward the circuit breaker.

## Try it (no accounts, no API keys)

Needs Node 20+ and Rust (cargo).

```bash
npm install
npm run demo:valid        # expect: [APPROVED] ... Tx Signed via MPC (local stand-in): 0x...
npm run demo:overbudget   # expect: [REJECTED_ON_CHAIN] NearPolicyError: Exceeds max_per_tx limit ($50.00)...
npm run demo:injected     # expect: [BLOCKED_BY_TEE] SemanticMismatch ... Attestation DENIED
npm test                  # 26 Rust contract tests + 9 TypeScript tests
npm run dashboard         # http://localhost:3000, replays the last demo runs
```

Each demo prints `[PASS]` if the outcome is the one it is meant to show, and exits non-zero otherwise. Run logs are written to `demo-output/`.

## What is real and what is a stand-in

Read this before judging. The demos run offline, so some parts are substitutes.

| Part | Status |
| --- | --- |
| Policy contract (`packages/near-contract`) | **Real Rust code.** Unit-tested (26 tests). The demos run the same code natively under near-sdk's mock VM via `examples/sim.rs`. It is **not deployed** to NEAR testnet. |
| EIP-1559 encoding | Real. Checked against viem as an independent implementation (`tests/vectors.json`). |
| On-chain TEE signature check (EIP-191 recovery, digest binding) | Real, tested including forged, replayed and tampered verdicts. |
| MPC signing | **Local stand-in** (`LocalMpc`). The contract does emit the real call shape for `v1.signer-prod.testnet.sign`, and signature conversion uses `chainsig.js`, but the real MPC network is not contacted. The `sign` argument format was not verifiable from the docs; the contract supports two formats via `set_sign_config` and must be confirmed on testnet. |
| Semantic verifier | Demos use a **local rule-based stand-in**, not an LLM and not a TEE. It signs in NEAR AI Cloud's documented format. The live client (`NearAiVerifier`) is written to the NEAR AI Cloud docs but **has not been run against the live API**. Try it with `BASTION_VERIFIER=nearai NEARAI_API_KEY=... npm run demo:injected`. |
| Hardware attestation of the TEE key | Not verified by this repo. The owner must verify the NEAR AI Cloud attestation report (see `nearai-cloud-verifier`) and pin the address with `set_provider_tee_signer`. |
| NEAR Intents refuel (`intentsRefuel.ts`) | Dry quotes only, not exercised in the demos. Intents has no testnet. |
| Function Call Key provisioning, testnet deploy, Base Sepolia broadcast, Solana | **Not done.** `BASTION_MODE=testnet` is not implemented. |
| wasm build | Not built in the authoring environment (wasm target could not be installed). Run `rustup target add wasm32-unknown-unknown && npm run build:contract`. |

## Known limits

- Only ERC-20 `transfer` on allow-listed tokens and chains, zero native value.
- The TEE check is a model judgment. It reduces injection risk; it is not a proof. Allow-lists and caps remain the hard backstop.
- Gateway-kind attestations are rejected unless the owner pins a gateway signer.

## Repo layout

```
packages/near-contract   Rust policy contract, tests, native simulator
packages/tee-verifier    prompt, NEAR AI Cloud client, local stand-in, attestation checks
packages/relayer         EVM tx building, chainsig.js conversion, Intents dry quotes, sim client
packages/web-dashboard   Next.js replay of demo runs
scripts/                 the three demos + test-vector generator
```

## Hackathon disclosure

All code was written during the hackathon window (Nov 1-14, 2026), with AI assistance (Claude Code). Libraries: near-sdk, k256, viem, chainsig.js, Next.js. License: MIT.
