import type { JsonValueT } from "../common/json.js";

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS), pinned by ADR-0006, restricted to
 * the JSON-safe (`JsonValue`) subset that audit records are built from
 * (Appendix B; no NaN/±Infinity/undefined/bigint — guaranteed upstream by the
 * `JsonObject` schema).
 *
 * For this subset JCS reduces to two transforms over `JSON.stringify`:
 *
 *   1. object keys are emitted sorted by UTF-16 code unit (RFC 8785 §3.2.3) —
 *      `String.prototype.localeCompare` is locale-sensitive, so we use the
 *      default `<` comparison on code units, which `Array.prototype.sort` also
 *      uses;
 *   2. arrays are NOT reordered (RFC 8785 §3.2.2.1).
 *
 * Number and string serialization are left to the engine: RFC 8785 §3.2.2.3
 * mandates ECMAScript `Number::toString`, which is exactly what `JSON.stringify`
 * emits for a finite number, and §3.2.2.2 mandates ECMAScript string
 * serialization (minimal escaping, non-ASCII preserved), which is exactly
 * `JSON.stringify` of a string.
 *
 * Hashing the UTF-8 encoding of this output gives a deterministic, cross-platform
 * digest for the audit hash chain (Appendix B).
 */
export function canonicalize(value: JsonValueT): string {
  if (value === null || typeof value !== "object") {
    // string | number | boolean | null — JSON.stringify matches JCS for these.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const members = Object.entries(value)
    // Object keys are distinct, so a strict `<` ordering by UTF-16 code unit is total
    // (no equal case) — matching JCS key ordering (RFC 8785 §3.2.3).
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${members.join(",")}}`;
}
