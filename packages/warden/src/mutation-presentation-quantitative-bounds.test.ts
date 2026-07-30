import { MutationPresentationV1, type MutationPresentationV1T } from "@keel/shared";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  MUTATION_PRESENTATION_CONSTRUCTION_DEADLINE_MS,
  MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES,
  MUTATION_PRESENTATION_MAX_DIFF_SCALAR_OPERATIONS,
  MUTATION_PRESENTATION_MAX_GLOBAL_BYTES,
  MUTATION_PRESENTATION_MAX_HUNKS,
  MUTATION_PRESENTATION_MAX_INDEXED_LINES,
  MUTATION_PRESENTATION_MAX_LINE_BYTES,
  MUTATION_PRESENTATION_MAX_PATH_BYTES,
  MUTATION_PRESENTATION_MAX_PRESENTED_LINES,
  MUTATION_PRESENTATION_MAX_REDACTION_BYTE_VISITS,
  MUTATION_PRESENTATION_YIELD_BYTE_WORK,
  MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS,
  MUTATION_PRESENTATION_YIELD_WALL_MS,
  createMutationPresentationWalkingSkeletonTransport,
  type MutationPresentationAdmissionReservation,
  type MutationPresentationConstructionControl,
  type MutationPresentationWalkingSkeletonTransport,
  type WardenMutationPresentationCandidate,
} from "./mutation-presentation-walking-skeleton.js";

const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MIB = 1024 * 1024;
const REDACTED_MARKER_BYTES = Buffer.byteLength("[redacted]", "utf8");

class ManualScheduler {
  readonly #waiters: Array<() => void> = [];

  readonly yieldControl = (): Promise<void> =>
    new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });

  get pending(): number {
    return this.#waiters.length;
  }

  async releaseOne(): Promise<void> {
    const resume = this.#waiters.shift();
    if (resume === undefined) throw new Error("expected a scheduled cooperative yield");
    resume();
    await settleMicrotasks();
  }
}

class SwitchableScheduler {
  readonly #waiters: Array<() => void> = [];
  blocked = false;

  readonly yieldControl = (): Promise<void> => {
    if (!this.blocked) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  };

  get pending(): number {
    return this.#waiters.length;
  }

  async releaseOne(): Promise<void> {
    const resume = this.#waiters.shift();
    if (resume === undefined) throw new Error("expected a scheduled cooperative yield");
    resume();
    await settleMicrotasks();
  }
}

async function settleMicrotasks(): Promise<void> {
  // Coverage instrumentation adds promise continuations, so a fixed number of microtask turns is
  // not a stable settlement boundary. One check-phase turn drains the current promise chain while
  // every deliberately blocked scheduler waiter remains blocked.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function candidate(options: {
  readonly toolCallId: string;
  readonly auditSeq: number;
  readonly before?: string;
  readonly after?: string;
}): WardenMutationPresentationCandidate {
  const before = options.before ?? "before\n";
  const after = options.after ?? "after\n";
  return {
    operation: "edit",
    displayPath: `${options.toolCallId}.txt`,
    observedBefore: {
      content: before,
      sha256: `sha256:${"a".repeat(64)}`,
      bytes: Buffer.byteLength(before),
      mode: 0o600,
    },
    verifiedInstalledAfter: {
      content: after,
      sha256: `sha256:${"b".repeat(64)}`,
      bytes: Buffer.byteLength(after),
      mode: 0o600,
    },
    sessionId: SESSION_ID,
    toolCallId: options.toolCallId,
    auditSeq: options.auditSeq,
  };
}

function text(value: string) {
  return { segments: [{ kind: "literal" as const, text: value }], redactionCount: 0 };
}

function summaryArtifact(input: WardenMutationPresentationCandidate): MutationPresentationV1T {
  return MutationPresentationV1.parse({
    schemaVersion: "mutation-presentation/v1",
    producer: "warden-typed-mutation",
    operation: input.operation,
    auditSeq: input.auditSeq,
    displayPath: text(input.displayPath),
    pathIdentity: `opaque-${input.auditSeq}`,
    observedBefore: {
      status: "file-observed",
      sha256: input.observedBefore.sha256,
      bytes: input.observedBefore.bytes,
      mode: input.observedBefore.mode,
      contentClass: "text",
      finalNewline: true,
    },
    verifiedInstalledAfter: {
      status: "file-observed",
      sha256: input.verifiedInstalledAfter.sha256,
      bytes: input.verifiedInstalledAfter.bytes,
      mode: input.verifiedInstalledAfter.mode,
      contentClass: "text",
      finalNewline: true,
    },
    transitionBinding: "not-atomic",
    concurrentMutation: "not-excluded",
    comparison: {
      coverage: "summary-only",
      totals: {
        observedBeforeLines: "unknown",
        installedAfterLines: "unknown",
        shownLines: 0,
        hiddenLines: "unknown",
      },
      hunks: [],
      redactionCount: 0,
    },
    freshness: { basis: "warden-observation", currentWorkspace: "not-observed" },
  });
}

