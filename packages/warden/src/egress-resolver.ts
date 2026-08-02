import { lookup as dnsLookup } from "node:dns";

import {
  classifyEgressAddress,
  classifyEgressHostname,
  parseCanonicalAddress,
  type EgressAddressClassification,
} from "./egress-address-policy.js";
import { normalizeEgressGrantDomain } from "./egress-review.js";

export const EGRESS_ADDRESS_GUARD_LIMITS = Object.freeze({
  maxAnswers: 16,
  maxConcurrentLookups: 8,
  maxQueuedLookups: 32,
  requestDeadlineMs: 5_000,
  maxConcurrentGuardedConnections: 64,
  totalDialTimeMs: 30_000,
  maxDiagnosticLength: 160,
  denialBurstLimit: 64,
  denialWindowMs: 1_000,
  shutdownTimeoutMs: 5_000,
});

export interface EgressResolverLookupAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type EgressResolverLookup = (
  hostname: string,
  options: { readonly all: true; readonly verbatim: true },
  callback: (
    error: NodeJS.ErrnoException | Error | null,
    addresses: readonly EgressResolverLookupAddress[],
  ) => void,
) => void;

export type EgressAddressGuardErrorCode =
  | "answer-limit"
  | "audit-failure"
  | "duplicate-answer"
  | "empty-answer-set"
  | "exception-authority-failure"
  | "family-mismatch"
  | "guard-quarantined"
  | "guard-shutdown"
  | "hard-deny"
  | "hard-deny-name"
  | "invalid-request"
  | "malformed-answer"
  | "restricted-address-not-excepted"
  | "resolver-aborted"
  | "resolver-failure"
  | "resolver-queue-full"
  | "resolver-timeout";

export class EgressAddressGuardError extends Error {
  readonly code: EgressAddressGuardErrorCode;

  constructor(code: EgressAddressGuardErrorCode) {
    super("egress address guard denied the connection");
    this.name = "EgressAddressGuardError";
    this.code = code;
  }
}

export interface EgressResolverDenialAuditRecord {
  readonly kind: "denial";
  readonly host: string;
  readonly port: number;
  readonly reason: EgressAddressGuardErrorCode;
  readonly addressClass: "hard-deny" | "restricted" | "unknown";
  readonly answerCount: number;
  readonly exceptionPolicyRevision: string;
}

export interface EgressResolverQuarantineAuditRecord {
  readonly kind: "quarantine";
  readonly host: string;
  readonly port: number;
  readonly reason: "audit-failure" | "denial-rate-quarantine";
  readonly addressClass: "unknown";
  readonly answerCount: number;
  readonly exceptionPolicyRevision: string;
}

export type EgressResolverAuditRecord =
  | EgressResolverDenialAuditRecord
  | EgressResolverQuarantineAuditRecord;

export interface RestrictedAddressContext {
  readonly hostname: string;
  readonly port: number;
  readonly address: string;
  readonly family: 4 | 6;
  readonly classification: EgressAddressClassification;
}

export interface BoundedEgressAddressResolverOptions {
  readonly lookup?: EgressResolverLookup;
  readonly audit: { append(record: EgressResolverAuditRecord): void };
  readonly onQuarantine: (reason: "audit-failure" | "denial-rate-quarantine") => void;
  readonly allowsRestrictedAddress?: (context: RestrictedAddressContext) => boolean;
  readonly exceptionPolicyRevision?: string;
  /** Monotonic-enough wall clock seam for deterministic rate-window tests. */
  readonly now?: () => number;
}

export interface EgressResolverSnapshot {
  readonly state: "active" | "quarantined" | "shutdown";
  readonly activeLookups: number;
  readonly queuedLookups: number;
}

export interface EgressResolverShutdownResult {
  readonly drained: boolean;
  readonly activeLookups: number;
}

export interface BoundedEgressAddressResolver {
  resolveDestination(
    hostname: string,
    port: number,
    signal: AbortSignal,
  ): Promise<readonly EgressResolverLookupAddress[]>;
  snapshot(): EgressResolverSnapshot;
  shutdown(): Promise<EgressResolverShutdownResult>;
}

type ResolverState = EgressResolverSnapshot["state"];
type LookupCallback = Parameters<EgressResolverLookup>[2];

interface LookupTask {
  readonly hostname: string;
  readonly signal: AbortSignal;
  readonly resolve: (addresses: readonly EgressResolverLookupAddress[]) => void;
  readonly reject: (error: EgressAddressGuardError) => void;
  readonly abortListener: () => void;
  deadline: NodeJS.Timeout | undefined;
  callerSettled: boolean;
  underlyingSettled: boolean;
  phase: "queued" | "active" | "done";
}

interface AttemptContext {
  readonly host: string;
  readonly port: number;
  answerCount: number;
}

