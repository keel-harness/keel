import { describe, expect, it } from "vitest";
import {
  createVendoredSrtSandboxPort,
  createSrtSandboxPort,
  handleRpcLine,
  missingSandboxPort,
  runStdioWardenServer,
} from "./index.js";
import * as wardenRoot from "./index.js";

describe("@keel/warden exports", () => {
  it("exposes the RPC skeleton server surface", async () => {
    expect(handleRpcLine).toBeTypeOf("function");
    expect(missingSandboxPort.status().available).toBe(false);
    await expect(missingSandboxPort.execute({ command: "true" }, {})).rejects.toThrow(
      "no sandbox backend configured",
    );
    expect(runStdioWardenServer).toBeTypeOf("function");
    expect(createVendoredSrtSandboxPort).toBeTypeOf("function");
    expect(createSrtSandboxPort).toBeTypeOf("function");
    expect(wardenRoot).not.toHaveProperty("createSrtSandboxLaunchPreparer");
    expect(wardenRoot).not.toHaveProperty("createVendoredSrtSandboxComponents");
  });
});