function takeParams(input: WardenMutationPresentationCandidate) {
  return {
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    auditSeq: input.auditSeq,
  };
}

function reserveAndFinalize(
  transport: MutationPresentationWalkingSkeletonTransport,
  input: WardenMutationPresentationCandidate,
): void {
  const admission = transport.reserve(
    { sessionId: input.sessionId, toolCallId: input.toolCallId },
    {
      observedBeforeBytes: Buffer.byteLength(input.observedBefore.content),
      verifiedInstalledAfterBytes: Buffer.byteLength(input.verifiedInstalledAfter.content),
    },
  );
  if (admission.status !== "reserved") throw new Error("expected presentation reservation");
  transport.finalize({ kind: "candidate", reservation: admission.reservation, candidate: input });
}

async function waitForTerminal(
  transport: MutationPresentationWalkingSkeletonTransport,
  input: WardenMutationPresentationCandidate,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = transport.take(takeParams(input));
    if (result.status !== "pending") return result;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("presentation construction did not settle");
}

async function constructOnce(
  build: (
    input: WardenMutationPresentationCandidate,
    control: MutationPresentationConstructionControl,
  ) => MutationPresentationV1T | Promise<MutationPresentationV1T>,
  toolCallId: string,
) {
  const transport = createMutationPresentationWalkingSkeletonTransport({
    cooperativeYield: async () => undefined,
    construct: build,
  });
  const input = candidate({ toolCallId, auditSeq: 1 });
  reserveAndFinalize(transport, input);
  const result = await waitForTerminal(transport, input);
  await transport.clear();
  return result;
}

function oneLineArtifact(
  input: WardenMutationPresentationCandidate,
  value: string,
): MutationPresentationV1T {
  const base = summaryArtifact(input);
  return MutationPresentationV1.parse({
    ...base,
    comparison: {
      coverage: "complete",
      totals: {
        observedBeforeLines: 1,
        installedAfterLines: 0,
        shownLines: 1,
        hiddenLines: 0,
      },
      hunks: [
        {
          observedBeforeStart: 1,
          observedBeforeLines: 1,
          installedAfterStart: 0,
          installedAfterLines: 0,
          lines: [
            {
              kind: "observed-before",
              observedBeforeLine: 1,
              ...text(value),
            },
          ],
        },
      ],
      redactionCount: 0,
    },
  });
}

function sizedArtifact(
  input: WardenMutationPresentationCandidate,
  artifactBytes: number,
): MutationPresentationV1T {
  const base = summaryArtifact(input);
  const baseBytes = Buffer.byteLength(JSON.stringify(base));
  const paddingBytes = artifactBytes - baseBytes;
  if (paddingBytes < 0) throw new Error("target artifact size is smaller than its fixture");
  const artifact = MutationPresentationV1.parse({
    ...base,
    pathIdentity: `${base.pathIdentity}${"x".repeat(paddingBytes)}`,
  });
  expect(Buffer.byteLength(JSON.stringify(artifact))).toBe(artifactBytes);
  return artifact;
}

async function waitForArtifactCount(
  transport: MutationPresentationWalkingSkeletonTransport,
  artifacts: number,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (transport.terminalUsage().artifacts === artifacts) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`expected ${String(artifacts)} finalized artifacts`);
}

