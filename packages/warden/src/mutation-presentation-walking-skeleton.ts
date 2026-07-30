import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  MutationPresentationV1,
  type MutationPresentationTakeParamsV1T,
  type MutationPresentationTakeResultV1T,
  type MutationPresentationUnavailableReasonV1T,
  type MutationPresentationV1T,
} from "@keel/shared";
import {
  MUTATION_PRESENTATION_ACTIVE_WORKING_RESERVATION_BYTES,
  MUTATION_PRESENTATION_BASE_BOOKKEEPING_BYTES,
  MUTATION_PRESENTATION_KEY_BYTES,
  MUTATION_PRESENTATION_MAX_CANDIDATE_METADATA_BYTES,
  MUTATION_PRESENTATION_MAX_GLOBAL_BYTES,
  MUTATION_PRESENTATION_MAX_IMAGE_BYTES,
  MUTATION_PRESENTATION_RECORD_BOOKKEEPING_BYTES,
  ConstructionBudgetExceededError,
  assertArtifactWithinQuantitativeBounds,
  boundedStringStorageBytes,
  createMutationPresentationConstructionControl,
  stringStorageBytes,
  type MutationPresentationConstructionControl,
} from "./mutation-presentation-bounds.js";
import type {
  TypedMutationPresentationCandidate,
  TypedMutationPresentationCandidateV1,
} from "./typed-mutation-runner.js";

export {
  MUTATION_PRESENTATION_CONSTRUCTION_DEADLINE_MS,
  MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES,
  MUTATION_PRESENTATION_MAX_DIFF_SCALAR_OPERATIONS,
  MUTATION_PRESENTATION_MAX_GLOBAL_BYTES,
  MUTATION_PRESENTATION_MAX_HUNKS,
  MUTATION_PRESENTATION_MAX_IMAGE_BYTES,
  MUTATION_PRESENTATION_MAX_INDEXED_LINES,
  MUTATION_PRESENTATION_MAX_LINE_BYTES,
  MUTATION_PRESENTATION_MAX_PATH_BYTES,
  MUTATION_PRESENTATION_MAX_PRESENTED_LINES,
  MUTATION_PRESENTATION_MAX_REDACTION_BYTE_VISITS,
  MUTATION_PRESENTATION_MAX_REDACTION_METADATA_RECORDS,
  MUTATION_PRESENTATION_YIELD_BYTE_WORK,
  MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS,
  MUTATION_PRESENTATION_YIELD_WALL_MS,
} from "./mutation-presentation-bounds.js";
export type {
  MutationPresentationConstructionControl,
  MutationPresentationConstructionWork,
} from "./mutation-presentation-bounds.js";

export const MUTATION_PRESENTATION_MAX_PENDING_CANDIDATES = 2;
export const MUTATION_PRESENTATION_MAX_PENDING_BYTES = 8 * 1024 * 1024;
export const MUTATION_PRESENTATION_MAX_FINALIZED_ARTIFACTS = 16;
export const MUTATION_PRESENTATION_MAX_FINALIZED_ARTIFACT_BYTES = 4 * 1024 * 1024;
export const MUTATION_PRESENTATION_MAX_TERMINAL_DISPOSITIONS = 64;
export const MUTATION_PRESENTATION_MAX_TERMINAL_DISPOSITION_BYTES = 64 * 1024;
export const MUTATION_PRESENTATION_PENDING_RETRY_MS = 25;
/** Applies only after the transport owns a construction generation. */
export const MUTATION_PRESENTATION_PENDING_TTL_MS = 2_000;
export const MUTATION_PRESENTATION_FINALIZED_TTL_MS = 30_000;

/** Internal candidate sidecar. Raw contents remain in Warden memory and are never an RPC field. */
export interface WardenMutationPresentationCandidate extends TypedMutationPresentationCandidate {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly auditSeq: number;
}

export type WardenMutationPresentationCandidateV1 = TypedMutationPresentationCandidateV1 & {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly auditSeq: number;
};

/** Constructor-only enrichment. The keyed identity is minted inside the bounded transport. */
export type WardenMutationPresentationConstructionCandidate =
  WardenMutationPresentationCandidate & { readonly pathIdentity: string };
export type WardenWriteMutationPresentationConstructionCandidate = Extract<
  WardenMutationPresentationCandidateV1,
  { readonly operation: "write" }
> & { readonly pathIdentity: string };
export type WardenMutationPresentationConstructionCandidateV1 =
  | WardenMutationPresentationConstructionCandidate
  | WardenWriteMutationPresentationConstructionCandidate;

export interface MutationPresentationPreAuditIdentity {
  readonly sessionId: string;
  readonly toolCallId: string;
}

