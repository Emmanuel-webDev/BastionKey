import { createPublicClient, http, parseAbi, type Address } from "viem";
import fs from "node:fs";
import path from "node:path";
import { BastionRpcError } from "./errors.js";

const ERC20_DECIMALS_ABI = parseAbi(["function decimals() view returns (uint8)"]);

// Memory cache: `${chainId}:${tokenAddress.toLowerCase()}` -> decimals
const memoryCache = new Map<string, number>();

function getCacheFilePath(customPath?: string): string {
  if (customPath) return customPath;
  const dir = path.join(process.cwd(), ".bastion-cache");
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // Ignore if cannot create directory
    }
  }
  return path.join(dir, "token-decimals.json");
}

function loadDiskCache(filePath: string): Record<string, number> {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      return JSON.parse(raw);
    }
  } catch {
    // Ignore corrupt or unreadable cache
  }
  return {};
}

function writeDiskCache(filePath: string, cache: Record<string, number>) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), "utf8");
  } catch {
    // Non-fatal if cache cannot be persisted
  }
}

export interface GetTokenDecimalsOptions {
  tokenAddress: Address;
  chainId: number;
  rpcUrl: string;
  cacheFilePath?: string;
  knownDecimals?: number;
}

/**
 * Reads token decimals dynamically from the chain, with memory & disk caching.
 * Never assumes 6 decimals.
 */
export async function getTokenDecimals(options: GetTokenDecimalsOptions): Promise<number> {
  const { tokenAddress, chainId, rpcUrl, cacheFilePath, knownDecimals } = options;
  const normalizedAddr = tokenAddress.toLowerCase() as Address;
  const key = `${chainId}:${normalizedAddr}`;

  if (typeof knownDecimals === "number" && knownDecimals >= 0) {
    memoryCache.set(key, knownDecimals);
    return knownDecimals;
  }

  if (memoryCache.has(key)) {
    return memoryCache.get(key)!;
  }

  const diskPath = getCacheFilePath(cacheFilePath);
  const diskCache = loadDiskCache(diskPath);
  if (typeof diskCache[key] === "number") {
    memoryCache.set(key, diskCache[key]);
    return diskCache[key];
  }

  try {
    const publicClient = createPublicClient({
      transport: http(rpcUrl, { timeout: 10000 }),
    });

    const decimals = await publicClient.readContract({
      address: normalizedAddr,
      abi: ERC20_DECIMALS_ABI,
      functionName: "decimals",
    });

    const decNumber = Number(decimals);
    memoryCache.set(key, decNumber);
    diskCache[key] = decNumber;
    writeDiskCache(diskPath, diskCache);

    return decNumber;
  } catch (err: any) {
    throw new BastionRpcError(
      `Failed to query decimals() for token ${tokenAddress} on chain ${chainId} via ${rpcUrl}: ${err.message}`,
    );
  }
}

/**
 * Clear cached decimals (useful in tests).
 */
export function clearDecimalsCache(): void {
  memoryCache.clear();
}
