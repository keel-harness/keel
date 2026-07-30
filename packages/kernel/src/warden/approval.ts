import { domainToASCII } from "node:url";
import type { z } from "zod";
import type { WARDEN_METHODS } from "@keel/shared";
import { oneLineText } from "../control-strip.js";

type ExecuteResult = z.infer<(typeof WARDEN_METHODS)["warden.execute"]["result"]>;
type ReviewRequired = NonNullable<ExecuteResult["review"]>;
type ResolveReviewParams = z.infer<(typeof WARDEN_METHODS)["warden.resolveReview"]["params"]>;
type ResolveReviewResult = z.infer<(typeof WARDEN_METHODS)["warden.resolveReview"]["result"]>;

const COMMAND_GRANT_KEY_RE = /^sha256:[a-f0-9]{64}$/u;
const MCP_REVIEW_ID_RE = /^mcp_review_[1-9]\d*$/u;
const CONSOLE_TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ABBREVIATED_REVIEW_RE = /\[\d+ chars omitted\]/u;
const MAX_PLAN_APPROVAL_RESOURCES = 128;

export type PlanApprovalResource =
  | { readonly kind: "domain"; readonly value: string }
  | { readonly kind: "command-key"; readonly value: string };

export interface PlanApprovalEnvelope {
  readonly planId: string;
  readonly trustedWorkspace: boolean;
  readonly resources: readonly PlanApprovalResource[];
}

export interface PlanApprovalSummary {
  readonly planId: string;
  readonly accepted: number;
  readonly rejected: number;
}

export interface RejectedPlanApprovalResource {
  readonly kind: string;
  readonly value: string;
  readonly reason: string;
}

export interface PlanApprovalPreview {
  readonly planId: string;
  readonly trustedWorkspace: boolean;
  readonly acceptedResources: readonly PlanApprovalResource[];
  readonly rejectedResources: readonly RejectedPlanApprovalResource[];
}

export type ScopedApprovalResolutionSource =
  | "session-grant"
  | "plan-approval"
  | "autopilot-command";

export interface ScopedApprovalResolution {
  readonly source: ScopedApprovalResolutionSource;
  readonly planId?: string;
  readonly resource: PlanApprovalResource;
  readonly reviewId: string;
  readonly scope: "once";
  readonly auditSeq: number;
  readonly verdict: ResolveReviewResult["verdict"];
}

export type ScopedApprovalResolutionCallback = (
  application: ScopedApprovalResolution,
) => void | Promise<void>;

export interface WardenCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ResolveReviewClient {
  call(
    method: "warden.resolveReview",
    params: ResolveReviewParams,
    options?: WardenCallOptions,
  ): Promise<ResolveReviewResult>;
}

function oneLine(value: string): string {
  return oneLineText(value);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isStrictExactEgressDomain(domain: string): boolean {
  if (domain === "") return false;
  if (
    domain === "*" ||
    domain.includes("*") ||
    domain.includes(":") ||
    domain.includes("/") ||
    domain.includes("[")
  ) {
    return false;
  }
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL_RE.test(label))) return false;
  if (!labels.some((label) => /[a-z]/u.test(label))) return false;
  if (labels.some((label) => label.startsWith("0x"))) return false;
  return true;
}

function normalizeDomain(domain: string): string | undefined {
  const normalized = domain.trim().toLowerCase();
  if (
    normalized === "*" ||
    normalized.includes("*") ||
    normalized.includes(":") ||
    normalized.includes("/") ||
    normalized.includes("[")
  ) {
    return undefined;
  }
  const ascii = domainToASCII(normalized);
  return isStrictExactEgressDomain(ascii) ? ascii : undefined;
}

function normalizeExactDomain(domain: string): string | undefined {
  const normalized = normalizeDomain(domain);
  if (normalized === undefined || normalized.includes("*")) return undefined;
  return normalized;
}

function normalizeCommandGrantKey(key: string): string | undefined {
  const normalized = key.trim();
  return COMMAND_GRANT_KEY_RE.test(normalized) ? normalized : undefined;
}

