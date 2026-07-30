import type { SandboxProfile } from "./sandbox.js";

export class InvalidEgressConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEgressConfigError";
  }
}

export interface EgressProfileOptions {
  readonly allowedDomains?: readonly string[];
}

export interface DnsRebindingPosture {
  readonly status: "not-applicable" | "documented-limitation";
  readonly requiredBackendControl?: "deny-private-resolved-addresses";
  readonly reason: string;
}

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeDomainPattern(pattern: string): string {
  const normalized = pattern.trim().toLowerCase();
  if (normalized === "") {
    throw new InvalidEgressConfigError("egress domain must not be empty");
  }
  if (normalized === "localhost") return normalized;
  if (
    normalized === "*" ||
    normalized.includes(":") ||
    normalized.includes("/") ||
    normalized.includes("[")
  ) {
    throw new InvalidEgressConfigError(`invalid egress domain pattern: ${pattern}`);
  }

  const wildcard = normalized.startsWith("*.");
  if (normalized.includes("*") && !wildcard) {
    throw new InvalidEgressConfigError(`invalid egress domain pattern: ${pattern}`);
  }

  const domain = wildcard ? normalized.slice(2) : normalized;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL.test(label))) {
    throw new InvalidEgressConfigError(`invalid egress domain pattern: ${pattern}`);
  }
  if (
    !labels.some((label) => /[a-z]/.test(label)) ||
    labels.some((label) => label.startsWith("0x"))
  ) {
    throw new InvalidEgressConfigError(`IP-like egress domain pattern is not allowed: ${pattern}`);
  }

  return wildcard ? `*.${domain}` : domain;
}

export function buildEgressNetworkProfile(
  options: EgressProfileOptions = {},
): NonNullable<SandboxProfile["network"]> {
  const allowedDomains = options.allowedDomains ?? [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const domain of allowedDomains) {
    const normalized = normalizeDomainPattern(domain);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return {
    allowedDomains: unique,
    deniedDomains: unique.length === 0 ? ["*"] : [],
    strictAllowlist: true,
  };
}

export function describeDnsRebindingPosture(
  profile: NonNullable<SandboxProfile["network"]>,
): DnsRebindingPosture {
  if ((profile.allowedDomains ?? []).length === 0) {
    return {
      status: "not-applicable",
      reason: "network profile allows no requested host, so DNS rebinding has no allowed target",
    };
  }

  return {
    status: "documented-limitation",
    requiredBackendControl: "deny-private-resolved-addresses",
    reason:
      "vendored srt filters the requested host before dialing; it does not prove that the resolved address stays outside private, loopback, or link-local ranges",
  };
}
