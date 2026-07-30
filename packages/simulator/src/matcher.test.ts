import { describe, expect, it } from "vitest";
import { InvalidMatcherPatternError, UnsupportedMatcherError } from "./errors.js";
import { matchResult } from "./matcher.js";

describe("result matcher", () => {
  it("regex matches and fails as expected", () => {
    const m = { on: "toolResult", kind: "regex", pattern: "id_rsa" } as const;
    expect(matchResult(m, "-----BEGIN id_rsa-----")).toBe(true);
    expect(matchResult(m, "nothing here")).toBe(false);
  });

  it("a missing (undefined) prior tool result never matches", () => {
    expect(matchResult({ on: "toolResult", kind: "regex", pattern: ".*" }, undefined)).toBe(false);
  });

  it("jsonpath is deferred with a typed UnsupportedMatcherError", () => {
    expect(() => matchResult({ on: "toolResult", kind: "jsonpath", pattern: "$.x" }, "{}")).toThrow(
      UnsupportedMatcherError,
    );
  });

  it("N6: an uncompilable regex pattern throws a typed InvalidMatcherPatternError, not a raw SyntaxError", () => {
    expect(() =>
      matchResult({ on: "toolResult", kind: "regex", pattern: "(" }, "sometext"),
    ).toThrow(InvalidMatcherPatternError);
    expect(() =>
      matchResult({ on: "toolResult", kind: "regex", pattern: "(" }, "sometext"),
    ).not.toThrow(SyntaxError);
  });
});
