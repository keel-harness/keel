import { describe, expect, it } from "vitest";
import { errorMessage } from "./errors.js";

describe("errorMessage (DRY catch normaliser)", () => {
  it("returns .message for an Error instance (true branch)", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error thrown value (false branch — the defensive case)", () => {
    expect(errorMessage("plain")).toBe("plain");
  });
});