function planIdFrom(envelope: Record<string, unknown> | undefined): string {
  const planId = envelope?.["planId"];
  if (typeof planId !== "string") return "plan";
  const normalized = oneLine(planId);
  return normalized === "" ? "plan" : normalized;
}

function planResourcesFrom(envelope: Record<string, unknown> | undefined): readonly unknown[] {
  const resources = envelope?.["resources"];
  return Array.isArray(resources) ? resources : [];
}

function previewRejectedResource(
  rawResource: unknown,
  reason: string,
): RejectedPlanApprovalResource {
  const resource = recordOf(rawResource);
  const kind = resource?.["kind"];
  const value = resource?.["value"];
  return {
    kind: typeof kind === "string" ? oneLine(kind) : "resource",
    value: typeof value === "string" ? oneLine(value) : "(invalid)",
    reason,
  };
}

function reviewDomain(review: ReviewRequired): string | undefined {
  const match = /(?:^|\s)--domain\s+([^\s]+)/u.exec(review.allowCommand);
  if (match?.[1] === undefined) return undefined;
  return normalizeDomain(match[1]);
}

function reviewCommandKey(review: ReviewRequired): string | undefined {
  const match = /(?:^|\s)--command-key\s+(sha256:[a-f0-9]{64})(?:\s|$)/u.exec(review.allowCommand);
  return match?.[1];
}

function reviewConsoleTarget(review: ReviewRequired): string | undefined {
  const match = /(?:^|\s)--console-target\s+([^\s]+)(?:\s|$)/u.exec(review.allowCommand);
  const target = match?.[1];
  return target !== undefined && CONSOLE_TARGET_RE.test(target) ? target : undefined;
}

function reviewConsoleKey(review: ReviewRequired): string | undefined {
  const match = /(?:^|\s)--console-key\s+(sha256:[a-f0-9]{64})(?:\s|$)/u.exec(review.allowCommand);
  return match?.[1];
}

function reviewResource(review: ReviewRequired): PlanApprovalResource | undefined {
  const domain = reviewDomain(review);
  if (domain !== undefined) return { kind: "domain", value: domain };
  const commandKey = reviewCommandKey(review);
  return commandKey === undefined ? undefined : { kind: "command-key", value: commandKey };
}

function isExactOnceMcpReview(review: ReviewRequired): boolean {
  return (
    MCP_REVIEW_ID_RE.test(review.reviewId) &&
    oneLine(review.allowCommand) === `keel approve ${review.reviewId} --scope once`
  );
}

export type ReviewApprovalPresentationResource =
  | { readonly status: "available"; readonly kind: "domain"; readonly value: string }
  | { readonly status: "available"; readonly kind: "command-envelope"; readonly value: string }
  | {
      readonly status: "available";
      readonly kind: "console";
      readonly target: string;
      readonly key: string;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "no exact reusable resource in the Warden review";
    };

export interface ReviewApprovalPresentation {
  readonly summaryCompleteness: "complete" | "abbreviated";
  readonly exactResource: ReviewApprovalPresentationResource;
  readonly sessionAvailable: boolean;
}

/** One parser owns both displayed resource identity and live-session eligibility. */
export function reviewApprovalPresentation(review: ReviewRequired): ReviewApprovalPresentation {
  const summaryCompleteness = ABBREVIATED_REVIEW_RE.test(review.summary)
    ? "abbreviated"
    : "complete";
  const consoleTarget = reviewConsoleTarget(review);
  const consoleKey = reviewConsoleKey(review);
  if (consoleTarget !== undefined && consoleKey !== undefined) {
    return {
      summaryCompleteness,
      exactResource: {
        status: "available",
        kind: "console",
        target: consoleTarget,
        key: consoleKey,
      },
      sessionAvailable: false,
    };
  }
  const resource = reviewResource(review);
  if (resource === undefined) {
    return {
      summaryCompleteness,
      exactResource: {
        status: "unavailable",
        reason: "no exact reusable resource in the Warden review",
      },
      sessionAvailable: false,
    };
  }
  return {
    summaryCompleteness,
    exactResource:
      resource.kind === "domain"
        ? { status: "available", kind: "domain", value: resource.value }
        : { status: "available", kind: "command-envelope", value: resource.value },
    sessionAvailable: summaryCompleteness === "complete",
  };
}

