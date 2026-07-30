/**
 * Shared tolerant-read primitives for keel's durable audit chain (ADR-0072 P1-12 Slice 2).
 *
 * The in-process audit readers (warden `parseCompleteLog`/`readAuditLog`/`open`, kernel
 * `parseBundleRecords`) and the vendored `verify-bundle.mjs` must all read a newer keel's records
 * without bricking on additive fields, while preserving SEC-008 tamper-evidence. This module is the
 * ONE source of truth for the security-critical parse so the invariants cannot drift across those
 * copies.
 *
 * ADR-0072 §2 invariant 2: reject duplicate object keys. `JSON.parse` silently keeps the last of a
 * duplicate key, a parse-confusion vector that lets a keep-first external verifier hash a different
 * byte-image than keel's keep-last readers. Detection cannot use a `JSON.parse` reviver (the reviver
 * runs after the collapse), so we scan the raw, already-`JSON.parse`-validated text for object keys.
 */

import { z } from "zod";
import { Ed25519Sig, IsoTimestamp, Sha256, SessionId } from "../common/formats.js";
import { JsonObject, JsonValue, type JsonValueT } from "../common/json.js";
import type { AnyAuditRecordT } from "./record.js";

// LOCKSTEP (ADR-0072 §6): the vendored `verify-bundle.mjs` in
// packages/warden/src/audit/bundle.ts (`verifierScriptSource`) hand-duplicates the scanner, the
// null-prototype `hashAuditRecord` accumulator, and the tolerant record checks below. Any change to
// the security invariants here MUST be mirrored there, or the auditor-facing verifier drifts weaker.
// Parity is pinned by packages/kernel/src/audit/evidence-bundle.test.ts (spawns the real .mjs).

/** Thrown when a JSON document carries the same object key twice at one nesting level. */
export class DuplicateKeyError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`duplicate object key ${JSON.stringify(key)}`);
    this.name = "DuplicateKeyError";
    this.key = key;
  }
}

/** Thrown when a line parses as JSON but is not a valid tolerant audit record (bad spine, a
 *  digest-excluded/prototype hiding-place key, or a JSON-unsafe value). Distinct from a raw
 *  `SyntaxError`/{@link DuplicateKeyError} so callers can render a precise diagnosis. */
export class TolerantRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TolerantRecordError";
  }
}

interface Frame {
  /** True for `{...}`, false for `[...]`. Only object frames carry keys. */
  readonly isObject: boolean;
  /** Decoded keys seen so far in this object frame (duplicate detection). */
  readonly keys: Set<string>;
  /** True when the next string token in this object is a KEY (not a value). */
  expectKey: boolean;
}

/**
 * Parse `text` as JSON and reject any object that carries a duplicate key at any nesting depth.
 * Returns exactly what `JSON.parse(text)` returns for duplicate-free input (including the authentic
 * `SyntaxError` on malformed JSON — this is a strict superset of `JSON.parse`'s rejections).
 *
 * Duplicate keys are compared by their DECODED value, so `"a"` and `"a"` collide the same way
 * `JSON.parse` would collapse them. The scan is string-aware: JSON structure characters inside a
 * string value never affect key detection.
 */
export function parseJsonRejectingDuplicateKeys(text: string): unknown {
  // Authoritative parse first: validates syntax and yields the value. The scan below then only has
  // to locate object keys in known-valid JSON, so it never has to reject malformed input itself.
  const value = JSON.parse(text) as unknown;
  assertNoDuplicateKeys(text);
  return value;
}

/**
 * Prototype-pollution key names that are never legitimate as a TOP-LEVEL audit-record field and
 * would (for `__proto__`) hit the digest accumulator's inherited setter. Rejected only at the
 * record's top level — a nested `payload` may legitimately carry such a key, and a nested
 * `__proto__` is already correctly committed by `canonicalize`, so recursive rejection would brick
 * a valid record (ADR-0072 §2).
 */
const FORBIDDEN_TOP_LEVEL_KEYS = ["__proto__", "constructor", "prototype"] as const;

const CheckpointRange = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);

/**
 * The tolerant validation GATE (ADR-0072 §1/§2). It strictly types the chain spine + discriminant
 * that `verifyChain`, the checkpoint machinery, and the bundle verifier structurally read, and
 * `.catchall`s everything else as JSON-safe `JsonValue` (retaining additive fields while keeping the
 * `JsonObject` constraint — no `NaN`/`±Infinity`/`-0`). It is NEVER `.strict()` (would brick additive
 * fields) and NEVER bare `.passthrough()` (would drop the value constraint). `principal`/`payload`
 * are shape-checked as objects but NOT validated internally, so a newer keel's nested additive field
 * is tolerated. **This gate MUST stay transform-free** — its OUTPUT is never hashed; the raw parsed
 * object is (see {@link parseTolerantAuditRecord}). Never route the hashed object through a schema
 * with a transform (e.g. the `SideEffect` sort/dedup): it would forge a false `hash_mismatch` on a
 * non-fixpoint foreign record (ADR-0072 §2(a)).
 */
