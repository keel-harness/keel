import { describe, expect, it } from "vitest";
import { KeelMeta } from "@keel/shared";

/**
 * Wiring proof: a cross-package import of `@keel/shared` resolves to its
 * TypeScript *source* (via the "@keel/source" export condition) for both `tsc`
 * and vitest — with no build step. This locks in monorepo cross-package
 * resolution before Epic 0.2 starts importing real schemas from `@keel/shared`.
 */
describe("cross-package resolution (@keel/simulator -> @keel/shared)", () => {
  it("imports and uses KeelMeta from @keel/shared", () => {
    expect(KeelMeta.parse({ name: "keel", specVersion: "1.3" })).toEqual({
      name: "keel",
      specVersion: "1.3",
    });
  });
});
