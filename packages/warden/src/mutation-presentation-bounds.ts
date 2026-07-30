import type { MutationPresentationV1T } from "@keel/shared";

export const MUTATION_PRESENTATION_MAX_GLOBAL_BYTES = 32 * 1024 * 1024;
export const MUTATION_PRESENTATION_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES = 256 * 1024;
export const MUTATION_PRESENTATION_MAX_PRESENTED_LINES = 2_000;
export const MUTATION_PRESENTATION_MAX_HUNKS = 128;
export const MUTATION_PRESENTATION_MAX_LINE_BYTES = 8 * 1024;
export const MUTATION_PRESENTATION_MAX_PATH_BYTES = 512;
export const MUTATION_PRESENTATION_MAX_INDEXED_LINES = 20_000;
export const MUTATION_PRESENTATION_MAX_DIFF_SCALAR_OPERATIONS = 2_000_000;
export const MUTATION_PRESENTATION_MAX_REDACTION_BYTE_VISITS = 8 * 1024 * 1024;
// Every retained redaction record can eventually create at least one typed JSON segment. Derive a
// conservative metadata ceiling from the already-registered 256 KiB artifact cap so adversarial
// marker density cannot consume the fixed constructor arena before output validation runs.
export const MUTATION_PRESENTATION_MAX_REDACTION_METADATA_RECORDS = Math.floor(
  MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES / 32,
);
export const MUTATION_PRESENTATION_CONSTRUCTION_DEADLINE_MS = 200;
export const MUTATION_PRESENTATION_YIELD_BYTE_WORK = 64 * 1024;
export const MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS = 2_048;
export const MUTATION_PRESENTATION_YIELD_WALL_MS = 2;

// A single constructor receives a fixed arena reservation rather than growing the ledger while it
// works. Together with two worst-case decoded 4 MiB candidates (16 MiB), fixed candidate metadata,
// and the reserved disposition lane, 12 MiB remains below the 32 MiB ceiling. Old finalized
// artifacts are deterministically evicted before this arena is admitted.
export const MUTATION_PRESENTATION_ACTIVE_WORKING_RESERVATION_BYTES = 12 * 1024 * 1024;
export const MUTATION_PRESENTATION_MAX_CANDIDATE_METADATA_BYTES = 64 * 1024;
// Logical accounting reserves portable padding for object/map/array metadata rather than pretending
// that engine-specific V8 heap layouts are a stable public measurement.
export const MUTATION_PRESENTATION_BASE_BOOKKEEPING_BYTES = 64 * 1024;
export const MUTATION_PRESENTATION_RECORD_BOOKKEEPING_BYTES = 4 * 1024;
export const MUTATION_PRESENTATION_KEY_BYTES = 32;

const MUTATION_PRESENTATION_REDACTED_MARKER_BYTES = Buffer.byteLength("[redacted]", "utf8");

export class ConstructionBudgetExceededError extends Error {
  constructor() {
    super("mutation presentation construction budget exhausted");
    this.name = "ConstructionBudgetExceededError";
  }
}

export interface MutationPresentationConstructionControl {
  /** Yield to the Warden event loop and reject if this exact generation is no longer current. */
  checkpoint(): Promise<void>;
  /** Account one bounded unit of trusted constructor work, yielding automatically when required. */
  account(work: MutationPresentationConstructionWork): Promise<void>;
}

export interface MutationPresentationConstructionWork {
  readonly byteWork?: number;
  readonly scalarOperations?: number;
  readonly indexedLines?: number;
  readonly redactionByteVisits?: number;
}

function safeNonnegativeInteger(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new ConstructionBudgetExceededError();
  return value;
}

export function stringStorageBytes(value: string): number {
  return Math.max(Buffer.byteLength(value, "utf8"), value.length * 2);
}

/** Return a conservative string-storage charge without UTF-8 scanning a code-unit-oversize value. */
export function boundedStringStorageBytes(value: string, maxBytes: number): number | undefined {
  const codeUnitBytes = value.length * 2;
  if (codeUnitBytes > maxBytes) return undefined;
  const bytes = Math.max(Buffer.byteLength(value, "utf8"), codeUnitBytes);
  return bytes <= maxBytes ? bytes : undefined;
}

function presentedTextBytes(
  value:
    | MutationPresentationV1T["displayPath"]
    | MutationPresentationV1T["comparison"]["hunks"][number]["lines"][number],
): number {
  let bytes = 0;
  for (const segment of value.segments) {
    bytes +=
      segment.kind === "literal"
        ? Buffer.byteLength(segment.text, "utf8")
        : MUTATION_PRESENTATION_REDACTED_MARKER_BYTES;
  }
  return bytes;
}