const TolerantAuditRecordGate = z
  .object({
    seq: z.number().int().nonnegative(),
    ts: IsoTimestamp,
    sessionId: SessionId,
    principal: JsonObject,
    payload: JsonObject,
    prevHash: Sha256,
    hash: Sha256,
    eventType: z.string().min(1),
  })
  .catchall(JsonValue)
  .superRefine((rec, ctx) => {
    const extras = rec as Record<string, JsonValueT>;
    if (rec.eventType === "checkpoint") {
      // A known discriminant is validated strictly: a checkpoint MUST carry the signed Merkle spine.
      if (!Sha256.safeParse(extras["merkleRoot"]).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "checkpoint requires a sha256 merkleRoot",
        });
      }
      if (!CheckpointRange.safeParse(extras["range"]).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "checkpoint requires a [start,end] range",
        });
      }
      if (!Ed25519Sig.safeParse(extras["sig"]).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "checkpoint requires an ed25519 sig",
        });
      }
    } else if (Object.prototype.hasOwnProperty.call(rec, "sig")) {
      // ADR-0072 §2 invariant 3: `sig` is excluded from the digest by name, so a `sig` on a
      // non-checkpoint record would be retained-but-unhashed — an un-hashed hiding place. Reject it.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "a non-checkpoint record must not carry a top-level `sig` (excluded from the digest)",
      });
    }
  });

/**
 * Parse one audit JSONL line into a tolerant record: reject duplicate keys and top-level
 * prototype-pollution keys, validate the chain spine + discriminant, and return the RAW all-keys
 * object (never the zod output) so `hashAuditRecord`/`verifyChain` commit exactly the on-disk bytes.
 * An unknown `eventType` with a valid spine is accepted as an opaque record (ADR-0072 §4), NOT
 * rejected as corrupt. Throws {@link DuplicateKeyError} / {@link TolerantRecordError} / `SyntaxError`
 * on the respective faults; the object it returns is safe to feed to `toChainRecords`/`verifyChain`.
 */
export function parseTolerantAuditRecord(line: string): AnyAuditRecordT {
  const raw = parseJsonRejectingDuplicateKeys(line);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TolerantRecordError("audit record is not a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  for (const key of FORBIDDEN_TOP_LEVEL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new TolerantRecordError(
        `audit record carries a forbidden top-level key ${JSON.stringify(key)}`,
      );
    }
  }
  const parsed = TolerantAuditRecordGate.safeParse(obj);
  if (!parsed.success) {
    throw new TolerantRecordError(
      `audit record failed tolerant validation: ${parsed.error.issues[0]?.message ?? "invalid record"}`,
    );
  }
  // The gate validated; the RAW object (all keys, no zod transform) is what we hash and verify.
  return obj as unknown as AnyAuditRecordT;
}

function assertNoDuplicateKeys(text: string): void {
  const stack: Frame[] = [];
  const top = (): Frame | undefined => stack[stack.length - 1];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (ch === '"') {
      // Consume a full string token (raw, including quotes and escapes).
      const start = i;
      i += 1;
      while (i < n) {
        const c = text[i];
        if (c === "\\") {
          i += 2; // skip the escape and the escaped char
          continue;
        }
        i += 1;
        if (c === '"') break;
      }
      const frame = top();
      if (frame !== undefined && frame.isObject && frame.expectKey) {
        // Decode via JSON.parse so escapes collapse exactly as they would for a real key.
        const key = JSON.parse(text.slice(start, i)) as string;
        if (frame.keys.has(key)) throw new DuplicateKeyError(key);
        frame.keys.add(key);
      }
      continue;
    }

    switch (ch) {
      case "{":
        stack.push({ isObject: true, keys: new Set(), expectKey: true });
        break;
      case "[":
        stack.push({ isObject: false, keys: new Set(), expectKey: false });
        break;
      case "}":
      case "]":
        stack.pop();
        break;
      case ":": {
        const frame = top();
        if (frame !== undefined) frame.expectKey = false;
        break;
      }
      case ",": {
        const frame = top();
        if (frame !== undefined && frame.isObject) frame.expectKey = true;
        break;
      }
      default:
        break; // whitespace, numbers, true/false/null — irrelevant to key detection
    }
    i += 1;
  }
}