interface AnswerAssessment {
  readonly answer: EgressResolverLookupAddress;
  readonly classification: EgressAddressClassification;
}

const NO_AUDIT_CODES = new Set<EgressAddressGuardErrorCode>([
  "guard-quarantined",
  "guard-shutdown",
  "resolver-aborted",
]);

function systemLookup(
  hostname: string,
  options: { readonly all: true; readonly verbatim: true },
  callback: LookupCallback,
): void {
  dnsLookup(hostname, options, (error, addresses) => {
    callback(error, addresses as readonly EgressResolverLookupAddress[]);
  });
}

function stableError(code: EgressAddressGuardErrorCode): EgressAddressGuardError {
  return new EgressAddressGuardError(code);
}

function addressClassForCode(
  code: EgressAddressGuardErrorCode,
): EgressResolverDenialAuditRecord["addressClass"] {
  if (code === "hard-deny" || code === "hard-deny-name") return "hard-deny";
  if (code === "restricted-address-not-excepted" || code === "exception-authority-failure") {
    return "restricted";
  }
  return "unknown";
}

function validatedPolicyRevision(revision: string | undefined): string {
  const value = revision ?? "none";
  if (!/^(?:none|sha256:[a-zA-Z0-9_-]{1,80})$/.test(value)) {
    throw new Error("invalid egress exception policy revision");
  }
  return value;
}

function normalizedHostname(hostname: string): string | undefined {
  try {
    return normalizeEgressGrantDomain(hostname);
  } catch {
    return undefined;
  }
}

function firstAssessmentFailure(
  assessments: readonly AnswerAssessment[],
  validationFailures: ReadonlySet<EgressAddressGuardErrorCode>,
): EgressAddressGuardErrorCode | undefined {
  for (const code of ["malformed-answer", "family-mismatch", "duplicate-answer"] as const) {
    if (validationFailures.has(code)) return code;
  }
  return assessments.some((assessment) => assessment.classification.kind === "hard-deny")
    ? "hard-deny"
    : undefined;
}