export interface MutationPresentationImageByteLengths {
  readonly observedBeforeBytes: number;
  readonly verifiedInstalledAfterBytes: number;
}

const reservationBrand: unique symbol = Symbol("MutationPresentationAdmissionReservation");

/** Opaque, process-local authority. It deliberately has no serializable own properties. */
export interface MutationPresentationAdmissionReservation {
  readonly [reservationBrand]: true;
}

export type MutationPresentationAdmissionDecision =
  | {
      readonly status: "reserved";
      readonly reservation: MutationPresentationAdmissionReservation;
    }
  | { readonly status: "refused"; readonly reason: "capture-budget" };

export type WardenMutationPresentationFinalization =
  | {
      readonly kind: "candidate";
      readonly reservation: MutationPresentationAdmissionReservation;
      readonly candidate: WardenMutationPresentationCandidateV1;
    }
  | {
      readonly kind: "unavailable";
      readonly params: MutationPresentationTakeParamsV1T;
      readonly reason: Extract<
        MutationPresentationUnavailableReasonV1T,
        "capture-budget" | "capture-unavailable"
      >;
      readonly reservation?: MutationPresentationAdmissionReservation;
    };

export interface MutationPresentationWalkingSkeletonTransport {
  /** Historical field name retained for source compatibility. It is not sufficient to advertise:
   * RPC additionally requires a 1.1 peer, audit, typed mutation enforcement, and a live sandbox. */
  readonly advertiseTestCapability: true;
  reserve(
    identity: MutationPresentationPreAuditIdentity,
    images: MutationPresentationImageByteLengths,
  ): MutationPresentationAdmissionDecision;
  pendingUsage(): { readonly candidates: number; readonly bytes: number };
  terminalUsage(): {
    readonly artifacts: number;
    readonly artifactBytes: number;
    readonly dispositions: number;
    readonly dispositionBytes: number;
  };
  /** Conservative logical ownership ledger; this is not process RSS or a product-memory claim. */
  globalUsage(): {
    readonly bytes: number;
    readonly activeWorkingBytes: number;
    readonly ceilingBytes: number;
  };
  finalize(finalization: WardenMutationPresentationFinalization): void;
  discard(reservation: MutationPresentationAdmissionReservation): void;
  take(params: MutationPresentationTakeParamsV1T): MutationPresentationTakeResultV1T;
  clear(): Promise<void>;
}

interface Options {
  readonly construct: (
    candidate: WardenMutationPresentationConstructionCandidate,
    control: MutationPresentationConstructionControl,
  ) => MutationPresentationV1T | Promise<MutationPresentationV1T>;
  readonly constructWrite?: (
    candidate: WardenWriteMutationPresentationConstructionCandidate,
    control: MutationPresentationConstructionControl,
  ) => MutationPresentationV1T | Promise<MutationPresentationV1T>;
  readonly now?: () => number;
  readonly cooperativeYield?: () => Promise<void>;
}

interface ReservationRecord {
  readonly reservation: MutationPresentationAdmissionReservation;
  readonly identityKey: Buffer;
  readonly observedBeforeBytes: number;
  readonly verifiedInstalledAfterBytes: number;
  readonly totalBytes: number;
  readonly accountedBytes: number;
}

type AvailableResult = Extract<MutationPresentationTakeResultV1T, { readonly status: "available" }>;
type UnavailableResult = Extract<
  MutationPresentationTakeResultV1T,
  { readonly status: "unavailable" }
>;

interface TerminalRecord<Result extends AvailableResult | UnavailableResult> {
  readonly key: Buffer;
  readonly result: Result;
  readonly bytes: number;
  readonly accountedBytes: number;
  readonly expiresAt: number;
}

type ConstructionCancellation = "expired" | "shutdown" | "superseded";

interface ConstructionRecord {
  readonly key: Buffer;
  candidate: WardenMutationPresentationCandidateV1 | undefined;
  readonly rawBytes: number;
  readonly accountedBytes: number;
  readonly expiresAt: number;
  state: "active" | "queued";
  current: boolean;
  workingReserved: boolean;
  cancellation?: ConstructionCancellation;
}

type ReservationConsumption = "matched" | "missing" | "identity-mismatch" | "images-mismatch";

const ADMISSION_KEY_DOMAIN = "keel/mutation-presentation/v1/admission";
const FINAL_KEY_DOMAIN = "keel/mutation-presentation/v1/final";
const PATH_IDENTITY_DOMAIN = "keel/mutation-presentation/v1/path-identity";

