import { describe, expect, it } from "vitest";
import { JUNK, assertRejects, assertRoundTrips } from "../testing/property.js";
import { MemoryCategory, MemoryConfidence, MemoryFrontmatter, MemoryState } from "./frontmatter.js";

const BASE = {
  id: "mem_01J000000000000000000000XY",
  category: "project-fact",
  valid_from: "2026-06-11",
  valid_until: null,
  invalidated_by: null,
  state: "active",
  entities: ["pnpm", "build"],
  source_session: "ses_01J000000000000000000000XY",
  confidence: "stated",
  occurrences: 1,
} as const;

describe("memory frontmatter (Appendix C)", () => {
  it("enums match the spec", () => {
    expect(MemoryCategory.options).toEqual([
      "project-fact",
      "preference",
      "decision",
      "environment",
      "procedural",
    ]);
    expect(MemoryState.options).toEqual(["active", "superseded", "redacted"]);
    expect(MemoryConfidence.options).toEqual(["stated", "inferred"]);
  });

  it("round-trips and rejects malformed", () => {
    expect(MemoryFrontmatter.parse(BASE)).toBeTruthy();
    assertRoundTrips(MemoryFrontmatter);
    assertRejects(MemoryFrontmatter, [
      ...JUNK,
      // occurrences must be >= 1
      { ...BASE, occurrences: 0 },
      // bad category
      { ...BASE, category: "secret" },
    ]);
  });

  describe("valid_from / valid_until ordering constraint (N2)", () => {
    it("accepts a normal validity window (valid_until > valid_from)", () => {
      expect(
        MemoryFrontmatter.safeParse({
          ...BASE,
          valid_from: "2026-01-01",
          valid_until: "2026-12-31",
        }).success,
      ).toBe(true);
    });

    it("accepts a same-day window (valid_until === valid_from)", () => {
      expect(
        MemoryFrontmatter.safeParse({
          ...BASE,
          valid_from: "2026-06-13",
          valid_until: "2026-06-13",
        }).success,
      ).toBe(true);
    });

    it("accepts when only valid_from is set (valid_until null)", () => {
      expect(
        MemoryFrontmatter.safeParse({
          ...BASE,
          valid_from: "2026-06-13",
          valid_until: null,
        }).success,
      ).toBe(true);
    });

    it("rejects an inverted window (valid_until < valid_from)", () => {
      expect(
        MemoryFrontmatter.safeParse({
          ...BASE,
          valid_from: "2026-06-13",
          valid_until: "2026-01-01",
        }).success,
      ).toBe(false);
    });
  });
});
