import { describe, expect, it } from "vitest";
import { formatTokens } from "./format.js";

describe("formatTokens", () => {
  it("shows raw counts under 1k", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(850)).toBe("850");
    expect(formatTokens(999)).toBe("999");
  });
  it("shows one decimal k between 1k and 100k", () => {
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(12300)).toBe("12.3k");
  });
  it("rounds to whole k at 100k+", () => {
    expect(formatTokens(120000)).toBe("120k");
  });
});
