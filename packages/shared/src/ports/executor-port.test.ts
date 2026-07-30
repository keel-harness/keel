import { describe, expect, it } from "vitest";
import { assertWireRoundTrips } from "../testing/property.js";
import { ToolInvocation, ToolResult } from "./executor-port.js";

describe("ExecutorPort schemas", () => {
  it("ToolInvocation accepts a well-formed invocation", () => {
    const parsed = ToolInvocation.parse({ id: "call_0_0", name: "echo", args: { text: "hi" } });
    expect(parsed).toEqual({ id: "call_0_0", name: "echo", args: { text: "hi" } });
  });

  it("ToolInvocation rejects empty id/name and non-JSON args", () => {
    expect(ToolInvocation.safeParse({ id: "", name: "echo", args: {} }).success).toBe(false);
    expect(ToolInvocation.safeParse({ id: "x", name: "", args: {} }).success).toBe(false);
    expect(ToolInvocation.safeParse({ id: "x", name: "e", args: { n: NaN } }).success).toBe(false);
    expect(ToolInvocation.safeParse({ id: "x", name: "e", args: {}, extra: 1 }).success).toBe(
      false,
    );
  });

  it("ToolResult accepts ok and error shapes, rejects unknown keys", () => {
    expect(ToolResult.parse({ ok: true, output: "done" })).toEqual({ ok: true, output: "done" });
    expect(ToolResult.parse({ ok: false, output: "boom" })).toEqual({ ok: false, output: "boom" });
    expect(ToolResult.safeParse({ ok: true, output: "x", isError: true }).success).toBe(false);
  });

  it("wire round-trips (JSON serialize→parse identity) — these cross the warden RPC wire in Phase 2", () => {
    assertWireRoundTrips(ToolInvocation);
    assertWireRoundTrips(ToolResult);
  });
});