describe("Epic 3.10 Slice 2B-S5C2 quantitative presentation bounds", () => {
  it("exports the accepted global, artifact, structure, and work limits", () => {
    expect(MUTATION_PRESENTATION_MAX_GLOBAL_BYTES).toBe(32 * MIB);
    expect(MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES).toBe(256 * 1024);
    expect(MUTATION_PRESENTATION_MAX_PRESENTED_LINES).toBe(2_000);
    expect(MUTATION_PRESENTATION_MAX_HUNKS).toBe(128);
    expect(MUTATION_PRESENTATION_MAX_LINE_BYTES).toBe(8 * 1024);
    expect(MUTATION_PRESENTATION_MAX_PATH_BYTES).toBe(512);
    expect(MUTATION_PRESENTATION_MAX_INDEXED_LINES).toBe(20_000);
    expect(MUTATION_PRESENTATION_MAX_DIFF_SCALAR_OPERATIONS).toBe(2_000_000);
    expect(MUTATION_PRESENTATION_MAX_REDACTION_BYTE_VISITS).toBe(8 * MIB);
    expect(MUTATION_PRESENTATION_CONSTRUCTION_DEADLINE_MS).toBe(200);
    expect(MUTATION_PRESENTATION_YIELD_BYTE_WORK).toBe(64 * 1024);
    expect(MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS).toBe(2_048);
    expect(MUTATION_PRESENTATION_YIELD_WALL_MS).toBe(2);
  });

  it("settles every over-limit artifact as sanitized capture-budget unavailability", async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly build: (input: WardenMutationPresentationCandidate) => MutationPresentationV1T;
    }> = [
      {
        name: "display-path",
        build(input) {
          return MutationPresentationV1.parse({
            ...summaryArtifact(input),
            displayPath: text("p".repeat(MUTATION_PRESENTATION_MAX_PATH_BYTES + 1)),
          });
        },
      },
      {
        name: "redacted-display-path",
        build(input) {
          return MutationPresentationV1.parse({
            ...summaryArtifact(input),
            displayPath: {
              segments: Array.from(
                {
                  length:
                    Math.floor(MUTATION_PRESENTATION_MAX_PATH_BYTES / REDACTED_MARKER_BYTES) + 1,
                },
                () => ({ kind: "redacted" as const }),
              ),
              redactionCount:
                Math.floor(MUTATION_PRESENTATION_MAX_PATH_BYTES / REDACTED_MARKER_BYTES) + 1,
            },
          });
        },
      },
      {
        name: "line",
        build(input) {
          return oneLineArtifact(input, "x".repeat(MUTATION_PRESENTATION_MAX_LINE_BYTES + 1));
        },
      },
      {
        name: "presented-lines",
        build(input) {
          const base = summaryArtifact(input);
          const lines = Array.from(
            { length: MUTATION_PRESENTATION_MAX_PRESENTED_LINES + 1 },
            (_, index) => ({
              kind: "observed-before" as const,
              observedBeforeLine: index + 1,
              segments: [],
              redactionCount: 0,
            }),
          );
          return MutationPresentationV1.parse({
            ...base,
            comparison: {
              coverage: "truncated",
              totals: {
                observedBeforeLines: lines.length,
                installedAfterLines: 0,
                shownLines: lines.length,
                hiddenLines: 0,
              },
              hunks: [
                {
                  observedBeforeStart: 1,
                  observedBeforeLines: lines.length,
                  installedAfterStart: 0,
                  installedAfterLines: 0,
                  lines,
                },
              ],
              redactionCount: 0,
            },
          });
        },
      },
      {
        name: "hunks",
        build(input) {
          const base = summaryArtifact(input);
          return MutationPresentationV1.parse({
            ...base,
            comparison: {
              ...base.comparison,
              hunks: Array.from({ length: MUTATION_PRESENTATION_MAX_HUNKS + 1 }, () => ({
                observedBeforeStart: 0,
                observedBeforeLines: 0,
                installedAfterStart: 0,
                installedAfterLines: 0,
                lines: [],
              })),
            },
          });
        },
      },
      {
        name: "declared-shown-lines",
        build(input) {
          const base = summaryArtifact(input);
          return MutationPresentationV1.parse({
            ...base,
            comparison: {
              ...base.comparison,
              totals: {
                ...base.comparison.totals,
                shownLines: MUTATION_PRESENTATION_MAX_PRESENTED_LINES + 1,
              },
            },
          });
        },
      },
      {
        name: "serialized-artifact",
        build(input) {
          return MutationPresentationV1.parse({
            ...summaryArtifact(input),
            pathIdentity: "i".repeat(MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES),
          });
        },
      },
    ];

    for (const entry of cases) {
      const result = await constructOnce(entry.build, `over-${entry.name}`);
      expect(result, entry.name).toEqual({ status: "unavailable", reason: "capture-budget" });
      expect(JSON.stringify(result), entry.name).not.toContain("over-");
    }
  });

  it("accepts exact path, line, and hunk boundaries", async () => {
    const result = await constructOnce((input) => {
      const artifact = oneLineArtifact(input, "x".repeat(MUTATION_PRESENTATION_MAX_LINE_BYTES));
      return MutationPresentationV1.parse({
        ...artifact,
        displayPath: text("p".repeat(MUTATION_PRESENTATION_MAX_PATH_BYTES)),
        comparison: {
          ...artifact.comparison,
          hunks: [
            ...artifact.comparison.hunks,
            ...Array.from({ length: MUTATION_PRESENTATION_MAX_HUNKS - 1 }, () => ({
              observedBeforeStart: 0,
              observedBeforeLines: 0,
              installedAfterStart: 0,
              installedAfterLines: 0,
              lines: [],
            })),
          ],
        },
      });
    }, "exact-output-boundaries");

    expect(result.status).toBe("available");
  });

  it("accepts exactly 2,000 compact presented lines below the artifact byte ceiling", async () => {
    const result = await constructOnce((input) => {
      const base = summaryArtifact(input);
      const lines = Array.from(
        { length: MUTATION_PRESENTATION_MAX_PRESENTED_LINES },
        (_, index) => ({
          kind: "observed-before" as const,
          observedBeforeLine: index + 1,
          segments: [],
          redactionCount: 0,
        }),
      );
      const artifact = MutationPresentationV1.parse({
        ...base,
        comparison: {
          coverage: "complete",
          totals: {
            observedBeforeLines: lines.length,
            installedAfterLines: 0,
            shownLines: lines.length,
            hiddenLines: 0,
          },
          hunks: [
            {
              observedBeforeStart: 1,
              observedBeforeLines: lines.length,
              installedAfterStart: 0,
              installedAfterLines: 0,
              lines,
            },
          ],
          redactionCount: 0,
        },
      });
      expect(Buffer.byteLength(JSON.stringify(artifact))).toBeLessThanOrEqual(
        MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES,
      );
      return artifact;
    }, "exact-line-count");

    expect(result.status).toBe("available");
  });

  it("accepts an artifact at the exact 256 KiB serialized boundary", async () => {
    const result = await constructOnce(
      (input) => sizedArtifact(input, MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES),
      "exact-artifact-bytes",
    );

    expect(result.status).toBe("available");
  });

  it("measures path ceilings in rendered UTF-8 bytes", async () => {
    const accepted = await constructOnce((input) => {
      return MutationPresentationV1.parse({
        ...summaryArtifact(input),
        displayPath: text("é".repeat(MUTATION_PRESENTATION_MAX_PATH_BYTES / 2)),
      });
    }, "utf8-path-exact");
    const refused = await constructOnce((input) => {
      return MutationPresentationV1.parse({
        ...summaryArtifact(input),
        displayPath: text("é".repeat(MUTATION_PRESENTATION_MAX_PATH_BYTES / 2 + 1)),
      });
    }, "utf8-path-over");

    expect(accepted.status).toBe("available");
    expect(refused).toEqual({ status: "unavailable", reason: "capture-budget" });
  });

  it("accounts reservations, active working-set capacity, and shutdown release under one ceiling", async () => {
    const scheduler = new ManualScheduler();
    const transport = createMutationPresentationWalkingSkeletonTransport({
      cooperativeYield: scheduler.yieldControl,
      async construct(input, control) {
        await control.checkpoint();
        return summaryArtifact(input);
      },
    });
    const baseline = transport.globalUsage();
    expect(baseline.bytes).toBeGreaterThan(0);
    expect(baseline.bytes).toBeLessThanOrEqual(MUTATION_PRESENTATION_MAX_GLOBAL_BYTES);
    expect(baseline.activeWorkingBytes).toBe(0);

    const discarded = candidate({ toolCallId: "global-discard", auditSeq: 10 });
    const admission = transport.reserve(
      { sessionId: discarded.sessionId, toolCallId: discarded.toolCallId },
      {
        observedBeforeBytes: discarded.observedBefore.bytes,
        verifiedInstalledAfterBytes: discarded.verifiedInstalledAfter.bytes,
      },
    );
    if (admission.status !== "reserved") throw new Error("expected presentation reservation");
    expect(transport.globalUsage().bytes).toBeGreaterThan(baseline.bytes);
    transport.discard(admission.reservation);
    expect(transport.globalUsage()).toEqual(baseline);

    const active = candidate({ toolCallId: "global-active", auditSeq: 11 });
    reserveAndFinalize(transport, active);
    expect(transport.globalUsage().bytes).toBeLessThanOrEqual(
      MUTATION_PRESENTATION_MAX_GLOBAL_BYTES,
    );
    await scheduler.releaseOne();
    expect(transport.globalUsage().activeWorkingBytes).toBeGreaterThan(0);
    expect(transport.globalUsage().bytes).toBeLessThanOrEqual(
      MUTATION_PRESENTATION_MAX_GLOBAL_BYTES,
    );

    const closing = transport.clear();
    await scheduler.releaseOne();
    await closing;
    expect(transport.globalUsage()).toEqual({
      bytes: 0,
      activeWorkingBytes: 0,
      ceilingBytes: MUTATION_PRESENTATION_MAX_GLOBAL_BYTES,
    });
  });

  it("rejects oversized transient identities and candidate metadata before keyed retention", async () => {
    let constructions = 0;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      cooperativeYield: async () => undefined,
      construct(input) {
        constructions += 1;
        return summaryArtifact(input);
      },
    });
    const baseline = transport.globalUsage();
    const oversizedIdentity = "I".repeat(64 * 1024);
    const utf8OversizedIdentity = "€".repeat(25_000);

    expect(
      transport.reserve(
        { sessionId: SESSION_ID, toolCallId: oversizedIdentity },
        { observedBeforeBytes: 1, verifiedInstalledAfterBytes: 1 },
      ),
    ).toEqual({ status: "refused", reason: "capture-budget" });
    expect(
      transport.reserve(
        { sessionId: SESSION_ID, toolCallId: utf8OversizedIdentity },
        { observedBeforeBytes: 1, verifiedInstalledAfterBytes: 1 },
      ),
    ).toEqual({ status: "refused", reason: "capture-budget" });
    transport.finalize({
      kind: "unavailable",
      params: { sessionId: SESSION_ID, toolCallId: oversizedIdentity, auditSeq: 40 },
      reason: "capture-unavailable",
    });
    expect(
      transport.take({ sessionId: SESSION_ID, toolCallId: oversizedIdentity, auditSeq: 40 }),
    ).toEqual({ status: "unavailable", reason: "not-found-or-consumed" });
    expect(transport.globalUsage()).toEqual(baseline);

    const mismatchedCandidate = candidate({
      toolCallId: "bounded-reservation-candidate",
      auditSeq: 41,
    });
    const mismatchedCandidateReservation = transport.reserve(
      {
        sessionId: mismatchedCandidate.sessionId,
        toolCallId: mismatchedCandidate.toolCallId,
      },
      {
        observedBeforeBytes: mismatchedCandidate.observedBefore.bytes,
        verifiedInstalledAfterBytes: mismatchedCandidate.verifiedInstalledAfter.bytes,
      },
    );
    if (mismatchedCandidateReservation.status !== "reserved") {
      throw new Error("expected presentation reservation");
    }
    transport.finalize({
      kind: "candidate",
      reservation: mismatchedCandidateReservation.reservation,
      candidate: { ...mismatchedCandidate, toolCallId: oversizedIdentity },
    });

    const unavailableReservation = transport.reserve(
      { sessionId: SESSION_ID, toolCallId: "bounded-reservation-unavailable" },
      { observedBeforeBytes: 1, verifiedInstalledAfterBytes: 1 },
    );
    if (unavailableReservation.status !== "reserved") {
      throw new Error("expected presentation reservation");
    }
    transport.finalize({
      kind: "unavailable",
      reservation: unavailableReservation.reservation,
      params: { sessionId: SESSION_ID, toolCallId: oversizedIdentity, auditSeq: 42 },
      reason: "capture-unavailable",
    });
    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });

    const oversizedCandidate = candidate({ toolCallId: "bounded-identity", auditSeq: 41 });
    const reservation = transport.reserve(
      { sessionId: oversizedCandidate.sessionId, toolCallId: oversizedCandidate.toolCallId },
      {
        observedBeforeBytes: oversizedCandidate.observedBefore.bytes,
        verifiedInstalledAfterBytes: oversizedCandidate.verifiedInstalledAfter.bytes,
      },
    );
    if (reservation.status !== "reserved") throw new Error("expected presentation reservation");
    transport.finalize({
      kind: "candidate",
      reservation: reservation.reservation,
      candidate: { ...oversizedCandidate, displayPath: "P".repeat(64 * 1024) },
    });
    expect(await waitForTerminal(transport, oversizedCandidate)).toEqual({
      status: "unavailable",
      reason: "capture-budget",
    });
    expect(constructions).toBe(0);
    await transport.clear();
  });

  it("cannot admit a reservation when an injected clock closes the transport reentrantly", async () => {
    let closeOnRead = false;
    const transport: MutationPresentationWalkingSkeletonTransport =
      createMutationPresentationWalkingSkeletonTransport({
        now() {
          if (closeOnRead) void transport.clear();
          return 0;
        },
        construct: summaryArtifact,
      });
    closeOnRead = true;

    expect(
      transport.reserve(
        { sessionId: SESSION_ID, toolCallId: "reentrant-clock-close" },
        { observedBeforeBytes: 1, verifiedInstalledAfterBytes: 1 },
      ),
    ).toEqual({ status: "refused", reason: "capture-budget" });
    await transport.clear();
    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    expect(transport.globalUsage().bytes).toBe(0);
  });

  it("drops disposition and candidate promotion when a later clock sample closes reentrantly", async () => {
    let dispositionReads = 0;
    const dispositionTransport: MutationPresentationWalkingSkeletonTransport =
      createMutationPresentationWalkingSkeletonTransport({
        now() {
          dispositionReads += 1;
          if (dispositionReads === 2) void dispositionTransport.clear();
          return 0;
        },
        construct: summaryArtifact,
      });
    dispositionTransport.finalize({
      kind: "unavailable",
      params: { sessionId: SESSION_ID, toolCallId: "reentrant-disposition", auditSeq: 50 },
      reason: "capture-unavailable",
    });
    await dispositionTransport.clear();
    expect(dispositionTransport.terminalUsage().dispositions).toBe(0);
    expect(dispositionTransport.globalUsage().bytes).toBe(0);

    let candidateReads = 0;
    const candidateTransport: MutationPresentationWalkingSkeletonTransport =
      createMutationPresentationWalkingSkeletonTransport({
        now() {
          candidateReads += 1;
          if (candidateReads === 3) void candidateTransport.clear();
          return 0;
        },
        construct: summaryArtifact,
      });
    const input = candidate({ toolCallId: "reentrant-candidate", auditSeq: 51 });
    reserveAndFinalize(candidateTransport, input);
    await candidateTransport.clear();
    expect(candidateTransport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    expect(candidateTransport.terminalUsage().artifacts).toBe(0);
    expect(candidateTransport.globalUsage().bytes).toBe(0);
  });

  it("evicts oldest finalized output before admitting max raw images plus the active arena", async () => {
    const scheduler = new SwitchableScheduler();
    const artifacts = new Map<string, MutationPresentationV1T>();
    const transport = createMutationPresentationWalkingSkeletonTransport({
      cooperativeYield: scheduler.yieldControl,
      async construct(input, control) {
        const artifact = artifacts.get(input.toolCallId);
        if (artifact !== undefined) return artifact;
        await control.checkpoint();
        return summaryArtifact(input);
      },
    });

    for (let index = 0; index < 16; index += 1) {
      const input = candidate({ toolCallId: `global-terminal-${index}`, auditSeq: 100 + index });
      artifacts.set(input.toolCallId, sizedArtifact(input, 255 * 1024));
      reserveAndFinalize(transport, input);
      await waitForArtifactCount(transport, index + 1);
    }
    expect(transport.terminalUsage().artifacts).toBe(16);
    expect(transport.globalUsage().bytes).toBeLessThanOrEqual(
      MUTATION_PRESENTATION_MAX_GLOBAL_BYTES,
    );

    scheduler.blocked = true;
    const before = "a".repeat(2 * MIB);
    const after = "b".repeat(2 * MIB);
    const first = candidate({
      toolCallId: "global-max-first",
      auditSeq: 200,
      before,
      after,
    });
    const second = candidate({
      toolCallId: "global-max-second",
      auditSeq: 201,
      before,
      after,
    });
    reserveAndFinalize(transport, first);
    reserveAndFinalize(transport, second);
    expect(scheduler.pending).toBe(1);
    expect(transport.globalUsage().bytes).toBeLessThanOrEqual(
      MUTATION_PRESENTATION_MAX_GLOBAL_BYTES,
    );

    await scheduler.releaseOne();
    expect(transport.globalUsage().activeWorkingBytes).toBeGreaterThan(0);
    expect(transport.globalUsage().bytes).toBeLessThanOrEqual(
      MUTATION_PRESENTATION_MAX_GLOBAL_BYTES,
    );
    expect(transport.terminalUsage().artifacts).toBeLessThan(16);

    const closing = transport.clear();
    await scheduler.releaseOne();
    await closing;
    expect(transport.globalUsage().bytes).toBe(0);
  });

  it("keeps randomized admission and disposition sequences inside the global ledger", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            kind: fc.constantFrom("reserve", "discard", "settle", "disposition", "take"),
            beforeBytes: fc.integer({ min: 0, max: 2 * MIB }),
            afterBytes: fc.integer({ min: 0, max: 2 * MIB }),
          }),
          { maxLength: 100 },
        ),
        async (operations) => {
          const transport = createMutationPresentationWalkingSkeletonTransport({
            construct: summaryArtifact,
          });
          const reservations: Array<{
            readonly reservation: MutationPresentationAdmissionReservation;
            readonly params: ReturnType<typeof takeParams>;
          }> = [];
          const terminals: Array<ReturnType<typeof takeParams>> = [];
          let nextId = 0;

          for (const operation of operations) {
            const sequence = nextId;
            nextId += 1;
            if (operation.kind === "reserve") {
              const params = takeParams(
                candidate({ toolCallId: `property-${sequence}`, auditSeq: sequence }),
              );
              const admission = transport.reserve(params, {
                observedBeforeBytes: operation.beforeBytes,
                verifiedInstalledAfterBytes: operation.afterBytes,
              });
              if (admission.status === "reserved") {
                reservations.push({ reservation: admission.reservation, params });
              }
            } else if (operation.kind === "discard") {
              const record = reservations.shift();
              if (record !== undefined) transport.discard(record.reservation);
            } else if (operation.kind === "settle") {
              const record = reservations.shift();
              if (record !== undefined) {
                transport.finalize({
                  kind: "unavailable",
                  reservation: record.reservation,
                  params: record.params,
                  reason: "capture-budget",
                });
                terminals.push(record.params);
              }
            } else if (operation.kind === "disposition") {
              const params = takeParams(
                candidate({ toolCallId: `property-terminal-${sequence}`, auditSeq: sequence }),
              );
              transport.finalize({
                kind: "unavailable",
                params,
                reason: "capture-unavailable",
              });
              terminals.push(params);
            } else {
              const params = terminals.shift();
              if (params !== undefined) transport.take(params);
            }

            const usage = transport.globalUsage();
            expect(usage.bytes).toBeGreaterThan(0);
            expect(usage.bytes).toBeLessThanOrEqual(MUTATION_PRESENTATION_MAX_GLOBAL_BYTES);
            expect(usage.activeWorkingBytes).toBe(0);
          }

          await transport.clear();
          expect(transport.globalUsage().bytes).toBe(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("automatically yields at the exact byte-work and scalar-operation intervals", async () => {
    const scheduler = new ManualScheduler();
    const completed: string[] = [];
    const transport = createMutationPresentationWalkingSkeletonTransport({
      // This case isolates work-count yield boundaries. A real clock can consume the independent
      // construction deadline while a coverage worker is descheduled between manual releases.
      now: () => 0,
      cooperativeYield: scheduler.yieldControl,
      async construct(input, control) {
        await control.account({ byteWork: MUTATION_PRESENTATION_YIELD_BYTE_WORK });
        completed.push("byte");
        await control.account({
          scalarOperations: MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS,
        });
        completed.push("scalar");
        return summaryArtifact(input);
      },
    });
    const input = candidate({ toolCallId: "yield-intervals", auditSeq: 20 });
    reserveAndFinalize(transport, input);

    await scheduler.releaseOne();
    expect(completed).toEqual([]);
    expect(scheduler.pending).toBe(1);
    await scheduler.releaseOne();
    // Under full-suite worker pressure, the constructor continuation can settle after the helper's
    // check-phase turn. Poll the observable state rather than assuming one host turn is sufficient.
    await vi.waitFor(() => expect(completed).toEqual(["byte"]));
    expect(scheduler.pending).toBe(1);
    await scheduler.releaseOne();
    await vi.waitFor(() => expect(completed).toEqual(["byte", "scalar"]));
    expect(transport.take(takeParams(input))).toMatchObject({ status: "available" });
    await transport.clear();
  });

  it("yields before more work after two monotonic milliseconds", async () => {
    let now = 0;
    const scheduler = new ManualScheduler();
    let finished = false;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now: () => now,
      cooperativeYield: scheduler.yieldControl,
      async construct(input, control) {
        now = 2;
        await control.account({ byteWork: 1 });
        finished = true;
        return summaryArtifact(input);
      },
    });
    const input = candidate({ toolCallId: "yield-wall", auditSeq: 21 });
    reserveAndFinalize(transport, input);

    await scheduler.releaseOne();
    expect(finished).toBe(false);
    expect(scheduler.pending).toBe(1);
    await scheduler.releaseOne();
    expect(finished).toBe(true);
    expect(transport.take(takeParams(input))).toMatchObject({ status: "available" });
    await transport.clear();
  });

  it("settles indexed-line, per-step, scalar-total, and redaction-visit exhaustion as capture-budget", async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly exhaust: (control: MutationPresentationConstructionControl) => Promise<void>;
    }> = [
      {
        name: "indexed-lines",
        async exhaust(control) {
          await control.account({ indexedLines: MUTATION_PRESENTATION_MAX_INDEXED_LINES + 1 });
        },
      },
      {
        name: "byte-step",
        async exhaust(control) {
          await control.account({ byteWork: MUTATION_PRESENTATION_YIELD_BYTE_WORK + 1 });
        },
      },
      {
        name: "invalid-work",
        async exhaust(control) {
          await control.account({ byteWork: Number.NaN });
        },
      },
      {
        name: "scalar-step",
        async exhaust(control) {
          await control.account({
            scalarOperations: MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS + 1,
          });
        },
      },
      {
        name: "scalar-total",
        async exhaust(control) {
          const fullSteps = Math.floor(
            MUTATION_PRESENTATION_MAX_DIFF_SCALAR_OPERATIONS /
              MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS,
          );
          const remainder =
            MUTATION_PRESENTATION_MAX_DIFF_SCALAR_OPERATIONS %
            MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS;
          for (let index = 0; index < fullSteps; index += 1) {
            await control.account({
              scalarOperations: MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS,
            });
          }
          if (remainder > 0) await control.account({ scalarOperations: remainder });
          await control.account({ scalarOperations: 1 });
        },
      },
      {
        name: "redaction-visits",
        async exhaust(control) {
          const steps =
            MUTATION_PRESENTATION_MAX_REDACTION_BYTE_VISITS / MUTATION_PRESENTATION_YIELD_BYTE_WORK;
          for (let index = 0; index < steps; index += 1) {
            await control.account({
              byteWork: MUTATION_PRESENTATION_YIELD_BYTE_WORK,
              redactionByteVisits: MUTATION_PRESENTATION_YIELD_BYTE_WORK,
            });
          }
          await control.account({ byteWork: 1, redactionByteVisits: 1 });
        },
      },
    ];

    for (const entry of cases) {
      const result = await constructOnce(async (input, control) => {
        await entry.exhaust(control);
        return summaryArtifact(input);
      }, `work-${entry.name}`);
      expect(result, entry.name).toEqual({ status: "unavailable", reason: "capture-budget" });
    }
  });

  it("enforces the absolute deadline even when an injected constructor omits checkpoints", async () => {
    let now = 0;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now: () => now,
      cooperativeYield: async () => undefined,
      construct(input) {
        now = MUTATION_PRESENTATION_CONSTRUCTION_DEADLINE_MS;
        return summaryArtifact(input);
      },
    });
    const input = candidate({ toolCallId: "deadline-no-checkpoint", auditSeq: 30 });
    reserveAndFinalize(transport, input);

    expect(await waitForTerminal(transport, input)).toEqual({
      status: "unavailable",
      reason: "capture-budget",
    });
    await transport.clear();
  });

  it("accepts completion immediately before the absolute deadline", async () => {
    let now = 0;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now: () => now,
      cooperativeYield: async () => undefined,
      construct(input) {
        now = MUTATION_PRESENTATION_CONSTRUCTION_DEADLINE_MS - 1;
        return summaryArtifact(input);
      },
    });
    const input = candidate({ toolCallId: "deadline-before-boundary", auditSeq: 31 });
    reserveAndFinalize(transport, input);

    expect((await waitForTerminal(transport, input)).status).toBe("available");
    await transport.clear();
  });
});
