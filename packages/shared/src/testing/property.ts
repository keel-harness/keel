import * as fc from "fast-check";
import { expect } from "vitest";
import { z, type ZodTypeAny } from "zod";
import { ZodFastCheck } from "zod-fast-check";
import { type JsonObjectT, type JsonValueT, JsonObject, JsonValue } from "../common/json.js";
import { DateOnly } from "../common/formats.js";

/**
 * Universally-invalid values: not a valid instance of any object/union schema in
 * this package. Reused across accept/reject tables to help meet the ≥20-malformed
 * bar (combine with schema-specific malformed cases).
 */
export const JUNK: readonly unknown[] = [
  undefined,
  null,
  42,
  -1,
  Number.NaN,
  "string",
  "",
  true,
  false,
  [],
  [1, 2, 3],
  {},
  Symbol("x"),
];

/** Extract the regex from a ZodString that has a `.regex()` check, if any. */
function regexOf(schema: z.ZodString): RegExp | undefined {
  const checks = (schema._def as { checks?: Array<{ kind: string; regex?: RegExp }> }).checks ?? [];
  return checks.find((c) => c.kind === "regex" && c.regex instanceof RegExp)?.regex;
}

/**
 * Walk the schema tree and collect every ZodString instance constrained by a
 * regex (zod-fast-check cannot auto-satisfy regex checks). Covers the container
 * kinds used in this package, including ZodEffects, ZodLazy, ZodPipeline,
 * ZodBranded, and ZodRecord key schemas (N8).
 */
function collectRegexStrings(
  schema: ZodTypeAny,
  acc: Map<ZodTypeAny, RegExp>,
  seen: Set<ZodTypeAny>,
): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  if (schema instanceof z.ZodString) {
    const re = regexOf(schema);
    if (re) acc.set(schema, re);
    return;
  }
  if (schema instanceof z.ZodObject) {
    for (const value of Object.values(schema.shape as Record<string, ZodTypeAny>)) {
      collectRegexStrings(value, acc, seen);
    }
  } else if (schema instanceof z.ZodArray) {
    collectRegexStrings(schema.element as ZodTypeAny, acc, seen);
  } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    collectRegexStrings(schema.unwrap() as ZodTypeAny, acc, seen);
  } else if (schema instanceof z.ZodDefault) {
    collectRegexStrings(schema.removeDefault() as ZodTypeAny, acc, seen);
  } else if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    for (const option of schema.options as ZodTypeAny[]) {
      collectRegexStrings(option, acc, seen);
    }
  } else if (schema instanceof z.ZodRecord) {
    // Walk both key AND value schemas (zod-fast-check uses keyType for generation)
    collectRegexStrings(schema.keySchema as ZodTypeAny, acc, seen);
    collectRegexStrings(schema.valueSchema as ZodTypeAny, acc, seen);
  } else if (schema instanceof z.ZodTuple) {
    for (const item of schema.items as ZodTypeAny[]) {
      collectRegexStrings(item, acc, seen);
    }
  } else if (schema instanceof z.ZodEffects) {
    // ZodEffects wraps a base schema (transform/refine/superRefine); the inner
    // schema is in ._def.schema (same path zod-fast-check uses for generation)
    collectRegexStrings((schema._def as { schema: ZodTypeAny }).schema, acc, seen);
  } else if (schema instanceof z.ZodBranded) {
    collectRegexStrings(schema.unwrap() as ZodTypeAny, acc, seen);
  } else if (schema instanceof z.ZodPipeline) {
    // Pipeline input schema is what zod-fast-check generates from
    collectRegexStrings((schema._def as { in: ZodTypeAny }).in, acc, seen);
  } else if (schema instanceof z.ZodLazy) {
    // Expand the lazy getter — the seen set prevents infinite recursion
    collectRegexStrings((schema._def as { getter: () => ZodTypeAny }).getter(), acc, seen);
  }
}

/**
 * Build a ZodFastCheck instance with all necessary overrides for the given schema:
 * - regex-constrained ZodStrings get fc.stringMatching overrides
 * - JsonValue / JsonObject schemas get fc.jsonValue() overrides (zod-fast-check
 *   cannot handle z.lazy() natively; fc.jsonValue() is the fast-check ≥3 built-in
 *   that generates exactly JSON-safe values)
 */
