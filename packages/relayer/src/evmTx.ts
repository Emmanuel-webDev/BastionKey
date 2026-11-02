import {
  bytesToHex,
  decodeFunctionData,
  encodeFunctionData,
  hexToBytes,
  keccak256,
  parseAbi,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";

export const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

export const BASE_SEPOLIA = {
  chainId: 84532,
  usdc: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Address,
  usdcDecimals: 6,
};

/** Transaction in the exact JSON shape the BastionKey contract takes. `data` is base64. */
export interface BastionTx {
  chain_id: number;
  nonce: number;
  max_priority_fee_per_gas: string;
  max_fee_per_gas: string;
  gas_limit: number;
  to: string;
  value: string;
  data: string;
}

export interface TransferParams {
  chainId?: number;
  nonce: number;
  token?: Address;
  recipient: Address;
  /** token base units */
  amount: bigint;
  gasLimit?: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export function buildErc20Transfer(p: TransferParams): BastionTx {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [p.recipient, p.amount] });
  return {
    chain_id: p.chainId ?? BASE_SEPOLIA.chainId,
    nonce: p.nonce,
    max_priority_fee_per_gas: (p.maxPriorityFeePerGas ?? 1_000_000n).toString(),
    max_fee_per_gas: (p.maxFeePerGas ?? 2_000_000_000n).toString(),
    gas_limit: p.gasLimit ?? 100_000,
    to: (p.token ?? BASE_SEPOLIA.usdc).toLowerCase(),
    value: "0",
    data: Buffer.from(hexToBytes(data)).toString("base64"),
  };
}

export const calldataOf = (tx: BastionTx): Hex => bytesToHex(Buffer.from(tx.data, "base64"));

export function decodeTransfer(tx: BastionTx): { recipient: Address; amount: bigint } {
  const { args } = decodeFunctionData({ abi: ERC20_ABI, data: calldataOf(tx) });
  return { recipient: (args[0] as string).toLowerCase() as Address, amount: args[1] as bigint };
}

export function toViemTx(tx: BastionTx): TransactionSerializableEIP1559 {
  return {
    type: "eip1559",
    chainId: tx.chain_id,
    nonce: tx.nonce,
    maxPriorityFeePerGas: BigInt(tx.max_priority_fee_per_gas),
    maxFeePerGas: BigInt(tx.max_fee_per_gas),
    gas: BigInt(tx.gas_limit),
    to: tx.to as Address,
    value: BigInt(tx.value),
    data: calldataOf(tx),
    accessList: [],
  };
}

/** keccak256 of the unsigned transaction: what the MPC network signs, and what the contract recomputes. */
export const unsignedDigest = (tx: BastionTx): Hex => keccak256(serializeTransaction(toViemTx(tx)));

export function signedRawTx(tx: BastionTx, sig: { r: Hex; s: Hex; yParity: 0 | 1 }): Hex {
  return serializeTransaction(toViemTx(tx), sig);
}

/** "$5.00" for USDC base units */
export function usd(amount: bigint | string | number, decimals = BASE_SEPOLIA.usdcDecimals): string {
  const a = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = (a % base).toString().padStart(decimals, "0").slice(0, 2);
  return `$${whole.toLocaleString("en-US")}.${frac}`;
}
