import { describe, expect, it } from "vitest";
import {
  MutationPresentationTakeParamsV1,
  MutationPresentationTakeResultV1,
  MutationPresentationV1,
} from "./mutation-presentation.js";

const SHA = `sha256:${"a".repeat(64)}`;

const artifact = {
  schemaVersion: "mutation-presentation/v1",
  producer: "warden-typed-mutation",
  operation: "write",
  auditSeq: 0,
  displayPath: { segments: [{ kind: "literal", text: "new.txt" }], redactionCount: 0 },
  pathIdentity: "path_opaque",
  observedBefore: { status: "absent-observed" },
  verifiedInstalledAfter: {
    status: "file-observed",
    sha256: SHA,
    bytes: 4,
    mode: 0o644,
    contentClass: "text",
    finalNewline: true,
  },
  transitionBinding: "not-atomic",
  concurrentMutation: "not-excluded",
  comparison: {
    coverage: "summary-only",
    totals: {
      observedBeforeLines: 0,
      installedAfterLines: 1,
      shownLines: 0,
      hiddenLines: 1,
    },
    hunks: [],
    redactionCount: 0,
  },
  freshness: { basis: "warden-observation", currentWorkspace: "not-observed" },
};

describe("mutation-presentation/v1 frozen wire schemas", () => {
  it("accepts the non-atomic observed/verified artifact and rejects authority upgrades", () => {
    expect(MutationPresentationV1.parse(artifact)).toEqual(artifact);
    for (const invalid of [
      { ...artifact, transitionBinding: "atomic" },
      { ...artifact, concurrentMutation: "excluded" },
      { ...artifact, producer: "kernel" },
      { ...artifact, operation: "created" },
      { ...artifact, exactDiff: true },
      {
        ...artifact,
        verifiedInstalledAfter: { ...artifact.verifiedInstalledAfter, mode: 0o1000 },
      },
    ]) {
      expect(MutationPresentationV1.safeParse(invalid).success).toBe(false);
    }
  });

  it("requires the exact one-shot correlation key, including valid audit sequence zero", () => {
    const valid = {
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      toolCallId: "tc_1",
      auditSeq: 0,
    };
    expect(MutationPresentationTakeParamsV1.parse(valid)).toEqual(valid);
    expect(MutationPresentationTakeParamsV1.safeParse({ ...valid, auditSeq: -1 }).success).toBe(
      false,
    );
    expect(MutationPresentationTakeParamsV1.safeParse({ ...valid, extra: true }).success).toBe(
      false,
    );
  });

  it("keeps pending polling and terminal unavailable reasons closed and bounded", () => {
    expect(MutationPresentationTakeResultV1.parse({ status: "available", artifact })).toEqual({
      status: "available",
      artifact,
    });
    expect(MutationPresentationTakeResultV1.parse({ status: "pending", retryAfterMs: 1 })).toEqual({
      status: "pending",
      retryAfterMs: 1,
    });
    expect(
      MutationPresentationTakeResultV1.parse({
        status: "unavailable",
        reason: "not-found-or-consumed",
      }),
    ).toEqual({ status: "unavailable", reason: "not-found-or-consumed" });

    for (const invalid of [
      { status: "pending", retryAfterMs: 0 },
      { status: "pending", retryAfterMs: 26 },
      { status: "pending", retryAfterMs: Number.NaN },
      { status: "unavailable", reason: "unknown" },
      { status: "unavailable", reason: "capture-budget", extra: true },
    ]) {
      expect(MutationPresentationTakeResultV1.safeParse(invalid).success).toBe(false);
    }
  });

  it("binds each comparison line kind to its authoritative source line numbers", () => {
    const base = { segments: [{ kind: "literal", text: "x" }], redactionCount: 0 };
    const result = MutationPresentationV1.shape.comparison.shape.hunks.element.shape.lines;
    expect(
      result.safeParse([
        { kind: "context", observedBeforeLine: 1, installedAfterLine: 1, ...base },
        { kind: "observed-before", observedBeforeLine: 2, ...base },
        { kind: "installed-after", installedAfterLine: 2, ...base },
      ]).success,
    ).toBe(true);
    for (const invalid of [
      [{ kind: "context", observedBeforeLine: 1, ...base }],
      [{ kind: "observed-before", installedAfterLine: 1, ...base }],
      [{ kind: "installed-after", observedBeforeLine: 1, ...base }],
    ]) {
      expect(result.safeParse(invalid).success).toBe(false);
    }
  });
});