function buildZfc(schema: ZodTypeAny): ReturnType<typeof ZodFastCheck> {
  const regexStrings = new Map<ZodTypeAny, RegExp>();
  collectRegexStrings(schema, regexStrings, new Set());

  let zfc = ZodFastCheck();
  for (const [stringSchema, regex] of regexStrings) {
    zfc = zfc.override(stringSchema, fc.stringMatching(regex));
  }

  // Override JsonValue and JsonObject (z.lazy schemas) with a JSON-safe arbitrary.
  // Detection is by reference equality against the exported schema instances.
  // fc.jsonValue() (fast-check ≥3) generates JSON-serializable values; we
  // additionally filter -0 (JSON.stringify(-0)==="0", so it is not truly
  // wire-safe and our JsonValue schema rejects it). The cast is safe because the
  // filter+schema.parse ensures every yielded value is a valid JsonValueT.
  //
  // maxDepth: 3 bounds generation cost. Unbounded fc.jsonValue() under v8 coverage
  // instrumentation produced a measured 5.3s timeout on the recursive SimulatorScript
  // round-trip (args: JsonObject). Depth-3 JSON still exercises real nesting and still
  // catches the NaN/Infinity/undefined wire bugs this harness exists for, at a fraction
  // of the cost — and the cost is now robust to FAST_CHECK_SEED rotation, not just the
  // pinned default. See ADR-0020.
  const JSON_MAX_DEPTH = 3;
  const jsonValueArb = fc
    .jsonValue({ maxDepth: JSON_MAX_DEPTH })
    .filter((v) => !containsNegZero(v)) as unknown as fc.Arbitrary<JsonValueT>;
  const jsonObjectArb = fc
    .jsonValue({ maxDepth: JSON_MAX_DEPTH })
    .filter(isPlainObject)
    .filter((v) => !containsNegZero(v)) as unknown as fc.Arbitrary<JsonObjectT>;
  zfc = zfc.override(JsonValue, jsonValueArb);
  zfc = zfc.override(JsonObject, jsonObjectArb);

  // Override DateOnly (a regex string + calendar-validity refine): the raw regex
  // override would generate shape-valid-but-impossible dates (month 13, Feb 30)
  // that the refine rejects, so generation would lean on zod-fast-check's filter
  // (wasteful, and dependent on staying above its 1% success floor). Generating
  // from fc.date() yields only real calendar dates, so any schema containing a
  // DateOnly field round-trips reliably and cheaply. Bounded to 4-digit years
  // (the DateOnly refine maps years 0-99 to 1900+ and rejects them).
  const dateOnlyArb = fc
    .date({
      min: new Date(Date.UTC(1000, 0, 1)),
      max: new Date(Date.UTC(9999, 11, 31)),
    })
    .map((d) => d.toISOString().slice(0, 10));
  zfc = zfc.override(DateOnly, dateOnlyArb);

  return zfc;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True iff n is negative zero. */
function isNegZero(v: unknown): boolean {
  return typeof v === "number" && Object.is(v, -0);
}

/**
 * True iff a JSON value deeply contains negative zero anywhere in its tree.
 * Used to filter -0 from fc.jsonValue() output before passing to JsonValue/
 * JsonObject schemas (which reject -0 per the JSON-safe contract).
 */
function containsNegZero(v: unknown): boolean {
  if (isNegZero(v)) return true;
  if (Array.isArray(v)) return v.some(containsNegZero);
  if (typeof v === "object" && v !== null) {
    return Object.values(v as Record<string, unknown>).some(containsNegZero);
  }
  return false;
}

/**
 * Assert `schema` round-trips for parse-idempotency: every generated valid input
 * parses, and re-parsing the already-parsed value produces the identical result.
 * This proves `parse(parse(x)) === parse(x)` (idempotency), NOT wire identity.
 * For wire-round-trip correctness (JSON serialize→parse identity), use
 * `assertWireRoundTrips` instead — especially for schemas with JSON-crossing fields.
 *
 * Regex-constrained ZodStrings (anywhere in the tree) get an fc.stringMatching
 * override so generation satisfies the regex; the schemas themselves are NOT
 * weakened (parse still enforces every constraint).
 */
export function assertRoundTrips(schema: ZodTypeAny, numRuns = 200): void {
  const zfc = buildZfc(schema);
  const arbitrary = zfc.inputOf(schema);
  fc.assert(
    fc.property(arbitrary, (value) => {
      const parsed: unknown = schema.parse(value);
      expect(schema.parse(parsed)).toEqual(parsed);
    }),
    { numRuns },
  );
}

/**
 * Assert `schema` is wire-safe: every generated valid input survives a full
 * JSON serialize→parse round-trip (`JSON.parse(JSON.stringify(parsed))`) without
 * dropping or corrupting any field. This catches schemas with z.unknown()/
 * z.record(z.unknown()) fields that silently drop NaN, ±Infinity, or undefined
 * over the warden JSON-RPC wire.
 *
 * Generation uses JSON-safe arbitraries for JsonValue/JsonObject schemas, so
 * assertWireRoundTrips(JsonObject) and assertWireRoundTrips(JsonValue) pass by
 * construction. For schemas that admit non-JSON-safe values (e.g. z.unknown()),
 * the wire round-trip assertion will catch corruption when those values appear.
 */
export function assertWireRoundTrips(schema: ZodTypeAny, numRuns = 200): void {
  const zfc = buildZfc(schema);
  const arbitrary = zfc.inputOf(schema);
  fc.assert(
    fc.property(arbitrary, (value) => {
      const parsed: unknown = schema.parse(value);
      const wire = JSON.parse(JSON.stringify(parsed)) as unknown;
      expect(schema.parse(wire)).toEqual(parsed);
    }),
    { numRuns },
  );
}

/** Assert that every value in `cases` is REJECTED by `schema.safeParse`. */
export function assertRejects(schema: ZodTypeAny, cases: readonly unknown[]): void {
  for (const value of cases) {
    const result = schema.safeParse(value);
    if (result.success) {
      throw new Error(`expected schema to reject value but it parsed: ${safe(value)}`);
    }
  }
}

function safe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
