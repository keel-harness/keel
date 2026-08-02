import { domainToASCII, domainToUnicode } from "node:url";
import { redactText, type PolicyInputT, type WARDEN_METHODS } from "@keel/shared";
import type { LoadedProjectCommandGrant } from "./command-project-grants.js";
import { buildEgressNetworkProfile, InvalidEgressConfigError } from "./egress-profile.js";
import type { LifecycleAuditPayload } from "./lifecycle.js";
import type { SandboxProfile } from "./sandbox.js";
import type { PendingMcpReview } from "./mcp/review.js";

type ExecuteParams = ReturnType<(typeof WARDEN_METHODS)["warden.execute"]["params"]["parse"]>;

export interface PendingEgressReview {
  readonly kind: "egress";
  readonly reviewId: string;
  readonly domain: string;
  readonly displayDomain: string;
  readonly command: string;
  readonly executeParams: ExecuteParams;
  readonly lifecycle?: LifecycleAuditPayload;
  readonly summary: string;
  readonly allowCommand: string;
}

export interface PendingCommandReview {
  readonly kind: "command";
  readonly approvalScope: "grantable" | "once-only";
  readonly reviewId: string;
  readonly command: string;
  readonly executeParams: ExecuteParams;
  /** Request-time classified intent retained so every approved-review failure can close the audit. */
  readonly auditPolicyInput: PolicyInputT;
  readonly lifecycle?: LifecycleAuditPayload;
  readonly grantKey: `sha256:${string}`;
  readonly summary: string;
  readonly allowCommand: string;
}

export type PendingReview = PendingEgressReview | PendingCommandReview | PendingMcpReview;

export interface EgressReviewState {
  readonly pending: Map<string, PendingReview>;
  readonly projectGrants: Set<string>;
  readonly projectCommandGrants: Map<string, LoadedProjectCommandGrant>;
  projectGrantsActive: boolean;
  nextReviewSeq: number;
  nextCommandReviewSeq: number;
  nextMcpReviewSeq: number;
}

export type ExplicitEgressTarget =
  | { readonly kind: "none" }
  | { readonly kind: "domain"; readonly domain: string; readonly url: string }
  | { readonly kind: "invalid"; readonly target: string; readonly reason: string };

const EXPLICIT_HTTP_URL = /\bhttps?:\/\/[^\s"'`<>]+/giu;
const MAX_REVIEW_COMMAND_CHARS = 180;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

export function createEgressReviewState(
  projectGrantDomains: readonly string[] = [],
  projectCommandGrants: readonly LoadedProjectCommandGrant[] = [],
): EgressReviewState {
  return {
    pending: new Map(),
    projectGrants: new Set(projectGrantDomains.map((domain) => normalizeEgressGrantDomain(domain))),
    projectCommandGrants: new Map(projectCommandGrants.map((grant) => [grant.key, grant])),
    projectGrantsActive: false,
    nextReviewSeq: 1,
    nextCommandReviewSeq: 1,
    nextMcpReviewSeq: 1,
  };
}

export function normalizeEgressGrantDomain(domain: string): string {
  const trimmed = domain.trim();
  if (trimmed.includes("*")) {
    throw new InvalidEgressConfigError(`invalid egress domain pattern: ${domain}`);
  }
  const ascii = domainToASCII(trimmed.toLowerCase());
  if (ascii === "") {
    throw new InvalidEgressConfigError(`invalid egress domain pattern: ${domain}`);
  }
  buildEgressNetworkProfile({ allowedDomains: [ascii] });
  return ascii;
}

function replaceControlCharacters(value: string): string {
  let output = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    output += code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) ? " " : char;
  }
  return output;
}

export function oneLineReviewText(value: string): string {
  const sanitized = replaceControlCharacters(redactText(value))
    .replace(BIDI_CONTROL, "")
    .replace(DEFAULT_IGNORABLE, "");
  const text = redactText(sanitized).replace(/\s+/gu, " ").trim();
  if (text.length <= MAX_REVIEW_COMMAND_CHARS) return text;
  const suffixLength = 48;
  let omitted = text.length - suffixLength;
  let marker = `[${omitted} chars omitted]`;
  let prefixLength = MAX_REVIEW_COMMAND_CHARS - suffixLength - marker.length;
  omitted = text.length - suffixLength - prefixLength;
  marker = `[${omitted} chars omitted]`;
  prefixLength = MAX_REVIEW_COMMAND_CHARS - suffixLength - marker.length;
  return `${text.slice(0, prefixLength)}${marker}${text.slice(-suffixLength)}`;
}

