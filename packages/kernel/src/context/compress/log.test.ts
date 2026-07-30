import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { logCompressor } from "./log.js";
import { ERROR_KEYWORDS, isErrorLine } from "./error-keywords.js";

describe("logCompressor (keep errors + head/tail anchors, elide noise)", () => {
  it("keeps error lines and head/tail anchors, elides the noisy middle", () => {
    const lines = [
      "start",
      ...Array.from({ length: 200 }, (_, i) => `step ${i}`),
      "ERROR: kaboom",
      "end",
    ];
    const out = logCompressor.compress(lines.join("\n"), {}).text;
    expect(out).toContain("ERROR: kaboom"); // needle survives
    expect(out).toContain("start"); // head anchor
    expect(out).toContain("end"); // tail anchor
    expect(out).toMatch(/elided/i); // middle elided
    expect(out.length).toBeLessThan(lines.join("\n").length);
    expect(logCompressor.compress("ERROR x", {}).kind).toBe("log");
  });

  it("keeps a short log (<= head+tail) verbatim with no elision marker", () => {
    const body = "a\nb\nc";
    const out = logCompressor.compress(body, {}).text;
    expect(out).toBe(body);
  });

  it("normalizes carriage-return progress before applying log head/tail retention", () => {
    const body = "ERROR setup\ndownload 1%\rdownload 80%\rdownload 100%\nERROR final";
    const out = logCompressor.compress(body, {}).text;
    expect(out).toContain("ERROR setup");
    expect(out).toContain("download 100%");
    expect(out).toContain("ERROR final");
    expect(out).not.toContain("download 1%");
  });

  it("does not drop an overwritten error segment on a carriage-return line", () => {
    const out = logCompressor.compress("start\nERROR failed\rOK\nend", {}).text;
    expect(out).toContain("ERROR failed");
    expect(out).toContain("OK");
  });

  it("NEEDLE RETENTION: every error line survives as a whole line (property)", () => {
    // Generate inputs that actually CONTAIN needles — plain fc.string() almost never emits an error
    // keyword, so the old generator made this property vacuously true (QC must-fix). Assert LINE
    // membership, not substring: a substring check would pass even if a short needle were dropped but
    // happened to be a substring of a kept anchor line.
    const needleLine = fc
      .tuple(fc.constantFrom(...ERROR_KEYWORDS), fc.integer({ min: 0, max: 9999 }))
      .map(([k, n]) => `${k.toUpperCase()} at line ${String(n)}`);
    const plainLine = fc.string().filter((s) => !s.includes("\n"));
    fc.assert(
      fc.property(fc.array(fc.oneof(plainLine, needleLine), { maxLength: 300 }), (lines) => {
        const out = logCompressor.compress(lines.join("\n"), {}).text.split("\n");
        return lines.filter(isErrorLine).every((l) => out.includes(l));
      }),
    );
  });

  it("is deterministic (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 200 }), (lines) => {
        const b = lines.join("\n");
        return logCompressor.compress(b, {}).text === logCompressor.compress(b, {}).text;
      }),
    );
  });
});
