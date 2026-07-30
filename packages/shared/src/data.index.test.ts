import { describe, expect, it } from "vitest";
import * as shared from "./index.js";

describe("@keel/shared barrel (data schemas)", () => {
  it("re-exports the 0.2b surface", () => {
    for (const name of [
      "IsoTimestamp",
      "AuditRecord",
      "AnyAuditRecord",
      "MemoryFrontmatter",
      "PolicyInput",
      "Goal",
      "LoopConfig",
      "SessionEvent",
      "SimulatorScript",
    ]) {
      expect(name in shared).toBe(true);
    }
  });
});
