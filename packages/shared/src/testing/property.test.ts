import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { JsonObject, JsonValue } from "../common/json.js";
import { JUNK, assertRejects, assertRoundTrips, assertWireRoundTrips } from "./property.js";

describe("fast-check global seed (I6 — replayable failures)", () => {
  it("vitest.setup.ts pins a finite seed via fc.configureGlobal", () => {
    // Proves setupFiles ran and the seed is wired — a property failure in CI is
    // reproducible by exporting the same FAST_CHECK_SEED. See ADR-0020.
    const { seed } = fc.readConfigureGlobal();
    expect(typeof seed).toBe("number");
    expect(Number.isFinite(seed)).toBe(true);
  });
});

const Sample = z.object({ a: z.string().min(1), b: z.number().int() });

describe("property-test helpers", () => {
  it("assertRoundTrips passes for a well-formed schema", () => {
    expect(() => assertRoundTrips(Sample)).not.toThrow();
  });

  it("JUNK bank has at least 10 universally-invalid object values", () => {
    expect(JUNK.length).toBeGreaterThanOrEqual(10);
  });

  it("assertRejects passes when every case is rejected", () => {
    expect(() => assertRejects(Sample, JUNK)).not.toThrow();
  });

  it("assertRejects throws if a 'bad' case actually parses", () => {
    // {a:'x', b:1} is VALID for Sample, so asserting it is rejected must fail.
    expect(() => assertRejects(Sample, [{ a: "x", b: 1 }])).toThrow();
  });

  it("assertRoundTrips handles regex strings nested in objects/arrays/unions/optionals", () => {
    const Semver = z.string().regex(/^\d+\.\d+\.\d+$/);
    const Nested = z.object({
      v: Semver,
      list: z.array(Semver),
      opt: Semver.optional(),
      u: z.union([z.object({ k: Semver }), z.object({ n: z.number() })]),
    });
    expect(() => assertRoundTrips(Nested)).not.toThrow();
  });
});

describe("assertWireRoundTrips", () => {
  it("passes for JsonObject (JSON-safe schema)", () => {
    expect(() => assertWireRoundTrips(JsonObject)).not.toThrow();
  });

  it("passes for JsonValue (JSON-safe schema)", () => {
    expect(() => assertWireRoundTrips(JsonValue)).not.toThrow();
  });

  it("passes for a plain object schema with no wire-unsafe fields", () => {
    const Safe = z.object({ name: z.string(), count: z.number().int() });
    expect(() => assertWireRoundTrips(Safe)).not.toThrow();
  });

  it("wire assertion catches NaN corruption (control: proves the mechanism works)", () => {
    // Demonstrates the core assertion: NaN becomes null over JSON, so
    // schema.parse(wire) !== parsed, causing toEqual to throw.
    // This is the exact check that assertWireRoundTrips performs per-value.
    const Unsafe = z.object({ x: z.unknown() });
    expect(() => {
      const parsed = Unsafe.parse({ x: Number.NaN });
      const wire = JSON.parse(JSON.stringify(parsed)) as unknown;
      // NaN → null over JSON; this must fail
      expect(Unsafe.parse(wire)).toEqual(parsed);
    }).toThrow();
  });

  it("assertWireRoundTrips throws on a schema that always emits a wire-unsafe value", () => {
    // z.nan() generates fc.constant(NaN) (zod-fast-check built-in), so
    // assertWireRoundTrips will ALWAYS receive {x: NaN}. NaN becomes null
    // over JSON, so schema.parse(wire) throws (null fails z.nan()), causing
    // assertWireRoundTrips to fail. This proves the harness catches corruption.
    const AlwaysNaN = z.object({ x: z.nan() });
    expect(() => assertWireRoundTrips(AlwaysNaN)).toThrow();
  });
});

describe("collectRegexStrings traversal extensions", () => {
  it("finds regex strings nested in ZodEffects (transform)", () => {
    const Semver = z.string().regex(/^\d+\.\d+\.\d+$/);
    // ZodEffects wraps a base schema with transformations
    const WithEffect = Semver.transform((s) => s);
    const Nested = z.object({ v: WithEffect });
    expect(() => assertRoundTrips(Nested)).not.toThrow();
  });

  it("finds regex strings nested in ZodBranded", () => {
    const Semver = z.string().regex(/^\d+\.\d+\.\d+$/);
    const Branded = Semver.brand("Semver");
    const Nested = z.object({ v: Branded });
    expect(() => assertRoundTrips(Nested)).not.toThrow();
  });

  it("finds regex strings in ZodRecord keys", () => {
    // Record with a constrained key schema
    const KeyPattern = z.string().regex(/^key_[a-z]+$/);
    const Rec = z.record(KeyPattern, z.number());
    // collectRegexStrings must walk the key schema so zfc gets the override
    expect(() => assertRoundTrips(Rec)).not.toThrow();
  });

  it("handles ZodLazy gracefully (no infinite loop)", () => {
    // JsonValue is a ZodLazy; collectRegexStrings must use the `seen` set
    // to avoid infinite recursion when traversing the recursive schema
    expect(() => assertWireRoundTrips(JsonValue)).not.toThrow();
  });

  it("finds regex strings nested in ZodDefault (unwraps removeDefault)", () => {
    // ZodDefault wraps a base schema with a fallback value; collectRegexStrings
    // must descend via removeDefault() to reach the constrained string.
    const Semver = z.string().regex(/^\d+\.\d+\.\d+$/);
    const Nested = z.object({ v: Semver.default("0.0.0") });
    expect(() => assertRoundTrips(Nested)).not.toThrow();
  });

  it("finds regex strings nested in ZodPipeline (walks the input schema)", () => {
    // ZodPipeline generation draws from the INPUT schema (._def.in), so the
    // regex override must be collected from there.
    const Semver = z.string().regex(/^\d+\.\d+\.\d+$/);
    const Piped = Semver.pipe(z.string());
    const Nested = z.object({ v: Piped });
    expect(() => assertRoundTrips(Nested)).not.toThrow();
  });
});

describe("assertRejects diagnostic formatting", () => {
  it("reports a non-JSON-stringifiable rejected-but-parsed value without throwing on the formatter", () => {
    // safe() falls back to String(value) when JSON.stringify throws (a BigInt
    // cannot be serialised). z.bigint() ACCEPTS 1n, so assertRejects must throw
    // its 'expected reject but parsed' error — and building that message must
    // exercise safe()'s catch branch rather than crash on the BigInt.
    expect(() => assertRejects(z.bigint(), [1n])).toThrow(/expected schema to reject/);
  });

  it("reports a value JSON.stringify maps to undefined via the String() fallback", () => {
    // JSON.stringify(undefined) === undefined, so safe() takes its `?? String(value)`
    // branch. z.undefined() ACCEPTS undefined, so assertRejects must throw — and the
    // message is built without the formatter returning a bare "undefined" crash.
    expect(() => assertRejects(z.undefined(), [undefined])).toThrow(/expected schema to reject/);
  });
});
