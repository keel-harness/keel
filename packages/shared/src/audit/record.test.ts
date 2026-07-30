import { describe, expect, it } from "vitest";
import { type ZodTypeAny } from "zod";
import { JUNK, assertRejects } from "../testing/property.js";
import { SIDE_EFFECT_TAXONOMY_VERSION, type SideEffectT } from "../policy/side-effect.js";
import {
  AnyAuditRecord,
  AuditCheckpointRecord,
  AuditEventType,
  AuditRecord,
  AuditRecordBaseShape,
} from "./record.js";

const principal = {
  osUser: "alice",
  configuredId: null,
  authProvider: "local" as const,
  assurance: "local-os-user" as const,
};

const BASE_NON_CHECKPOINT = {
  seq: 4217,
  ts: "2026-06-11T14:03:22.117Z",
  sessionId: "ses_01J000000000000000000000XY",
  principal,
  eventType: "tool.execute",
  payload: { tool: "bash" },
  sideEffect: validSideEffect(),
  prevHash: "sha256:" + "a".repeat(64),
  hash: "sha256:" + "b".repeat(64),
};

const BASE_NON_TOOL = {
  ...BASE_NON_CHECKPOINT,
  eventType: "session.start",
  payload: { cwd: "/repo" },
  sideEffect: undefined,
};

const BASE_CHECKPOINT = {
  seq: 4223,
  ts: "2026-06-11T14:03:22.117Z",
  sessionId: "ses_01J000000000000000000000XY",
  principal,
  eventType: "checkpoint",
  payload: {},
  prevHash: "sha256:" + "a".repeat(64),
  hash: "sha256:" + "b".repeat(64),
  merkleRoot: "sha256:" + "c".repeat(64),
  range: [4096, 4223],
  // 86 base64 chars + "==" = 88-char canonical encoding of a 64-byte Ed25519 signature.
  sig: "ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
};

function validSideEffect(): SideEffectT {
  return {
    taxonomyVersion: SIDE_EFFECT_TAXONOMY_VERSION,
    staticCapability: { toolName: "bash", effectEnvelope: ["fs_read"], broad: false },
    dynamic: {
      effectKinds: ["fs_read"],
      scopes: ["workspace"],
      targets: [
        {
          kind: "path",
          value: "README.md",
          normalized: "/repo/README.md",
          withinWorkspace: true,
          sensitivity: "internal",
        },
      ],
      modifiers: [],
      composition: {
        kind: "atomic",
        segments: [
          {
            effectKinds: ["fs_read"],
            scopes: ["workspace"],
            targets: [
              {
                kind: "path",
                value: "README.md",
                normalized: "/repo/README.md",
                withinWorkspace: true,
                sensitivity: "internal",
              },
            ],
            modifiers: [],
          },
        ],
        edges: [],
      },
      classifier: { name: "shell-classifier", version: "0.0.0", confidence: "exact", reasons: [] },
    },
  };
}

function expectWireRoundTrip(schema: ZodTypeAny, value: unknown): void {
  const parsed: unknown = schema.parse(value);
  expect(schema.parse(parsed)).toEqual(parsed);
  const wire = JSON.parse(JSON.stringify(parsed)) as unknown;
  expect(schema.parse(wire)).toEqual(parsed);
}