export interface ReviewApprovalOptions {
  readonly sessionAvailable: boolean;
  readonly project?: {
    readonly kind: "domain" | "command";
    readonly impact: string;
  };
}

/** Exact scopes the live warden review can structurally resolve. Console and generic reviews stay
 * once-only; project/session choices exist only when the warden supplied a validated exact resource. */
export function reviewApprovalOptions(review: ReviewRequired): ReviewApprovalOptions {
  const presentation = reviewApprovalPresentation(review);
  // Persistent approval requires the complete warden-owned target. A bounded summary that omitted
  // command text may still be approved once, but cannot create session or project authority.
  if (!presentation.sessionAvailable || presentation.exactResource.status !== "available") {
    return { sessionAvailable: false };
  }
  if (presentation.exactResource.kind === "domain") {
    return {
      sessionAvailable: true,
      project: {
        kind: "domain",
        impact: `project scope: remembers exact domain ${presentation.exactResource.value} for this workspace; policy/provenance checks still apply · revoke: keel autopilot grants revoke --domain ${presentation.exactResource.value}`,
      },
    };
  }
  if (presentation.exactResource.kind !== "command-envelope") {
    return { sessionAvailable: false };
  }
  return {
    sessionAvailable: true,
    project: {
      kind: "command",
      impact: `project scope: remembers this exact command envelope for this workspace; policy/provenance checks still apply · revoke: keel autopilot grants revoke --command-key ${presentation.exactResource.value}`,
    },
  };
}

export function reviewHasSessionGrantResource(review: ReviewRequired): boolean {
  return reviewApprovalOptions(review).sessionAvailable;
}

function resourceValueIn(
  resource: PlanApprovalResource,
  domains: ReadonlySet<string>,
  commandKeys: ReadonlySet<string>,
): boolean {
  return resource.kind === "domain" ? domains.has(resource.value) : commandKeys.has(resource.value);
}

function notifyScopedApprovalResolved(
  onResolved: ScopedApprovalResolutionCallback | undefined,
  application: ScopedApprovalResolution,
): void {
  if (onResolved === undefined) return;
  try {
    void Promise.resolve(onResolved(application)).catch(() => undefined);
  } catch {
    /* Optional receipt/attribution observers are non-authoritative. */
  }
}

export function renderScopedApprovalLine(review: ReviewRequired): string {
  const summary = oneLine(review.summary);
  const allow = oneLine(review.allowCommand);
  if (reviewConsoleTarget(review) !== undefined && reviewConsoleKey(review) !== undefined) {
    return `console review: ${summary}; [a] once [d] deny [?] why; exact console target only; allow: ${allow}`;
  }
  if (reviewCommandKey(review) !== undefined) {
    return `command review: ${summary}; [a] once [s] session [d] deny [?] why; project scope is configured through Project Autopilot; exact command envelope only; allow: ${allow}`;
  }
  if (reviewDomain(review) !== undefined) {
    return `egress review: ${summary}; [a] once [s] session [d] deny [?] why; project scope is configured through Project Autopilot; exact domain only; allow: ${allow}`;
  }
  if (isExactOnceMcpReview(review)) {
    return `mcp review: ${summary}; [a] once [d] deny [?] why; exact local MCP call only; allow: ${allow}`;
  }
  return `command review: ${summary}; [a] once [d] deny [?] why; this action only; allow: ${allow}`;
}

export function renderPendingReviewCount(count: number): string | undefined {
  if (count <= 0) return undefined;
  return count === 1 ? "1 review item pending" : `${count} review items pending`;
}

export function renderScopedApprovalBatch(reviews: readonly ReviewRequired[]): string | undefined {
  const count = renderPendingReviewCount(reviews.length);
  if (count === undefined) return undefined;
  return [
    count,
    ...reviews.map((review, index) => `${index + 1}. ${renderScopedApprovalLine(review)}`),
  ].join("\n");
}

