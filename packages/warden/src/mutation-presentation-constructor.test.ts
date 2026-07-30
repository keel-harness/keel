import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { MutationPresentationSegmentV1T } from "@keel/shared";
import {
  MUTATION_PRESENTATION_MAX_HUNKS,
  MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES,
  MUTATION_PRESENTATION_MAX_LINE_BYTES,
  MUTATION_PRESENTATION_MAX_PRESENTED_LINES,
  ConstructionBudgetExceededError,
  assertArtifactWithinQuantitativeBounds,
  createMutationPresentationConstructionControl,
} from "./mutation-presentation-bounds.js";
import { constructMutationPresentationArtifact } from "./mutation-presentation-constructor.js";
import type {
  MutationPresentationConstructionControl,
  WardenMutationPresentationConstructionCandidateV1,
} from "./mutation-presentation-walking-skeleton.js";

const OPENAI_SECRET = "sk-proj-abcDEF1234567890abcDEF1234567890abcDEF12";

function text(segments: readonly MutationPresentationSegmentV1T[]): string {
  return segments
    .map((segment) => (segment.kind === "literal" ? segment.text : "[redacted]"))
    .join("");
}

function control(): MutationPresentationConstructionControl {
  return {
    checkpoint: async () => undefined,
    account: async () => undefined,
  };
}

function editCandidate(
  before: string,
  after: string,
): WardenMutationPresentationConstructionCandidateV1 {
  return {
    sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    toolCallId: "edit-constructor",
    auditSeq: 7,
    pathIdentity: "path-key-edit",
    operation: "edit",
    displayPath: `src/${OPENAI_SECRET}.ts`,
    observedBefore: {
      content: before,
      sha256: `sha256:${"1".repeat(64)}`,
      bytes: Buffer.byteLength(before, "utf8"),
      mode: 0o644,
    },
    verifiedInstalledAfter: {
      content: after,
      sha256: `sha256:${"2".repeat(64)}`,
      bytes: Buffer.byteLength(after, "utf8"),
      mode: 0o644,
    },
  };
}