describe("audit record (Appendix B)", () => {
  it("AuditEventType is exactly the spec's 16 event types (Appendix B)", () => {
    expect(AuditEventType.options).toEqual([
      "tool.execute",
      "tool.deny",
      "review.requested",
      "review.resolved",
      "egress.deny",
      "egress.grant",
      "trust.grant",
      "mode.change",
      "memory.accept",
      "memory.decline",
      "memory.redact",
      "memory.delete",
      "provenance.declassify",
      "session.start",
      "session.end",
      "checkpoint",
    ]);
  });

  it("a base record round-trips and rejects malformed", () => {
    expect(AuditRecord.parse(BASE_NON_CHECKPOINT)).toBeTruthy();
    expect(AuditRecord.parse(BASE_NON_TOOL)).toBeTruthy();
    expectWireRoundTrip(AuditRecord, BASE_NON_CHECKPOINT);
    expectWireRoundTrip(AuditRecord, BASE_NON_TOOL);
    assertRejects(AuditRecord, [
      ...JUNK,
      {
        seq: -1,
        ts: "x",
        sessionId: "ses_x",
        principal,
        eventType: "tool.execute",
        payload: {},
        prevHash: "x",
        hash: "y",
      },
      {
        seq: 1,
        ts: "2026-06-11T14:03:22.117Z",
        sessionId: "ses_01J000000000000000000000XY",
        principal,
        eventType: "nope",
        payload: {},
        prevHash: "sha256:" + "a".repeat(64),
        hash: "sha256:" + "b".repeat(64),
      },
    ]);
  });

  it("R1 freeze: tool.execute and tool.deny records require sideEffect", () => {
    const executeWithoutSideEffect = { ...BASE_NON_CHECKPOINT };
    delete (executeWithoutSideEffect as { sideEffect?: unknown }).sideEffect;
    expect(AuditRecord.safeParse(executeWithoutSideEffect).success).toBe(false);
    expect(AnyAuditRecord.safeParse(executeWithoutSideEffect).success).toBe(false);

    const denyWithoutSideEffect = { ...executeWithoutSideEffect, eventType: "tool.deny" };
    expect(AuditRecord.safeParse(denyWithoutSideEffect).success).toBe(false);
    expect(AnyAuditRecord.safeParse(denyWithoutSideEffect).success).toBe(false);

    const denyWithSideEffect = { ...BASE_NON_CHECKPOINT, eventType: "tool.deny" };
    expect(AuditRecord.parse(denyWithSideEffect)).toMatchObject({ eventType: "tool.deny" });
    expect(AnyAuditRecord.parse(denyWithSideEffect)).toMatchObject({ eventType: "tool.deny" });
  });

  it("R1 freeze: non-tool records and checkpoints may omit sideEffect", () => {
    expect(AuditRecord.parse(BASE_NON_TOOL)).toMatchObject({ eventType: "session.start" });
    expect(AnyAuditRecord.parse(BASE_NON_TOOL)).toMatchObject({ eventType: "session.start" });
    expect(AuditCheckpointRecord.parse(BASE_CHECKPOINT)).toMatchObject({ eventType: "checkpoint" });
  });

  it("R1 freeze: policy_sandbox_mismatch is an open-payload finding, not a new event type", () => {
    expect(AuditEventType.options).not.toContain("policy_sandbox_mismatch");
    expect(
      AuditRecord.parse({
        ...BASE_NON_TOOL,
        payload: {
          findings: [
            {
              kind: "policy_sandbox_mismatch",
              policyVerdict: "allow",
              sandboxOutcome: "deny",
            },
          ],
        },
      }),
    ).toBeTruthy();
  });

  // C2 (SEC-008): AuditRecord must NOT accept eventType:"checkpoint" (it has no
  // merkleRoot/range/sig). The checkpoint is structurally a different record type.
  it("C2 (SEC-008): AuditRecord rejects eventType:'checkpoint' — unsigned checkpoint is not representable", () => {
    const unsignedCheckpoint = { ...BASE_NON_CHECKPOINT, eventType: "checkpoint" };
    expect(AuditRecord.safeParse(unsignedCheckpoint).success).toBe(false);
  });

  it("a checkpoint record adds merkleRoot/range/sig", () => {
    expect(AuditCheckpointRecord.parse(BASE_CHECKPOINT)).toBeTruthy();
    expectWireRoundTrip(AuditCheckpointRecord, BASE_CHECKPOINT);
    expectWireRoundTrip(AuditCheckpointRecord, {
      ...BASE_CHECKPOINT,
      sideEffect: validSideEffect(),
    });
    expectWireRoundTrip(AnyAuditRecord, BASE_CHECKPOINT);
    expectWireRoundTrip(AnyAuditRecord, BASE_NON_CHECKPOINT);
  });

  // C2 (SEC-008): AnyAuditRecord must REJECT an unsigned checkpoint (no merkleRoot/
  // range/sig). Today it wrongly falls through to AuditRecord. After the fix the
  // discriminated-union or reduced-enum union ensures no branch accepts it.
  it("C2 (SEC-008): AnyAuditRecord rejects an unsigned/merkle-less checkpoint — tamper-evidence spine", () => {
    // No merkleRoot/range/sig — must be rejected
    const unsignedCheckpoint = { ...BASE_NON_CHECKPOINT, eventType: "checkpoint" };
    expect(AnyAuditRecord.safeParse(unsignedCheckpoint).success).toBe(false);
  });

  // C2: Well-formed checkpoint still accepted by AnyAuditRecord
  it("C2: AnyAuditRecord accepts a well-formed (signed) checkpoint", () => {
    expect(AnyAuditRecord.parse(BASE_CHECKPOINT)).toBeTruthy();
  });

  // C2: Well-formed non-checkpoint record accepted by AnyAuditRecord
  it("C2: AnyAuditRecord accepts a well-formed non-checkpoint record", () => {
    expect(AnyAuditRecord.parse(BASE_NON_CHECKPOINT)).toBeTruthy();
  });

  // C3: payload must be JSON-safe (no NaN/undefined/±Infinity)
  it("C3: AuditRecord.payload rejects non-JSON-safe values (NaN, undefined, Infinity)", () => {
    const withNaN = { ...BASE_NON_CHECKPOINT, payload: { value: Number.NaN } };
    const withInf = { ...BASE_NON_CHECKPOINT, payload: { value: Infinity } };
    const withUndef = { ...BASE_NON_CHECKPOINT, payload: { value: undefined } };
    expect(AuditRecord.safeParse(withNaN).success).toBe(false);
    expect(AuditRecord.safeParse(withInf).success).toBe(false);
    // undefined in an object key is dropped by JS — check that the key is gone or rejected
    // (JSON.stringify drops undefined values, which is the wire-corruption we prevent)
    const withUndefParsed = AuditRecord.safeParse(withUndef);
    // Either it's rejected outright or the undefined is stripped — both are wire-safe;
    // but JsonValue/JsonObject does NOT allow undefined so it must be rejected.
    expect(withUndefParsed.success).toBe(false);
  });

  // C3: wire round-trip for AuditRecord and AuditCheckpointRecord
  it("C3: AuditRecord and AuditCheckpointRecord survive a JSON wire round-trip", () => {
    expectWireRoundTrip(AuditRecord, BASE_NON_CHECKPOINT);
    expectWireRoundTrip(AuditRecord, BASE_NON_TOOL);
    expectWireRoundTrip(AuditCheckpointRecord, BASE_CHECKPOINT);
    expectWireRoundTrip(AnyAuditRecord, BASE_NON_CHECKPOINT);
    expectWireRoundTrip(AnyAuditRecord, BASE_CHECKPOINT);
  });
});

