import { describe, expect, it } from "vitest";
import { Sha256 } from "../common/formats.js";
import type { JsonValueT } from "../common/json.js";
import { GENESIS_PREV_HASH, hashAuditRecord } from "./hash.js";

/** A record-shaped fixture (only the fields that matter for hashing). */
function rec(overrides: Record<string, JsonValueT> = {}): Record<string, JsonValueT> {
  return {
    seq: 0,
    ts: "2026-06-26T14:00:00.000Z",
    sessionId: "ses_abc",
    eventType: "session.start",
    payload: { kind: "start" },
    prevHash: GENESIS_PREV_HASH,
    ...overrides,
  };
}

describe("hashAuditRecord (SHA-256 over canonical JSON, sans hash/sig)", () => {
  it("GENESIS_PREV_HASH is the sha256:<64-zero> genesis sentinel", () => {
    expect(GENESIS_PREV_HASH).toBe(`sha256:${"0".repeat(64)}`);
    expect(Sha256.safeParse(GENESIS_PREV_HASH).success).toBe(true);
  });

  it("returns a valid sha256:<64hex> digest", () => {
    expect(Sha256.safeParse(hashAuditRecord(rec())).success).toBe(true);
  });

  it("is deterministic for equal records", () => {
    expect(hashAuditRecord(rec())).toBe(hashAuditRecord(rec()));
  });

  it("ignores a present `hash` field (hash is computed sans hash)", () => {
    const withHash = rec({ hash: `sha256:${"a".repeat(64)}` });
    expect(hashAuditRecord(withHash)).toBe(hashAuditRecord(rec()));
  });

  it("ignores a present `sig` field (checkpoint signature excluded)", () => {
    const withSig = rec({ sig: "ed25519:Zm9v" });
    expect(hashAuditRecord(withSig)).toBe(hashAuditRecord(rec()));
  });

  it("is independent of key insertion order (canonicalization sorts keys)", () => {
    const a: Record<string, JsonValueT> = {
      seq: 1,
      ts: "t",
      sessionId: "s",
      eventType: "session.end",
      payload: {},
      prevHash: "p",
    };
    const b: Record<string, JsonValueT> = {
      prevHash: "p",
      payload: {},
      eventType: "session.end",
      sessionId: "s",
      ts: "t",
      seq: 1,
    };
    expect(hashAuditRecord(a)).toBe(hashAuditRecord(b));
  });

  it("changes when any committed field changes", () => {
    const base = hashAuditRecord(rec());
    expect(hashAuditRecord(rec({ seq: 1 }))).not.toBe(base);
    expect(hashAuditRecord(rec({ prevHash: `sha256:${"1".repeat(64)}` }))).not.toBe(base);
    expect(hashAuditRecord(rec({ payload: { kind: "other" } }))).not.toBe(base);
  });

  // ADR-0072 §2 invariant 4: a top-level `__proto__` own key must be COMMITTED to the digest, not
  // dropped through the accumulator's inherited `__proto__` setter (an un-hashed hiding place that
  // tolerance would open). The digest accumulator is built with a null prototype so this holds.
  it("commits a top-level `__proto__` own key to the digest (no prototype-setter hiding place)", () => {
    const line = (extra: string): string =>
      `{"seq":0,"ts":"2026-06-26T14:00:00.000Z","sessionId":"ses_abc","eventType":"session.start","payload":{"kind":"start"},"prevHash":"${GENESIS_PREV_HASH}"${extra}}`;
    // JSON.parse creates `__proto__` as an OWN enumerable data property (CreateDataProperty), the
    // exact shape a tolerant reader gets off disk.
    const withProto = JSON.parse(line(',"__proto__":{"exfil":"x"}')) as Record<string, JsonValueT>;
    const without = JSON.parse(line("")) as Record<string, JsonValueT>;

    expect(Object.prototype.hasOwnProperty.call(withProto, "__proto__")).toBe(true);
    // If `__proto__` were silently dropped from the digest, these would be equal — the hole.
    expect(hashAuditRecord(withProto)).not.toBe(hashAuditRecord(without));
    // And tampering the hidden field must flip the digest (it is genuinely covered).
    const tampered = JSON.parse(line(',"__proto__":{"exfil":"y"}')) as Record<string, JsonValueT>;
    expect(hashAuditRecord(withProto)).not.toBe(hashAuditRecord(tampered));
  });
});
