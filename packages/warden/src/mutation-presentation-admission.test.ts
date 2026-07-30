import { MutationPresentationV1, type MutationPresentationV1T } from "@keel/shared";
import { describe, expect, it, vi } from "vitest";
import {
  MUTATION_PRESENTATION_MAX_IMAGE_BYTES,
  MUTATION_PRESENTATION_MAX_PENDING_BYTES,
  MUTATION_PRESENTATION_MAX_PENDING_CANDIDATES,
  createMutationPresentationWalkingSkeletonTransport,
  type WardenMutationPresentationCandidate,
} from "./mutation-presentation-walking-skeleton.js";

const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function candidate(options: {
  readonly toolCallId: string;
  readonly auditSeq: number;
  readonly before?: string;
  readonly after?: string;
  readonly claimedBeforeBytes?: number;
  readonly claimedAfterBytes?: number;
}): WardenMutationPresentationCandidate {
  const before = options.before ?? "before\n";
  const after = options.after ?? "after\n";
  return {
    operation: "edit",
    displayPath: "private/path.txt",
    observedBefore: {
      content: before,
      sha256: `sha256:${"a".repeat(64)}`,
      bytes: options.claimedBeforeBytes ?? Buffer.byteLength(before),
      mode: 0o600,
    },
    verifiedInstalledAfter: {
      content: after,
      sha256: `sha256:${"b".repeat(64)}`,
      bytes: options.claimedAfterBytes ?? Buffer.byteLength(after),
      mode: 0o600,
    },
    sessionId: SESSION_ID,
    toolCallId: options.toolCallId,
    auditSeq: options.auditSeq,
  };
}

