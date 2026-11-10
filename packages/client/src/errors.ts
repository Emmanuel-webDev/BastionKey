/**
 * Typed error classes for BastionKey client, CLI, and services.
 * All errors extend BastionError and sanitize any secrets from messages.
 */

function sanitize(message: string): string {
  return message
    .replace(/ed25519:[A-Za-z0-9+/=]{30,}/g, "[REDACTED_ED25519_KEY]")
    .replace(/0x[a-fA-F0-9]{64}/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED_TOKEN]");
}

export class BastionError extends Error {
  public readonly code: string;

  constructor(message: string, code = "BASTION_ERROR") {
    super(sanitize(message));
    this.name = "BastionError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BastionConfigError extends BastionError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR");
    this.name = "BastionConfigError";
  }
}

export class BastionTrustError extends BastionError {
  constructor(message: string) {
    super(message, "TRUST_RULE_VIOLATION");
    this.name = "BastionTrustError";
  }
}

export class BastionRpcError extends BastionError {
  constructor(message: string) {
    super(message, "RPC_ERROR");
    this.name = "BastionRpcError";
  }
}

export class BastionTeeError extends BastionError {
  constructor(message: string) {
    super(message, "TEE_VERIFIER_ERROR");
    this.name = "BastionTeeError";
  }
}

export class BastionPolicyError extends BastionError {
  constructor(message: string) {
    super(message, "POLICY_ERROR");
    this.name = "BastionPolicyError";
  }
}

export class BastionAuthError extends BastionError {
  constructor(message: string) {
    super(message, "AUTH_ERROR");
    this.name = "BastionAuthError";
  }
}

export class BastionRateLimitError extends BastionError {
  constructor(message: string) {
    super(message, "RATE_LIMIT_ERROR");
    this.name = "BastionRateLimitError";
  }
}

export class BastionKeySecurityError extends BastionError {
  constructor(message: string) {
    super(message, "KEY_SECURITY_ERROR");
    this.name = "BastionKeySecurityError";
  }
}
