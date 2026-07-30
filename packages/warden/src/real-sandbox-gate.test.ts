import { describe, expect, it } from "vitest";

import { isRealSandboxRequired, resolveRealSandboxGate } from "./real-sandbox-gate.js";

describe("isRealSandboxRequired", () => {
  it("is false when the env var is absent", () => {
    expect(isRealSandboxRequired({})).toBe(false);
  });

  it('is true for "1"', () => {
    expect(isRealSandboxRequired({ KEEL_REQUIRE_REAL_SANDBOX: "1" })).toBe(true);
  });

  it('is true for "true" regardless of case or surrounding whitespace', () => {
    expect(isRealSandboxRequired({ KEEL_REQUIRE_REAL_SANDBOX: "  TRUE " })).toBe(true);
    expect(isRealSandboxRequired({ KEEL_REQUIRE_REAL_SANDBOX: "True" })).toBe(true);
  });

  it("is false for empty / falsey values, so it never accidentally arms the gate", () => {
    expect(isRealSandboxRequired({ KEEL_REQUIRE_REAL_SANDBOX: "" })).toBe(false);
    expect(isRealSandboxRequired({ KEEL_REQUIRE_REAL_SANDBOX: "0" })).toBe(false);
    expect(isRealSandboxRequired({ KEEL_REQUIRE_REAL_SANDBOX: "false" })).toBe(false);
    expect(isRealSandboxRequired({ KEEL_REQUIRE_REAL_SANDBOX: "no" })).toBe(false);
  });
});

describe("resolveRealSandboxGate", () => {
  it("runs the probes when the real sandbox is available", () => {
    expect(resolveRealSandboxGate({ required: true, available: true })).toEqual({ action: "run" });
    // Availability alone is enough to run even when not explicitly required.
    expect(resolveRealSandboxGate({ required: false, available: true })).toEqual({ action: "run" });
  });

  it("skips (never fails) when the sandbox is unavailable and not required", () => {
    const decision = resolveRealSandboxGate({ required: false, available: false });
    expect(decision.action).toBe("skip");
    if (decision.action !== "skip") throw new Error("unreachable");
    expect(decision.reason).toMatch(/opt-in|KEEL_REQUIRE_REAL_SANDBOX/i);
  });

  it("FAILS CLOSED when the sandbox is required but unavailable (anti hidden-green)", () => {
    const decision = resolveRealSandboxGate({
      required: true,
      available: false,
      unavailableReason: "bwrap not found",
    });
    expect(decision.action).toBe("fail");
    if (decision.action !== "fail") throw new Error("unreachable");
    // The failure message must name the required flag AND surface why the sandbox was unavailable,
    // so a red CI leg is self-diagnosing rather than a mystery skip.
    expect(decision.reason).toMatch(/KEEL_REQUIRE_REAL_SANDBOX/);
    expect(decision.reason).toContain("bwrap not found");
  });

  it("still fails closed when required-but-unavailable and no reason was captured", () => {
    const decision = resolveRealSandboxGate({ required: true, available: false });
    expect(decision.action).toBe("fail");
    if (decision.action !== "fail") throw new Error("unreachable");
    expect(decision.reason).toMatch(/unknown/i);
  });
});
