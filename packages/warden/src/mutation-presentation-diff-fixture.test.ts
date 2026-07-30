import { createHash } from "node:crypto";
import type { MutationPresentationSegmentV1T, MutationPresentationV1T } from "@keel/shared";
import { describe, expect, it } from "vitest";
import {
  MUTATION_PRESENTATION_MAX_LINE_BYTES,
  MUTATION_PRESENTATION_MAX_PATH_BYTES,
  MUTATION_PRESENTATION_MAX_PRESENTED_LINES,
} from "./mutation-presentation-bounds.js";
import { constructMutationPresentationArtifact } from "./mutation-presentation-constructor.js";
import type {
  MutationPresentationConstructionControl,
  WardenMutationPresentationConstructionCandidateV1,
} from "./mutation-presentation-walking-skeleton.js";
import { parseEditArgs } from "./typed-tools.js";

const control: MutationPresentationConstructionControl = {
  checkpoint: async () => undefined,
  account: async () => undefined,
};

function sha256(content: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function editCandidate(
  before: string,
  after: string,
  displayPath = "src/fixture.ts",
): WardenMutationPresentationConstructionCandidateV1 {
  return {
    sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    toolCallId: "fixture-edit",
    auditSeq: 31,
    pathIdentity: "fixture-path-key",
    operation: "edit",
    displayPath,
    observedBefore: {
      content: before,
      sha256: sha256(before),
      bytes: Buffer.byteLength(before),
      mode: 0o644,
    },
    verifiedInstalledAfter: {
      content: after,
      sha256: sha256(after),
      bytes: Buffer.byteLength(after),
      mode: 0o644,
    },
  };
}

function observedText(artifact: MutationPresentationV1T): string[] {
  return artifact.comparison.hunks.flatMap((hunk) =>
    hunk.lines
      .filter((line) => line.kind === "observed-before")
      .map((line) => displayText(line.segments)),
  );
}

function installedText(artifact: MutationPresentationV1T): string[] {
  return artifact.comparison.hunks.flatMap((hunk) =>
    hunk.lines
      .filter((line) => line.kind === "installed-after")
      .map((line) => displayText(line.segments)),
  );
}

function displayText(segments: readonly MutationPresentationSegmentV1T[]): string {
  return segments
    .map((segment) => (segment.kind === "literal" ? segment.text : "[redacted]"))
    .join("");
}

const DISPOSITIONS = [
  [1, "captured-small-substitution"],
  [2, "captured-adjacent-blocks"],
  [3, "captured-whitespace"],
  [4, "captured-tabs-unicode"],
  [5, "captured-bounded-long-line"],
  [6, "captured-multiple-hunks"],
  [7, "captured-absent-write; delete-uncaptured"],
  [8, "rename-uncaptured"],
  [9, "mode-change-uncaptured"],
  [10, "typed-binary-refused; external-binary-uncaptured"],
  [11, "captured-final-newline-metadata"],
  [12, "identical-edit-refused; identical-write-observed"],
  [13, "per-occurrence-multi-file; over-cap-truncated"],
  [14, "captured-redacted-bounded-path"],
  [15, "captured-control-neutralized"],
] as const;

describe("Epic 3.10 mandatory 15-case mutation-presentation fixture", () => {
  it("has one explicit product disposition for every rubric case without a generic unsupported bucket", () => {
    expect(DISPOSITIONS.map(([id]) => id)).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
    expect(DISPOSITIONS.every(([, disposition]) => disposition.length > 0)).toBe(true);
    expect(DISPOSITIONS.map(([, disposition]) => disposition).join("\n")).not.toContain(
      "NOT_SUPPORTED",
    );
  });

  it("covers small substitution and adjacent delete/add blocks with exact source rows", async () => {
    const small = await constructMutationPresentationArtifact(
      editCandidate("const total = 10;\n", "const total = 12;\n"),
      control,
    );
    expect(observedText(small)).toEqual(["const total = 10;"]);
    expect(installedText(small)).toEqual(["const total = 12;"]);
    expect(small.comparison.coverage).toBe("complete");

    const adjacent = await constructMutationPresentationArtifact(
      editCandidate("keep\ndelete-a\ndelete-b\ntail\n", "keep\nadd-a\nadd-b\ntail\n"),
      control,
    );
    expect(observedText(adjacent)).toEqual(["delete-a", "delete-b"]);
    expect(installedText(adjacent)).toEqual(["add-a", "add-b"]);
    expect(adjacent.comparison.totals).toMatchObject({
      observedBeforeLines: 4,
      installedAfterLines: 4,
    });
  });

  it("preserves indentation, trailing whitespace, and Unicode while rendering tabs as inert tokens", async () => {
    const before = "\tconst label = 'café  ';\n  const flag = '🇨🇦';\n";
    const after = "  const label = 'café';\n\tconst flag = '👩🏽‍💻';\n";
    const artifact = await constructMutationPresentationArtifact(
      editCandidate(before, after),
      control,
    );

    // ADR-0078 neutralizes C0 controls before transport. The producer hashes below retain exact byte
    // identity; the terminal-facing comparison makes each tab visible instead of letting terminal
    // tab stops change the layout. Slice 3B owns cell-safe layout without weakening this boundary.
    expect(observedText(artifact)).toEqual(["␉const label = 'café  ';", "  const flag = '🇨🇦';"]);
    expect(installedText(artifact)).toEqual(["  const label = 'café';", "␉const flag = '👩🏽‍💻';"]);
    expect(artifact.observedBefore).toMatchObject({ sha256: sha256(before) });
    expect(artifact.verifiedInstalledAfter).toMatchObject({ sha256: sha256(after) });
    expect(artifact.observedBefore).toMatchObject({ bytes: Buffer.byteLength(before) });
    expect(artifact.verifiedInstalledAfter).toMatchObject({ bytes: Buffer.byteLength(after) });
  });

  it("bounds a 16 KiB changed line and reports truncation without losing exact line totals", async () => {
    const before = `${"a".repeat(16 * 1024)}\n`;
    const after = `${"b".repeat(16 * 1024)}\n`;
    const artifact = await constructMutationPresentationArtifact(
      editCandidate(before, after),
      control,
    );

    expect(artifact.comparison.coverage).toBe("truncated");
    expect(artifact.comparison.totals).toMatchObject({
      observedBeforeLines: 1,
      installedAfterLines: 1,
      shownLines: 2,
      hiddenLines: 0,
    });
    for (const line of artifact.comparison.hunks.flatMap((hunk) => hunk.lines)) {
      expect(Buffer.byteLength(displayText(line.segments))).toBeLessThanOrEqual(
        MUTATION_PRESENTATION_MAX_LINE_BYTES,
      );
    }
  });

  it("keeps separated changes as exact complete hunks", async () => {
    const before = Array.from({ length: 30 }, (_, index) => `line-${String(index + 1)}`);
    const after = [...before];
    after[1] = "changed-two";
    after[27] = "changed-twenty-eight";
    const artifact = await constructMutationPresentationArtifact(
      editCandidate(`${before.join("\n")}\n`, `${after.join("\n")}\n`),
      control,
    );

    expect(artifact.comparison.coverage).toBe("complete");
    expect(artifact.comparison.hunks).toHaveLength(2);
    expect(observedText(artifact)).toEqual(["line-2", "line-28"]);
    expect(installedText(artifact)).toEqual(["changed-two", "changed-twenty-eight"]);
  });

  it("represents a new typed write as absent-observed without an atomic create claim", async () => {
    const after = "first\nsecond";
    const artifact = await constructMutationPresentationArtifact(
      {
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolCallId: "fixture-new-write",
        auditSeq: 32,
        pathIdentity: "fixture-new-path-key",
        operation: "write",
        displayPath: "new file.txt",
        observedBefore: { status: "absent-observed" },
        verifiedInstalledAfter: {
          content: after,
          sha256: sha256(after),
          bytes: Buffer.byteLength(after),
          mode: 0o644,
        },
      },
      control,
    );

    expect(artifact.observedBefore).toEqual({ status: "absent-observed" });
    expect(installedText(artifact)).toEqual(["first", "second"]);
    expect(JSON.stringify(artifact)).not.toMatch(/created|exact-diff|modified|removed/iu);
  });

  it("keeps a typed-write binary preimage's metadata and hash while inventing no text comparison", async () => {
    const before = Buffer.from([0x00, 0x41, 0xff, 0x0a]);
    const after = "safe replacement\n";
    const artifact = await constructMutationPresentationArtifact(
      {
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolCallId: "fixture-binary-write",
        auditSeq: 35,
        pathIdentity: "fixture-binary-path-key",
        operation: "write",
        displayPath: "assets/data.bin",
        observedBefore: {
          status: "file-observed",
          content: before,
          sha256: sha256(before),
          bytes: before.byteLength,
          mode: 0o600,
        },
        verifiedInstalledAfter: {
          content: after,
          sha256: sha256(after),
          bytes: Buffer.byteLength(after),
          mode: 0o600,
        },
      },
      control,
    );

    expect(artifact.observedBefore).toMatchObject({
      sha256: sha256(before),
      bytes: before.byteLength,
      contentClass: "binary",
    });
    expect(artifact.verifiedInstalledAfter).toMatchObject({
      sha256: sha256(after),
      bytes: Buffer.byteLength(after),
      contentClass: "text",
    });
    expect(artifact.comparison).toMatchObject({ coverage: "summary-only", hunks: [] });
  });

  it("records a missing-final-newline difference even when logical text rows match", async () => {
    const artifact = await constructMutationPresentationArtifact(
      editCandidate("alpha\n", "alpha"),
      control,
    );

    expect(artifact.observedBefore).toMatchObject({ finalNewline: true });
    expect(artifact.verifiedInstalledAfter).toMatchObject({ finalNewline: false });
    expect(artifact.comparison).toMatchObject({
      coverage: "complete",
      totals: { shownLines: 0, hiddenLines: 1 },
      hunks: [],
    });
  });

  it("refuses an identical edit and separately reports an identical-byte write comparison", async () => {
    expect(() => parseEditArgs({ path: "same.txt", oldString: "same", newString: "same" })).toThrow(
      /identical \(no-op\)/u,
    );

    const content = "same\nbytes\n";
    const observedContent = Buffer.from(content, "utf8");
    const artifact = await constructMutationPresentationArtifact(
      {
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolCallId: "fixture-identical-write",
        auditSeq: 33,
        pathIdentity: "fixture-identical-path-key",
        operation: "write",
        displayPath: "same.txt",
        observedBefore: {
          status: "file-observed",
          content: observedContent,
          sha256: sha256(observedContent),
          bytes: observedContent.byteLength,
          mode: 0o644,
        },
        verifiedInstalledAfter: {
          content,
          sha256: sha256(content),
          bytes: Buffer.byteLength(content),
          mode: 0o644,
        },
      },
      control,
    );
    expect(artifact.observedBefore).toMatchObject({ sha256: sha256(content) });
    expect(artifact.verifiedInstalledAfter.sha256).toBe(sha256(content));
    expect(artifact.comparison.totals).toMatchObject({ shownLines: 0, hiddenLines: 2 });
  });

  it("keeps multi-file observations occurrence-scoped and reports an over-cap artifact exactly", async () => {
    const first = await constructMutationPresentationArtifact(
      editCandidate("a\n", "A\n", "src/one.ts"),
      control,
    );
    const second = await constructMutationPresentationArtifact(
      editCandidate("b\n", "B\n", "src/two.ts"),
      control,
    );
    expect([first, second].map((item) => displayText(item.displayPath.segments))).toEqual([
      "src/one.ts",
      "src/two.ts",
    ]);
    expect(
      [first, second].reduce(
        (sum, item) =>
          sum +
          item.comparison.hunks
            .flatMap((hunk) => hunk.lines)
            .filter((line) => line.kind !== "context").length,
        0,
      ),
    ).toBe(4);

    const installed = Array.from(
      { length: MUTATION_PRESENTATION_MAX_PRESENTED_LINES + 1 },
      (_, index) => `line-${String(index + 1)}`,
    ).join("\n");
    const overCap = await constructMutationPresentationArtifact(
      {
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolCallId: "fixture-over-cap",
        auditSeq: 34,
        pathIdentity: "fixture-over-cap-path-key",
        operation: "write",
        displayPath: "large.txt",
        observedBefore: { status: "absent-observed" },
        verifiedInstalledAfter: {
          content: installed,
          sha256: sha256(installed),
          bytes: Buffer.byteLength(installed),
          mode: 0o644,
        },
      },
      control,
    );
    expect(overCap.comparison).toMatchObject({
      coverage: "truncated",
      totals: {
        observedBeforeLines: 0,
        installedAfterLines: MUTATION_PRESENTATION_MAX_PRESENTED_LINES + 1,
        shownLines: MUTATION_PRESENTATION_MAX_PRESENTED_LINES,
        hiddenLines: 1,
      },
    });
  });

  it("bounds hostile paths and neutralizes ANSI, OSC, CR, bidi, and state-spoofing content", async () => {
    const escape = String.fromCharCode(27);
    const hostilePath = `dir with spaces/punct.!()/${"long-component-".repeat(50)}${escape}[2J.ts`;
    const before = `normal\n${escape}]0;owned\u0007● sandbox on\r\u202Eevil\n`;
    const after = `normal\n${escape}[31m● audit verified\u202C\n`;
    const artifact = await constructMutationPresentationArtifact(
      editCandidate(before, after, hostilePath),
      control,
    );
    const json = JSON.stringify(artifact);
    const path = displayText(artifact.displayPath.segments);

    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(MUTATION_PRESENTATION_MAX_PATH_BYTES);
    expect(path).toContain("dir with spaces/punct.!()");
    expect(json).not.toContain(escape);
    expect(json).not.toContain("\u0007");
    expect(json).not.toContain("\r");
    expect(json).not.toContain("\u202e");
    expect(json).toContain("␛");
    expect(artifact.comparison.coverage).toBe("complete");
  });
});