class ConstructionCancelledError extends Error {
  constructor() {
    super("mutation presentation construction cancelled");
    this.name = "ConstructionCancelledError";
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function isBoundedByteLength(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value >= 0 && value <= MUTATION_PRESENTATION_MAX_IMAGE_BYTES
  );
}

function encodeStringCodeUnits(value: string): Buffer {
  const encoded = Buffer.allocUnsafe(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    encoded.writeUInt16BE(value.charCodeAt(index), index * 2);
  }
  return encoded;
}

function encodedComposite(fields: readonly string[]): Buffer {
  // JSON strings are UTF-16 code-unit sequences. Encoding them through UTF-8 would collapse every
  // distinct unpaired surrogate to U+FFFD, creating real composite-key aliases. Preserve the exact
  // parsed code units in fixed-endian form before length-prefixing each field.
  const encoded = fields.map(encodeStringCodeUnits);
  const parts: Buffer[] = [];
  for (const field of encoded) {
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(field.byteLength));
    parts.push(length, field);
  }
  return Buffer.concat(parts);
}

function hmacComposite(secret: Buffer, domain: string, fields: readonly string[]): Buffer {
  return createHmac("sha256", secret)
    .update(encodedComposite([domain, ...fields]))
    .digest();
}

function identityFields(identity: MutationPresentationPreAuditIdentity): readonly string[] {
  return [identity.sessionId, identity.toolCallId];
}

function finalFields(params: MutationPresentationTakeParamsV1T): readonly string[] {
  return [params.sessionId, params.toolCallId, String(params.auditSeq)];
}

function observedContent(
  candidate: WardenMutationPresentationCandidateV1,
): string | Uint8Array | undefined {
  if (candidate.operation === "edit") return candidate.observedBefore.content;
  return candidate.observedBefore.status === "file-observed"
    ? candidate.observedBefore.content
    : undefined;
}

function observedMetadataKey(candidate: WardenMutationPresentationCandidateV1): string {
  if (candidate.operation === "edit") return candidate.observedBefore.sha256;
  return candidate.observedBefore.status === "file-observed"
    ? candidate.observedBefore.sha256
    : candidate.observedBefore.status;
}

/** Bounded process-local transport with cooperative construction and quantitative resource limits.
 * The historical factory name is retained to avoid an unnecessary exported-API break. */
