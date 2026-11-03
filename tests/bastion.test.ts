import { describe, expect, it } from "vitest";
import { recoverMessageAddress } from "viem";
import { extractJsonObject, verifyAttestation, signedText } from "@bastionkey/tee-verifier";
import { LocalAttestor } from "../packages/tee-verifier/src/testing/localAttestor.js";
import { BASE_SEPOLIA, buildErc20Transfer, decodeTransfer, unsignedDigest, usd, signatureFromMpc, signedRawTx } from "@bastionkey/relayer";
import { LocalMpc } from "../packages/relayer/src/testing/localMpc.js";
import { recoverTransactionAddress, type Address, type Hex } from "viem";

const GOOD = "0x1111111111111111111111111111111111111111" as Address;
const BAD = "0xbadbadbadbadbadbadbadbadbadbadbadbadbad0" as Address;

function facts(recipient: Address, dollars: number) {
  const tx = buildErc20Transfer({ nonce: 1, recipient, amount: BigInt(dollars) * 1_000_000n });
  const d = decodeTransfer(tx);
  return {
    tx,
    input: (task: string) => ({
      task,
      actionLog: [],
      tx: { chainId: tx.chain_id, token: tx.to, recipient: d.recipient, amount: d.amount, decimals: 6, digest: unsignedDigest(tx) },
    }),
  };
}

describe("transaction building", () => {
  it("round-trips an ERC-20 transfer", () => {
    const { tx } = facts(GOOD, 5);
    expect(decodeTransfer(tx)).toEqual({ recipient: GOOD, amount: 5_000_000n });
    expect(tx.to).toBe(BASE_SEPOLIA.usdc);
  });
  it("formats USD", () => expect(usd(150_000_000n)).toBe("$150.00"));
});

describe("local attestor (offline stand-in)", () => {
  const att = new LocalAttestor();
  it("aligns when task names recipient and amount", async () => {
    const f = facts(GOOD, 5);
    const r = await att.verify(f.input(`send $5 USDC to ${GOOD}`));
    expect(r.verdict.is_aligned).toBe(true);
    await verifyAttestation(r.attestation, att.address as Address, unsignedDigest(f.tx));
  });
  it("denies a recipient the task never named", async () => {
    const f = facts(BAD, 10);
    const r = await att.verify(f.input(`send $10 USDC to ${GOOD}`));
    expect(r.verdict.is_aligned).toBe(false);
  });
  it("rejects verification against the wrong digest", async () => {
    const f = facts(GOOD, 5);
    const r = await att.verify(f.input(`send $5 USDC to ${GOOD}`));
    await expect(verifyAttestation(r.attestation, att.address as Address, "0x" + "00".repeat(32))).rejects.toThrow();
  });
  it("rejects a different signer", async () => {
    const f = facts(GOOD, 5);
    const r = await att.verify(f.input(`send $5 USDC to ${GOOD}`));
    await expect(verifyAttestation(r.attestation, BAD, unsignedDigest(f.tx))).rejects.toThrow(/pinned/);
  });
  it("signs the documented text format", async () => {
    const f = facts(GOOD, 5);
    const r = await att.verify(f.input(`send $5 USDC to ${GOOD}`));
    const who = await recoverMessageAddress({ message: signedText(r.attestation), signature: r.attestation.signature as Hex });
    expect(who).toBe(att.address);
  });
});

describe("json extraction", () => {
  it("tolerates prose and fences", () => {
    expect(extractJsonObject('sure ```json\n{"a":1}\n``` done')).toBe('{"a":1}');
    expect(extractJsonObject("no json")).toBeNull();
  });
});

describe("MPC signature assembly", () => {
  it("recovers to the derived address", async () => {
    const mpc = new LocalMpc("t");
    const { tx } = facts(GOOD, 5);
    const resp = await mpc.sign(unsignedDigest(tx), "p");
    const raw = signedRawTx(tx, signatureFromMpc(resp));
    expect(await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })).toBe(mpc.address("p"));
  });
});
