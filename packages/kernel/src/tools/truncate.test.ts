import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { truncateHeadTail, truncateHeadUtf8 } from "./truncate.js";

describe("truncateHeadUtf8 (head-only, codepoint-safe — TRUNC-1)", () => {
  it("returns the text unchanged when within the byte cap", () => {
    expect(truncateHeadUtf8("hello", 100)).toBe("hello");
  });

  it("cuts on a UTF-8 codepoint boundary (drops a severed trailing multibyte char, no U+FFFD)", () => {
    const out = truncateHeadUtf8("€".repeat(100), 50); // 3-byte chars; 50 is not a multiple of 3
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(50);
    expect(out).not.toContain("�");
    expect(out).toBe("€".repeat(16)); // 48 bytes; the 17th char's partial bytes are dropped
  });
});

describe("truncateHeadTail", () => {
  it("returns the text unchanged when within the cap", () => {
    expect(truncateHeadTail("hello", 100)).toEqual({ text: "hello", truncated: false });
  });

  it("keeps a head and a tail with an elision notice when over the cap", () => {
    const text = "A".repeat(1000) + "Z".repeat(1000);
    const { text: out, truncated } = truncateHeadTail(text, 200);
    expect(truncated).toBe(true);
    expect(out.startsWith("A")).toBe(true);
    expect(out.endsWith("Z")).toBe(true);
    expect(out).toMatch(/elided/);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(400);
  });

  it("handles a cut that falls exactly mid-multibyte (leading continuation byte at tail start)", () => {
    // "🚀" is 4 bytes: 0xF0 0x9F 0x9A 0x80. Use a string where the byte-level half-cut is
    // guaranteed to land inside a multibyte codepoint, exercising decodeDropLeadingPartial's skip loop.
    // "X".repeat(20)="20 bytes" + "🚀".repeat(20)="80 bytes" = 100 bytes total.
    // cap=10 → half=5 → tail starts at byte 95 (0x80 continuation of the last rocket), must skip it.
    const text = "X".repeat(20) + "🚀".repeat(20);
    const { text: out, truncated } = truncateHeadTail(text, 10);
    expect(truncated).toBe(true);
    expect(out.includes("�")).toBe(false); // no U+FFFD replacement char introduced by our cut
    expect(out).toMatch(/elided/);
  });

  it("never emits a corrupted partial UTF-8 codepoint at a cut", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 300, maxLength: 2000 }),
        fc.integer({ min: 50, max: 250 }),
        (s, cap) => {
          const { text } = truncateHeadTail(s + "🚀".repeat(50) + s, cap);
          // round-trips through utf8 with no replacement char introduced by our cut
          expect(text.includes("�")).toBe(false);
        },
      ),
    );
  });
});
