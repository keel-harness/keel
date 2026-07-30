import { describe, expect, it } from "vitest";
import {
  BUNDLE_FORMAT_VERSION,
  BundleManifest,
  checkpointRecords,
  checkpointTailCoverageError,
  sha256Bytes,
} from "./evidence-bundle.js";
import type { AnyAuditRecordT, AuditCheckpointRecordT } from "./record.js";

describe("evidence-bundle shared format + helpers (ADR-0071 P1-10 slice 2)", () => {
  it("pins the bundle format version", () => {
    expect(BUNDLE_FORMAT_VERSION).toBe("evidence-bundle/v1-2b");
  });

  it("computes a sha256:<hex> digest (characterization golden)", () => {
    expect(sha256Bytes("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("parses a valid manifest and rejects a malformed one (.strict())", () => {
    const manifest = {
      bundleFormatVersion: BUNDLE_FORMAT_VERSION,
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      createdAt: "2026-07-15T00:00:00.000Z",
      recordCount: 0,
      timeRange: { from: null, to: null },
      rootHash: `sha256:${"0".repeat(64)}`,
      policyPack: { name: "starter", hash: `sha256:${"0".repeat(64)}` },
      redactionLevel: "full",
      signer: { checkpointPublicKey: `ed25519:${"A".repeat(43)}=` },
      checkpoints: { file: "checkpoints.json", count: 0 },
      componentHashes: { "audit.jsonl": `sha256:${"0".repeat(64)}` },
    };
    expect(BundleManifest.parse(manifest).sessionId).toBe("ses_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(BundleManifest.safeParse({ ...manifest, unexpected: true }).success).toBe(false);
    expect(BundleManifest.safeParse({ ...manifest, recordCount: -1 }).success).toBe(false);
  });

  it("selects only checkpoint records and detects an uncovered tail", () => {
    const base = { sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV", hash: `sha256:${"1".repeat(64)}` };
    const entry = { ...base, eventType: "tool.execute", seq: 1 } as unknown as AnyAuditRecordT;
    const checkpoint = {
      ...base,
      eventType: "checkpoint",
      seq: 2,
      hash: `sha256:${"2".repeat(64)}`,
    } as unknown as AuditCheckpointRecordT;

    expect(checkpointRecords([entry, checkpoint])).toEqual([checkpoint]);
    // tail is a non-checkpoint record (entry last) → uncovered
    expect(checkpointTailCoverageError([checkpoint, entry], [checkpoint])).toMatch(
      /not signed by a final checkpoint/u,
    );
    // tail IS the final checkpoint (checkpoint last) → covered
    expect(checkpointTailCoverageError([entry, checkpoint], [checkpoint])).toBeUndefined();
    // empty chain → covered (nothing to sign)
    expect(checkpointTailCoverageError([], [])).toBeUndefined();
  });
});