export class ScopedEgressApprovals {
  readonly #sessionDomains = new Set<string>();
  readonly #sessionCommandKeys = new Set<string>();
  readonly #planDomains = new Set<string>();
  readonly #planCommandKeys = new Set<string>();
  #activePlanId: string | undefined;

  constructor(initialDomains: readonly string[] = []) {
    for (const domain of initialDomains) {
      const normalized = normalizeDomain(domain);
      if (normalized !== undefined) this.#sessionDomains.add(normalized);
    }
  }

  clearPlanApproval(planId?: string): boolean {
    if (this.#activePlanId === undefined) return false;
    if (planId !== undefined && planId !== this.#activePlanId) return false;
    this.#planDomains.clear();
    this.#planCommandKeys.clear();
    this.#activePlanId = undefined;
    return true;
  }

  rememberPlanApproval(envelope: unknown): PlanApprovalSummary {
    this.clearPlanApproval();
    const record = recordOf(envelope);
    const planId = planIdFrom(record);
    const resources = planResourcesFrom(record);
    let accepted = 0;
    let rejected = 0;

    if (record === undefined || !Array.isArray(record["resources"])) {
      return { planId, accepted, rejected: 1 };
    }

    if (resources.length > MAX_PLAN_APPROVAL_RESOURCES) {
      return { planId, accepted, rejected: resources.length };
    }

    if (record["trustedWorkspace"] !== true) {
      return {
        planId,
        accepted,
        rejected: resources.length,
      };
    }
    this.#activePlanId = planId;
    for (const rawResource of resources) {
      const resource = recordOf(rawResource);
      const kind = resource?.["kind"];
      const value = resource?.["value"];
      if (resource === undefined || typeof value !== "string") {
        rejected += 1;
        continue;
      }
      if (kind === "domain") {
        const domain = normalizeExactDomain(value);
        if (domain === undefined) {
          rejected += 1;
          continue;
        }
        this.#planDomains.add(domain);
        accepted += 1;
        continue;
      }
      if (kind !== "command-key") {
        rejected += 1;
        continue;
      }
      const commandKey = normalizeCommandGrantKey(value);
      if (commandKey === undefined) {
        rejected += 1;
        continue;
      }
      this.#planCommandKeys.add(commandKey);
      accepted += 1;
    }
    return { planId, accepted, rejected };
  }

  rememberSessionGrant(review: ReviewRequired): boolean {
    const domain = reviewDomain(review);
    if (domain !== undefined) {
      this.#sessionDomains.add(domain);
      return true;
    }
    const commandKey = reviewCommandKey(review);
    if (commandKey === undefined) return false;
    this.#sessionCommandKeys.add(commandKey);
    return true;
  }

  #approvalMatch(review: ReviewRequired):
    | {
        readonly source: Exclude<ScopedApprovalResolutionSource, "autopilot-command">;
        readonly planId?: string;
        readonly resource: PlanApprovalResource;
      }
    | undefined {
    const resource = reviewResource(review);
    if (resource === undefined) return undefined;
    const planMatched = resourceValueIn(resource, this.#planDomains, this.#planCommandKeys);
    if (this.#activePlanId !== undefined) {
      if (!planMatched) return undefined;
      return {
        source: "plan-approval",
        planId: this.#activePlanId,
        resource,
      };
    }
    if (resourceValueIn(resource, this.#sessionDomains, this.#sessionCommandKeys)) {
      return { source: "session-grant", resource };
    }
    if (planMatched) {
      return { source: "plan-approval", resource };
    }
    return undefined;
  }

  canApplySessionGrant(review: ReviewRequired): boolean {
    return this.#approvalMatch(review) !== undefined;
  }

  async tryApplySessionGrant(
    result: ExecuteResult,
    client: ResolveReviewClient,
    principal: ResolveReviewParams["principal"],
    options?: WardenCallOptions,
    onResolved?: ScopedApprovalResolutionCallback,
  ): Promise<ResolveReviewResult | undefined> {
    if (result.verdict !== "review" || result.review === undefined) return undefined;
    const match = this.#approvalMatch(result.review);
    if (match === undefined) return undefined;
    const resolved = await client.call(
      "warden.resolveReview",
      {
        reviewId: result.review.reviewId,
        approved: true,
        principal,
        scope: "once",
      },
      options,
    );
    notifyScopedApprovalResolved(onResolved, {
      ...match,
      reviewId: result.review.reviewId,
      scope: "once",
      auditSeq: resolved.auditSeq,
      verdict: resolved.verdict,
    });
    return resolved;
  }
}

export function summarizePlanApprovalEnvelope(envelope: unknown): PlanApprovalSummary {
  return new ScopedEgressApprovals().rememberPlanApproval(envelope);
}

export function previewPlanApprovalEnvelope(envelope: unknown): PlanApprovalPreview {
  const record = recordOf(envelope);
  const planId = planIdFrom(record);
  const trustedWorkspace = record?.["trustedWorkspace"] === true;
  const resources = planResourcesFrom(record);
  const acceptedResources: PlanApprovalResource[] = [];
  const rejectedResources: RejectedPlanApprovalResource[] = [];

  if (record === undefined || !Array.isArray(record["resources"])) {
    rejectedResources.push({
      kind: "resource",
      value: "(invalid)",
      reason: "missing resources",
    });
    return { planId, trustedWorkspace, acceptedResources, rejectedResources };
  }

  if (resources.length > MAX_PLAN_APPROVAL_RESOURCES) {
    rejectedResources.push(
      ...resources.map((resource) =>
        previewRejectedResource(
          resource,
          `too many resources (max ${MAX_PLAN_APPROVAL_RESOURCES})`,
        ),
      ),
    );
    return { planId, trustedWorkspace, acceptedResources, rejectedResources };
  }

  if (!trustedWorkspace) {
    rejectedResources.push(
      ...resources.map((resource) => previewRejectedResource(resource, "workspace not trusted")),
    );
    return { planId, trustedWorkspace, acceptedResources, rejectedResources };
  }

  for (const rawResource of resources) {
    const resource = recordOf(rawResource);
    const kind = resource?.["kind"];
    const value = resource?.["value"];
    if (resource === undefined || typeof value !== "string") {
      rejectedResources.push(previewRejectedResource(rawResource, "invalid resource"));
      continue;
    }
    if (kind === "domain") {
      const domain = normalizeExactDomain(value);
      if (domain === undefined) {
        rejectedResources.push(previewRejectedResource(rawResource, "invalid exact domain"));
        continue;
      }
      acceptedResources.push({ kind: "domain", value: domain });
      continue;
    }
    if (kind !== "command-key") {
      rejectedResources.push(previewRejectedResource(rawResource, "unknown resource kind"));
      continue;
    }
    const commandKey = normalizeCommandGrantKey(value);
    if (commandKey === undefined) {
      rejectedResources.push(previewRejectedResource(rawResource, "invalid command key"));
      continue;
    }
    acceptedResources.push({ kind: "command-key", value: commandKey });
  }

  return { planId, trustedWorkspace, acceptedResources, rejectedResources };
}

export async function tryApplyAutopilotCommandReview(
  result: ExecuteResult,
  client: ResolveReviewClient,
  principal: ResolveReviewParams["principal"],
  options?: WardenCallOptions,
  onResolved?: ScopedApprovalResolutionCallback,
): Promise<ResolveReviewResult | undefined> {
  if (result.verdict !== "review" || result.review === undefined) return undefined;
  const commandKey = reviewCommandKey(result.review);
  if (commandKey === undefined) return undefined;
  const resolved = await client.call(
    "warden.resolveReview",
    {
      reviewId: result.review.reviewId,
      approved: true,
      principal,
      scope: "once",
    },
    options,
  );
  notifyScopedApprovalResolved(onResolved, {
    source: "autopilot-command",
    resource: { kind: "command-key", value: commandKey },
    reviewId: result.review.reviewId,
    scope: "once",
    auditSeq: resolved.auditSeq,
    verdict: resolved.verdict,
  });
  return resolved;
}
