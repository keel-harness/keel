import { describe, expect, it } from "vitest";
import { z } from "zod";
import { badArgsMessage, errMessage } from "./strings.js";

/**
 * Direct unit tests for badArgsMessage microcopy.
 * args.test.ts exercises the happy-path and field-name branches via parseArgs;
 * this file covers the remaining branches (no-path fallback, missing-issue fallback).
 */
describe("badArgsMessage", () => {
  it("names a field when the issue has a non-empty path", () => {
    const schema = z.object({ x: z.string() });
    const err = schema.safeParse({ x: 1 });
    expect(err.success).toBe(false);
    const msg = badArgsMessage("mytool", err.error!);
    expect(msg).toContain("mytool");
    expect(msg).toContain("'x'");
    expect(msg.toLowerCase()).toContain("invalid");
  });

  it("falls back to 'arguments' when the first issue has an empty path (top-level refine)", () => {
    const schema = z.object({ n: z.number() }).refine(() => false, { message: "always fails" });
    const err = schema.safeParse({ n: 1 });
    expect(err.success).toBe(false);
    // The top-level refine issue has path === []
    const msg = badArgsMessage("mytool", err.error!);
    expect(msg).toContain("mytool");
    expect(msg).toContain("arguments");
    expect(msg.toLowerCase()).toContain("invalid");
  });

  it("falls back to 'invalid arguments' when the issue has no message (defensive codepath)", () => {
    // Construct a synthetic ZodError where issue.message is undefined —
    // unreachable in normal Zod usage but guarded defensively in badArgsMessage.
    const syntheticIssue = {
      code: "custom" as const,
      path: [],
      message: undefined as unknown as string,
    };
    const syntheticError = new z.ZodError([syntheticIssue]);
    const msg = badArgsMessage("mytool", syntheticError);
    expect(msg).toContain("invalid arguments");
  });
});

describe("errMessage", () => {
  it("returns the message property for an Error instance", () => {
    expect(errMessage(new Error("boom"))).toBe("boom");
  });

  it("returns the string itself for a string value", () => {
    expect(errMessage("something went wrong")).toBe("something went wrong");
  });

  it("returns 'unknown error' for any other value", () => {
    expect(errMessage(42)).toBe("unknown error");
    expect(errMessage(null)).toBe("unknown error");
    expect(errMessage(undefined)).toBe("unknown error");
    expect(errMessage({ message: "nope" })).toBe("unknown error");
  });
});
