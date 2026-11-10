import { BastionRpcError } from "./errors.js";

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * Perform an HTTP fetch with timeout and at most 1 bounded retry for transient network errors.
 */
export async function fetchWithTimeoutAndRetry(
  url: string,
  options: FetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxRetries = options.maxRetries ?? 1;

  let attempt = 0;
  let lastError: unknown = null;

  while (attempt <= maxRetries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res;
    } catch (err: any) {
      clearTimeout(timer);
      lastError = err;
      const isAbort = err?.name === "AbortError";
      const isNetwork = err?.code === "ECONNRESET" || err?.code === "ETIMEDOUT" || isAbort;

      if (attempt < maxRetries && isNetwork) {
        attempt++;
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      break;
    }
  }

  const errMessage =
    lastError instanceof Error
      ? lastError.message
      : typeof lastError === "string"
      ? lastError
      : "Network request failed";

  throw new BastionRpcError(
    `RPC/API request to ${url.replace(/\?.*$/, "")} failed after ${attempt + 1} attempt(s): ${errMessage}`,
  );
}
