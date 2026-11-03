import { utils } from "chainsig.js";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import type { MpcSignature } from "../mpcSigner.js";

/**
 * Local stand-in for testing only. Not used in production.
 */
export class LocalMpc {
  constructor(private readonly seed: string) {}

  private key(path: string): Hex {
    return keccak256(toBytes(`bastionkey-local-mpc|${this.seed}|${path}`));
  }

  address(path: string): Address {
    return privateKeyToAccount(this.key(path)).address;
  }

  async sign(digest: Hex, path: string): Promise<MpcSignature> {
    const sig = await sign({ hash: digest, privateKey: this.key(path), to: "object" });
    const yParity = Number(sig.yParity ?? (sig.v === 28n ? 1 : 0));
    return {
      big_r: { affine_point: (yParity === 0 ? "02" : "03") + sig.r.slice(2) },
      s: { scalar: sig.s.slice(2) },
      recovery_id: yParity,
    };
  }
}
