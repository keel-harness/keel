import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseArgs } from "./args.js";
import { ToolError } from "./errors.js";

const schema = z
  .object({ path: z.string().min(1), limit: z.number().int().positive().optional() })
  .strict();

describe("parseArgs", () => {
  it("returns the parsed value on valid args", () => {
    expect(parseArgs("read", schema, { path: "a.txt" })).toEqual({ path: "a.txt" });
    expect(parseArgs("read", schema, { path: "a.txt", limit: 5 })).toEqual({
      path: "a.txt",
      limit: 5,
    });
  });

  it("throws a ToolError naming the tool and the offending field (no raw ZodError dump)", () => {
    let err: unknown;
    try {
      parseArgs("read", schema, { path: "" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toContain("read");
    expect((err as ToolError).message).toContain("path");
    expect((err as ToolError).message).not.toContain("\n");
    expect((err as ToolError).message.toLowerCase()).toContain("invalid");
  });

  it("reports a missing required field", () => {
    expect(() => parseArgs("read", schema, {})).toThrow(ToolError);
  });

  it("reports a wrong-typed field by name", () => {
    let err: unknown;
    try {
      parseArgs("read", schema, { path: "a.txt", limit: -1 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toContain("limit");
  });
});