describe("AuditRecord ↔ AuditCheckpointRecord base-field drift guard (ADR-0072)", () => {
  it("AuditCheckpointRecord mirrors every AuditRecord base field", () => {
    // The checkpoint record hand-copies AuditRecord's base fields (a discriminated-union branch must
    // be a plain ZodObject). This guard fails if a base field (e.g. `schemaVersion`) is added to
    // AuditRecord but not mirrored into the checkpoint — so hash coverage cannot silently diverge.
    const cpKeys = new Set(Object.keys(AuditCheckpointRecord.shape));
    for (const key of Object.keys(AuditRecordBaseShape)) {
      expect(cpKeys.has(key), `AuditCheckpointRecord is missing base field "${key}"`).toBe(true);
    }
  });

  it("the mirrored `schemaVersion` field validates identically on both branches", () => {
    // Behavior parity (catches a type drift the key-presence guard would miss): both must accept the
    // current version + absence and reject any other value, so a checkpoint cannot silently drift to
    // a different schemaVersion contract than a normal record.
    const base = AuditRecordBaseShape.schemaVersion;
    const mirror = AuditCheckpointRecord.shape.schemaVersion;
    for (const value of [1, undefined, 2, "1", 0]) {
      expect(base.safeParse(value).success, `base schemaVersion parse of ${String(value)}`).toBe(
        mirror.safeParse(value).success,
      );
    }
  });
});
