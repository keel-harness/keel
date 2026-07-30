import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { genericCompressor, normalizeCarriageReturnProgress } from "./generic.js";

describe("genericCompressor (head/tail + consecutive-duplicate collapse)", () => {
  it("collapses runs of identical consecutive lines to one line + (×N)", () => {
    const out = genericCompressor.compress(
      "duplicate log line\nduplicate log line\nduplicate log line\nb\n",
      {},
    ).text;
    expect(out).toContain("duplicate log line (×3)");
    expect(out).toContain("b");
    expect(out).not.toContain("duplicate log line\nduplicate log line"); // the run is collapsed
  });

  it("does not enlarge tiny duplicate runs just to add a count marker", () => {
    const body = "a\na\nb\n";
    const out = genericCompressor.compress(body, {}).text;
    expect(out).toBe(body);
  });

  it("normalizes carriage-return progress spam to the final visible state and keeps line anchors", () => {
    const body = [
      "starting build",
      "download 1%\rdownload 20%\rdownload 100%",
      "running tests",
      "case 1/3\rcase 2/3\rcase 3/3",
      "done",
    ].join("\n");

    const out = genericCompressor.compress(body, { maxBytes: 2_000 }).text;
    expect(out).toContain("starting build");
    expect(out).toContain("download 100%");
    expect(out).toContain("running tests");
    expect(out).toContain("case 3/3");
    expect(out).toContain("done");
    expect(out).not.toContain("download 1%");
    expect(out).not.toContain("case 1/3");
  });

  it("normalizes an all-carriage-return physical line to an empty visible line", () => {
    expect(normalizeCarriageReturnProgress("start\n\r\r\nend")).toBe("start\n\nend");
  });

  it("retains overwritten error segments when normalizing carriage-return output", () => {
    const out = normalizeCarriageReturnProgress("start\nERROR failed\rOK\nend");
    expect(out).toContain("ERROR failed");
    expect(out).toContain("OK");
  });

  it("head/tail truncates a large multi-line body and marks the elision", () => {
    const body = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const out = genericCompressor.compress(body, { maxBytes: 200 }).text;
    expect(out.length).toBeLessThan(body.length);
    expect(out).toMatch(/elided/i);
  });

  it("reports its kind", () => {
    expect(genericCompressor.compress("x", {}).kind).toBe("generic");
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        return genericCompressor.compress(s, {}).text === genericCompressor.compress(s, {}).text;
      }),
    );
  });

  it("never enlarges the model-visible body", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        return genericCompressor.compress(s, { maxBytes: 4096 }).text.length <= s.length;
      }),
    );
  });

  it("is idempotent (re-compressing the output is a no-op)", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 50 }), (lines) => {
        const once = genericCompressor.compress(lines.join("\n"), { maxBytes: 256 }).text;
        const twice = genericCompressor.compress(once, { maxBytes: 256 }).text;
        return once === twice;
      }),
    );
  });

  it("materially shrinks a large redundant body", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 6000, maxLength: 12000 }), (s) => {
        return genericCompressor.compress(s, { maxBytes: 256 }).text.length < s.length;
      }),
    );
  });
});