export function createBoundedEgressAddressResolver(
  options: BoundedEgressAddressResolverOptions,
): BoundedEgressAddressResolver {
  const lookup = options.lookup ?? systemLookup;
  const now = options.now ?? Date.now;
  const exceptionPolicyRevision = validatedPolicyRevision(options.exceptionPolicyRevision);
  const activeTasks = new Set<LookupTask>();
  const queue: LookupTask[] = [];
  const denialTimes: number[] = [];
  let state: ResolverState = "active";
  let shutdownPromise: Promise<EgressResolverShutdownResult> | undefined;
  let resolveShutdown: ((result: EgressResolverShutdownResult) => void) | undefined;
  let shutdownTimer: NodeJS.Timeout | undefined;

  const snapshot = (): EgressResolverSnapshot => ({
    state,
    activeLookups: activeTasks.size,
    queuedLookups: queue.length,
  });

  const clearCallerHooks = (task: LookupTask): void => {
    if (task.deadline !== undefined) clearTimeout(task.deadline);
    task.deadline = undefined;
    task.signal.removeEventListener("abort", task.abortListener);
  };

  const settleCaller = (
    task: LookupTask,
    result:
      | { readonly kind: "resolve"; readonly addresses: readonly EgressResolverLookupAddress[] }
      | { readonly kind: "reject"; readonly code: EgressAddressGuardErrorCode },
  ): void => {
    if (task.callerSettled) return;
    task.callerSettled = true;
    clearCallerHooks(task);
    if (result.kind === "resolve") task.resolve(result.addresses);
    else task.reject(stableError(result.code));
  };

  const finishShutdownIfDrained = (): void => {
    if (activeTasks.size !== 0 || resolveShutdown === undefined) return;
    if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
    shutdownTimer = undefined;
    const finish = resolveShutdown;
    resolveShutdown = undefined;
    finish({ drained: true, activeLookups: 0 });
  };

  const removeQueuedTask = (task: LookupTask): boolean => {
    const index = queue.indexOf(task);
    if (index < 0) return false;
    queue.splice(index, 1);
    task.phase = "done";
    return true;
  };

  const drainQueue = (): void => {
    if (state !== "active") return;
    while (
      activeTasks.size < EGRESS_ADDRESS_GUARD_LIMITS.maxConcurrentLookups &&
      queue.length > 0
    ) {
      const task = queue.shift();
      if (task === undefined || task.callerSettled) continue;
      startLookup(task);
    }
  };

  const completeUnderlying = (
    task: LookupTask,
    error: NodeJS.ErrnoException | Error | null,
    addresses: readonly EgressResolverLookupAddress[],
  ): void => {
    if (task.underlyingSettled) return;
    task.underlyingSettled = true;
    task.phase = "done";
    activeTasks.delete(task);
    if (!task.callerSettled) {
      if (error === null && Array.isArray(addresses)) {
        settleCaller(task, { kind: "resolve", addresses });
      } else {
        settleCaller(task, { kind: "reject", code: "resolver-failure" });
      }
    }
    drainQueue();
    finishShutdownIfDrained();
  };

  function startLookup(task: LookupTask): void {
    if (task.callerSettled || state !== "active") return;
    task.phase = "active";
    activeTasks.add(task);
    const callback: LookupCallback = (error, addresses) => {
      completeUnderlying(task, error, addresses);
    };
    try {
      lookup(task.hostname, { all: true, verbatim: true }, callback);
    } catch {
      completeUnderlying(task, new Error("resolver threw"), []);
    }
  }

  const cancelOutstanding = (code: EgressAddressGuardErrorCode): void => {
    for (const task of queue.splice(0)) {
      task.phase = "done";
      settleCaller(task, { kind: "reject", code });
    }
    for (const task of activeTasks) settleCaller(task, { kind: "reject", code });
  };

  const appendQuarantineAndStop = (
    reason: EgressResolverQuarantineAuditRecord["reason"],
    context: AttemptContext,
  ): boolean => {
    if (state !== "active") return false;
    let auditFailed = false;
    try {
      options.audit.append({
        kind: "quarantine",
        host: context.host,
        port: context.port,
        reason,
        addressClass: "unknown",
        answerCount: context.answerCount,
        exceptionPolicyRevision,
      });
    } catch {
      auditFailed = true;
    }
    state = "quarantined";
    cancelOutstanding("guard-quarantined");
    try {
      options.onQuarantine(auditFailed ? "audit-failure" : reason);
    } catch {
      // Quarantine is already terminal. Raw teardown diagnostics never reach the caller.
    }
    return auditFailed;
  };

  const appendDenial = (
    code: EgressAddressGuardErrorCode,
    context: AttemptContext,
  ): "audit-failure" | undefined => {
    try {
      options.audit.append({
        kind: "denial",
        host: context.host,
        port: context.port,
        reason: code,
        addressClass: addressClassForCode(code),
        answerCount: context.answerCount,
        exceptionPolicyRevision,
      });
    } catch {
      appendQuarantineAndStop("audit-failure", context);
      return "audit-failure";
    }

    const timestamp = now();
    const oldestAllowed = timestamp - EGRESS_ADDRESS_GUARD_LIMITS.denialWindowMs;
    while (denialTimes.length > 0 && denialTimes[0]! < oldestAllowed) denialTimes.shift();
    denialTimes.push(timestamp);
    if (denialTimes.length >= EGRESS_ADDRESS_GUARD_LIMITS.denialBurstLimit) {
      const transitionAuditFailed = appendQuarantineAndStop("denial-rate-quarantine", context);
      if (transitionAuditFailed) return "audit-failure";
    }
    return undefined;
  };

  const deny = (code: EgressAddressGuardErrorCode, context: AttemptContext): never => {
    if (!NO_AUDIT_CODES.has(code)) {
      const replacement = appendDenial(code, context);
      if (replacement !== undefined) throw stableError(replacement);
    }
    throw stableError(code);
  };

  const scheduleLookup = (
    hostname: string,
    signal: AbortSignal,
  ): Promise<readonly EgressResolverLookupAddress[]> => {
    if (signal.aborted) return Promise.reject(stableError("resolver-aborted"));
    if (
      activeTasks.size >= EGRESS_ADDRESS_GUARD_LIMITS.maxConcurrentLookups &&
      queue.length >= EGRESS_ADDRESS_GUARD_LIMITS.maxQueuedLookups
    ) {
      return Promise.reject(stableError("resolver-queue-full"));
    }

    return new Promise((resolve, reject) => {
      const task = {} as LookupTask;
      const abortListener = (): void => {
        if (task.phase === "queued") removeQueuedTask(task);
        settleCaller(task, { kind: "reject", code: "resolver-aborted" });
      };
      Object.assign(task, {
        hostname,
        signal,
        resolve,
        reject,
        abortListener,
        callerSettled: false,
        underlyingSettled: false,
        phase: "queued",
      } satisfies Omit<LookupTask, "deadline">);
      task.deadline = setTimeout(() => {
        if (task.phase === "queued") removeQueuedTask(task);
        settleCaller(task, { kind: "reject", code: "resolver-timeout" });
      }, EGRESS_ADDRESS_GUARD_LIMITS.requestDeadlineMs);
      signal.addEventListener("abort", abortListener, { once: true });

      if (activeTasks.size < EGRESS_ADDRESS_GUARD_LIMITS.maxConcurrentLookups) {
        startLookup(task);
      } else {
        queue.push(task);
      }
    });
  };

  const assessAnswers = (
    hostname: string,
    port: number,
    rawAnswers: readonly EgressResolverLookupAddress[],
    context: AttemptContext,
  ): readonly EgressResolverLookupAddress[] => {
    context.answerCount = rawAnswers.length;
    if (rawAnswers.length === 0) return deny("empty-answer-set", context);
    if (rawAnswers.length > EGRESS_ADDRESS_GUARD_LIMITS.maxAnswers) {
      return deny("answer-limit", context);
    }

    const seen = new Set<string>();
    const assessments: AnswerAssessment[] = [];
    const validationFailures = new Set<EgressAddressGuardErrorCode>();
    for (const raw of rawAnswers) {
      if (
        typeof raw !== "object" ||
        raw === null ||
        typeof raw.address !== "string" ||
        (raw.family !== 4 && raw.family !== 6)
      ) {
        validationFailures.add("malformed-answer");
        continue;
      }
      const parsed = parseCanonicalAddress(raw.address);
      if (parsed === undefined) {
        validationFailures.add("malformed-answer");
        continue;
      }
      if (parsed.family !== raw.family) {
        validationFailures.add("family-mismatch");
        continue;
      }
      const key = `${String(parsed.family)}:${parsed.normalized}`;
      if (seen.has(key)) validationFailures.add("duplicate-answer");
      seen.add(key);
      assessments.push({
        answer: { address: parsed.normalized, family: parsed.family },
        classification: classifyEgressAddress(parsed.normalized),
      });
    }

    const initialFailure = firstAssessmentFailure(assessments, validationFailures);
    if (initialFailure !== undefined) return deny(initialFailure, context);

    let restrictedFailure = false;
    let exceptionAuthorityFailure = false;
    for (const assessment of assessments) {
      if (assessment.classification.kind !== "restricted") continue;
      try {
        if (
          options.allowsRestrictedAddress?.({
            hostname,
            port,
            address: assessment.answer.address,
            family: assessment.answer.family,
            classification: assessment.classification,
          }) !== true
        ) {
          restrictedFailure = true;
        }
      } catch {
        exceptionAuthorityFailure = true;
      }
    }
    if (exceptionAuthorityFailure) return deny("exception-authority-failure", context);
    if (restrictedFailure) return deny("restricted-address-not-excepted", context);
    return Object.freeze(assessments.map(({ answer }) => Object.freeze({ ...answer })));
  };

  const resolveDestination = async (
    hostname: string,
    port: number,
    signal: AbortSignal,
  ): Promise<readonly EgressResolverLookupAddress[]> => {
    if (state === "quarantined") throw stableError("guard-quarantined");
    if (state === "shutdown") throw stableError("guard-shutdown");
    if (signal.aborted) throw stableError("resolver-aborted");

    const literal = parseCanonicalAddress(hostname);
    const normalizedHost = literal?.normalized ?? normalizedHostname(hostname);
    const context: AttemptContext = {
      host: literal === undefined ? (normalizedHost ?? "invalid-host") : "ip-literal",
      port,
      answerCount: 0,
    };
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || normalizedHost === undefined) {
      return deny("invalid-request", context);
    }

    if (literal === undefined) {
      const hostnameClassification = classifyEgressHostname(normalizedHost);
      if (hostnameClassification.kind === "hard-deny") return deny("hard-deny-name", context);
    }

    let rawAnswers: readonly EgressResolverLookupAddress[];
    if (literal !== undefined) {
      rawAnswers = [{ address: literal.normalized, family: literal.family }];
    } else {
      try {
        rawAnswers = await scheduleLookup(normalizedHost, signal);
      } catch (error) {
        if (error instanceof EgressAddressGuardError) {
          if (NO_AUDIT_CODES.has(error.code)) throw error;
          return deny(error.code, context);
        }
        return deny("resolver-failure", context);
      }
    }
    return assessAnswers(normalizedHost, port, rawAnswers, context);
  };

  const shutdown = (): Promise<EgressResolverShutdownResult> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    if (state === "active") state = "shutdown";
    cancelOutstanding(state === "quarantined" ? "guard-quarantined" : "guard-shutdown");
    shutdownPromise = new Promise((resolve) => {
      if (activeTasks.size === 0) {
        resolve({ drained: true, activeLookups: 0 });
        return;
      }
      resolveShutdown = resolve;
      shutdownTimer = setTimeout(() => {
        const finish = resolveShutdown;
        resolveShutdown = undefined;
        shutdownTimer = undefined;
        finish?.({ drained: false, activeLookups: activeTasks.size });
      }, EGRESS_ADDRESS_GUARD_LIMITS.shutdownTimeoutMs);
    });
    return shutdownPromise;
  };

  return { resolveDestination, snapshot, shutdown };
}