describe("Epic 3.10 COVER/P1 production mutation-presentation constructor", () => {
  it("builds a complete source-numbered comparison and redacts before display truncation", async () => {
    const before = `alpha\nold ${OPENAI_SECRET}\nomega\n`;
    const artifact = await constructMutationPresentationArtifact(
      editCandidate(before, "alpha\nnew \u001b[2J\nomega\n"),
      control(),
    );

    expect(artifact).toMatchObject({
      schemaVersion: "mutation-presentation/v1",
      producer: "warden-typed-mutation",
      operation: "edit",
      auditSeq: 7,
      pathIdentity: "path-key-edit",
      observedBefore: {
        status: "file-observed",
        bytes: Buffer.byteLength(before, "utf8"),
        contentClass: "text",
        finalNewline: true,
      },
      verifiedInstalledAfter: {
        status: "file-observed",
        contentClass: "text",
        finalNewline: true,
      },
      transitionBinding: "not-atomic",
      concurrentMutation: "not-excluded",
      comparison: {
        coverage: "complete",
        totals: {
          observedBeforeLines: 3,
          installedAfterLines: 3,
          shownLines: 4,
          hiddenLines: 0,
        },
      },
    });
    expect(text(artifact.displayPath.segments)).toBe("src/[redacted].ts");
    expect(artifact.comparison.hunks).toHaveLength(1);
    expect(artifact.comparison.hunks[0]).toMatchObject({
      observedBeforeStart: 1,
      observedBeforeLines: 3,
      installedAfterStart: 1,
      installedAfterLines: 3,
    });
    expect(
      artifact.comparison.hunks[0]?.lines.map((line) => ({
        kind: line.kind,
        text: text(line.segments),
        ...(line.kind === "context"
          ? {
              observedBeforeLine: line.observedBeforeLine,
              installedAfterLine: line.installedAfterLine,
            }
          : line.kind === "observed-before"
            ? { observedBeforeLine: line.observedBeforeLine }
            : { installedAfterLine: line.installedAfterLine }),
      })),
    ).toEqual([
      { kind: "context", text: "alpha", observedBeforeLine: 1, installedAfterLine: 1 },
      { kind: "observed-before", text: "old [redacted]", observedBeforeLine: 2 },
      { kind: "installed-after", text: "new ␛[2J", installedAfterLine: 2 },
      { kind: "context", text: "omega", observedBeforeLine: 3, installedAfterLine: 3 },
    ]);
    expect(JSON.stringify(artifact)).not.toContain(OPENAI_SECRET);
    expect(JSON.stringify(artifact)).not.toContain("\u001b");
  });

  it("represents an absent-observed write as verified installed additions without a create claim", async () => {
    const after = "one\ntwo";
    const candidate: WardenMutationPresentationConstructionCandidateV1 = {
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      toolCallId: "write-absent-constructor",
      auditSeq: 8,
      pathIdentity: "path-key-write-absent",
      operation: "write",
      displayPath: "new.txt",
      observedBefore: { status: "absent-observed" },
      verifiedInstalledAfter: {
        content: after,
        sha256: `sha256:${"3".repeat(64)}`,
        bytes: Buffer.byteLength(after, "utf8"),
        mode: 0o644,
      },
    };

    const artifact = await constructMutationPresentationArtifact(candidate, control());

    expect(artifact.observedBefore).toEqual({ status: "absent-observed" });
    expect(artifact.operation).toBe("write");
    expect(artifact.comparison).toMatchObject({
      coverage: "complete",
      totals: {
        observedBeforeLines: 0,
        installedAfterLines: 2,
        shownLines: 2,
        hiddenLines: 0,
      },
    });
    expect(artifact.comparison.hunks[0]?.lines.map((line) => line.kind)).toEqual([
      "installed-after",
      "installed-after",
    ]);
    expect(artifact.comparison.hunks[0]).toMatchObject({
      observedBeforeStart: 0,
      observedBeforeLines: 0,
      installedAfterStart: 1,
      installedAfterLines: 2,
    });
    expect(JSON.stringify(artifact)).not.toMatch(/created|exact-diff|modified|removed/u);
  });

  it("keeps oversized or deliberately unretained write preimages explicitly not-inspected", async () => {
    const after = "replacement\n";
    const candidate: WardenMutationPresentationConstructionCandidateV1 = {
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      toolCallId: "write-not-inspected-constructor",
      auditSeq: 9,
      pathIdentity: "path-key-write-not-inspected",
      operation: "write",
      displayPath: "large.txt",
      observedBefore: { status: "not-inspected" },
      verifiedInstalledAfter: {
        content: after,
        sha256: `sha256:${"4".repeat(64)}`,
        bytes: Buffer.byteLength(after, "utf8"),
        mode: 0o600,
      },
    };

    const artifact = await constructMutationPresentationArtifact(candidate, control());

    expect(artifact.observedBefore).toEqual({ status: "not-inspected" });
    expect(artifact.comparison).toEqual({
      coverage: "unknown",
      totals: {
        observedBeforeLines: "unknown",
        installedAfterLines: 1,
        shownLines: 0,
        hiddenLines: "unknown",
      },
      hunks: [],
      redactionCount: 0,
    });
  });

  it("classifies a fully observed binary preimage without projecting its bytes into hunks", async () => {
    const before = Buffer.from([0x61, 0x00, 0xff, 0x62]);
    const after = "safe text\n";
    const artifact = await constructMutationPresentationArtifact(
      {
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolCallId: "write-binary-constructor",
        auditSeq: 10,
        pathIdentity: "path-key-write-binary",
        operation: "write",
        displayPath: "binary.dat",
        observedBefore: {
          status: "file-observed",
          content: before,
          sha256: `sha256:${"5".repeat(64)}`,
          bytes: before.byteLength,
          mode: 0o600,
        },
        verifiedInstalledAfter: {
          content: after,
          sha256: `sha256:${"6".repeat(64)}`,
          bytes: Buffer.byteLength(after, "utf8"),
          mode: 0o600,
        },
      },
      control(),
    );

    expect(artifact.observedBefore).toMatchObject({
      status: "file-observed",
      contentClass: "binary",
      finalNewline: false,
    });
    expect(artifact.comparison.coverage).toBe("summary-only");
    expect(artifact.comparison.hunks).toEqual([]);
    expect(JSON.stringify(artifact)).not.toContain(before.toString("base64"));
  });

  it("omits unchanged rows after proving an identical overwrite comparison", async () => {
    const content = "same\nbytes\n";
    const artifact = await constructMutationPresentationArtifact(
      {
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        auditSeq: 11,
        pathIdentity: "path-key-write-identical",
        operation: "write",
        toolCallId: "write-identical-constructor",
        displayPath: "same.txt",
        observedBefore: {
          status: "file-observed",
          content: Buffer.from(content, "utf8"),
          sha256: `sha256:${"7".repeat(64)}`,
          bytes: Buffer.byteLength(content, "utf8"),
          mode: 0o644,
        },
        verifiedInstalledAfter: {
          content,
          sha256: `sha256:${"8".repeat(64)}`,
          bytes: Buffer.byteLength(content, "utf8"),
          mode: 0o644,
        },
      },
      control(),
    );

    expect(artifact.comparison).toMatchObject({
      coverage: "complete",
      totals: {
        observedBeforeLines: 2,
        installedAfterLines: 2,
        shownLines: 0,
        hiddenLines: 2,
      },
    });
    expect(artifact.comparison.hunks).toEqual([]);
  });

  it("keeps a fully computed multi-hunk comparison complete when only unchanged context is hidden", async () => {
    const before = Array.from({ length: 20 }, (_, index) => `line-${String(index + 1)}`);
    const after = [...before];
    after[1] = "changed-two";
    after[17] = "changed-eighteen";

    const artifact = await constructMutationPresentationArtifact(
      editCandidate(`${before.join("\n")}\n`, `${after.join("\n")}\n`),
      control(),
    );

    expect(artifact.comparison.coverage).toBe("complete");
    expect(artifact.comparison.hunks).toHaveLength(2);
    expect(artifact.comparison.totals.hiddenLines).toBeGreaterThan(0);
    expect(
      artifact.comparison.hunks
        .flatMap((hunk) => hunk.lines)
        .filter((line) => line.kind !== "context"),
    ).toHaveLength(4);
  });

  it("redacts the full source line before bounding its rendered width", async () => {
    const longSecretLine = `${"x".repeat(MUTATION_PRESENTATION_MAX_LINE_BYTES - 5)} ${OPENAI_SECRET}`;
    const artifact = await constructMutationPresentationArtifact(
      editCandidate(`${longSecretLine}\n`, "safe replacement\n"),
      control(),
    );
    const removed = artifact.comparison.hunks[0]?.lines.find(
      (line) => line.kind === "observed-before",
    );
    if (removed === undefined) throw new Error("expected one observed-before row");

    expect(removed.redactionCount).toBe(0);
    expect(artifact.comparison.redactionCount).toBe(1);
    expect(Buffer.byteLength(text(removed.segments), "utf8")).toBeLessThanOrEqual(
      MUTATION_PRESENTATION_MAX_LINE_BYTES,
    );
    expect(artifact.comparison.coverage).toBe("truncated");
    expect(JSON.stringify(artifact)).not.toContain(OPENAI_SECRET);
  });

  it("caps presented rows and hunks without overstating comparison completeness", async () => {
    const additions = Array.from(
      { length: MUTATION_PRESENTATION_MAX_PRESENTED_LINES + 1 },
      (_, index) => `addition-${String(index)}`,
    ).join("\n");
    const added = await constructMutationPresentationArtifact(
      {
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolCallId: "write-presented-line-cap",
        auditSeq: 12,
        pathIdentity: "path-key-line-cap",
        operation: "write",
        displayPath: "bounded.txt",
        observedBefore: { status: "absent-observed" },
        verifiedInstalledAfter: {
          content: additions,
          sha256: `sha256:${"9".repeat(64)}`,
          bytes: Buffer.byteLength(additions),
          mode: 0o644,
        },
      },
      control(),
    );
    expect(added.comparison).toMatchObject({
      coverage: "truncated",
      totals: {
        observedBeforeLines: 0,
        installedAfterLines: MUTATION_PRESENTATION_MAX_PRESENTED_LINES + 1,
        shownLines: MUTATION_PRESENTATION_MAX_PRESENTED_LINES,
        hiddenLines: 1,
      },
    });

    const before = Array.from(
      { length: 8 * (MUTATION_PRESENTATION_MAX_HUNKS + 1) },
      (_, index) => `stable-${String(index)}`,
    );
    const after = [...before];
    for (let index = 0; index < MUTATION_PRESENTATION_MAX_HUNKS + 1; index += 1) {
      after[index * 8] = `changed-${String(index)}`;
    }
    const manyHunks = await constructMutationPresentationArtifact(
      editCandidate(`${before.join("\n")}\n`, `${after.join("\n")}\n`),
      control(),
    );
    expect(manyHunks.comparison.hunks).toHaveLength(MUTATION_PRESENTATION_MAX_HUNKS);
    expect(manyHunks.comparison.coverage).toBe("truncated");
  });

  it("keeps a maximum admitted text image inside the serialized artifact ceiling", async () => {
    // Empty rows keep rendered-text bytes low while maximizing typed per-row JSON metadata. This
    // forces the serialized-fit path instead of the earlier aggregate rendered-text bound.
    const metadataHeavyLine = "x".repeat(48);
    const installed = Array.from(
      { length: MUTATION_PRESENTATION_MAX_PRESENTED_LINES },
      () => metadataHeavyLine,
    ).join("\n");
    let checkpoints = 0;
    const cooperativeControl: MutationPresentationConstructionControl = {
      account: async () => undefined,
      checkpoint: async () => {
        checkpoints += 1;
      },
    };
    expect(Buffer.byteLength(installed)).toBeLessThanOrEqual(2 * 1024 * 1024);
    const artifact = await constructMutationPresentationArtifact(
      {
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolCallId: "write-artifact-byte-cap",
        auditSeq: 14,
        pathIdentity: "path-key-artifact-byte-cap",
        operation: "write",
        displayPath: "maximum.txt",
        observedBefore: { status: "absent-observed" },
        verifiedInstalledAfter: {
          content: installed,
          sha256: `sha256:${"b".repeat(64)}`,
          bytes: Buffer.byteLength(installed),
          mode: 0o644,
        },
      },
      cooperativeControl,
    );

    expect(Buffer.byteLength(JSON.stringify(artifact))).toBeLessThanOrEqual(
      MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES,
    );
    expect(() => assertArtifactWithinQuantitativeBounds(artifact)).not.toThrow();
    expect(artifact.comparison.coverage).toBe("truncated");
    expect(artifact.comparison.totals.shownLines).toBeLessThan(
      MUTATION_PRESENTATION_MAX_PRESENTED_LINES,
    );
    if (
      typeof artifact.comparison.totals.shownLines !== "number" ||
      typeof artifact.comparison.totals.hiddenLines !== "number"
    ) {
      throw new Error("expected exact text comparison totals");
    }
    expect(artifact.comparison.totals.shownLines + artifact.comparison.totals.hiddenLines).toBe(
      MUTATION_PRESENTATION_MAX_PRESENTED_LINES,
    );
    // The two redaction passes each checkpoint twice. Oversize serialized fitting must add at least
    // one more yield so repeated JSON serialization cannot monopolize the Warden event loop.
    expect(checkpoints).toBeGreaterThanOrEqual(5);
  });

  it("fails closed when real constructor line accounting exceeds its registered ceiling", async () => {
    let now = 0;
    const bounded = createMutationPresentationConstructionControl({
      startedAt: now,
      now: () => now,
      cooperativeYield: async () => {
        now += 0.001;
      },
      assertCurrent: () => undefined,
    });
    const tooManyLines = `${"x\n".repeat(20_001)}`;
    const candidate: WardenMutationPresentationConstructionCandidateV1 = {
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      toolCallId: "write-indexed-line-cap",
      auditSeq: 13,
      pathIdentity: "path-key-indexed-line-cap",
      operation: "write",
      displayPath: "too-many-lines.txt",
      observedBefore: { status: "absent-observed" },
      verifiedInstalledAfter: {
        content: tooManyLines,
        sha256: `sha256:${"a".repeat(64)}`,
        bytes: Buffer.byteLength(tooManyLines),
        mode: 0o644,
      },
    };

    await expect(
      constructMutationPresentationArtifact(candidate, bounded.control),
    ).rejects.toBeInstanceOf(ConstructionBudgetExceededError);
  });

  it("preserves valid source numbering across randomized small comparisons", async () => {
    const line = fc
      .array(fc.constantFrom("a", "b", "c", "0", "1", "-"), { maxLength: 8 })
      .map((characters) => characters.join(""));
    await fc.assert(
      fc.asyncProperty(
        fc.array(line, { maxLength: 8 }),
        fc.array(line, { maxLength: 8 }),
        async (before, after) => {
          const artifact = await constructMutationPresentationArtifact(
            editCandidate(before.join("\n"), after.join("\n")),
            control(),
          );
          for (const row of artifact.comparison.hunks.flatMap((hunk) => hunk.lines)) {
            if (row.kind === "context") {
              expect(text(row.segments)).toBe(before[row.observedBeforeLine - 1]);
              expect(text(row.segments)).toBe(after[row.installedAfterLine - 1]);
            } else if (row.kind === "observed-before") {
              expect(text(row.segments)).toBe(before[row.observedBeforeLine - 1]);
            } else {
              expect(text(row.segments)).toBe(after[row.installedAfterLine - 1]);
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
