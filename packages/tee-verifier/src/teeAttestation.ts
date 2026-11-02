/**
 * Client-side mirror of the contract's attestation check (packages/near-contract/src/tee.rs).
 * Running the same check off chain first lets the agent fail fast and lets tests prove both
 * sides agree on the signed-text format.
 *
 * What this does and does not establish:
 *  - It proves a response was signed by the key at `signer`.
 *  - That `signer` belongs to a genuine hardware TEE is a separate, one-time check against the
 *    NEAR AI Cloud attestation report (Intel TDX quote + NVIDIA NRAS). Do that with
 *    https://github.com/nearai/nearai-cloud-verifier and pin the address in the contract with
 *    `set_provider_tee_signer`. `fetchSigningAddress` below only reads the address from the report;
 *    it does not verify the hardware quote.
 */
import { createHash } from "node:crypto";
import { recoverMessageAddress, type Address, type Hex } from "viem";

export interface Attestation {
  kind: string;
  model_id: string | null;
  /** base64 of the exact request body bytes */
  request: string;
  /** base64 of the exact response body bytes */
  response: string;
  signature: string;
}

export interface Verdict {
  tx_digest: string;
  is_aligned: boolean;
  confidence_pct: number;
  reason?: string;
}

const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export function signedText(a: Attestation): string {
  const req = sha256Hex(Buffer.from(a.request, "base64"));
  const resp = sha256Hex(Buffer.from(a.response, "base64"));
  if (a.kind === "provider_tee") {
    if (!a.model_id) throw new Error("provider_tee attestation needs model_id");
    return `${a.model_id}:${req}:${resp}`;
  }
  if (a.kind === "gateway") return `${req}:${resp}`;
  throw new Error(`unknown attestation kind: ${a.kind}`);
}

export const with0x = (s: string): Hex => (s.startsWith("0x") ? s : `0x${s}`) as Hex;

export async function recoverSigner(a: Attestation): Promise<Address> {
  return recoverMessageAddress({ message: signedText(a), signature: with0x(a.signature) });
}

/** Extract the first {...} object from model output, tolerating prose or fences around it. */
export function extractJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  return start >= 0 && end > start ? s.slice(start, end + 1) : null;
}

export function readVerdict(a: Attestation): Verdict {
  const body = JSON.parse(Buffer.from(a.response, "base64").toString("utf8"));
  const content: string = body?.choices?.[0]?.message?.content ?? "";
  const obj = extractJsonObject(content);
  if (!obj) throw new Error("no JSON verdict in the model response");
  const v = JSON.parse(obj);
  if (typeof v.is_aligned !== "boolean" || !Number.isInteger(v.confidence_pct)) {
    throw new Error("verdict needs boolean is_aligned and integer confidence_pct");
  }
  return v as Verdict;
}

/** Full off-chain check. Throws if anything is off; returns the verdict otherwise. */
export async function verifyAttestation(a: Attestation, pinnedSigner: Address, digest: string): Promise<Verdict> {
  const signer = await recoverSigner(a);
  if (signer.toLowerCase() !== pinnedSigner.toLowerCase()) {
    throw new Error(`signed by ${signer}, not the pinned TEE key ${pinnedSigner}`);
  }
  const request = Buffer.from(a.request, "base64").toString("utf8");
  if (!request.includes(`TX_DIGEST:${digest}`)) throw new Error("attested request does not cover this digest");
  const v = readVerdict(a);
  if (v.tx_digest?.toLowerCase() !== digest.toLowerCase()) throw new Error("verdict echoes a different digest");
  return v;
}

/** Find `signing_address` anywhere in an attestation report (the report nests it per model). */
export function findSigningAddress(report: unknown): string | null {
  if (report && typeof report === "object") {
    for (const [k, v] of Object.entries(report)) {
      if (k === "signing_address" && typeof v === "string") return v;
      const inner = findSigningAddress(v);
      if (inner) return inner;
    }
  }
  return null;
}

export async function fetchSigningAddress(opts: {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ address: string | null; report: unknown }> {
  const f = opts.fetchImpl ?? fetch;
  const nonce = createHash("sha256").update(String(Math.random())).digest("hex");
  const url = `${opts.baseUrl ?? "https://cloud-api.near.ai"}/v1/attestation/report?model=${encodeURIComponent(
    opts.model,
  )}&signing_algo=ecdsa&nonce=${nonce}`;
  const res = await f(url, { headers: { Authorization: `Bearer ${opts.apiKey}` } });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`attestation report failed: HTTP ${res.status}: ${errText}`);
  }
  const report = await res.json();
  return { address: findSigningAddress(report), report };
}
