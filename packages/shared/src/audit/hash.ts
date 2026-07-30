import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { Sha256T } from "../common/formats.js";
import type { JsonValueT } from "../common/json.js";
import { canonicalize } from "./canonicalize.js";

/**
 * Genesis `prevHash` sentinel for the first record in a chain ("no previous
 * record"). Matches the existing `ZERO_HASH` convention used elsewhere in the
 * warden (`rpc-server.ts`, `policy.ts`); deduping the three literals into this
 * one constant is a follow-up once those files are safe to touch (Epic 2.6 plan).
 */
export const GENESIS_PREV_HASH: Sha256T = `sha256:${"0".repeat(64)}`;

/**
 * The SHA-256 (ADR-0006) of an audit record over its RFC 8785 canonical JSON,
 * with the self-referential `hash` field — and, for checkpoint records, the
 * `sig` field — omitted (Appendix B: "SHA-256 over canonical JSON of record sans
 * hash/sig"). Returned in the `sha256:<64hex>` `Sha256` wire format.
 *
 * Input must be JSON-safe (no `undefined`-valued keys): records are built from
 * `JsonObject`-constrained fields and absent optionals are omitted, never set to
 * `undefined`.
 */
export function hashAuditRecord(record: Record<string, JsonValueT>): Sha256T {
  // Null prototype so a top-level `__proto__` own key (which a tolerant reader can retain off disk,
  // ADR-0072 §2) becomes a normal own data property that IS committed — NOT swallowed by the
  // inherited `__proto__` setter, which would drop it from `Object.entries` and open an un-hashed
  // hiding place. Behavior-identical for every real record (none carry `__proto__`); the golden
  // vectors are the guard.
  const committed: Record<string, JsonValueT> = Object.create(null) as Record<string, JsonValueT>;
  for (const [key, value] of Object.entries(record)) {
    // Omit the self-referential `hash` and (checkpoint-only) `sig` from the digest input.
    if (key !== "hash" && key !== "sig") committed[key] = value;
  }
  const digest = sha256(utf8ToBytes(canonicalize(committed)));
  return `sha256:${bytesToHex(digest)}`;
}
