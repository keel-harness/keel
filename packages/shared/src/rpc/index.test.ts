import { describe, expect, it } from "vitest";
import * as shared from "../index.js";

describe("@keel/shared barrel", () => {
  it("re-exports the RPC surface", () => {
    for (const name of [
      "Principal",
      "Verdict",
      "JsonRpcRequest",
      "WARDEN_METHODS",
      "WardenMethodName",
    ]) {
      expect(name in shared).toBe(true);
    }
  });

  it("KeelMeta is still exported (wiring schema retained)", () => {
    expect("KeelMeta" in shared).toBe(true);
  });
});