function summaryArtifact(input: WardenMutationPresentationCandidate): MutationPresentationV1T {
  const text = (value: string) => ({
    segments: [{ kind: "literal" as const, text: value }],
    redactionCount: 0,
  });
  return MutationPresentationV1.parse({
    schemaVersion: "mutation-presentation/v1",
    producer: "warden-typed-mutation",
    operation: input.operation,
    auditSeq: input.auditSeq,
    displayPath: text(input.displayPath),
    pathIdentity: "opaque-test-path",
    observedBefore: {
      status: "file-observed",
      sha256: input.observedBefore.sha256,
      bytes: input.observedBefore.bytes,
      mode: input.observedBefore.mode,
      contentClass: "text",
      finalNewline: input.observedBefore.content.endsWith("\n"),
    },
    verifiedInstalledAfter: {
      status: "file-observed",
      sha256: input.verifiedInstalledAfter.sha256,
      bytes: input.verifiedInstalledAfter.bytes,
      mode: input.verifiedInstalledAfter.mode,
      contentClass: "text",
      finalNewline: input.verifiedInstalledAfter.content.endsWith("\n"),
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

function reserve(
  transport: ReturnType<typeof createMutationPresentationWalkingSkeletonTransport>,
  toolCallId: string,
  observedBeforeBytes: number,
  verifiedInstalledAfterBytes: number,
) {
  return transport.reserve(
    { sessionId: SESSION_ID, toolCallId },
    { observedBeforeBytes, verifiedInstalledAfterBytes },
  );
}

describe("Epic 3.10 Slice 2B-S5A mutation-presentation admission", () => {
  it("exports the frozen image and pending raw-candidate limits", () => {
    expect(MUTATION_PRESENTATION_MAX_IMAGE_BYTES).toBe(2 * 1024 * 1024);
    expect(MUTATION_PRESENTATION_MAX_PENDING_CANDIDATES).toBe(2);
    expect(MUTATION_PRESENTATION_MAX_PENDING_BYTES).toBe(8 * 1024 * 1024);
  });

  it("accounts exact raw bytes, reaches both pending ceilings, and releases once", () => {
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct: summaryArtifact,
    });
    const first = reserve(
      transport,
      "edit-capacity-1",
      MUTATION_PRESENTATION_MAX_IMAGE_BYTES,
      MUTATION_PRESENTATION_MAX_IMAGE_BYTES,
    );
    const second = reserve(
      transport,
      "edit-capacity-2",
      MUTATION_PRESENTATION_MAX_IMAGE_BYTES,
      MUTATION_PRESENTATION_MAX_IMAGE_BYTES,
    );

    expect(first.status).toBe("reserved");
    expect(second.status).toBe("reserved");
    expect(transport.pendingUsage()).toEqual({
      candidates: MUTATION_PRESENTATION_MAX_PENDING_CANDIDATES,
      bytes: MUTATION_PRESENTATION_MAX_PENDING_BYTES,
    });
    expect(reserve(transport, "edit-byte-capacity", 1, 0)).toEqual({
      status: "refused",
      reason: "capture-budget",
    });
    expect(reserve(transport, "edit-count-capacity", 0, 0)).toEqual({
      status: "refused",
      reason: "capture-budget",
    });

    if (first.status !== "reserved" || second.status !== "reserved") {
      throw new Error("expected both reservations");
    }
    transport.discard(first.reservation);
    transport.discard(first.reservation);
    expect(transport.pendingUsage()).toEqual({
      candidates: 1,
      bytes: 2 * MUTATION_PRESENTATION_MAX_IMAGE_BYTES,
    });
    transport.discard(second.reservation);
    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
  });

  it("refuses either oversize image without allocating pending raw bytes", () => {
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct: summaryArtifact,
    });

    expect(
      reserve(transport, "edit-before-oversize", MUTATION_PRESENTATION_MAX_IMAGE_BYTES + 1, 0),
    ).toEqual({ status: "refused", reason: "capture-budget" });
    expect(
      reserve(transport, "edit-after-oversize", 0, MUTATION_PRESENTATION_MAX_IMAGE_BYTES + 1),
    ).toEqual({ status: "refused", reason: "capture-budget" });
    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "refuses non-accountable image byte length %s",
    (invalidBytes) => {
      const transport = createMutationPresentationWalkingSkeletonTransport({
        construct: summaryArtifact,
      });

      expect(reserve(transport, "edit-invalid-size", invalidBytes, 0)).toEqual({
        status: "refused",
        reason: "capture-budget",
      });
      expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    },
  );

  it("keeps ambiguous composite identities distinct with length-prefixed HMAC binding", async () => {
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct: summaryArtifact,
    });
    const input = candidate({ toolCallId: "edit-1", auditSeq: 23 });
    const admission = reserve(
      transport,
      input.toolCallId,
      Buffer.byteLength(input.observedBefore.content),
      Buffer.byteLength(input.verifiedInstalledAfter.content),
    );
    if (admission.status !== "reserved") throw new Error("expected reservation");

    transport.finalize({ kind: "candidate", reservation: admission.reservation, candidate: input });
    await vi.waitFor(() => expect(transport.terminalUsage().artifacts).toBe(1));

    expect(transport.take({ sessionId: SESSION_ID, toolCallId: "edit-12", auditSeq: 3 })).toEqual({
      status: "unavailable",
      reason: "not-found-or-consumed",
    });
    expect(
      transport.take({ sessionId: SESSION_ID, toolCallId: "edit-1", auditSeq: 23 }),
    ).toMatchObject({ status: "available" });
  });

  it("invalidates a reservation on identity mismatch without consuming another entry", () => {
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct: summaryArtifact,
    });
    const input = candidate({ toolCallId: "edit-wrong-binding", auditSeq: 25 });
    const admission = reserve(
      transport,
      "edit-original-binding",
      Buffer.byteLength(input.observedBefore.content),
      Buffer.byteLength(input.verifiedInstalledAfter.content),
    );
    if (admission.status !== "reserved") throw new Error("expected reservation");

    transport.finalize({ kind: "candidate", reservation: admission.reservation, candidate: input });

    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    expect(
      transport.take({
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        auditSeq: input.auditSeq,
      }),
    ).toEqual({ status: "unavailable", reason: "not-found-or-consumed" });
    transport.finalize({ kind: "candidate", reservation: admission.reservation, candidate: input });
    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
  });

  it("rejects an unavailable disposition whose reservation belongs to another identity", () => {
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct: summaryArtifact,
    });
    const admission = reserve(transport, "edit-original-unavailable-binding", 7, 6);
    if (admission.status !== "reserved") throw new Error("expected reservation");

    transport.finalize({
      kind: "unavailable",
      params: {
        sessionId: SESSION_ID,
        toolCallId: "edit-forged-unavailable-binding",
        auditSeq: 26,
      },
      reason: "capture-unavailable",
      reservation: admission.reservation,
    });

    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    expect(
      transport.take({
        sessionId: SESSION_ID,
        toolCallId: "edit-forged-unavailable-binding",
        auditSeq: 26,
      }),
    ).toEqual({ status: "unavailable", reason: "not-found-or-consumed" });

    transport.finalize({
      kind: "unavailable",
      params: {
        sessionId: SESSION_ID,
        toolCallId: "edit-original-unavailable-binding",
        auditSeq: 26,
      },
      reason: "capture-unavailable",
      reservation: admission.reservation,
    });
    expect(
      transport.take({
        sessionId: SESSION_ID,
        toolCallId: "edit-original-unavailable-binding",
        auditSeq: 26,
      }),
    ).toEqual({ status: "unavailable", reason: "not-found-or-consumed" });
  });

  it("binds lossless JSON string code units instead of collapsing unpaired surrogates", async () => {
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct: summaryArtifact,
    });
    const input = candidate({ toolCallId: "edit-\uD800", auditSeq: 24 });
    const admission = reserve(
      transport,
      input.toolCallId,
      Buffer.byteLength(input.observedBefore.content),
      Buffer.byteLength(input.verifiedInstalledAfter.content),
    );
    if (admission.status !== "reserved") throw new Error("expected reservation");

    transport.finalize({ kind: "candidate", reservation: admission.reservation, candidate: input });
    await vi.waitFor(() => expect(transport.terminalUsage().artifacts).toBe(1));

    expect(
      transport.take({ sessionId: SESSION_ID, toolCallId: "edit-\uD801", auditSeq: 24 }),
    ).toEqual({ status: "unavailable", reason: "not-found-or-consumed" });
    expect(
      transport.take({ sessionId: SESSION_ID, toolCallId: input.toolCallId, auditSeq: 24 }),
    ).toMatchObject({ status: "available" });
  });

  it("does not retain raw identity or path fields in serializable transport state", () => {
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct: summaryArtifact,
    });
    const admission = reserve(transport, "PRIVATE-TOOL-CALL", 7, 6);
    expect(admission.status).toBe("reserved");

    const serialized = JSON.stringify(transport);
    expect(serialized).not.toContain(SESSION_ID);
    expect(serialized).not.toContain("PRIVATE-TOOL-CALL");
    expect(serialized).not.toContain("private/path.txt");
    expect(serialized).toBe('{"advertiseTestCapability":true}');
  });

  it("rejects forged image-byte metadata and releases the reservation before construction", () => {
    let constructed = false;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct(input) {
        constructed = true;
        return summaryArtifact(input);
      },
    });
    const input = candidate({
      toolCallId: "edit-forged-bytes",
      auditSeq: 31,
      claimedBeforeBytes: 1,
    });
    const admission = reserve(
      transport,
      input.toolCallId,
      Buffer.byteLength(input.observedBefore.content),
      Buffer.byteLength(input.verifiedInstalledAfter.content),
    );
    if (admission.status !== "reserved") throw new Error("expected reservation");

    transport.finalize({ kind: "candidate", reservation: admission.reservation, candidate: input });

    expect(constructed).toBe(false);
    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    expect(
      transport.take({
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        auditSeq: input.auditSeq,
      }),
    ).toEqual({ status: "unavailable", reason: "capture-unavailable" });
  });

  it("settles a reservation-to-candidate content-size mismatch as capture-unavailable", () => {
    let constructed = false;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct(input) {
        constructed = true;
        return summaryArtifact(input);
      },
    });
    const input = candidate({
      toolCallId: "edit-content-size-drift",
      auditSeq: 32,
      after: "after changed after admission\n",
    });
    const admission = reserve(
      transport,
      input.toolCallId,
      Buffer.byteLength(input.observedBefore.content),
      Buffer.byteLength("after\n"),
    );
    if (admission.status !== "reserved") throw new Error("expected reservation");

    transport.finalize({ kind: "candidate", reservation: admission.reservation, candidate: input });

    expect(constructed).toBe(false);
    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    expect(
      transport.take({
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        auditSeq: input.auditSeq,
      }),
    ).toEqual({ status: "unavailable", reason: "capture-unavailable" });
  });

  it("records a bounded capture-budget disposition only after final correlation is known", () => {
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct: summaryArtifact,
    });
    const refused = reserve(transport, "edit-budget", MUTATION_PRESENTATION_MAX_IMAGE_BYTES + 1, 0);
    expect(refused).toEqual({ status: "refused", reason: "capture-budget" });

    transport.finalize({
      kind: "unavailable",
      params: { sessionId: SESSION_ID, toolCallId: "edit-budget", auditSeq: 41 },
      reason: "capture-budget",
    });

    expect(
      transport.take({ sessionId: SESSION_ID, toolCallId: "edit-budget", auditSeq: 41 }),
    ).toEqual({ status: "unavailable", reason: "capture-budget" });
    expect(
      transport.take({ sessionId: SESSION_ID, toolCallId: "edit-budget", auditSeq: 41 }),
    ).toEqual({ status: "unavailable", reason: "not-found-or-consumed" });
  });

  it("releases an accepted reservation into a sanitized unavailable disposition", () => {
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct: summaryArtifact,
    });
    const admission = reserve(transport, "edit-no-candidate", 7, 6);
    if (admission.status !== "reserved") throw new Error("expected reservation");

    transport.finalize({
      kind: "unavailable",
      params: { sessionId: SESSION_ID, toolCallId: "edit-no-candidate", auditSeq: 42 },
      reason: "capture-unavailable",
      reservation: admission.reservation,
    });

    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    expect(
      transport.take({ sessionId: SESSION_ID, toolCallId: "edit-no-candidate", auditSeq: 42 }),
    ).toEqual({ status: "unavailable", reason: "capture-unavailable" });
  });

  it("retains multiple finalized candidates in the separately bounded artifact lane", async () => {
    let constructed = 0;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct(input) {
        constructed += 1;
        return summaryArtifact(input);
      },
    });
    const first = candidate({ toolCallId: "edit-terminal-1", auditSeq: 43 });
    const second = candidate({ toolCallId: "edit-terminal-2", auditSeq: 44 });
    const firstAdmission = reserve(
      transport,
      first.toolCallId,
      first.observedBefore.bytes,
      first.verifiedInstalledAfter.bytes,
    );
    const secondAdmission = reserve(
      transport,
      second.toolCallId,
      second.observedBefore.bytes,
      second.verifiedInstalledAfter.bytes,
    );
    if (firstAdmission.status !== "reserved" || secondAdmission.status !== "reserved") {
      throw new Error("expected reservations");
    }

    transport.finalize({
      kind: "candidate",
      reservation: firstAdmission.reservation,
      candidate: first,
    });
    transport.finalize({
      kind: "candidate",
      reservation: secondAdmission.reservation,
      candidate: second,
    });
    await vi.waitFor(() => expect(constructed).toBe(2));

    expect(constructed).toBe(2);
    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    expect(
      transport.take({
        sessionId: second.sessionId,
        toolCallId: second.toolCallId,
        auditSeq: second.auditSeq,
      }),
    ).toMatchObject({ status: "available" });
    expect(
      transport.take({
        sessionId: first.sessionId,
        toolCallId: first.toolCallId,
        auditSeq: first.auditSeq,
      }),
    ).toMatchObject({ status: "available" });
  });

  it("clears every pending reservation and refuses later admission", async () => {
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct: summaryArtifact,
    });
    reserve(transport, "edit-clear-1", 10, 20);
    reserve(transport, "edit-clear-2", 30, 40);
    expect(transport.pendingUsage()).toEqual({ candidates: 2, bytes: 100 });

    await transport.clear();

    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    expect(reserve(transport, "edit-after-clear", 0, 0)).toEqual({
      status: "refused",
      reason: "capture-budget",
    });
    expect(() =>
      transport.finalize({
        kind: "unavailable",
        params: { sessionId: SESSION_ID, toolCallId: "edit-after-clear", auditSeq: 45 },
        reason: "capture-budget",
      }),
    ).not.toThrow();
  });
});
