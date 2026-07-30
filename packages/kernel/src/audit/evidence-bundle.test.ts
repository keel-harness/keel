import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnyAuditRecord,
  type AnyAuditRecordT,
  type AuditCheckpointRecordT,
  BundleCheckpoints,
  BundleManifest,
  type BundleManifestT,
  type ConfigSnapshotT,
  GENESIS_PREV_HASH,
  hashAuditRecord,
  type JsonValueT,
  merkleRootForAuditHashes,
  type PolicyPackSnapshotT,
  type PrincipalT,
  type SideEffectT,
  publicKeyFromSecretKey,
  signCheckpointRecord,
  toChainRecords,
  verifyChain,
} from "@keel/shared";
// ADR-0071 P1-10 slice 2: the warden BUILDS bundles; the kernel's offline verifier is what
// `keel audit verify` runs. This round-trip test lives with the verifier it exercises.
import { AuditChainWriter, EvidenceBundleError, buildEvidenceBundle } from "@keel/warden";
import { verifyEvidenceBundle } from "./verify-bundle.js";

const PRINCIPAL: PrincipalT = {
  osUser: "alice",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
};
const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FIXED_TS = "2026-06-26T14:00:00.000Z";
const PACK_HASH = `sha256:${"a".repeat(64)}`;
const CHECKPOINT_SECRET_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const CHECKPOINT_PUBLIC_KEY = publicKeyFromSecretKey(CHECKPOINT_SECRET_KEY);
const WRONG_CHECKPOINT_PUBLIC_KEY = `ed25519:${Buffer.from(
  publicKeyFromSecretKey(Uint8Array.from({ length: 32 }, (_, i) => 101 + i)),
).toString("base64")}`;
const WRONG_CHECKPOINT_SIG = `ed25519:${Buffer.from(new Uint8Array(64).fill(9)).toString(
  "base64",
)}`;

const SIDE_EFFECT: SideEffectT = {
  taxonomyVersion: "side-effect-taxonomy/v1",
  staticCapability: { toolName: "bash", effectEnvelope: ["fs_read"], broad: true },
  dynamic: {
    effectKinds: ["fs_read"],
    scopes: ["workspace"],
    targets: [],
    modifiers: [],
    composition: {
      kind: "atomic",
      segments: [{ effectKinds: ["fs_read"], scopes: ["workspace"], targets: [], modifiers: [] }],
      edges: [],
    },
    classifier: { name: "test-classifier", version: "1", confidence: "exact", reasons: [] },
  },
};

const POLICY_PACK: PolicyPackSnapshotT = {
  name: "default",
  hash: PACK_HASH,
  files: { "starter.rego": "package keel\n", "starter-wasm.ts": "export const x = 1;\n" },
};
const CONFIG: ConfigSnapshotT = {
  enforcementTier: "none",
  sandboxBackend: "srt:vendored",
  egressAllowlist: ["registry.npmjs.org"],
};

let dir: string;
let logPath: string;
let outDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-bundle-"));
  logPath = join(dir, "audit.jsonl");
  outDir = join(dir, "out");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openWriter(cadence = 128) {
  return AuditChainWriter.open({
    path: logPath,
    principal: PRINCIPAL,
    now: () => FIXED_TS,
    policyPack: { name: POLICY_PACK.name, hash: POLICY_PACK.hash },
    checkpoint: { cadence, secretKey: CHECKPOINT_SECRET_KEY },
  });
}

function readRecords(path: string): AnyAuditRecordT[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => AnyAuditRecord.parse(JSON.parse(l)));
}

function componentHash(bundlePath: string, relativePath: string): string {
  return `sha256:${createHash("sha256")
    .update(readFileSync(join(bundlePath, relativePath)))
    .digest("hex")}`;
}