export function createMutationPresentationWalkingSkeletonTransport(
  options: Options,
): MutationPresentationWalkingSkeletonTransport {
  const secret = randomBytes(32);
  const clock = options.now ?? (() => performance.now());
  const cooperativeYield = options.cooperativeYield ?? yieldToEventLoop;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let constructorTask: Promise<void> | undefined;
  let lastNow = 0;
  let pendingCandidates = 0;
  let pendingBytes = 0;
  let artifactBytes = 0;
  let dispositionBytes = 0;
  let globalBytes = secret.byteLength + MUTATION_PRESENTATION_BASE_BOOKKEEPING_BYTES;
  let activeWorkingBytes = 0;
  let reservations = new WeakMap<object, ReservationRecord>();
  const liveRecords = new Set<ReservationRecord>();
  const constructions: ConstructionRecord[] = [];
  const artifacts: TerminalRecord<AvailableResult>[] = [];
  const dispositions: TerminalRecord<UnavailableResult>[] = [];

  const keyForIdentity = (identity: MutationPresentationPreAuditIdentity): Buffer =>
    hmacComposite(secret, ADMISSION_KEY_DOMAIN, identityFields(identity));
  const keyForFinal = (params: MutationPresentationTakeParamsV1T): Buffer =>
    hmacComposite(secret, FINAL_KEY_DOMAIN, finalFields(params));

  const boundedMetadataBytes = (values: readonly string[], fixedBytes = 0): number | undefined => {
    let total = fixedBytes;
    for (const value of values) {
      const bytes = boundedStringStorageBytes(
        value,
        MUTATION_PRESENTATION_MAX_CANDIDATE_METADATA_BYTES - total,
      );
      if (bytes === undefined) return undefined;
      total += bytes;
    }
    return total;
  };

  const identityMetadataBytes = (
    identity: MutationPresentationPreAuditIdentity,
  ): number | undefined => boundedMetadataBytes([identity.sessionId, identity.toolCallId]);

  const hasBoundedIdentity = (identity: MutationPresentationPreAuditIdentity): boolean =>
    identityMetadataBytes(identity) !== undefined;

  const readNow = (): number => {
    let sampled: number;
    try {
      sampled = clock();
    } catch {
      return lastNow;
    }
    if (Number.isFinite(sampled) && sampled >= 0 && sampled > lastNow) lastNow = sampled;
    return lastNow;
  };

  const expiryAfter = (registeredAt: number, ttlMs: number): number => {
    const expiresAt = registeredAt + ttlMs;
    return Number.isFinite(expiresAt) ? expiresAt : Number.MAX_VALUE;
  };

  const releaseGlobalBytes = (bytes: number): void => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > globalBytes) {
      throw new Error("invalid mutation presentation accounting release");
    }
    globalBytes -= bytes;
  };

  const reserveGlobalBytes = (bytes: number): boolean => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
    if (globalBytes + bytes > MUTATION_PRESENTATION_MAX_GLOBAL_BYTES) return false;
    globalBytes += bytes;
    return true;
  };

  const invalidatePendingRecord = (record: ReservationRecord): boolean => {
    if (!liveRecords.delete(record)) return false;
    reservations.delete(record.reservation);
    pendingCandidates -= 1;
    pendingBytes -= record.totalBytes;
    releaseGlobalBytes(record.accountedBytes);
    record.identityKey.fill(0);
    return true;
  };

  const discardReservation = (reservation: MutationPresentationAdmissionReservation): void => {
    const record = reservations.get(reservation);
    if (record !== undefined) invalidatePendingRecord(record);
  };

  const consumeReservation = (
    reservation: MutationPresentationAdmissionReservation,
    identity: MutationPresentationPreAuditIdentity,
    images: MutationPresentationImageByteLengths,
  ): ReservationConsumption => {
    const record = reservations.get(reservation);
    if (record === undefined) return "missing";
    if (!hasBoundedIdentity(identity)) {
      invalidatePendingRecord(record);
      return "identity-mismatch";
    }
    const suppliedIdentityKey = keyForIdentity(identity);
    const identityMatches = timingSafeEqual(record.identityKey, suppliedIdentityKey);
    suppliedIdentityKey.fill(0);
    const imagesMatch =
      record.observedBeforeBytes === images.observedBeforeBytes &&
      record.verifiedInstalledAfterBytes === images.verifiedInstalledAfterBytes;
    invalidatePendingRecord(record);
    if (!identityMatches) return "identity-mismatch";
    return imagesMatch ? "matched" : "images-mismatch";
  };

  const consumeReservationIdentity = (
    reservation: MutationPresentationAdmissionReservation,
    identity: MutationPresentationPreAuditIdentity,
  ): boolean => {
    const record = reservations.get(reservation);
    if (record === undefined) return false;
    if (!hasBoundedIdentity(identity)) {
      invalidatePendingRecord(record);
      return false;
    }
    const suppliedIdentityKey = keyForIdentity(identity);
    const identityMatches = timingSafeEqual(record.identityKey, suppliedIdentityKey);
    suppliedIdentityKey.fill(0);
    invalidatePendingRecord(record);
    return identityMatches;
  };

  const releaseArtifactAt = (index: number): void => {
    const [record] = artifacts.splice(index, 1);
    if (record === undefined) return;
    artifactBytes -= record.bytes;
    releaseGlobalBytes(record.accountedBytes);
    record.key.fill(0);
  };

  const releaseDispositionAt = (index: number): void => {
    const [record] = dispositions.splice(index, 1);
    if (record === undefined) return;
    dispositionBytes -= record.bytes;
    releaseGlobalBytes(record.accountedBytes);
    record.key.fill(0);
  };

  const detachConstruction = (
    record: ConstructionRecord,
    preserveKey: boolean,
  ): Buffer | undefined => {
    const index = constructions.indexOf(record);
    if (index < 0) return undefined;
    constructions.splice(index, 1);
    record.candidate = undefined;
    pendingCandidates -= 1;
    pendingBytes -= record.rawBytes;
    releaseGlobalBytes(record.accountedBytes);
    if (record.workingReserved) {
      record.workingReserved = false;
      activeWorkingBytes -= MUTATION_PRESENTATION_ACTIVE_WORKING_RESERVATION_BYTES;
      releaseGlobalBytes(MUTATION_PRESENTATION_ACTIVE_WORKING_RESERVATION_BYTES);
    }
    if (preserveKey) return record.key;
    record.key.fill(0);
    return undefined;
  };

  const purgeExpiredTerminals = (now: number): void => {
    for (let index = artifacts.length - 1; index >= 0; index -= 1) {
      if (artifacts[index]!.expiresAt <= now) releaseArtifactAt(index);
    }
    for (let index = dispositions.length - 1; index >= 0; index -= 1) {
      if (dispositions[index]!.expiresAt <= now) releaseDispositionAt(index);
    }
  };

  const removeMatchingTerminals = (key: Buffer): void => {
    for (let index = artifacts.length - 1; index >= 0; index -= 1) {
      if (timingSafeEqual(artifacts[index]!.key, key)) releaseArtifactAt(index);
    }
    for (let index = dispositions.length - 1; index >= 0; index -= 1) {
      if (timingSafeEqual(dispositions[index]!.key, key)) releaseDispositionAt(index);
    }
  };

  const evictArtifactsForGlobalCapacity = (additionalBytes: number): boolean => {
    while (
      globalBytes + additionalBytes > MUTATION_PRESENTATION_MAX_GLOBAL_BYTES &&
      artifacts.length > 0
    ) {
      releaseArtifactAt(0);
    }
    return globalBytes + additionalBytes <= MUTATION_PRESENTATION_MAX_GLOBAL_BYTES;
  };

  const candidateMetadataBytes = (
    candidate: WardenMutationPresentationCandidateV1,
  ): number | undefined =>
    boundedMetadataBytes(
      [
        candidate.displayPath,
        candidate.sessionId,
        candidate.toolCallId,
        observedMetadataKey(candidate),
        candidate.verifiedInstalledAfter.sha256,
      ],
      5 * 8,
    );

  const candidateAccountedBytes = (
    key: Buffer,
    candidate: WardenMutationPresentationCandidateV1,
    metadataBytes: number,
  ): number =>
    key.byteLength +
    MUTATION_PRESENTATION_RECORD_BOOKKEEPING_BYTES +
    metadataBytes +
    (() => {
      const content = observedContent(candidate);
      if (content === undefined) return 0;
      return typeof content === "string" ? stringStorageBytes(content) : content.byteLength;
    })() +
    stringStorageBytes(candidate.verifiedInstalledAfter.content);

  const reserveActiveWorkingSet = (record: ConstructionRecord): boolean => {
    if (
      !evictArtifactsForGlobalCapacity(MUTATION_PRESENTATION_ACTIVE_WORKING_RESERVATION_BYTES) ||
      !reserveGlobalBytes(MUTATION_PRESENTATION_ACTIVE_WORKING_RESERVATION_BYTES)
    ) {
      return false;
    }
    record.workingReserved = true;
    activeWorkingBytes += MUTATION_PRESENTATION_ACTIVE_WORKING_RESERVATION_BYTES;
    return true;
  };

  const installDisposition = (
    key: Buffer,
    reason: UnavailableResult["reason"],
    registeredAt: number,
  ): void => {
    if (closed) {
      key.fill(0);
      return;
    }
    removeMatchingTerminals(key);
    const result: UnavailableResult = { status: "unavailable", reason };
    const bytes = key.byteLength + Buffer.byteLength(JSON.stringify(result), "utf8");
    const resultBytes = bytes - key.byteLength;
    const accountedBytes =
      key.byteLength + 2 * resultBytes + MUTATION_PRESENTATION_RECORD_BOOKKEEPING_BYTES;
    while (
      dispositions.length >= MUTATION_PRESENTATION_MAX_TERMINAL_DISPOSITIONS ||
      dispositionBytes + bytes > MUTATION_PRESENTATION_MAX_TERMINAL_DISPOSITION_BYTES
    ) {
      releaseDispositionAt(0);
    }
    while (
      globalBytes + accountedBytes > MUTATION_PRESENTATION_MAX_GLOBAL_BYTES &&
      dispositions.length > 0
    ) {
      releaseDispositionAt(0);
    }
    if (!evictArtifactsForGlobalCapacity(accountedBytes) || !reserveGlobalBytes(accountedBytes)) {
      key.fill(0);
      return;
    }
    dispositions.push({
      key,
      result,
      bytes,
      accountedBytes,
      expiresAt: expiryAfter(registeredAt, MUTATION_PRESENTATION_FINALIZED_TTL_MS),
    });
    dispositionBytes += bytes;
  };

  const installArtifact = (
    key: Buffer,
    artifact: MutationPresentationV1T,
    registeredAt: number,
  ): void => {
    removeMatchingTerminals(key);
    const bytes = key.byteLength + Buffer.byteLength(JSON.stringify(artifact), "utf8");
    const artifactOnlyBytes = bytes - key.byteLength;
    // The terminal lane's public byte counter is exact serialized UTF-8. The global ledger is
    // deliberately more conservative: it reserves two bytes for every serialized artifact byte,
    // covering worst-case retained JS string storage plus the fixed HMAC key and bookkeeping.
    const accountedBytes =
      key.byteLength + 2 * artifactOnlyBytes + MUTATION_PRESENTATION_RECORD_BOOKKEEPING_BYTES;
    while (
      artifacts.length >= MUTATION_PRESENTATION_MAX_FINALIZED_ARTIFACTS ||
      artifactBytes + bytes > MUTATION_PRESENTATION_MAX_FINALIZED_ARTIFACT_BYTES
    ) {
      releaseArtifactAt(0);
    }
    if (!evictArtifactsForGlobalCapacity(accountedBytes) || !reserveGlobalBytes(accountedBytes)) {
      installDisposition(key, "capture-budget", registeredAt);
      return;
    }
    artifacts.push({
      key,
      result: { status: "available", artifact },
      bytes,
      accountedBytes,
      expiresAt: expiryAfter(registeredAt, MUTATION_PRESENTATION_FINALIZED_TTL_MS),
    });
    artifactBytes += bytes;
  };

  const cancelMatchingConstructions = (key: Buffer): void => {
    for (const record of [...constructions]) {
      if (!record.current || !timingSafeEqual(record.key, key)) continue;
      record.current = false;
      record.cancellation = "superseded";
      if (record.state === "queued") detachConstruction(record, false);
    }
  };

  const purgeExpiredConstructions = (now: number): void => {
    for (const record of [...constructions]) {
      if (!record.current || record.expiresAt > now) continue;
      if (record.state === "active") {
        record.cancellation ??= "expired";
        continue;
      }
      const key = detachConstruction(record, true);
      if (key !== undefined) installDisposition(key, "capture-budget", now);
    }
  };

  const purgeExpiredState = (now: number): void => {
    purgeExpiredTerminals(now);
    purgeExpiredConstructions(now);
  };

  const assertConstructionCurrent = (record: ConstructionRecord): void => {
    const now = readNow();
    purgeExpiredState(now);
    if (closed) record.cancellation = "shutdown";
    if (record.cancellation !== undefined || !record.current || !constructions.includes(record)) {
      throw new ConstructionCancelledError();
    }
  };

  const settleConstruction = (
    record: ConstructionRecord,
    outcome:
      | { readonly status: "artifact"; readonly artifact: MutationPresentationV1T }
      | { readonly status: "failed"; readonly reason: UnavailableResult["reason"] },
  ): void => {
    const now = readNow();
    purgeExpiredTerminals(now);
    if (closed) record.cancellation = "shutdown";
    if (record.current && record.cancellation === undefined && record.expiresAt <= now) {
      record.cancellation = "expired";
    }

    const shouldInstallExpiry = record.current && record.cancellation === "expired" && !closed;
    const shouldInstallFailure =
      record.current && record.cancellation === undefined && !closed && outcome.status === "failed";
    const shouldInstallArtifact =
      record.current &&
      record.cancellation === undefined &&
      !closed &&
      outcome.status === "artifact";
    const key = detachConstruction(
      record,
      shouldInstallExpiry || shouldInstallFailure || shouldInstallArtifact,
    );
    if (key === undefined) return;
    if (shouldInstallExpiry) {
      installDisposition(key, "capture-budget", now);
      return;
    }
    if (outcome.status === "failed") {
      installDisposition(key, outcome.reason, now);
      return;
    }
    installArtifact(key, outcome.artifact, now);
  };

  const constructArtifact = async (
    record: ConstructionRecord,
    control: MutationPresentationConstructionControl,
    assertWithinDeadline: () => void,
  ): Promise<MutationPresentationV1T> => {
    const candidate = record.candidate!;
    const pathIdentity = hmacComposite(secret, PATH_IDENTITY_DOMAIN, [
      candidate.displayPath,
    ]).toString("base64url");
    const enriched = {
      ...candidate,
      pathIdentity,
    } as WardenMutationPresentationConstructionCandidateV1;
    const constructed =
      enriched.operation === "write"
        ? await options.constructWrite?.(enriched, control)
        : await options.construct(enriched, control);
    if (constructed === undefined) throw new Error("write presentation constructor is unavailable");
    assertWithinDeadline();
    const artifact = MutationPresentationV1.parse(constructed);
    assertWithinDeadline();
    assertArtifactWithinQuantitativeBounds(artifact);
    return artifact;
  };

  const runConstructionQueue = async (): Promise<void> => {
    while (!closed) {
      const now = readNow();
      purgeExpiredState(now);
      const record = constructions.find((candidate) => candidate.state === "queued");
      if (record === undefined) return;

      try {
        // Scheduling precedes ownership by the active constructor. A queued generation can still be
        // cancelled and have its candidate reference cleared while this yield is outstanding.
        await cooperativeYield();
        assertConstructionCurrent(record);
        record.state = "active";
        if (!reserveActiveWorkingSet(record)) throw new ConstructionBudgetExceededError();
        const { control, assertWithinDeadline } = createMutationPresentationConstructionControl({
          startedAt: readNow(),
          now: readNow,
          cooperativeYield,
          assertCurrent: () => assertConstructionCurrent(record),
        });
        // Candidate liveness is confined to this helper frame. Once it resolves, the record is the
        // only transport-owned raw reference and can be cleared before its byte ledger is released.
        const artifact = await constructArtifact(record, control, assertWithinDeadline);
        settleConstruction(record, { status: "artifact", artifact });
      } catch (error) {
        settleConstruction(record, {
          status: "failed",
          reason:
            error instanceof ConstructionBudgetExceededError
              ? "capture-budget"
              : "redaction-failed",
        });
      }
    }
  };

  const ensureConstructorTask = (): void => {
    if (closed || constructorTask !== undefined) return;
    constructorTask = runConstructionQueue()
      .catch(() => {
        // Every per-generation failure is already converted into a bounded disposition. The queue
        // task itself must never create an unhandled rejection or affect execution settlement.
      })
      .finally(() => {
        constructorTask = undefined;
        if (!closed && constructions.some((record) => record.state === "queued")) {
          ensureConstructorTask();
        }
      });
  };

  const enqueueConstruction = (
    key: Buffer,
    candidate: WardenMutationPresentationCandidateV1,
    metadataBytes: number,
    rawBytes: number,
    registeredAt: number,
  ): void => {
    if (closed) {
      key.fill(0);
      return;
    }
    removeMatchingTerminals(key);
    cancelMatchingConstructions(key);
    const accountedBytes = candidateAccountedBytes(key, candidate, metadataBytes);
    if (!evictArtifactsForGlobalCapacity(accountedBytes) || !reserveGlobalBytes(accountedBytes)) {
      installDisposition(key, "capture-budget", registeredAt);
      return;
    }
    constructions.push({
      key,
      candidate,
      rawBytes,
      accountedBytes,
      expiresAt: expiryAfter(registeredAt, MUTATION_PRESENTATION_PENDING_TTL_MS),
      state: "queued",
      current: true,
      workingReserved: false,
    });
    pendingCandidates += 1;
    pendingBytes += rawBytes;
    ensureConstructorTask();
  };

  return {
    advertiseTestCapability: true,
    reserve(identity, images): MutationPresentationAdmissionDecision {
      if (closed) return { status: "refused", reason: "capture-budget" };
      const now = readNow();
      purgeExpiredState(now);
      if (closed) return { status: "refused", reason: "capture-budget" };
      if (
        identity.sessionId.length === 0 ||
        identity.toolCallId.length === 0 ||
        !hasBoundedIdentity(identity) ||
        !isBoundedByteLength(images.observedBeforeBytes) ||
        !isBoundedByteLength(images.verifiedInstalledAfterBytes)
      ) {
        return { status: "refused", reason: "capture-budget" };
      }
      const totalBytes = images.observedBeforeBytes + images.verifiedInstalledAfterBytes;
      if (
        pendingBytes + totalBytes > MUTATION_PRESENTATION_MAX_PENDING_BYTES ||
        pendingCandidates >= MUTATION_PRESENTATION_MAX_PENDING_CANDIDATES
      ) {
        return { status: "refused", reason: "capture-budget" };
      }
      const accountedBytes =
        2 * totalBytes +
        MUTATION_PRESENTATION_MAX_CANDIDATE_METADATA_BYTES +
        MUTATION_PRESENTATION_KEY_BYTES +
        MUTATION_PRESENTATION_RECORD_BOOKKEEPING_BYTES;
      if (
        !Number.isSafeInteger(accountedBytes) ||
        !evictArtifactsForGlobalCapacity(accountedBytes) ||
        !reserveGlobalBytes(accountedBytes)
      ) {
        return { status: "refused", reason: "capture-budget" };
      }
      const reservation = Object.freeze(
        Object.create(null) as MutationPresentationAdmissionReservation,
      );
      const record: ReservationRecord = {
        reservation,
        identityKey: keyForIdentity(identity),
        observedBeforeBytes: images.observedBeforeBytes,
        verifiedInstalledAfterBytes: images.verifiedInstalledAfterBytes,
        totalBytes,
        accountedBytes,
      };
      reservations.set(reservation, record);
      liveRecords.add(record);
      pendingCandidates += 1;
      pendingBytes += totalBytes;
      return { status: "reserved", reservation };
    },
    pendingUsage() {
      return { candidates: pendingCandidates, bytes: pendingBytes };
    },
    terminalUsage() {
      return {
        artifacts: artifacts.length,
        artifactBytes,
        dispositions: dispositions.length,
        dispositionBytes,
      };
    },
    globalUsage() {
      return {
        bytes: globalBytes,
        activeWorkingBytes,
        ceilingBytes: MUTATION_PRESENTATION_MAX_GLOBAL_BYTES,
      };
    },
    finalize(finalization): void {
      if (closed) {
        if (finalization.reservation !== undefined) discardReservation(finalization.reservation);
        return;
      }
      purgeExpiredState(readNow());
      if (closed) return;
      if (finalization.kind === "unavailable") {
        if (
          finalization.reservation !== undefined &&
          !consumeReservationIdentity(finalization.reservation, finalization.params)
        ) {
          return;
        }
        if (!hasBoundedIdentity(finalization.params)) return;
        const key = keyForFinal(finalization.params);
        cancelMatchingConstructions(key);
        installDisposition(key, finalization.reason, readNow());
        return;
      }

      const { candidate } = finalization;
      if (reservations.get(finalization.reservation) === undefined) return;
      const retainedObservedContent = observedContent(candidate);
      const observedBeforeBytes =
        retainedObservedContent === undefined
          ? 0
          : typeof retainedObservedContent === "string"
            ? Buffer.byteLength(retainedObservedContent, "utf8")
            : retainedObservedContent.byteLength;
      const actualImages = {
        observedBeforeBytes,
        verifiedInstalledAfterBytes: Buffer.byteLength(
          candidate.verifiedInstalledAfter.content,
          "utf8",
        ),
      };
      const reservationConsumption = consumeReservation(
        finalization.reservation,
        candidate,
        actualImages,
      );
      if (reservationConsumption === "missing" || reservationConsumption === "identity-mismatch") {
        return;
      }
      const key = keyForFinal(candidate);
      if (reservationConsumption === "images-mismatch") {
        cancelMatchingConstructions(key);
        installDisposition(key, "capture-unavailable", readNow());
        return;
      }
      const observedBytesMatch =
        candidate.operation === "edit"
          ? candidate.observedBefore.bytes === actualImages.observedBeforeBytes
          : candidate.observedBefore.status !== "file-observed" ||
            candidate.observedBefore.bytes === actualImages.observedBeforeBytes;
      if (
        !observedBytesMatch ||
        candidate.verifiedInstalledAfter.bytes !== actualImages.verifiedInstalledAfterBytes
      ) {
        cancelMatchingConstructions(key);
        installDisposition(key, "capture-unavailable", readNow());
        return;
      }
      const metadataBytes = candidateMetadataBytes(candidate);
      if (metadataBytes === undefined) {
        cancelMatchingConstructions(key);
        installDisposition(key, "capture-budget", readNow());
        return;
      }
      const registeredAt = readNow();
      purgeExpiredState(registeredAt);
      enqueueConstruction(
        key,
        candidate,
        metadataBytes,
        actualImages.observedBeforeBytes + actualImages.verifiedInstalledAfterBytes,
        registeredAt,
      );
    },
    discard: discardReservation,
    take(params): MutationPresentationTakeResultV1T {
      if (closed) return { status: "unavailable", reason: "not-found-or-consumed" };
      purgeExpiredState(readNow());
      if (closed) return { status: "unavailable", reason: "not-found-or-consumed" };
      if (!hasBoundedIdentity(params)) {
        return { status: "unavailable", reason: "not-found-or-consumed" };
      }
      const expected = keyForFinal(params);
      const pending = constructions.some(
        (record) => record.current && timingSafeEqual(record.key, expected),
      );
      if (pending) {
        expected.fill(0);
        return { status: "pending", retryAfterMs: MUTATION_PRESENTATION_PENDING_RETRY_MS };
      }
      const artifactIndex = artifacts.findIndex((record) => timingSafeEqual(record.key, expected));
      if (artifactIndex >= 0) {
        const result = artifacts[artifactIndex]!.result;
        releaseArtifactAt(artifactIndex);
        expected.fill(0);
        return result;
      }
      const dispositionIndex = dispositions.findIndex((record) =>
        timingSafeEqual(record.key, expected),
      );
      expected.fill(0);
      if (dispositionIndex >= 0) {
        const result = dispositions[dispositionIndex]!.result;
        releaseDispositionAt(dispositionIndex);
        return result;
      }
      return { status: "unavailable", reason: "not-found-or-consumed" };
    },
    clear(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      for (const record of [...liveRecords]) invalidatePendingRecord(record);
      reservations = new WeakMap<object, ReservationRecord>();
      for (const record of [...constructions]) {
        if (record.state === "active") {
          record.current = false;
          record.cancellation = "shutdown";
        } else {
          detachConstruction(record, false);
        }
      }
      while (artifacts.length > 0) releaseArtifactAt(0);
      while (dispositions.length > 0) releaseDispositionAt(0);
      const task = constructorTask;
      closePromise = (async () => {
        if (task !== undefined) await task;
        for (const record of [...constructions]) detachConstruction(record, false);
        secret.fill(0);
        releaseGlobalBytes(secret.byteLength + MUTATION_PRESENTATION_BASE_BOOKKEEPING_BYTES);
      })();
      return closePromise;
    },
  };
}
