export interface PolicyJson {
  max_per_tx: string;
  hourly_budget: string;
  max_gas_cost_wei: string;
  allowed_tokens: string[];
  allowed_recipients: string[];
  allowed_chain_ids: number[];
  tee_required_above: string;
  min_confidence_pct: number;
  max_calls_per_minute: number;
}

export interface TeeAttestationJson {
  kind: string;
  model_id: string | null;
  /** base64 of the exact request body bytes */
  request: string;
  /** base64 of the exact response body bytes */
  response: string;
  signature: string;
}

export interface SignOutcomeJson {
  status: "APPROVED" | "REJECTED" | "FROZEN" | "SIGN_FAILED";
  code: string | null;
  reason: string | null;
  digest: string | null;
  signature: unknown;
}