function updateManifest(bundlePath: string, mutate: (manifest: BundleManifestT) => void): void {
  const manifestPath = join(bundlePath, "manifest.json");
  const manifest = BundleManifest.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  mutate(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function refreshComponentHash(bundlePath: string, relativePath: string): void {
  updateManifest(bundlePath, (manifest) => {
    manifest.componentHashes[relativePath] = componentHash(bundlePath, relativePath);
  });
}

function writeBundleAuditRecords(bundlePath: string, records: readonly AnyAuditRecordT[]): void {
  writeFileSync(
    join(bundlePath, "audit.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

function forgeTailRecord(records: readonly AnyAuditRecordT[]): AnyAuditRecordT {
  const previous = records[records.length - 1];
  if (previous === undefined) throw new Error("cannot forge a tail for an empty record list");
  if (previous.policyPack === undefined) {
    throw new Error("cannot forge a current-format tail without policy-pack evidence");
  }
  const draft = {
    seq: previous.seq + 1,
    ts: FIXED_TS,
    sessionId: previous.sessionId,
    principal: previous.principal,
    eventType: "session.end" as const,
    payload: { forged: true },
    policyPack: previous.policyPack,
    prevHash: previous.hash,
    hash: `sha256:${"0".repeat(64)}`,
  };
  return AnyAuditRecord.parse({
    ...draft,
    hash: hashAuditRecord(draft),
  });
}

function appendHashConsistentForgedTail(bundlePath: string): void {
  const records = readRecords(join(bundlePath, "audit.jsonl"));
  const forged = forgeTailRecord(records);
  const extended = [...records, forged];
  writeBundleAuditRecords(bundlePath, extended);
  updateManifest(bundlePath, (manifest) => {
    manifest.rootHash = forged.hash;
    manifest.recordCount = extended.length;
    manifest.componentHashes["audit.jsonl"] = componentHash(bundlePath, "audit.jsonl");
  });
}

function removeCheckpointRecordsFromBundle(bundlePath: string): void {
  const manifestPath = join(bundlePath, "manifest.json");
  const manifest = BundleManifest.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const records = readRecords(join(bundlePath, "audit.jsonl")).filter(
    (record) => record.eventType !== "checkpoint",
  );
  writeBundleAuditRecords(bundlePath, records);
  writeFileSync(
    join(bundlePath, "checkpoints.json"),
    `${JSON.stringify(
      {
        bundleFormatVersion: "evidence-bundle/v1-2b",
        sessionId: manifest.sessionId,
        publicKey: manifest.signer.checkpointPublicKey,
        checkpoints: [],
      },
      null,
      2,
    )}\n`,
  );
  const last = records[records.length - 1];
  updateManifest(bundlePath, (m) => {
    m.recordCount = records.length;
    m.rootHash = last?.hash ?? `sha256:${"0".repeat(64)}`;
    m.checkpoints.count = 0;
    m.componentHashes["audit.jsonl"] = componentHash(bundlePath, "audit.jsonl");
    m.componentHashes["checkpoints.json"] = componentHash(bundlePath, "checkpoints.json");
  });
}

function build(
  records: readonly AnyAuditRecordT[],
  source?: Partial<{
    policyPack: PolicyPackSnapshotT;
    config: ConfigSnapshotT;
    checkpointPublicKey: Uint8Array;
    redactionLevel: "full" | "redacted";
  }>,
) {
  return buildEvidenceBundle(
    {
      sessionId: SESSION_ID,
      records,
      policyPack: POLICY_PACK,
      config: CONFIG,
      checkpointPublicKey: CHECKPOINT_PUBLIC_KEY,
      ...source,
    },
    { outDir, now: () => FIXED_TS },
  );
}

function checkpointedRecords(): AnyAuditRecordT[] {
  const w = openWriter(2);
  w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
  w.append({
    eventType: "tool.execute",
    sessionId: SESSION_ID,
    payload: { command: "ls" },
    sideEffect: SIDE_EFFECT,
  });
  w.close();
  return readRecords(logPath);
}

/**
 * A hand-sealed chain [session.start, session.end(+unknown field), signed checkpoint] as a NEWER
 * keel might write it (ADR-0072 P1-12). The `futureField` is committed to r1's hash and covered by
 * the checkpoint — a tolerant reader must verify it, byte-for-byte, without understanding it.
 */
function recordsWithUnknownField(): AnyAuditRecordT[] {
  const r0raw: Record<string, JsonValueT> = {
    seq: 0,
    ts: FIXED_TS,
    sessionId: SESSION_ID,
    principal: { ...PRINCIPAL },
    eventType: "session.start",
    payload: {},
    policyPack: { packName: POLICY_PACK.name, packHash: POLICY_PACK.hash },
    prevHash: GENESIS_PREV_HASH,
  };
  const r0 = { ...r0raw, hash: hashAuditRecord(r0raw) };
  const r1raw: Record<string, JsonValueT> = {
    seq: 1,
    ts: FIXED_TS,
    sessionId: SESSION_ID,
    principal: { ...PRINCIPAL },
    eventType: "session.end",
    payload: {},
    policyPack: { packName: POLICY_PACK.name, packHash: POLICY_PACK.hash },
    prevHash: r0.hash,
    futureField: { schemaThing: 7 },
  };
  const r1 = { ...r1raw, hash: hashAuditRecord(r1raw) };
  const cpDraft: AuditCheckpointRecordT = {
    seq: 2,
    ts: FIXED_TS,
    sessionId: SESSION_ID,
    principal: { ...PRINCIPAL },
    eventType: "checkpoint",
    payload: {},
    policyPack: { packName: POLICY_PACK.name, packHash: POLICY_PACK.hash },
    prevHash: r1.hash,
    merkleRoot: merkleRootForAuditHashes([r0.hash, r1.hash]),
    range: [0, 1],
    hash: GENESIS_PREV_HASH,
    sig: `ed25519:${Buffer.alloc(64).toString("base64")}`,
  };
  const cp = signCheckpointRecord(cpDraft, CHECKPOINT_SECRET_KEY);
  return [r0, r1, cp] as unknown as AnyAuditRecordT[];
}

// ADR-0071 P1-10 slice 2: build↔verify round-trip. The warden BUILDS the bundle
// (buildEvidenceBundle) and the kernel VERIFIES it (verifyEvidenceBundle) — the two sides now
// live in different packages, so this exercises the real cross-package contract end to end,
// including the warden's shipped standalone verify-bundle.mjs.
describe("evidence bundle build↔verify round-trip (Epic 2.18 · ADR-0071)", () => {
  it("builds a bundle whose audit.jsonl re-verifies and whose rootHash matches the chain head", () => {
    const w = openWriter(2);
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { command: "ls" },
      sideEffect: SIDE_EFFECT,
    });
    w.close();
    const records = readRecords(logPath);
    const expectedHead = records[records.length - 1]!.hash;

    const result = build(records);

    expect(existsSync(result.bundlePath)).toBe(true);
    expect(result.rootHash).toBe(expectedHead);

    const manifest = BundleManifest.parse(
      JSON.parse(readFileSync(join(result.bundlePath, "manifest.json"), "utf8")),
    );
    expect(manifest.bundleFormatVersion).toBe("evidence-bundle/v1-2b");
    expect(manifest.rootHash).toBe(expectedHead);
    expect(manifest.sessionId).toBe(SESSION_ID);
    expect(manifest.recordCount).toBe(3);
    expect(manifest.redactionLevel).toBe("full");
    expect(manifest.checkpoints.count).toBe(1);
    expect(Object.keys(manifest.componentHashes).sort()).toEqual([
      "audit.jsonl",
      "checkpoints.json",
      "config-snapshot.json",
      "policy-pack/starter-wasm.ts",
      "policy-pack/starter.rego",
      "redaction-report.json",
      "replay.html",
      "verify/VERIFY.md",
      "verify/verify-bundle.mjs",
    ]);
    expect(manifest.timeRange).toEqual({ from: FIXED_TS, to: FIXED_TS });

    const checkpoints = BundleCheckpoints.parse(
      JSON.parse(readFileSync(join(result.bundlePath, "checkpoints.json"), "utf8")),
    );
    expect(checkpoints.checkpoints).toHaveLength(1);
    const bundled = readRecords(join(result.bundlePath, "audit.jsonl"));
    expect(verifyChain(toChainRecords(bundled)).ok).toBe(true);
    expect(bundled).toHaveLength(3);
    expect(verifyEvidenceBundle(result.bundlePath).ok).toBe(true);
  });

  it("refuses to export checkpointed records without the matching checkpoint public key", () => {
    const records = checkpointedRecords();

    expect(() =>
      buildEvidenceBundle(
        { sessionId: SESSION_ID, records, policyPack: POLICY_PACK, config: CONFIG },
        { outDir, now: () => FIXED_TS },
      ),
    ).toThrow(EvidenceBundleError);
  });

  it("refuses to export non-empty Phase-2B records when no checkpoint was written", () => {
    const w = AuditChainWriter.open({
      path: logPath,
      principal: PRINCIPAL,
      now: () => FIXED_TS,
    });
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w.close();

    expect(() => build(readRecords(logPath))).toThrow(/no signed checkpoints/i);
  });

  it("refuses to export logs with foreign sessions before bundling", () => {
    const otherSession = "ses_01BX5ZZKBKACTAV9WEVGEMMVRZ";
    const w = openWriter();
    w.append({ eventType: "session.start", sessionId: otherSession, payload: {} });
    w.close();

    expect(() => build(readRecords(logPath))).toThrow(/foreign session record/i);
  });

  it("refuses to export records whose checkpoint signature is not valid", () => {
    const records = checkpointedRecords();
    const checkpoint = records.find((record) => record.eventType === "checkpoint");
    expect(checkpoint).toBeDefined();
    (checkpoint as { sig: string }).sig = WRONG_CHECKPOINT_SIG;

    expect(() => build(records)).toThrow(/checkpoint_signature_invalid/i);
  });

  it("refuses to export a hash-consistent tail that is not covered by the final signed checkpoint", () => {
    const records = checkpointedRecords();
    const forged = forgeTailRecord(records);

    expect(() => build([...records, forged])).toThrow(/checkpoint tail is not signed/i);
  });

  it("verifier rejects tampered bundle components and unexpected extra files", () => {
    const records = checkpointedRecords();
    const tamperCases: Array<[string, (bundlePath: string) => void]> = [
      [
        "audit",
        (bundlePath) => {
          const auditPath = join(bundlePath, "audit.jsonl");
          const lines = readFileSync(auditPath, "utf8").trimEnd().split("\n");
          const first = JSON.parse(lines[0]!) as { payload: unknown };
          first.payload = { tampered: true };
          lines[0] = JSON.stringify(first);
          writeFileSync(auditPath, `${lines.join("\n")}\n`);
        },
      ],
      [
        "checkpoints",
        (bundlePath) => {
          const checkpointsPath = join(bundlePath, "checkpoints.json");
          const checkpointFile = JSON.parse(readFileSync(checkpointsPath, "utf8")) as {
            checkpoints: Array<{ range: [number, number] }>;
          };
          checkpointFile.checkpoints[0]!.range = [0, 0];
          writeFileSync(checkpointsPath, `${JSON.stringify(checkpointFile, null, 2)}\n`);
        },
      ],
      [
        "manifest",
        (bundlePath) => {
          const manifestPath = join(bundlePath, "manifest.json");
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { rootHash: string };
          manifest.rootHash = `sha256:${"b".repeat(64)}`;
          writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        },
      ],
      [
        "config",
        (bundlePath) => {
          writeFileSync(
            join(bundlePath, "config-snapshot.json"),
            '{"enforcementTier":"tampered"}\n',
          );
        },
      ],
      [
        "policy-pack",
        (bundlePath) => {
          writeFileSync(join(bundlePath, "policy-pack", "starter.rego"), "package tampered\n");
        },
      ],
      [
        "extra-file",
        (bundlePath) => {
          writeFileSync(join(bundlePath, "EXTRA.txt"), "unexpected\n");
        },
      ],
    ];

    for (const [name, tamper] of tamperCases) {
      const result = build(records);
      tamper(result.bundlePath);
      expect(verifyEvidenceBundle(result.bundlePath), name).toMatchObject({ ok: false });
    }
  });

  it("verifier reports self-consistent checkpoint metadata and signature tamper", () => {
    const mismatch = build(checkpointedRecords());
    const mismatchCheckpointsPath = join(mismatch.bundlePath, "checkpoints.json");
    const mismatchCheckpoints = JSON.parse(readFileSync(mismatchCheckpointsPath, "utf8")) as {
      publicKey: string;
    };
    mismatchCheckpoints.publicKey = WRONG_CHECKPOINT_PUBLIC_KEY;
    writeFileSync(mismatchCheckpointsPath, `${JSON.stringify(mismatchCheckpoints, null, 2)}\n`);
    refreshComponentHash(mismatch.bundlePath, "checkpoints.json");
    expect(verifyEvidenceBundle(mismatch.bundlePath)).toMatchObject({
      ok: false,
      kind: "checkpoint_mismatch",
    });

    const invalid = build(checkpointedRecords());
    const auditPath = join(invalid.bundlePath, "audit.jsonl");
    const auditRecords = readFileSync(auditPath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line): { eventType: string; sig?: string } => {
        const parsed: unknown = JSON.parse(line);
        return parsed as { eventType: string; sig?: string };
      });
    const auditCheckpoint = auditRecords.find((record) => record.eventType === "checkpoint");
    expect(auditCheckpoint).toBeDefined();
    auditCheckpoint!.sig = WRONG_CHECKPOINT_SIG;
    writeFileSync(
      auditPath,
      `${auditRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    refreshComponentHash(invalid.bundlePath, "audit.jsonl");

    const invalidCheckpointsPath = join(invalid.bundlePath, "checkpoints.json");
    const invalidCheckpoints = JSON.parse(readFileSync(invalidCheckpointsPath, "utf8")) as {
      checkpoints: Array<{ sig: string }>;
    };
    invalidCheckpoints.checkpoints[0]!.sig = WRONG_CHECKPOINT_SIG;
    writeFileSync(invalidCheckpointsPath, `${JSON.stringify(invalidCheckpoints, null, 2)}\n`);
    refreshComponentHash(invalid.bundlePath, "checkpoints.json");

    expect(verifyEvidenceBundle(invalid.bundlePath)).toMatchObject({
      ok: false,
      kind: "checkpoint_invalid",
    });
  });

  it("refuses a bundle that contains a symlink (no following links out of the bundle)", () => {
    const result = build(checkpointedRecords());
    symlinkSync("/etc/passwd", join(result.bundlePath, "sneaky-link"));
    expect(verifyEvidenceBundle(result.bundlePath)).toMatchObject({
      ok: false,
      kind: "component_set_mismatch",
      detail: "bundle contains a symlink",
    });
  });

  it("verifier rejects a hash-consistent forged tail after the final signed checkpoint", () => {
    const result = build(checkpointedRecords());
    appendHashConsistentForgedTail(result.bundlePath);

    expect(verifyEvidenceBundle(result.bundlePath)).toMatchObject({
      ok: false,
      kind: "checkpoint_tail_uncovered",
    });
  });

  it("verifier rejects a hash-consistent non-empty bundle with no checkpoint records", () => {
    const result = build(checkpointedRecords());
    removeCheckpointRecordsFromBundle(result.bundlePath);

    expect(verifyEvidenceBundle(result.bundlePath)).toMatchObject({
      ok: false,
      kind: "checkpoint_missing",
    });
  });

  it("verifier reports hash-consistent artifact, manifest, session, redaction, and policy faults", () => {
    const artifact = build(checkpointedRecords());
    writeFileSync(join(artifact.bundlePath, "config-snapshot.json"), '{"enforcementTier":"x"}\n');
    refreshComponentHash(artifact.bundlePath, "config-snapshot.json");
    expect(verifyEvidenceBundle(artifact.bundlePath)).toMatchObject({
      ok: false,
      kind: "artifact_invalid",
    });

    const redaction = build(checkpointedRecords());
    const redactionReportPath = join(redaction.bundlePath, "redaction-report.json");
    const redactionReport = JSON.parse(readFileSync(redactionReportPath, "utf8")) as {
      redactionLevel: string;
    };
    redactionReport.redactionLevel = "redacted";
    writeFileSync(redactionReportPath, `${JSON.stringify(redactionReport, null, 2)}\n`);
    refreshComponentHash(redaction.bundlePath, "redaction-report.json");
    expect(verifyEvidenceBundle(redaction.bundlePath)).toMatchObject({
      ok: false,
      kind: "redaction_mismatch",
    });

    const session = build(checkpointedRecords());
    const checkpointsPath = join(session.bundlePath, "checkpoints.json");
    const checkpoints = JSON.parse(readFileSync(checkpointsPath, "utf8")) as { sessionId: string };
    checkpoints.sessionId = "ses_01BX5ZZKBKACTAV9WEVGEMMVRZ";
    writeFileSync(checkpointsPath, `${JSON.stringify(checkpoints, null, 2)}\n`);
    refreshComponentHash(session.bundlePath, "checkpoints.json");
    expect(verifyEvidenceBundle(session.bundlePath)).toMatchObject({
      ok: false,
      kind: "session_mismatch",
    });

    const count = build(checkpointedRecords());
    updateManifest(count.bundlePath, (manifest) => {
      manifest.recordCount += 1;
    });
    expect(verifyEvidenceBundle(count.bundlePath)).toMatchObject({
      ok: false,
      kind: "chain_invalid",
    });

    // Break the hash chain itself (corrupt a non-tail record's payload but keep its stored
    // hash) and refresh the audit.jsonl component hash so the component + count checks pass and
    // the chain verifier actually runs — exercising the `!chain.ok` path, not count mismatch.
    const chainBreak = build(checkpointedRecords());
    const chainAuditPath = join(chainBreak.bundlePath, "audit.jsonl");
    const chainLines = readFileSync(chainAuditPath, "utf8").trimEnd().split("\n");
    const firstRecord = JSON.parse(chainLines[0]!) as { payload: unknown };
    firstRecord.payload = { tampered: true };
    chainLines[0] = JSON.stringify(firstRecord);
    writeFileSync(chainAuditPath, `${chainLines.join("\n")}\n`);
    refreshComponentHash(chainBreak.bundlePath, "audit.jsonl");
    expect(verifyEvidenceBundle(chainBreak.bundlePath)).toMatchObject({
      ok: false,
      kind: "chain_invalid",
    });

    const root = build(checkpointedRecords());
    updateManifest(root.bundlePath, (manifest) => {
      manifest.rootHash = `sha256:${"b".repeat(64)}`;
    });
    expect(verifyEvidenceBundle(root.bundlePath)).toMatchObject({
      ok: false,
      kind: "root_mismatch",
    });

    const policyWriter = openWriter();
    policyWriter.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { command: "ls" },
      sideEffect: SIDE_EFFECT,
      policy: {
        packName: "default",
        packHash: PACK_HASH,
        ruleIds: [],
        verdict: "allow",
      },
    });
    policyWriter.close();
    const policy = build(readRecords(logPath));
    updateManifest(policy.bundlePath, (manifest) => {
      manifest.policyPack.hash = `sha256:${"b".repeat(64)}`;
    });
    expect(verifyEvidenceBundle(policy.bundlePath)).toMatchObject({
      ok: false,
      kind: "policy_mismatch",
    });

    const policyPackWriter = openWriter();
    policyPackWriter.append({
      eventType: "session.start",
      sessionId: SESSION_ID,
      payload: {},
      policyPack: { name: "default", hash: PACK_HASH },
    });
    policyPackWriter.close();
    const policyPack = build(readRecords(logPath));
    updateManifest(policyPack.bundlePath, (manifest) => {
      manifest.policyPack.hash = `sha256:${"b".repeat(64)}`;
    });
    expect(verifyEvidenceBundle(policyPack.bundlePath)).toMatchObject({
      ok: false,
      kind: "policy_mismatch",
    });

    const missingPolicyPack = build(checkpointedRecords());
    const missingPolicyPackAuditPath = join(missingPolicyPack.bundlePath, "audit.jsonl");
    const missingPolicyPackRecords = readFileSync(missingPolicyPackAuditPath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, JsonValueT>);
    delete missingPolicyPackRecords[0]!["policyPack"];
    let prevHash = GENESIS_PREV_HASH;
    const rehashedMissingPolicyPackRecords = missingPolicyPackRecords.map((record) => {
      const draft = AnyAuditRecord.parse({
        ...record,
        prevHash,
        hash: GENESIS_PREV_HASH,
      });
      const hashed = {
        ...draft,
        hash: hashAuditRecord(draft as unknown as Record<string, JsonValueT>),
      };
      prevHash = hashed.hash;
      return hashed;
    });
    writeBundleAuditRecords(missingPolicyPack.bundlePath, rehashedMissingPolicyPackRecords);
    updateManifest(missingPolicyPack.bundlePath, (manifest) => {
      manifest.rootHash = prevHash;
      manifest.componentHashes["audit.jsonl"] = componentHash(
        missingPolicyPack.bundlePath,
        "audit.jsonl",
      );
    });
    expect(verifyEvidenceBundle(missingPolicyPack.bundlePath)).toMatchObject({
      ok: false,
      kind: "policy_mismatch",
    });

    const unsafe = build(checkpointedRecords());
    updateManifest(unsafe.bundlePath, (manifest) => {
      manifest.componentHashes["../escape"] = `sha256:${"c".repeat(64)}`;
    });
    expect(verifyEvidenceBundle(unsafe.bundlePath)).toMatchObject({
      ok: false,
      kind: "component_set_mismatch",
    });
  });

  it("verifier reports an invalid manifest before reading bundle artifacts", () => {
    const result = build(checkpointedRecords());
    writeFileSync(join(result.bundlePath, "manifest.json"), '{"bundleFormatVersion":"old"}\n');

    expect(verifyEvidenceBundle(result.bundlePath)).toMatchObject({
      ok: false,
      kind: "manifest_invalid",
    });
  });

  // ADR-0072 §4 (P1-12 Slice 6): a recognizable-but-unsupported envelope version is a "newer keel"
  // signal — the in-process verifier AND the vendored .mjs both say "upgrade", not a bare failure.
  it("reports an honest 'newer keel; upgrade' message on an unsupported bundle format version", () => {
    const result = build(checkpointedRecords());
    // A newer keel would stamp a bumped envelope version; the rest of the manifest stays intact.
    updateManifest(result.bundlePath, (m) => {
      (m as unknown as { bundleFormatVersion: string }).bundleFormatVersion =
        "evidence-bundle/v2-future";
    });

    const verdict = verifyEvidenceBundle(result.bundlePath);
    expect(verdict.ok).toBe(false);
    expect((verdict as { detail: string }).detail).toMatch(/newer keel/i);
    expect((verdict as { detail: string }).detail).not.toMatch(/unsupported bundle format/i);

    // The vendored .mjs gives the same honest signal (auditor-facing).
    const verifier = join(result.bundlePath, "verify", "verify-bundle.mjs");
    const bad = spawnSync(process.execPath, [verifier, result.bundlePath], { encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(`${bad.stdout}\n${bad.stderr}`).toMatch(/newer keel/i);
  });

  it("builds a redacted-level bundle that still verifies and omits planted secrets", () => {
    const secret = "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF1234";
    const w = openWriter();
    w.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { token: secret },
      sideEffect: SIDE_EFFECT,
    });
    w.close();

    const result = build(readRecords(logPath), { redactionLevel: "redacted" });

    expect(result.manifest.redactionLevel).toBe("redacted");
    expect(verifyEvidenceBundle(result.bundlePath).ok).toBe(true);
    const bundleText = [
      readFileSync(join(result.bundlePath, "audit.jsonl"), "utf8"),
      readFileSync(join(result.bundlePath, "replay.html"), "utf8"),
      readFileSync(join(result.bundlePath, "redaction-report.json"), "utf8"),
    ].join("\n");
    expect(bundleText).not.toContain(secret);
    expect(bundleText).toContain("[redacted:");
  });

  it("writes a vendored Node verifier that accepts the bundle and rejects tamper", () => {
    const result = build(checkpointedRecords());
    const verifier = join(result.bundlePath, "verify", "verify-bundle.mjs");

    const ok = spawnSync(process.execPath, [verifier, result.bundlePath], { encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("OK");

    writeFileSync(
      join(result.bundlePath, "config-snapshot.json"),
      '{"enforcementTier":"tampered"}\n',
    );
    const bad = spawnSync(process.execPath, [verifier, result.bundlePath], { encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(`${bad.stdout}\n${bad.stderr}`).toContain("FAIL");
  });

  it("vendored verifier rejects a hash-consistent forged tail after the final signed checkpoint", () => {
    const result = build(checkpointedRecords());
    const verifier = join(result.bundlePath, "verify", "verify-bundle.mjs");
    appendHashConsistentForgedTail(result.bundlePath);

    const bad = spawnSync(process.execPath, [verifier, result.bundlePath], { encoding: "utf8" });

    expect(bad.status).toBe(1);
    expect(`${bad.stdout}\n${bad.stderr}`).toContain("checkpoint tail uncovered");
  });

  it("vendored verifier matches shared canonicalization over JCS edge payloads", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const dalet = String.fromCharCode(0xfb33);
    const euro = String.fromCharCode(0x20ac);
    const w = openWriter(2);
    w.append({
      eventType: "session.start",
      sessionId: SESSION_ID,
      payload: {
        [dalet]: "bmp-after-surrogate",
        [emoji]: "supplementary-plane",
        [euro]: "bmp",
        nested: { z: 1, a: [{ b: 'line\nquote"slash\\', a: 1e21 }] },
      },
    });
    w.append({
      eventType: "session.end",
      sessionId: SESSION_ID,
      payload: {
        arrayOrder: [3, 1, 2],
        escaped: "\u0000\t\n",
      },
    });
    w.close();
    const result = build(readRecords(logPath));
    const verifier = join(result.bundlePath, "verify", "verify-bundle.mjs");

    expect(verifyEvidenceBundle(result.bundlePath).ok).toBe(true);
    const ok = spawnSync(process.execPath, [verifier, result.bundlePath], { encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("OK");
  });

  it("writes operator verification guidance for out-of-band signer-key comparison", () => {
    const result = build(checkpointedRecords());
    const verifyReadme = readFileSync(join(result.bundlePath, "verify", "VERIFY.md"), "utf8");

    expect(verifyReadme).toContain("internally consistent");
    expect(verifyReadme).toContain("signer.checkpointPublicKey");
    expect(verifyReadme).toContain("out-of-band");
  });

  it("snapshots the policy pack + config, and the manifest references the pack", () => {
    const w = openWriter();
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w.close();
    const result = build(readRecords(logPath));

    const cfg = JSON.parse(
      readFileSync(join(result.bundlePath, "config-snapshot.json"), "utf8"),
    ) as ConfigSnapshotT;
    expect(cfg).toEqual(CONFIG);

    expect(readFileSync(join(result.bundlePath, "policy-pack", "starter.rego"), "utf8")).toBe(
      "package keel\n",
    );
    expect(result.manifest.policyPack).toEqual({ name: "default", hash: PACK_HASH });
  });

  it("fails closed when a record's policy packHash does not match the snapshot pack", () => {
    const w = openWriter();
    w.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { command: "ls" },
      sideEffect: SIDE_EFFECT,
      policy: {
        packName: "default",
        packHash: `sha256:${"b".repeat(64)}`,
        ruleIds: [],
        verdict: "allow",
      },
    });
    w.close();
    expect(() => build(readRecords(logPath))).toThrow(EvidenceBundleError);
  });

  it("fails closed when a record-level policyPack hash does not match the snapshot pack", () => {
    const w = openWriter();
    w.append({
      eventType: "session.start",
      sessionId: SESSION_ID,
      payload: {},
      policyPack: { name: "stale", hash: `sha256:${"b".repeat(64)}` },
    });
    w.close();
    expect(() => build(readRecords(logPath))).toThrow(EvidenceBundleError);
  });

  it("fails closed when a current-format bundle record omits policyPack evidence", () => {
    const unstamped = AuditChainWriter.open({
      path: logPath,
      principal: PRINCIPAL,
      now: () => FIXED_TS,
      checkpoint: { cadence: 128, secretKey: CHECKPOINT_SECRET_KEY },
    });
    unstamped.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    unstamped.close();

    expect(() => build(readRecords(logPath))).toThrow(EvidenceBundleError);
  });

  it("rejects an unsafe policy-pack filename (no path traversal)", () => {
    const w = openWriter();
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w.close();
    const evil: PolicyPackSnapshotT = { ...POLICY_PACK, files: { "../escape.txt": "x" } };
    expect(() => build(readRecords(logPath), { policyPack: evil })).toThrow(EvidenceBundleError);
  });

  it("writes an escaped replay.html that renders the session", () => {
    const w = openWriter();
    w.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { note: "<script>alert(1)</script>" },
      sideEffect: SIDE_EFFECT,
    });
    w.close();
    const result = build(readRecords(logPath));
    const html = readFileSync(join(result.bundlePath, "replay.html"), "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("is reproducible: same input + clock → byte-identical files; only manifest createdAt varies", () => {
    const w = openWriter(2);
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { command: "ls" },
      sideEffect: SIDE_EFFECT,
    });
    w.close();
    const records = readRecords(logPath);
    const src = {
      sessionId: SESSION_ID,
      records,
      policyPack: POLICY_PACK,
      config: CONFIG,
      checkpointPublicKey: CHECKPOINT_PUBLIC_KEY,
    };

    const t1 = "2026-01-01T00:00:00.000Z";
    const t2 = "2026-12-31T23:59:59.000Z";
    const a = buildEvidenceBundle(src, { outDir: join(dir, "a"), now: () => t1 });
    const b = buildEvidenceBundle(src, { outDir: join(dir, "b"), now: () => t1 });
    const c = buildEvidenceBundle(src, { outDir: join(dir, "c"), now: () => t2 });

    const read = (base: string, f: string) => readFileSync(join(base, f), "utf8");
    for (const f of [
      "manifest.json",
      "audit.jsonl",
      "config-snapshot.json",
      "checkpoints.json",
      "redaction-report.json",
      "replay.html",
      "verify/VERIFY.md",
      "verify/verify-bundle.mjs",
      "policy-pack/starter.rego",
    ]) {
      expect(read(a.bundlePath, f)).toBe(read(b.bundlePath, f)); // same clock → identical
    }
    // Different clock → everything but the manifest createdAt is identical.
    expect(read(a.bundlePath, "audit.jsonl")).toBe(read(c.bundlePath, "audit.jsonl"));
    expect(read(a.bundlePath, "replay.html")).toBe(read(c.bundlePath, "replay.html"));
    const ma = BundleManifest.parse(JSON.parse(read(a.bundlePath, "manifest.json")));
    const mc = BundleManifest.parse(JSON.parse(read(c.bundlePath, "manifest.json")));
    expect(ma.createdAt).not.toBe(mc.createdAt);
    expect({ ...ma, createdAt: "X" }).toEqual({ ...mc, createdAt: "X" });
  });

  it("refuses to export a tampered chain (fails closed)", () => {
    const w = openWriter(2);
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w.append({ eventType: "session.end", sessionId: SESSION_ID, payload: {} });
    w.close();
    const records = readRecords(logPath);
    records[0]!.payload = { tampered: true }; // stored hash now stale

    expect(() => build(records)).toThrow();
  });

  it("defaults createdAt to wall-clock ISO 8601 when no clock is injected", () => {
    const w = openWriter();
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w.close();
    const result = buildEvidenceBundle(
      {
        sessionId: SESSION_ID,
        records: readRecords(logPath),
        policyPack: POLICY_PACK,
        config: CONFIG,
        checkpointPublicKey: CHECKPOINT_PUBLIC_KEY,
      },
      { outDir }, // no injected clock
    );
    expect(new Date(result.manifest.createdAt).toISOString()).toBe(result.manifest.createdAt);
  });

  it("replaces a prior export — no stale policy-pack or top-level files survive a re-export", () => {
    const w = openWriter();
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w.close();
    const records = readRecords(logPath);

    // First export with a DIFFERENT pack file set.
    buildEvidenceBundle(
      {
        sessionId: SESSION_ID,
        records,
        policyPack: { ...POLICY_PACK, files: { "old-rule.rego": "old\n" } },
        config: CONFIG,
        checkpointPublicKey: CHECKPOINT_PUBLIC_KEY,
      },
      { outDir, now: () => FIXED_TS },
    );
    const bundleDir = join(outDir, `bundle_${SESSION_ID}`);
    writeFileSync(join(bundleDir, "STALE.txt"), "leftover"); // a stray artifact

    // Re-export with the canonical POLICY_PACK (starter.rego, ...).
    const result = build(records);
    expect(existsSync(join(result.bundlePath, "STALE.txt"))).toBe(false);
    expect(existsSync(join(result.bundlePath, "policy-pack", "old-rule.rego"))).toBe(false);
    expect(existsSync(join(result.bundlePath, "policy-pack", "starter.rego"))).toBe(true);
  });

  it("computes timeRange as min/max over ts (robust to a non-monotonic clock)", () => {
    let i = 0;
    const stamps = [
      "2026-06-26T14:00:05.000Z",
      "2026-06-26T14:00:01.000Z",
      "2026-06-26T14:00:03.000Z",
    ]; // decreasing normal records; checkpoint sits between min/max
    const w = AuditChainWriter.open({
      path: logPath,
      principal: PRINCIPAL,
      now: () => stamps[i++]!,
      policyPack: { name: POLICY_PACK.name, hash: POLICY_PACK.hash },
      checkpoint: { cadence: 2, secretKey: CHECKPOINT_SECRET_KEY },
    });
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w.append({ eventType: "session.end", sessionId: SESSION_ID, payload: {} });
    w.close();
    const result = build(readRecords(logPath));
    expect(result.manifest.timeRange).toEqual({
      from: "2026-06-26T14:00:01.000Z",
      to: "2026-06-26T14:00:05.000Z",
    });
  });

  it("handles an empty session (genesis rootHash, null time range)", () => {
    const result = build([]);
    const manifest = BundleManifest.parse(
      JSON.parse(readFileSync(join(result.bundlePath, "manifest.json"), "utf8")),
    );
    expect(manifest.recordCount).toBe(0);
    expect(manifest.timeRange).toEqual({ from: null, to: null });
    expect(readRecords(join(result.bundlePath, "audit.jsonl"))).toHaveLength(0);
  });

  // ADR-0072 P1-12 Slice 2: the kernel's offline verifier (`parseBundleRecords`) reads a bundle a
  // NEWER keel produced — a record carries an additive field the current schema does not know. The
  // tolerant reader must verify the bundle (the hash covered the field), not reject it as corrupt.
  it("verifies a bundle whose audit.jsonl record carries an unknown additive field", () => {
    const result = build(recordsWithUnknownField());
    expect(verifyEvidenceBundle(result.bundlePath).ok).toBe(true);
  });

  // ADR-0072 §6: the shipped auditor-facing verify-bundle.mjs must stay in lockstep with the
  // in-process reader — same tolerance, same hiding-place rejections — or an auditor trusts the
  // weaker verifier. Each of these rewrites audit.jsonl and refreshes the componentHash so the
  // record-level check (not the byte-binding) is what bites.
  function rewriteFirstAuditRecord(bundlePath: string, mutate: (line: string) => string): void {
    const lines = readFileSync(join(bundlePath, "audit.jsonl"), "utf8").split("\n").filter(Boolean);
    lines[0] = mutate(lines[0]!);
    writeFileSync(join(bundlePath, "audit.jsonl"), `${lines.join("\n")}\n`);
    refreshComponentHash(bundlePath, "audit.jsonl");
  }
  function runVendored(bundlePath: string): { status: number | null; out: string } {
    const r = spawnSync(
      process.execPath,
      [join(bundlePath, "verify", "verify-bundle.mjs"), bundlePath],
      {
        encoding: "utf8",
      },
    );
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  }

  it("vendored verifier accepts an unknown additive field and agrees on the shared root hash", () => {
    const records = recordsWithUnknownField();
    const result = build(records);
    const rootHash = verifyChain(toChainRecords(records)).ok
      ? records[records.length - 1]!.hash
      : "unreachable";
    const ok = runVendored(result.bundlePath);
    expect(ok.status).toBe(0);
    expect(ok.out).toContain(`OK ${rootHash}`);
  });

  it("vendored verifier rejects a duplicate key (parity)", () => {
    const result = build(checkpointedRecords());
    // Duplicate a key with its SAME value: JSON.parse collapse keeps the hash valid, so ONLY the
    // dup-key rejection can catch it — isolating the invariant from an incidental hash mismatch.
    rewriteFirstAuditRecord(result.bundlePath, (line) => line.replace(/}$/, ',"seq":0}'));
    const bad = runVendored(result.bundlePath);
    expect(bad.status).toBe(1);
    expect(bad.out).toContain("duplicate object key");
  });

  it("vendored verifier rejects a top-level `sig` on a non-checkpoint record (parity)", () => {
    const result = build(checkpointedRecords());
    // `sig` is excluded from the digest, so the hash still matches — only the sig-on-normal rule bites.
    rewriteFirstAuditRecord(result.bundlePath, (line) =>
      line.replace(/}$/, `,"sig":"ed25519:${Buffer.alloc(64).toString("base64")}"}`),
    );
    const bad = runVendored(result.bundlePath);
    expect(bad.status).toBe(1);
    expect(bad.out).toContain("sig");
  });

  it("vendored verifier rejects a top-level __proto__ record key (parity)", () => {
    const result = build(checkpointedRecords());
    rewriteFirstAuditRecord(result.bundlePath, (line) =>
      line.replace(/}$/, ',"__proto__":{"x":1}}'),
    );
    const bad = runVendored(result.bundlePath);
    expect(bad.status).toBe(1);
    expect(bad.out).toContain("FAIL");
  });
});
