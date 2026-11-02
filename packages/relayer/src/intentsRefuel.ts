/**
 * NEAR Intents (1Click Swap API) refuel quotes.
 *
 * When an approved payment needs the agent's derived address to hold more gas or stablecoin on the
 * destination chain, BastionKey asks 1Click for a quote that delivers it straight to that address.
 *
 * Only `dry: true` quotes are issued here: no deposit address is created and nothing moves.
 * NEAR Intents has no testnet (see the hackathon rules, Q-007), so live swaps are out of scope for
 * the automated demos.
 */
const DEFAULT_BASE = "https://1click.chaindefuser.com";

export interface IntentsToken {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  price?: number;
}

export interface IntentsOptions {
  baseUrl?: string;
  /** optional 1Click JWT; without it the API charges a 0.2% fee */
  jwt?: string;
  fetchImpl?: typeof fetch;
}

const headers = (o: IntentsOptions): Record<string, string> => ({
  "Content-Type": "application/json",
  ...(o.jwt ? { Authorization: `Bearer ${o.jwt}` } : {}),
});

export async function listTokens(o: IntentsOptions = {}): Promise<IntentsToken[]> {
  const f = o.fetchImpl ?? fetch;
  const res = await f(`${o.baseUrl ?? DEFAULT_BASE}/v0/tokens`, { headers: headers(o) });
  if (!res.ok) throw new Error(`1Click /v0/tokens failed: HTTP ${res.status}`);
  return (await res.json()) as IntentsToken[];
}

/** Asset ids must come from /v0/tokens, never constructed by hand. */
export function findAsset(tokens: IntentsToken[], symbol: string, blockchain: string): IntentsToken {
  const t = tokens.find(
    (x) => x.symbol.toUpperCase() === symbol.toUpperCase() && x.blockchain.toLowerCase() === blockchain.toLowerCase(),
  );
  if (!t) throw new Error(`no 1Click asset for ${symbol} on ${blockchain}`);
  return t;
}

export interface RefuelRequest {
  origin: IntentsToken;
  destination: IntentsToken;
  /** origin amount in base units */
  amount: bigint;
  /** the agent's derived address on the destination chain */
  recipient: string;
  /** where unspent funds go back to on the origin chain */
  refundTo: string;
  slippageBps?: number;
}

export interface RefuelQuote {
  dry: true;
  request: Record<string, unknown>;
  response: any;
}

export async function dryRefuelQuote(r: RefuelRequest, o: IntentsOptions = {}): Promise<RefuelQuote> {
  const f = o.fetchImpl ?? fetch;
  const request = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: r.slippageBps ?? 100,
    originAsset: r.origin.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: r.destination.assetId,
    amount: r.amount.toString(),
    refundTo: r.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: r.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  const res = await f(`${o.baseUrl ?? DEFAULT_BASE}/v0/quote`, {
    method: "POST",
    headers: headers(o),
    body: JSON.stringify(request),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`1Click quote failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return { dry: true, request, response: body };
}
