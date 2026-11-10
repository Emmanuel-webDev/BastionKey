/**
 * MPC signer side of the relayer.
 *
 * - `LocalMpc` is a LOCAL STAND-IN for the NEAR MPC network (v1.signer-prod.testnet). It holds
 *   plain secp256k1 keys derived from a seed so tests run offline. It emits the same response
 *   shape the real signer returns, so the conversion code below runs unchanged against both.
 *   It is not threshold-secure and must never be used with real funds.
 * - `signatureFromMpc` converts a signer response to an Ethereum signature using chainsig.js.
 */
import { utils } from "chainsig.js";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";

/** The response shape of the NEAR MPC signer contract. */
export interface MpcSignature {
  big_r: { affine_point: string };
  s: { scalar: string };
  recovery_id: number;
}

const hex32 = (h: string): Hex => `0x${h.replace(/^0x/, "").padStart(64, "0")}`;

export function signatureFromMpc(resp: MpcSignature): { r: Hex; s: Hex; yParity: 0 | 1 } {
  const rsv = utils.cryptography.toRSV(resp);
  const yParity = (rsv.v >= 27 ? rsv.v - 27 : rsv.v) as 0 | 1;
  return { r: hex32(rsv.r), s: hex32(rsv.s), yParity };
}
