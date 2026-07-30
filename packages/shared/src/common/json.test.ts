import { describe, expect, it } from "vitest";
import { JsonObject, JsonValue } from "./json.js";

describe("JsonValue schema", () => {
  it("accepts string", () => {
    expect(JsonValue.parse("hello")).toBe("hello");
  });

  it("accepts finite number", () => {
    expect(JsonValue.parse(42)).toBe(42);
    expect(JsonValue.parse(-3.14)).toBe(-3.14);
    expect(JsonValue.parse(0)).toBe(0);
  });

  it("accepts boolean", () => {
    expect(JsonValue.parse(true)).toBe(true);
    expect(JsonValue.parse(false)).toBe(false);
  });

  it("accepts null", () => {
    expect(JsonValue.parse(null)).toBeNull();
  });

  it("accepts arrays of JSON values", () => {
    expect(JsonValue.parse([1, "two", null, true])).toEqual([1, "two", null, true]);
  });

  it("accepts deeply nested objects and arrays", () => {
    const nested = { a: [1, { b: "c", d: [null, false] }], e: "f" };
    expect(JsonValue.parse(nested)).toEqual(nested);
  });

  it("rejects NaN", () => {
    expect(JsonValue.safeParse(Number.NaN).success).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(JsonValue.safeParse(Infinity).success).toBe(false);
    expect(JsonValue.safeParse(-Infinity).success).toBe(false);
  });

  it("rejects negative zero (-0 serialises to '0' and cannot survive JSON round-trip)", () => {
    expect(JsonValue.safeParse(-0).success).toBe(false);
  });

  it("rejects undefined", () => {
    expect(JsonValue.safeParse(undefined).success).toBe(false);
  });

  it("rejects bigint", () => {
    expect(JsonValue.safeParse(10n).success).toBe(false);
  });

  it("rejects Symbol", () => {
    expect(JsonValue.safeParse(Symbol("x")).success).toBe(false);
  });

  it("rejects a function", () => {
    expect(JsonValue.safeParse(() => 1).success).toBe(false);
  });

  it("rejects an object with an undefined value", () => {
    // JSON.stringify drops undefined values; the schema should reject them
    expect(JsonValue.safeParse({ a: undefined }).success).toBe(false);
  });

  it("round-trips via JSON.parse(JSON.stringify(x)) for accepted values", () => {
    const values = [
      "hello",
      42,
      -3.14,
      0,
      true,
      false,
      null,
      [1, "two", null, true],
      { a: 1, b: [2, { c: "d" }] },
    ];
    for (const v of values) {
      const parsed = JsonValue.parse(v);
      const wired = JSON.parse(JSON.stringify(parsed)) as unknown;
      expect(wired).toEqual(parsed);
    }
  });
});

describe("JsonObject schema", () => {
  it("accepts a plain JSON object", () => {
    expect(JsonObject.parse({ key: "value", n: 42 })).toEqual({ key: "value", n: 42 });
  });

  it("rejects a non-object", () => {
    expect(JsonObject.safeParse("string").success).toBe(false);
    expect(JsonObject.safeParse(42).success).toBe(false);
    expect(JsonObject.safeParse([]).success).toBe(false);
  });

  it("rejects an object whose value contains NaN", () => {
    expect(JsonObject.safeParse({ x: Number.NaN }).success).toBe(false);
  });

  it("rejects an object whose value is undefined", () => {
    expect(JsonObject.safeParse({ x: undefined }).success).toBe(false);
  });
});
