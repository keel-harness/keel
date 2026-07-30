import { MutationPresentationV1, type MutationPresentationV1T } from "@keel/shared";
import { describe, expect, it, vi } from "vitest";
import {
  MUTATION_PRESENTATION_FINALIZED_TTL_MS,
  MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES,
  MUTATION_PRESENTATION_MAX_FINALIZED_ARTIFACT_BYTES,
  MUTATION_PRESENTATION_MAX_FINALIZED_ARTIFACTS,
  MUTATION_PRESENTATION_MAX_TERMINAL_DISPOSITION_BYTES,
  MUTATION_PRESENTATION_MAX_TERMINAL_DISPOSITIONS,
  MUTATION_PRESENTATION_PENDING_TTL_MS,
  createMutationPresentationWalkingSkeletonTransport,
  type MutationPresentationAdmissionReservation,
  type WardenMutationPresentationCandidate,
} from "./mutation-presentation-walking-skeleton.js";

const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FINAL_KEY_BYTES = 32;

type LifecycleTransport = ReturnType<typeof createMutationPresentationWalkingSkeletonTransport>;

function candidate(options: {
  readonly toolCallId: string;
  readonly auditSeq: number;
  readonly marker?: string;
}): WardenMutationPresentationCandidate {
  const before = "before\n";
  const after = "after\n";
  return {
    operation: "edit",
    displayPath: options.marker ?? "private/path.txt",
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

function summaryArtifact(
  input: WardenMutationPresentationCandidate,
  displayText = input.displayPath,
): MutationPresentationV1T {
  const text = (value: string) => ({
    segments: [{ kind: "literal" as const, text: value }],
    redactionCount: 0,
  });
  return MutationPresentationV1.parse({
    schemaVersion: "mutation-presentation/v1",
    producer: "warden-typed-mutation",
    operation: input.operation,
    auditSeq: input.auditSeq,
    displayPath: text(displayText),
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

function reserveCandidate(
  transport: LifecycleTransport,
  input: WardenMutationPresentationCandidate,
): MutationPresentationAdmissionReservation {
  const admission = transport.reserve(
    { sessionId: input.sessionId, toolCallId: input.toolCallId },
    {
      observedBeforeBytes: Buffer.byteLength(input.observedBefore.content),
      verifiedInstalledAfterBytes: Buffer.byteLength(input.verifiedInstalledAfter.content),
    },
  );
  if (admission.status !== "reserved") throw new Error("expected presentation reservation");
  return admission.reservation;
}

function finalizeCandidate(
  transport: LifecycleTransport,
  input: WardenMutationPresentationCandidate,
): void {
  transport.finalize({
    kind: "candidate",
    reservation: reserveCandidate(transport, input),
    candidate: input,
  });
}

function finalizeDisposition(
  transport: LifecycleTransport,
  toolCallId: string,
  auditSeq: number,
): void {
  transport.finalize({
    kind: "unavailable",
    params: { sessionId: SESSION_ID, toolCallId, auditSeq },
    reason: "capture-budget",
  });
}

function takeParams(input: WardenMutationPresentationCandidate) {
  return {
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    auditSeq: input.auditSeq,
  };
}

function literalDisplayText(artifact: MutationPresentationV1T): string | undefined {
  const segment = artifact.displayPath.segments[0];
  return segment?.kind === "literal" ? segment.text : undefined;
}

describe("Epic 3.10 Slice 2B-S5B mutation-presentation lifecycle", () => {
  it("exports the finalized lanes and monotonic lifetime budgets exactly", () => {
    expect(MUTATION_PRESENTATION_MAX_FINALIZED_ARTIFACTS).toBe(16);
    expect(MUTATION_PRESENTATION_MAX_FINALIZED_ARTIFACT_BYTES).toBe(4 * 1024 * 1024);
    expect(MUTATION_PRESENTATION_MAX_TERMINAL_DISPOSITIONS).toBe(64);
    expect(MUTATION_PRESENTATION_MAX_TERMINAL_DISPOSITION_BYTES).toBe(64 * 1024);
    expect(MUTATION_PRESENTATION_PENDING_TTL_MS).toBe(2_000);
    expect(MUTATION_PRESENTATION_FINALIZED_TTL_MS).toBe(30_000);
  });

  it("accounts exact serialized artifact/key and fixed disposition/key bytes", async () => {
    let now = 0;
    const input = candidate({ toolCallId: "edit-accounting", auditSeq: 101 });
    const artifact = summaryArtifact(input);
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now: () => now,
      construct: () => artifact,
    });

    finalizeCandidate(transport, input);
    finalizeDisposition(transport, "edit-disposition-accounting", 102);
    await vi.waitFor(() => expect(transport.terminalUsage().artifacts).toBe(1));

    const disposition = { status: "unavailable", reason: "capture-budget" } as const;
    expect(transport.terminalUsage()).toEqual({
      artifacts: 1,
      artifactBytes: FINAL_KEY_BYTES + Buffer.byteLength(JSON.stringify(artifact)),
      dispositions: 1,
      dispositionBytes: FINAL_KEY_BYTES + Buffer.byteLength(JSON.stringify(disposition)),
    });

    now += 1;
    expect(transport.take(takeParams(input))).toMatchObject({ status: "available" });
    expect(transport.terminalUsage()).toEqual({
      artifacts: 0,
      artifactBytes: 0,
      dispositions: 1,
      dispositionBytes: FINAL_KEY_BYTES + Buffer.byteLength(JSON.stringify(disposition)),
    });
  });

  it("evicts finalized artifacts oldest-registration-first at the 16-entry ceiling", async () => {
    let now = 0;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now: () => now,
      construct: (input) => summaryArtifact(input),
    });
    const inputs = Array.from(
      { length: MUTATION_PRESENTATION_MAX_FINALIZED_ARTIFACTS + 1 },
      (_, index) =>
        candidate({
          toolCallId: `edit-artifact-count-${index}`,
          auditSeq: 200 + index,
          marker: `artifact-${index}`,
        }),
    );

    for (const input of inputs) {
      finalizeCandidate(transport, input);
      await vi.waitFor(() => expect(transport.pendingUsage().candidates).toBe(0));
      now += 1;
    }

    expect(transport.terminalUsage().artifacts).toBe(MUTATION_PRESENTATION_MAX_FINALIZED_ARTIFACTS);
    expect(transport.take(takeParams(inputs[0]!))).toEqual({
      status: "unavailable",
      reason: "not-found-or-consumed",
    });
    expect(transport.take(takeParams(inputs[1]!))).toMatchObject({ status: "available" });
    expect(transport.take(takeParams(inputs.at(-1)!))).toMatchObject({ status: "available" });
  });

  it("fills the exact 4 MiB lane with bounded artifacts and evicts the oldest for the next artifact", async () => {
    let now = 0;
    const perArtifactRecordBytes =
      MUTATION_PRESENTATION_MAX_FINALIZED_ARTIFACT_BYTES /
      MUTATION_PRESENTATION_MAX_FINALIZED_ARTIFACTS;
    expect(Number.isInteger(perArtifactRecordBytes)).toBe(true);
    const inputs = Array.from(
      { length: MUTATION_PRESENTATION_MAX_FINALIZED_ARTIFACTS },
      (_, index) =>
        candidate({ toolCallId: `edit-exact-byte-cap-${index}`, auditSeq: 301 + index }),
    );
    const artifacts = new Map<string, MutationPresentationV1T>();
    for (const input of inputs) {
      const base = summaryArtifact(input, "");
      const baseBytes = FINAL_KEY_BYTES + Buffer.byteLength(JSON.stringify(base));
      const paddingBytes = perArtifactRecordBytes - baseBytes;
      expect(paddingBytes).toBeGreaterThan(0);
      const artifact = MutationPresentationV1.parse({
        ...base,
        pathIdentity: `${base.pathIdentity}${"x".repeat(paddingBytes)}`,
      });
      expect(FINAL_KEY_BYTES + Buffer.byteLength(JSON.stringify(artifact))).toBe(
        perArtifactRecordBytes,
      );
      expect(Buffer.byteLength(JSON.stringify(artifact))).toBeLessThanOrEqual(
        MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES,
      );
      artifacts.set(input.toolCallId, artifact);
    }
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now: () => now,
      construct(input) {
        return artifacts.get(input.toolCallId) ?? summaryArtifact(input);
      },
    });

    for (const input of inputs) {
      finalizeCandidate(transport, input);
      await vi.waitFor(() => expect(transport.pendingUsage().candidates).toBe(0));
      now += 1;
    }
    expect(transport.terminalUsage()).toMatchObject({
      artifacts: MUTATION_PRESENTATION_MAX_FINALIZED_ARTIFACTS,
      artifactBytes: MUTATION_PRESENTATION_MAX_FINALIZED_ARTIFACT_BYTES,
    });

    const next = candidate({ toolCallId: "edit-after-byte-cap", auditSeq: 302 });
    finalizeCandidate(transport, next);
    await vi.waitFor(() => expect(transport.pendingUsage().candidates).toBe(0));
    expect(transport.take(takeParams(inputs[0]!))).toEqual({
      status: "unavailable",
      reason: "not-found-or-consumed",
    });
    expect(transport.take(takeParams(next))).toMatchObject({ status: "available" });
  });

  it("settles a single artifact above the per-artifact ceiling as capture-budget", async () => {
    const now = 0;
    const input = candidate({ toolCallId: "edit-artifact-too-large", auditSeq: 303 });
    const base = summaryArtifact(input, "");
    const baseBytes = Buffer.byteLength(JSON.stringify(base));
    const oversize = MutationPresentationV1.parse({
      ...base,
      pathIdentity: `${base.pathIdentity}${"x".repeat(
        MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES - baseBytes + 1,
      )}`,
    });
    expect(Buffer.byteLength(JSON.stringify(oversize))).toBe(
      MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES + 1,
    );
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now: () => now,
      construct: () => oversize,
    });

    finalizeCandidate(transport, input);
    await vi.waitFor(() => expect(transport.terminalUsage().dispositions).toBe(1));

    expect(transport.terminalUsage()).toMatchObject({
      artifacts: 0,
      artifactBytes: 0,
      dispositions: 1,
    });
    expect(transport.take(takeParams(input))).toEqual({
      status: "unavailable",
      reason: "capture-budget",
    });
  });

  it("keeps 64 dispositions in their reserved lane and evicts the oldest only", () => {
    let now = 0;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now: () => now,
      construct: (input) => summaryArtifact(input),
    });
    const total = MUTATION_PRESENTATION_MAX_TERMINAL_DISPOSITIONS + 1;

    for (let index = 0; index < total; index += 1) {
      finalizeDisposition(transport, `edit-disposition-${index}`, 400 + index);
      now += 1;
    }

    const fixedDispositionBytes =
      FINAL_KEY_BYTES +
      Buffer.byteLength(JSON.stringify({ status: "unavailable", reason: "capture-budget" }));
    expect(transport.terminalUsage()).toEqual({
      artifacts: 0,
      artifactBytes: 0,
      dispositions: MUTATION_PRESENTATION_MAX_TERMINAL_DISPOSITIONS,
      dispositionBytes: MUTATION_PRESENTATION_MAX_TERMINAL_DISPOSITIONS * fixedDispositionBytes,
    });
    expect(transport.terminalUsage().dispositionBytes).toBeLessThanOrEqual(
      MUTATION_PRESENTATION_MAX_TERMINAL_DISPOSITION_BYTES,
    );
    expect(
      transport.take({ sessionId: SESSION_ID, toolCallId: "edit-disposition-0", auditSeq: 400 }),
    ).toEqual({ status: "unavailable", reason: "not-found-or-consumed" });
    expect(
      transport.take({ sessionId: SESSION_ID, toolCallId: "edit-disposition-1", auditSeq: 401 }),
    ).toEqual({ status: "unavailable", reason: "capture-budget" });
    expect(
      transport.take({
        sessionId: SESSION_ID,
        toolCallId: `edit-disposition-${total - 1}`,
        auditSeq: 400 + total - 1,
      }),
    ).toEqual({ status: "unavailable", reason: "capture-budget" });
  });

  it("keeps live pre-audit reservations accounted until their owner settles them", async () => {
    let now = 0;
    let constructed = 0;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now: () => now,
      construct(input) {
        constructed += 1;
        return summaryArtifact(input);
      },
    });
    const first = candidate({ toolCallId: "edit-live-reservation-1", auditSeq: 501 });
    const second = candidate({ toolCallId: "edit-live-reservation-2", auditSeq: 502 });
    const third = candidate({ toolCallId: "edit-live-reservation-3", auditSeq: 503 });
    const firstReservation = reserveCandidate(transport, first);
    const secondReservation = reserveCandidate(transport, second);
    const bytesPerCandidate =
      Buffer.byteLength(first.observedBefore.content) +
      Buffer.byteLength(first.verifiedInstalledAfter.content);
    expect(transport.pendingUsage()).toEqual({ candidates: 2, bytes: 2 * bytesPerCandidate });

    // The 2-second budget belongs to the S5C construction generation. A pre-audit reservation can
    // still have externally owned raw bytes, so expiring it here would make accounting untruthful.
    now = MUTATION_PRESENTATION_PENDING_TTL_MS * 10;
    expect(
      transport.reserve(
        { sessionId: third.sessionId, toolCallId: third.toolCallId },
        {
          observedBeforeBytes: Buffer.byteLength(third.observedBefore.content),
          verifiedInstalledAfterBytes: Buffer.byteLength(third.verifiedInstalledAfter.content),
        },
      ),
    ).toEqual({ status: "refused", reason: "capture-budget" });
    expect(transport.pendingUsage()).toEqual({ candidates: 2, bytes: 2 * bytesPerCandidate });

    transport.finalize({ kind: "candidate", reservation: firstReservation, candidate: first });
    transport.discard(secondReservation);
    await vi.waitFor(() => expect(constructed).toBe(1));

    expect(constructed).toBe(1);
    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    expect(transport.take(takeParams(first))).toMatchObject({ status: "available" });
  });

  it("expires terminal artifacts and dispositions at the exact 30-second boundary", async () => {
    let now = 0;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now: () => now,
      construct: (input) => summaryArtifact(input),
    });
    const beforeBoundary = candidate({ toolCallId: "edit-before-terminal-ttl", auditSeq: 601 });
    const atBoundary = candidate({ toolCallId: "edit-at-terminal-ttl", auditSeq: 602 });
    finalizeCandidate(transport, beforeBoundary);
    finalizeCandidate(transport, atBoundary);
    finalizeDisposition(transport, "disposition-before-terminal-ttl", 603);
    finalizeDisposition(transport, "disposition-at-terminal-ttl", 604);
    await vi.waitFor(() => expect(transport.terminalUsage().artifacts).toBe(2));

    now = MUTATION_PRESENTATION_FINALIZED_TTL_MS - 1;
    expect(transport.take(takeParams(beforeBoundary))).toMatchObject({ status: "available" });
    expect(
      transport.take({
        sessionId: SESSION_ID,
        toolCallId: "disposition-before-terminal-ttl",
        auditSeq: 603,
      }),
    ).toEqual({ status: "unavailable", reason: "capture-budget" });

    now = MUTATION_PRESENTATION_FINALIZED_TTL_MS;
    expect(transport.take(takeParams(atBoundary))).toEqual({
      status: "unavailable",
      reason: "not-found-or-consumed",
    });
    expect(
      transport.take({
        sessionId: SESSION_ID,
        toolCallId: "disposition-at-terminal-ttl",
        auditSeq: 604,
      }),
    ).toEqual({ status: "unavailable", reason: "not-found-or-consumed" });
    expect(transport.terminalUsage()).toEqual({
      artifacts: 0,
      artifactBytes: 0,
      dispositions: 0,
      dispositionBytes: 0,
    });
  });

  it("purges expired state lazily on reserve, finalize, and take without timers", async () => {
    let now = 0;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now: () => now,
      construct: (input) => summaryArtifact(input),
    });
    const first = candidate({ toolCallId: "edit-purge-on-reserve", auditSeq: 701 });
    finalizeCandidate(transport, first);
    await vi.waitFor(() => expect(transport.terminalUsage().artifacts).toBe(1));

    now = MUTATION_PRESENTATION_FINALIZED_TTL_MS;
    const second = candidate({ toolCallId: "edit-purge-on-finalize", auditSeq: 702 });
    const secondReservation = reserveCandidate(transport, second);
    expect(transport.terminalUsage().artifacts).toBe(0);
    transport.finalize({ kind: "candidate", reservation: secondReservation, candidate: second });
    await vi.waitFor(() => expect(transport.terminalUsage().artifacts).toBe(1));

    now += MUTATION_PRESENTATION_FINALIZED_TTL_MS;
    finalizeDisposition(transport, "disposition-purge-on-take", 703);
    expect(transport.terminalUsage()).toMatchObject({ artifacts: 0, dispositions: 1 });

    now += MUTATION_PRESENTATION_FINALIZED_TTL_MS;
    expect(
      transport.take({ sessionId: SESSION_ID, toolCallId: "never-present", auditSeq: 704 }),
    ).toEqual({ status: "unavailable", reason: "not-found-or-consumed" });
    expect(transport.terminalUsage()).toEqual({
      artifacts: 0,
      artifactBytes: 0,
      dispositions: 0,
      dispositionBytes: 0,
    });
  });

  it("does not schedule a per-entry timer for reservation, promotion, expiry, or take", async () => {
    let now = 0;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const transport = createMutationPresentationWalkingSkeletonTransport({
        now: () => now,
        construct: (input) => summaryArtifact(input),
      });
      const input = candidate({ toolCallId: "edit-no-entry-timer", auditSeq: 705 });
      finalizeCandidate(transport, input);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(transport.terminalUsage().artifacts).toBe(1);
      now = MUTATION_PRESENTATION_FINALIZED_TTL_MS;
      expect(transport.take(takeParams(input))).toEqual({
        status: "unavailable",
        reason: "not-found-or-consumed",
      });
      await transport.clear();

      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("replaces an identical final key as a new generation and returns only the newest artifact", async () => {
    let now = 0;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now: () => now,
      construct: (input) => summaryArtifact(input),
    });
    const oldGeneration = candidate({
      toolCallId: "edit-same-final-key",
      auditSeq: 801,
      marker: "old-generation",
    });
    const newGeneration = candidate({
      toolCallId: "edit-same-final-key",
      auditSeq: 801,
      marker: "new-generation",
    });
    finalizeCandidate(transport, oldGeneration);
    await vi.waitFor(() => expect(transport.terminalUsage().artifacts).toBe(1));
    now += 1;
    finalizeCandidate(transport, newGeneration);
    await vi.waitFor(() => expect(transport.pendingUsage().candidates).toBe(0));

    expect(transport.terminalUsage().artifacts).toBe(1);
    const taken = transport.take(takeParams(newGeneration));
    expect(taken.status).toBe("available");
    if (taken.status === "available") {
      expect(literalDisplayText(taken.artifact)).toBe("new-generation");
    }
    expect(transport.take(takeParams(oldGeneration))).toEqual({
      status: "unavailable",
      reason: "not-found-or-consumed",
    });
  });

  it("clamps a regressing injected clock so new generations retain monotonic lifetimes", async () => {
    let now = 1_000;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now: () => now,
      construct: (input) => summaryArtifact(input),
    });
    const first = candidate({ toolCallId: "edit-monotonic-first", auditSeq: 901 });
    const regressed = candidate({ toolCallId: "edit-monotonic-regressed", auditSeq: 902 });
    finalizeCandidate(transport, first);
    await vi.waitFor(() => expect(transport.terminalUsage().artifacts).toBe(1));

    now = 500;
    finalizeCandidate(transport, regressed);
    await vi.waitFor(() => expect(transport.terminalUsage().artifacts).toBe(2));
    now = 30_500;

    expect(transport.take(takeParams(regressed))).toMatchObject({ status: "available" });
    expect(transport.take(takeParams(first))).toMatchObject({ status: "available" });
  });

  it("keeps the last monotonic sample when the injected clock throws", async () => {
    let clockReads = 0;
    const input = candidate({ toolCallId: "edit-throwing-clock", auditSeq: 903 });
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now() {
        clockReads += 1;
        if (clockReads === 2) throw new Error("clock unavailable");
        return 1_000;
      },
      construct: (input) => summaryArtifact(input),
    });

    finalizeCandidate(transport, input);
    await vi.waitFor(() => expect(transport.terminalUsage().artifacts).toBe(1));

    expect(clockReads).toBeGreaterThanOrEqual(3);
    expect(transport.take(takeParams(input))).toMatchObject({ status: "available" });
  });

  it("cannot install a constructor result after reentrant shutdown clearing", async () => {
    const input = candidate({ toolCallId: "edit-clear-during-construction", auditSeq: 904 });
    const transports: LifecycleTransport[] = [];
    let invoked = false;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now: () => 0,
      construct(value) {
        invoked = true;
        void transports[0]!.clear();
        return summaryArtifact(value);
      },
    });
    transports.push(transport);

    finalizeCandidate(transport, input);
    await vi.waitFor(() => expect(invoked).toBe(true));
    await transport.clear();

    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    expect(transport.terminalUsage()).toEqual({
      artifacts: 0,
      artifactBytes: 0,
      dispositions: 0,
      dispositionBytes: 0,
    });
    expect(transport.take(takeParams(input))).toEqual({
      status: "unavailable",
      reason: "not-found-or-consumed",
    });
  });

  it("clears pending, artifact, and disposition lanes and invalidates every generation", async () => {
    let now = 0;
    let constructed = 0;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now: () => now,
      construct(input) {
        constructed += 1;
        return summaryArtifact(input);
      },
    });
    const pending = candidate({ toolCallId: "edit-clear-pending", auditSeq: 1_001 });
    const terminal = candidate({ toolCallId: "edit-clear-terminal", auditSeq: 1_002 });
    const pendingReservation = reserveCandidate(transport, pending);
    finalizeCandidate(transport, terminal);
    finalizeDisposition(transport, "edit-clear-disposition", 1_003);
    await vi.waitFor(() => expect(transport.terminalUsage().artifacts).toBe(1));

    expect(transport.pendingUsage().candidates).toBe(1);
    expect(transport.terminalUsage()).toMatchObject({ artifacts: 1, dispositions: 1 });

    await Promise.all([transport.clear(), transport.clear()]);
    now += 1;
    transport.finalize({ kind: "candidate", reservation: pendingReservation, candidate: pending });
    transport.discard(pendingReservation);

    expect(constructed).toBe(1);
    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    expect(transport.terminalUsage()).toEqual({
      artifacts: 0,
      artifactBytes: 0,
      dispositions: 0,
      dispositionBytes: 0,
    });
    expect(transport.take(takeParams(terminal))).toEqual({
      status: "unavailable",
      reason: "not-found-or-consumed",
    });
  });
});
