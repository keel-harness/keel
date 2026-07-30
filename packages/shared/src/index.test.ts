import { describe, expect, it } from "vitest";
import { KeelMeta, type KeelMetaT } from "./index.js";

describe("KeelMeta schema (wiring proof)", () => {
  it("parses a valid object round-trip", () => {
    const value: KeelMetaT = { name: "keel", specVersion: "1.3" };
    const parsed = KeelMeta.parse(value);
    expect(parsed).toEqual(value);
  });

  it("rejects an object with the wrong name literal", () => {
    const result = KeelMeta.safeParse({ name: "nope", specVersion: "1.3" });
    expect(result.success).toBe(false);
  });
});
