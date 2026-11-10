/**
 * Semantic checker backed by NEAR AI Cloud.
 *
 * Uses raw `fetch` instead of an OpenAI SDK on purpose: the signature covers the exact request and
 * response bytes, so we need to capture those bytes untouched.
 *
 * Flow: POST /v1/chat/completions -> GET /v1/signature/{id} -> verify signer locally.
 * The resulting `Attestation` is what gets passed to the contract.
 *
 * NOTE: this path has not been run against the live API from the build environment (no API key
 * was available). The request/response/signature handling follows the NEAR AI Cloud docs; run
 * `npm run verify:nearai` with NEARAI_API_KEY set to smoke test it.
 */
import { buildRequestBody, type VerifierInput } from "./prompt.js";
import { readVerdict, recoverSigner, with0x, type Attestation, type Verdict } from "./teeAttestation.js";

export interface NearAiConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface VerifierResult {
  attestation: Attestation;
  verdict: Verdict;
  signer: string;
  chatId: string;
}

export interface Verifier {
  readonly label: string;
  verify(input: VerifierInput): Promise<VerifierResult>;
}

export class NearAiVerifier implements Verifier {
  readonly label = "NEAR AI Cloud (TEE)";
  constructor(private cfg: NearAiConfig) {}

  async verify(input: VerifierInput): Promise<VerifierResult> {
    const f = this.cfg.fetchImpl ?? fetch;
    const base = this.cfg.baseUrl ?? "https://cloud-api.near.ai";
    const auth = { Authorization: `Bearer ${this.cfg.apiKey}` };

    const requestBody = buildRequestBody(this.cfg.model, input);
    const res = await f(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json",
        // hash the bytes as sent: no compression, and no model aliasing
        "Accept-Encoding": "identity",
        "x-no-aliasing": "true",
      },
      body: requestBody,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`NEAR AI Cloud completion failed: HTTP ${res.status}: ${errText}`);
    }
    const responseBytes = Buffer.from(await res.arrayBuffer());
    const chatId: string = JSON.parse(responseBytes.toString("utf8")).id;
    if (!chatId) throw new Error("completion response has no id");

    const sigRes = await f(
      `${base}/v1/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(this.cfg.model)}&signing_algo=ecdsa`,
      { headers: auth, signal: AbortSignal.timeout(30000) },
    );
    if (!sigRes.ok) {
      const errText = await sigRes.text();
      throw new Error(`signature fetch failed: HTTP ${sigRes.status}: ${errText}`);
    }
    const sig = (await sigRes.json()) as {
      text?: string;
      signature?: string;
      signing_address?: string;
      signature_kind?: string;
      error_code?: string;
      message?: string;
    };
    if (sig.error_code || !sig.text || !sig.signature) {
      throw new Error(`signature unavailable: ${sig.error_code ?? ""} ${sig.message ?? ""}`.trim());
    }

    // provider_tee text is "<MODEL_ID>:<64 hex>:<64 hex>"; recover the canonical model id from it.
    const kind = sig.signature_kind ?? "provider_tee";
    const model_id = kind === "provider_tee" ? sig.text.slice(0, sig.text.length - 130) : null;
    const attestation: Attestation = {
      kind,
      model_id,
      request: Buffer.from(requestBody, "utf8").toString("base64"),
      response: responseBytes.toString("base64"),
      signature: with0x(sig.signature),
    };

    const signer = await recoverSigner(attestation);
    if (sig.signing_address && signer.toLowerCase() !== sig.signing_address.toLowerCase()) {
      throw new Error(`recovered signer ${signer} does not match reported signing_address ${sig.signing_address}`);
    }
    return { attestation, verdict: readVerdict(attestation), signer, chatId };
  }
}