/** Returns review text only when the destructive command remains fully visible: no control/bidi
 * sanitization, secret/entropy redaction, or length abbreviation may hide the exact target. */
export function exactOneLineReviewText(value: string): string | undefined {
  if (
    replaceControlCharacters(value) !== value ||
    value.replace(BIDI_CONTROL, "") !== value ||
    value.replace(DEFAULT_IGNORABLE, "") !== value
  ) {
    return undefined;
  }
  const normalized = value.replace(/ +/gu, " ").trim();
  const rendered = oneLineReviewText(value);
  return rendered === normalized ? rendered : undefined;
}

export function formatEgressDomainForReview(domain: string): string {
  const ascii = normalizeEgressGrantDomain(domain);
  const unicode = oneLineReviewText(domainToUnicode(ascii));
  return unicode !== "" && unicode !== ascii ? `${ascii} (unicode: ${unicode})` : ascii;
}

function stripTrailingUrlPunctuation(value: string): string {
  return value.replace(/[),.;]+$/u, "");
}

export function extractExplicitEgressTarget(command: string): ExplicitEgressTarget {
  for (const match of command.matchAll(EXPLICIT_HTTP_URL)) {
    const token = stripTrailingUrlPunctuation(match[0] ?? "");
    if (token === "") continue;
    let url: URL;
    try {
      url = new URL(token);
    } catch {
      continue;
    }
    try {
      const domain = normalizeEgressGrantDomain(url.hostname);
      return { kind: "domain", domain, url: token };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: "invalid", target: url.hostname, reason };
    }
  }
  return { kind: "none" };
}

export function createPendingEgressReview(
  state: EgressReviewState,
  options: {
    readonly domain: string;
    readonly command: string;
    readonly executeParams: ExecuteParams;
    readonly lifecycle?: LifecycleAuditPayload;
  },
): PendingEgressReview {
  const reviewId = `egress_review_${state.nextReviewSeq}`;
  state.nextReviewSeq += 1;
  const command = oneLineReviewText(options.command);
  const domain = normalizeEgressGrantDomain(options.domain);
  const displayDomain = formatEgressDomainForReview(domain);
  const summary = `egress to ${displayDomain} requires review: ${command}`;
  const review = {
    kind: "egress" as const,
    reviewId,
    domain,
    displayDomain,
    command: options.command,
    executeParams: options.executeParams,
    ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
    summary,
    allowCommand: `keel approve ${reviewId} --scope once --domain ${domain}`,
  };
  state.pending.set(reviewId, review);
  return review;
}

export function createPendingCommandReview(
  state: EgressReviewState,
  options: {
    readonly grantKey: `sha256:${string}`;
    readonly approvalScope?: "grantable" | "once-only";
    readonly command: string;
    readonly executeParams: ExecuteParams;
    readonly auditPolicyInput: PolicyInputT;
    readonly lifecycle?: LifecycleAuditPayload;
  },
): PendingCommandReview {
  const reviewId = `command_review_${state.nextCommandReviewSeq}`;
  state.nextCommandReviewSeq += 1;
  const command = oneLineReviewText(options.command);
  const approvalScope = options.approvalScope ?? "grantable";
  const summary =
    approvalScope === "once-only"
      ? `workspace deletion requires exact once-only approval: ${command}`
      : `command review requires approval: ${command}`;
  const review = {
    kind: "command" as const,
    approvalScope,
    reviewId,
    command: options.command,
    executeParams: options.executeParams,
    auditPolicyInput: options.auditPolicyInput,
    ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
    grantKey: options.grantKey,
    summary,
    allowCommand:
      approvalScope === "once-only"
        ? `keel approve ${reviewId} --scope once`
        : `keel approve ${reviewId} --scope once --command-key ${options.grantKey}`,
  };
  state.pending.set(reviewId, review);
  return review;
}

function domainMatchesPattern(domain: string, pattern: string): boolean {
  if (domain === pattern) return true;
  if (!pattern.startsWith("*.")) return false;
  const suffix = pattern.slice(1);
  return domain.endsWith(suffix) && domain.length > suffix.length;
}

export function profileAllowsEgressDomain(profile: SandboxProfile, domain: string): boolean {
  const allowedDomains = profile.network?.allowedDomains ?? [];
  return allowedDomains.some((pattern) => domainMatchesPattern(domain, pattern));
}

export function withAdditionalEgressDomains(
  profile: SandboxProfile,
  domains: readonly string[],
): SandboxProfile {
  if (domains.length === 0) return profile;
  const allowedDomains = [...(profile.network?.allowedDomains ?? []), ...domains];
  return {
    ...profile,
    network: buildEgressNetworkProfile({ allowedDomains }),
  };
}
