import { isAddress } from "viem";

export interface UserPolicyFile {
  $schema?: string;
  version?: string;
  token: {
    symbol?: string;
    address: string;
    decimals: number;
  };
  limits: {
    maxPerTxUsd: number;
    hourlyBudgetUsd: number;
    teeRequiredAboveUsd?: number;
    maxGasCostGwei?: number;
  };
  rules: {
    allowedTokens: string[];
    allowedRecipients: string[];
    allowedChains: number[];
    minConfidencePct: number;
    maxCallsPerMinute: number;
  };
}

export interface OnChainPolicy {
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

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  onChainPolicy?: OnChainPolicy;
}

export function validatePolicy(data: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!data || typeof data !== "object") {
    return { valid: false, errors: ["Policy must be a valid JSON object."], warnings };
  }

  const p = data as Partial<UserPolicyFile>;

  // Token validation
  if (!p.token || typeof p.token !== "object") {
    errors.push("Missing required 'token' configuration block.");
  } else {
    if (!p.token.address || !isAddress(p.token.address)) {
      errors.push(`Invalid token address: '${p.token.address}'. Must be a valid 20-byte 0x-prefixed address.`);
    }
    if (typeof p.token.decimals !== "number" || !Number.isInteger(p.token.decimals) || p.token.decimals < 0 || p.token.decimals > 18) {
      errors.push(`Invalid token decimals: '${p.token.decimals}'. Must be an integer between 0 and 18.`);
    }
  }

  // Limits validation
  if (!p.limits || typeof p.limits !== "object") {
    errors.push("Missing required 'limits' configuration block.");
  } else {
    if (typeof p.limits.maxPerTxUsd !== "number" || isNaN(p.limits.maxPerTxUsd) || p.limits.maxPerTxUsd <= 0) {
      errors.push("limits.maxPerTxUsd must be a positive number greater than 0.");
    }
    if (typeof p.limits.hourlyBudgetUsd !== "number" || isNaN(p.limits.hourlyBudgetUsd) || p.limits.hourlyBudgetUsd <= 0) {
      errors.push("limits.hourlyBudgetUsd must be a positive number greater than 0.");
    }
    if (
      typeof p.limits.maxPerTxUsd === "number" &&
      typeof p.limits.hourlyBudgetUsd === "number" &&
      p.limits.hourlyBudgetUsd < p.limits.maxPerTxUsd
    ) {
      errors.push(
        `Invariant violation: limits.hourlyBudgetUsd ($${p.limits.hourlyBudgetUsd}) must be greater than or equal to limits.maxPerTxUsd ($${p.limits.maxPerTxUsd}).`,
      );
    }
    if (p.limits.teeRequiredAboveUsd !== undefined && (typeof p.limits.teeRequiredAboveUsd !== "number" || p.limits.teeRequiredAboveUsd < 0)) {
      errors.push("limits.teeRequiredAboveUsd must be a non-negative number.");
    }
    if (p.limits.maxGasCostGwei !== undefined && (typeof p.limits.maxGasCostGwei !== "number" || p.limits.maxGasCostGwei <= 0)) {
      errors.push("limits.maxGasCostGwei must be a positive number greater than 0.");
    }
  }

  // Rules validation
  if (!p.rules || typeof p.rules !== "object") {
    errors.push("Missing required 'rules' configuration block.");
  } else {
    if (!Array.isArray(p.rules.allowedTokens) || p.rules.allowedTokens.length === 0) {
      errors.push("rules.allowedTokens must be a non-empty array of valid token addresses.");
    } else {
      for (const t of p.rules.allowedTokens) {
        if (!isAddress(t)) {
          errors.push(`Invalid address in rules.allowedTokens: '${t}'.`);
        }
      }
    }

    if (!Array.isArray(p.rules.allowedRecipients)) {
      errors.push("rules.allowedRecipients must be an array of addresses (or empty for open policy).");
    } else {
      if (p.rules.allowedRecipients.length === 0) {
        warnings.push("rules.allowedRecipients is empty: open allow-list mode active. TEE semantic verification is mandatory for every transaction.");
      }
      for (const r of p.rules.allowedRecipients) {
        if (!isAddress(r)) {
          errors.push(`Invalid address in rules.allowedRecipients: '${r}'.`);
        }
      }
    }

    if (!Array.isArray(p.rules.allowedChains) || p.rules.allowedChains.length === 0) {
      errors.push("rules.allowedChains must be a non-empty array of chain IDs.");
    } else {
      for (const c of p.rules.allowedChains) {
        if (typeof c !== "number" || !Number.isInteger(c) || c < 1) {
          errors.push(`Invalid chain ID in rules.allowedChains: '${c}'. Must be a positive integer.`);
        }
      }
    }

    if (
      typeof p.rules.minConfidencePct !== "number" ||
      !Number.isInteger(p.rules.minConfidencePct) ||
      p.rules.minConfidencePct < 0 ||
      p.rules.minConfidencePct > 100
    ) {
      errors.push("rules.minConfidencePct must be an integer between 0 and 100.");
    }

    if (
      typeof p.rules.maxCallsPerMinute !== "number" ||
      !Number.isInteger(p.rules.maxCallsPerMinute) ||
      p.rules.maxCallsPerMinute <= 0
    ) {
      errors.push("rules.maxCallsPerMinute must be an integer greater than 0.");
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // Convert to token base units
  const decimals = p.token!.decimals;
  const multiplier = 10n ** BigInt(decimals);

  const toBaseUnits = (val: number): string => {
    // Avoid floating point inaccuracies by parsing as fixed-decimal string
    const str = val.toFixed(decimals);
    const [whole, frac = ""] = str.split(".");
    const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
    return (BigInt(whole) * multiplier + BigInt(fracPadded)).toString();
  };

  const toWei = (gweiVal: number): string => {
    return BigInt(Math.round(gweiVal * 1e9)).toString();
  };

  const onChainPolicy: OnChainPolicy = {
    max_per_tx: toBaseUnits(p.limits!.maxPerTxUsd),
    hourly_budget: toBaseUnits(p.limits!.hourlyBudgetUsd),
    max_gas_cost_wei: toWei(p.limits!.maxGasCostGwei ?? 10000000),
    allowed_tokens: p.rules!.allowedTokens.map((t) => t.toLowerCase()),
    allowed_recipients: p.rules!.allowedRecipients.map((r) => r.toLowerCase()),
    allowed_chain_ids: p.rules!.allowedChains,
    tee_required_above: toBaseUnits(p.limits!.teeRequiredAboveUsd ?? 0),
    min_confidence_pct: p.rules!.minConfidencePct,
    max_calls_per_minute: p.rules!.maxCallsPerMinute,
  };

  return {
    valid: true,
    errors: [],
    warnings,
    onChainPolicy,
  };
}
