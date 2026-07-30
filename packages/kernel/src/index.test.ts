import { describe, expect, it } from "vitest";
import {
  runAgentLoop,
  LocalExecutor,
  KernelEvent,
  DEFAULT_MAX_TURNS,
  VercelModelPort,
  createAnthropicModelPort,
  mapPart,
  WardenExecutor,
  wardenStatusViewConfig,
} from "./index.js";

describe("@keel/kernel barrel", () => {
  it("re-exports the public surface", () => {
    expect(typeof runAgentLoop).toBe("function");
    expect(typeof LocalExecutor).toBe("function");
    expect(KernelEvent.safeParse({ type: "run-started" }).success).toBe(true);
    expect(DEFAULT_MAX_TURNS).toBeGreaterThan(0);
  });

  it("re-exports the Epic 1.3 provider surface", () => {
    expect(typeof VercelModelPort).toBe("function");
    expect(typeof createAnthropicModelPort).toBe("function");
    expect(typeof mapPart).toBe("function");
  });

  it("re-exports the warden executor and status HUD adapter", () => {
    expect(typeof WardenExecutor).toBe("function");
    expect(typeof wardenStatusViewConfig).toBe("function");
  });
});
