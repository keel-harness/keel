import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DuplicateKeyError,
  parseJsonRejectingDuplicateKeys,
  parseTolerantAuditRecord,
  TolerantRecordError,
} from "./tolerant-read.js";
import { GENESIS_PREV_HASH, hashAuditRecord } from "./hash.js";
import { toChainRecords, verifyChain } from "./verify.js";
import type { JsonValueT } from "../common/json.js";

/**
 * Slice 2 (ADR-0072 §2 invariant 2): the shared strict-key scanner. `JSON.parse` silently keeps
 * the last of a duplicate object key — a parse-confusion vector that lets a keep-first external
 * verifier hash a different byte-image than keel's keep-last readers. This scanner rejects
 * duplicate object keys at ANY nesting depth while otherwise returning exactly what `JSON.parse`
 * would, so a tolerant audit reader can build on it without inheriting the collapse.
 */
describe("parseJsonRejectingDuplicateKeys", () => {
  it("returns the same value JSON.parse would for duplicate-free input", () => {
    const text = '{"seq":0,"nested":{"a":1,"b":[1,2,{"c":3}]},"s":"x"}';
    expect(parseJsonRejectingDuplicateKeys(text)).toEqual(JSON.parse(text));
  });

  it("rejects a duplicate top-level key", () => {
    expect(() => parseJsonRejectingDuplicateKeys('{"seq":0,"seq":1}')).toThrow(DuplicateKeyError);
  });

  it("rejects a duplicate key nested inside an object", () => {
    expect(() => parseJsonRejectingDuplicateKeys('{"payload":{"a":1,"a":2}}')).toThrow(
      DuplicateKeyError,
    );
  });

  it("rejects a duplicate key nested inside an object inside an array", () => {
    expect(() => parseJsonRejectingDuplicateKeys('{"xs":[{"ok":1},{"dup":1,"dup":2}]}')).toThrow(
      DuplicateKeyError,
    );
  });

  it("rejects duplicate keys that differ only by unicode escape (JSON collapses them)", () => {
    // "a" decodes to "a" — JSON.parse would keep-last; we must catch the collapse.
    expect(() => parseJsonRejectingDuplicateKeys('{"a":1,"\\u0061":2}')).toThrow(DuplicateKeyError);
  });

  it("does NOT treat a repeated string VALUE as a duplicate key", () => {
    const text = '{"a":"dup","b":"dup"}';
    expect(parseJsonRejectingDuplicateKeys(text)).toEqual({ a: "dup", b: "dup" });
  });

  it("is not confused by JSON structure characters inside string values", () => {
    // Braces, colons, commas, and escaped quotes inside a value must not be read as structure.
    const text = '{"a":"{\\"x\\":1,\\"x\\":2}","b":2}';
    expect(parseJsonRejectingDuplicateKeys(text)).toEqual({ a: '{"x":1,"x":2}', b: 2 });
  });

  it("allows the same key name in sibling objects", () => {
    const text = '{"one":{"k":1},"two":{"k":2}}';
    expect(parseJsonRejectingDuplicateKeys(text)).toEqual({ one: { k: 1 }, two: { k: 2 } });
  });

  it("propagates a SyntaxError on malformed JSON (delegates to JSON.parse)", () => {
    expect(() => parseJsonRejectingDuplicateKeys("{not json")).toThrow(SyntaxError);
  });

  it("handles primitives and arrays at the top level", () => {
    expect(parseJsonRejectingDuplicateKeys("42")).toBe(42);
    expect(parseJsonRejectingDuplicateKeys('["a","a"]')).toEqual(["a", "a"]);
    expect(parseJsonRejectingDuplicateKeys("null")).toBeNull();
  });

  it("property: agrees with JSON.parse on any JSON value serialized without duplicate keys", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const text = JSON.stringify(value);
        // JSON.stringify never emits duplicate keys, so the scanner must accept and match.
        expect(parseJsonRejectingDuplicateKeys(text)).toEqual(JSON.parse(text));
      }),
    );
  });

  it("property: rejects an object with an injected duplicate of one of its own keys", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1 }), fc.integer(), { minKeys: 1 }),
        (obj) => {
          const keys = Object.keys(obj);
          const dupKey = keys[0]!;
          // Build "{...obj, then repeat dupKey}" textually so the raw line carries a real duplicate.
          const body = keys.map((k) => `${JSON.stringify(k)}:${obj[k]}`).join(",");
          const text = `{${body},${JSON.stringify(dupKey)}:999}`;
          expect(() => parseJsonRejectingDuplicateKeys(text)).toThrow(DuplicateKeyError);
        },
      ),
    );
  });
});

const PRINCIPAL = {
  osUser: "keel-tester",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
} as const;
const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";

