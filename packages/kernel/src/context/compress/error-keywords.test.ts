import { describe, expect, it } from "vitest";
import { isErrorLine } from "./error-keywords.js";

describe("isErrorLine", () => {
  it("matches error/warn/fail/traceback/panic case-insensitively", () => {
    for (const l of [
      "ERROR: boom",
      "  Warning: deprecated",
      "test FAILED",
      "Traceback (most recent call last):",
      "panic: nil deref",
      "request timeout after 30s",
    ]) {
      expect(isErrorLine(l)).toBe(true);
    }
  });

  it("does not match ordinary lines", () => {
    for (const l of ["compiling foo", "ok", "   ", "a normal line of output", "42 passed"]) {
      expect(isErrorLine(l)).toBe(false);
    }
  });
});
