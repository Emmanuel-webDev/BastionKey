/**
 * LOCAL STAND-IN for testing only. Not used in production.
 */
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { buildRequestBody, type VerifierInput } from "../prompt.js";
import { readVerdict, signedText, type Attestation } from "../teeAttestation.js";
import type { Verifier, VerifierResult } from "../semanticChecker.js";

export const LOCAL_ATTESTOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const; // gitleaks:allow - Hardhat/Anvil well-known test key for offline tests
export const LOCAL_ATTESTOR_MODEL = "bastionkey-local/rule-verifier";

/** Dollar amounts mentioned in a task: "$10", "10 USDC", "10.50 usdc" */
export function amountsIn(task: string): string[] {
  const out = new Set<string>();
  for (const m of task.matchAll(/\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:usdc|usd|dollars?)\b/gi)) {
    out.add(Number(m[1] ?? m[2]).toFixed(6));
  }
  return [...out];
}

export class LocalAttestor implements Verifier {
  readonly label = "local rule-based stand-in (not a TEE)";
  private account = privateKeyToAccount(LOCAL_ATTESTOR_KEY);

  get address(): string {
    return this.account.address;
  }

  async verify(input: VerifierInput): Promise<VerifierResult> {
    const { task, tx } = input;
    const recipientNamed = task.toLowerCase().includes(tx.recipient.toLowerCase());
    const amount = (Number(tx.amount) / 10 ** tx.decimals).toFixed(6);
    const amountNamed = amountsIn(task).includes(amount);
    const aligned = recipientNamed && amountNamed;

    const verdict = {
      tx_digest: tx.digest,
      is_aligned: aligned,
      confidence_pct: aligned ? 97 : 99,
      reason: aligned
        ? "recipient and amount both match the task"
        : !recipientNamed
          ? "the task never names this recipient; it appears only in the untrusted action log"
          : "the amount does not match the task",
    };
    const requestBody = buildRequestBody(LOCAL_ATTESTOR_MODEL, input);
    const responseBody = JSON.stringify({
      id: `local-${createHash("sha256").update(requestBody).digest("hex").slice(0, 16)}`,
      object: "chat.completion",
      model: LOCAL_ATTESTOR_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(verdict) }, finish_reason: "stop" }],
    });

    const attestation: Attestation = {
      kind: "provider_tee",
      model_id: LOCAL_ATTESTOR_MODEL,
      request: Buffer.from(requestBody).toString("base64"),
      response: Buffer.from(responseBody).toString("base64"),
      signature: "",
    };
    attestation.signature = await this.account.signMessage({ message: signedText(attestation) });
    return { attestation, verdict: readVerdict(attestation), signer: this.account.address, chatId: "local" };
  }
}
