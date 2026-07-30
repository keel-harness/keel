import { describe, expect, it } from "vitest";
import { searchCompressor } from "./search.js";

// keel's search tool emits `path:line:col:text` (tools/search.ts).
const block = (file: string, count: number): string =>
  Array.from({ length: count }, (_, i) => `${file}:${i + 1}:1:match ${i}`).join("\n");

describe("searchCompressor (per-file first/last + task-token matches, cap files)", () => {
  it("keeps first + last match per file and elides the middle", () => {
    const body = block("a.ts", 40);
    const out = searchCompressor.compress(body, {}).text;
    expect(out).toContain("a.ts:1:1:match 0"); // first
    expect(out).toContain("a.ts:40:1:match 39"); // last
    expect(out.length).toBeLessThan(body.length);
    expect(out).toMatch(/more matches/i);
    expect(searchCompressor.compress(body, {}).kind).toBe("search");
  });

  it("keeps matches whose text overlaps taskTokens", () => {
    const body = [
      "a.ts:1:1:irrelevant",
      "a.ts:2:1:contains NEEDLE here",
      ...Array.from({ length: 30 }, (_, i) => `a.ts:${i + 3}:1:filler`),
    ].join("\n");
    const out = searchCompressor.compress(body, { taskTokens: ["needle"] }).text;
    expect(out).toContain("a.ts:2:1:contains NEEDLE here");
  });

  it("caps files at MAX_FILES and passes non-match lines through verbatim", () => {
    const manyFiles = Array.from({ length: 18 }, (_, i) => `f${i}.ts:1:1:hit`).join("\n");
    const out = searchCompressor.compress("searching workspace...\n" + manyFiles, {}).text;
    expect(out).toContain("searching workspace..."); // passthrough (non-match line)
    expect(out).toMatch(/more files elided/i); // cap hit
  });

  it("is deterministic across two files", () => {
    const body = block("a.ts", 50) + "\n" + block("b.ts", 50);
    expect(searchCompressor.compress(body, {}).text).toBe(searchCompressor.compress(body, {}).text);
  });

  it("collapses duplicate identical match lines (keeps by position, not text value)", () => {
    // QC must-fix regression: a Set<string> keep would re-admit all 40 identical lines (0% shrink).
    const dup = Array.from({ length: 40 }, () => "dup.ts:1:1:same match text").join("\n");
    const out = searchCompressor.compress(dup, {}).text;
    expect(out.length).toBeLessThan(dup.length); // must actually shrink
    expect(out).toMatch(/more matches/i); // and report the elision
  });
});