/** A valid non-tool audit record (fields the writer would seal), before the `hash`. */
function baseRecord(overrides: Record<string, JsonValueT> = {}): Record<string, JsonValueT> {
  return {
    seq: 0,
    ts: "2026-07-16T00:00:00.000Z",
    sessionId: SESSION_ID,
    principal: { ...PRINCIPAL },
    eventType: "session.start",
    payload: {},
    prevHash: GENESIS_PREV_HASH,
    ...overrides,
  };
}

/** Seal a record with its correct chain hash (as the writer does) and serialize to a JSONL line. */
function sealedLine(record: Record<string, JsonValueT>): string {
  return JSON.stringify({ ...record, hash: hashAuditRecord(record) });
}

/**
 * Slice 2 (ADR-0072 §1/§2/§4): the tolerant record parse. Validates only the chain spine +
 * discriminant, tolerates additive fields (hashing them via the raw object), and fails closed on
 * genuine corruption and on the digest-excluded/prototype hiding places.
 */
describe("parseTolerantAuditRecord", () => {
  it("accepts a well-formed record and returns the raw all-keys object", () => {
    const record = parseTolerantAuditRecord(sealedLine(baseRecord()));
    expect(record.seq).toBe(0);
    expect(record.eventType).toBe("session.start");
    // Chain-verifiable as a single-record chain (prevHash === genesis, seq 0).
    expect(verifyChain(toChainRecords([record])).ok).toBe(true);
  });

  it("tolerates an unknown TOP-LEVEL field and still verifies the chain (hash covered it)", () => {
    const record = parseTolerantAuditRecord(sealedLine(baseRecord({ futureField: "novel" })));
    expect((record as unknown as Record<string, JsonValueT>)["futureField"]).toBe("novel");
    expect(verifyChain(toChainRecords([record])).ok).toBe(true);
  });

  it("tolerates an unknown NESTED field (inside payload)", () => {
    const record = parseTolerantAuditRecord(
      sealedLine(baseRecord({ payload: { known: 1, futureNested: { deep: true } } })),
    );
    expect(verifyChain(toChainRecords([record])).ok).toBe(true);
  });

  it("tolerates an unknown eventType (opaque), verifies the chain, and does NOT throw corrupt", () => {
    const record = parseTolerantAuditRecord(
      sealedLine(baseRecord({ eventType: "widget.frobnicate" })),
    );
    expect(record.eventType).toBe("widget.frobnicate");
    expect(verifyChain(toChainRecords([record])).ok).toBe(true);
  });

  it("tolerates a NESTED __proto__ in payload and round-trips it with the hash intact", () => {
    // A model-controlled payload may legitimately carry a key named __proto__; it is hashed, not a
    // top-level hiding place. Build via a raw line so __proto__ is an own key off disk.
    const sealed = baseRecord({ payload: {} });
    const withNested = JSON.parse(
      JSON.stringify({ ...sealed, hash: hashAuditRecord(sealed) }).replace(
        '"payload":{}',
        '"payload":{"__proto__":{"x":1}}',
      ),
    ) as Record<string, JsonValueT>;
    // Re-seal so the (now-different) payload matches its hash, via the same raw-object path.
    const line = JSON.stringify({
      ...withNested,
      hash: hashAuditRecord(
        Object.fromEntries(Object.entries(withNested).filter(([k]) => k !== "hash")),
      ),
    });
    const record = parseTolerantAuditRecord(line);
    expect(verifyChain(toChainRecords([record])).ok).toBe(true);
  });

  // --- denied-path / fail-closed (tolerant is not credulous) ---

  it("rejects a malformed KNOWN field (seq is a string)", () => {
    expect(() =>
      parseTolerantAuditRecord(sealedLine(baseRecord({ seq: "x" as unknown as number }))),
    ).toThrow(TolerantRecordError);
  });

  it("rejects a non-sha256 hash", () => {
    const record = baseRecord();
    const line = JSON.stringify({ ...record, hash: "not-a-hash" });
    expect(() => parseTolerantAuditRecord(line)).toThrow(TolerantRecordError);
  });

  it("rejects a top-level `sig` on a non-checkpoint record (digest-excluded hiding place)", () => {
    const record = baseRecord();
    // Seal correctly, THEN append a sig the digest never covered — the F1 attack.
    const line = JSON.stringify({
      ...record,
      hash: hashAuditRecord(record),
      sig: `ed25519:${Buffer.alloc(64).toString("base64")}`,
    });
    expect(() => parseTolerantAuditRecord(line)).toThrow(TolerantRecordError);
  });

  it("rejects a top-level __proto__/constructor/prototype record key", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const line = sealedLine(baseRecord()).replace(/}$/, `,${JSON.stringify(key)}:{"x":1}}`);
      expect(() => parseTolerantAuditRecord(line)).toThrow(TolerantRecordError);
    }
  });

  it("rejects a duplicate key (delegates to the scanner)", () => {
    const line = sealedLine(baseRecord()).replace(/}$/, ',"seq":9}');
    expect(() => parseTolerantAuditRecord(line)).toThrow();
  });

  it("rejects a -0 value (not JSON-safe)", () => {
    // JSON serializes -0 as "0", so craft the raw text explicitly.
    const crafted = sealedLine(baseRecord()).replace(/}$/, ',"weird":-0}');
    expect(() => parseTolerantAuditRecord(crafted)).toThrow(TolerantRecordError);
  });

  it("rejects a checkpoint missing its merkleRoot/range/sig", () => {
    const line = sealedLine(baseRecord({ eventType: "checkpoint" }));
    expect(() => parseTolerantAuditRecord(line)).toThrow(TolerantRecordError);
  });

  it("rejects a non-object / array line", () => {
    expect(() => parseTolerantAuditRecord("[1,2,3]")).toThrow(TolerantRecordError);
    expect(() => parseTolerantAuditRecord("42")).toThrow(TolerantRecordError);
  });

  // --- properties (ADR-0072 §Tests 9) ---

  /** Parse + single-record chain verify, collapsing every failure mode into one verdict. */
  function readVerdict(line: string): "ok" | "rejected-or-invalid" {
    let record;
    try {
      record = parseTolerantAuditRecord(line);
    } catch {
      return "rejected-or-invalid";
    }
    return verifyChain(toChainRecords([record])).ok ? "ok" : "rejected-or-invalid";
  }

  const RESERVED = new Set([
    "seq",
    "ts",
    "sessionId",
    "principal",
    "eventType",
    "payload",
    "prevHash",
    "hash",
    "sig",
    "__proto__",
    "constructor",
    "prototype",
  ]);

  it("property (TOTAL tamper-detection, no carve-out): any unsealed added key is rejected or ok:false", () => {
    // Add ANY key — including the digest-excluded `hash`/`sig` and the prototype keys — to an
    // already-sealed record WITHOUT re-hashing. There must be no key for which the record still
    // verifies: it is either rejected (dup/`sig`/prototype) or fails the chain hash (unhashed field).
    // The named carve-out keys are drawn explicitly so the "no carve-out" claim is actually executed
    // (a random string arbitrary would essentially never emit them).
    const anyKey = fc.oneof(
      fc.string({ minLength: 1 }),
      fc.constantFrom("hash", "sig", "__proto__", "constructor", "prototype", "seq"),
    );
    fc.assert(
      fc.property(anyKey, fc.integer(), (key, val) => {
        const rec = baseRecord();
        const sealed = JSON.stringify({ ...rec, hash: hashAuditRecord(rec) });
        const line = sealed.replace(/}$/, `,${JSON.stringify(key)}:${val}}`);
        expect(readVerdict(line)).toBe("rejected-or-invalid");
      }),
    );
  });

  it("property (additive monotonicity): a fresh sealed field verifies and changes the digest", () => {
    const freshKey = fc.string({ minLength: 1 }).filter((k) => !RESERVED.has(k));
    const simpleVal = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant<JsonValueT>(null),
    );
    fc.assert(
      fc.property(freshKey, simpleVal, (key, val) => {
        const rec: Record<string, JsonValueT> = { ...baseRecord(), [key]: val };
        const line = JSON.stringify({ ...rec, hash: hashAuditRecord(rec) });
        const record = parseTolerantAuditRecord(line);
        expect(verifyChain(toChainRecords([record])).ok).toBe(true);
        // The additive field is genuinely committed — it moves the digest off the no-field baseline.
        expect(hashAuditRecord(rec)).not.toBe(hashAuditRecord(baseRecord()));
      }),
    );
  });

  it("a higher schemaVersion is tolerated but never fails OPEN (integrity is still checked)", () => {
    // A record from a NEWER keel carrying an unrecognized schemaVersion (2). ADR-0072 §4: it is
    // tolerated like any additive field — integrity-verified, NOT refused, and NOT short-circuited.
    const rec = baseRecord({ schemaVersion: 2 });
    const record = parseTolerantAuditRecord(sealedLine(rec));
    expect((record as unknown as Record<string, JsonValueT>)["schemaVersion"]).toBe(2);
    expect(verifyChain(toChainRecords([record])).ok).toBe(true);
    // Tamper a byte WITHOUT re-sealing: a higher schemaVersion must not cause the reader to skip the
    // hash check and report ok. It must still be caught.
    const tampered = sealedLine(rec).replace(/}$/, ',"extra":"x"}');
    expect(readVerdict(tampered)).toBe("rejected-or-invalid");
  });

  it("a mutated (sealed) schemaVersion flips the chain hash — it is a committed field", () => {
    const rec = baseRecord({ schemaVersion: 1 });
    // Seal with schemaVersion:1, then rewrite the value to 2 on disk WITHOUT re-hashing.
    const tampered = sealedLine(rec).replace('"schemaVersion":1', '"schemaVersion":2');
    expect(tampered).toContain('"schemaVersion":2');
    expect(readVerdict(tampered)).toBe("rejected-or-invalid");
  });
});