export function assertArtifactWithinQuantitativeBounds(artifact: MutationPresentationV1T): void {
  if (
    Buffer.byteLength(JSON.stringify(artifact), "utf8") >
      MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES ||
    presentedTextBytes(artifact.displayPath) > MUTATION_PRESENTATION_MAX_PATH_BYTES ||
    artifact.comparison.hunks.length > MUTATION_PRESENTATION_MAX_HUNKS
  ) {
    throw new ConstructionBudgetExceededError();
  }
  let presentedLines = 0;
  for (const hunk of artifact.comparison.hunks) {
    presentedLines += hunk.lines.length;
    if (presentedLines > MUTATION_PRESENTATION_MAX_PRESENTED_LINES) {
      throw new ConstructionBudgetExceededError();
    }
    for (const line of hunk.lines) {
      if (presentedTextBytes(line) > MUTATION_PRESENTATION_MAX_LINE_BYTES) {
        throw new ConstructionBudgetExceededError();
      }
    }
  }
  const declaredShown = artifact.comparison.totals.shownLines;
  if (
    typeof declaredShown === "number" &&
    declaredShown > MUTATION_PRESENTATION_MAX_PRESENTED_LINES
  ) {
    throw new ConstructionBudgetExceededError();
  }
}

interface ConstructionControlOptions {
  readonly startedAt: number;
  readonly now: () => number;
  readonly cooperativeYield: () => Promise<void>;
  readonly assertCurrent: () => void;
}

export function createMutationPresentationConstructionControl(
  options: ConstructionControlOptions,
): {
  readonly control: MutationPresentationConstructionControl;
  readonly assertWithinDeadline: () => void;
} {
  const calculatedDeadline = options.startedAt + MUTATION_PRESENTATION_CONSTRUCTION_DEADLINE_MS;
  const deadlineAt = Number.isFinite(calculatedDeadline) ? calculatedDeadline : Number.MAX_VALUE;
  let lastYieldAt = options.startedAt;
  let bytesSinceYield = 0;
  let scalarOperationsSinceYield = 0;
  let indexedLines = 0;
  let scalarOperations = 0;
  let redactionByteVisits = 0;

  const assertWithinDeadline = (): void => {
    options.assertCurrent();
    if (options.now() >= deadlineAt) throw new ConstructionBudgetExceededError();
  };

  const performCooperativeYield = async (): Promise<void> => {
    await options.cooperativeYield();
    assertWithinDeadline();
    bytesSinceYield = 0;
    scalarOperationsSinceYield = 0;
    lastYieldAt = options.now();
  };

  const control: MutationPresentationConstructionControl = {
    checkpoint: performCooperativeYield,
    account: async (work) => {
      const requestedByteWork = safeNonnegativeInteger(work.byteWork);
      const scalarDelta = safeNonnegativeInteger(work.scalarOperations);
      const indexedLineDelta = safeNonnegativeInteger(work.indexedLines);
      const redactionDelta = safeNonnegativeInteger(work.redactionByteVisits);
      const byteDelta = Math.max(requestedByteWork, redactionDelta);
      if (
        byteDelta > MUTATION_PRESENTATION_YIELD_BYTE_WORK ||
        scalarDelta > MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS ||
        indexedLines + indexedLineDelta > MUTATION_PRESENTATION_MAX_INDEXED_LINES ||
        scalarOperations + scalarDelta > MUTATION_PRESENTATION_MAX_DIFF_SCALAR_OPERATIONS ||
        redactionByteVisits + redactionDelta > MUTATION_PRESENTATION_MAX_REDACTION_BYTE_VISITS
      ) {
        throw new ConstructionBudgetExceededError();
      }

      assertWithinDeadline();
      const now = options.now();
      if (
        bytesSinceYield + byteDelta > MUTATION_PRESENTATION_YIELD_BYTE_WORK ||
        scalarOperationsSinceYield + scalarDelta > MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS ||
        now - lastYieldAt >= MUTATION_PRESENTATION_YIELD_WALL_MS
      ) {
        await performCooperativeYield();
      }

      bytesSinceYield += byteDelta;
      scalarOperationsSinceYield += scalarDelta;
      indexedLines += indexedLineDelta;
      scalarOperations += scalarDelta;
      redactionByteVisits += redactionDelta;

      if (
        bytesSinceYield === MUTATION_PRESENTATION_YIELD_BYTE_WORK ||
        scalarOperationsSinceYield === MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS
      ) {
        await performCooperativeYield();
      }
    },
  };

  return { control, assertWithinDeadline };
}
