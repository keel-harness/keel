import { describe, expect, it } from "vitest";
import type { JsonObjectT } from "@keel/shared";
import { ToolError } from "./errors.js";
import { PLAN_TOOL_NAME, createPlanTool, renderLedger } from "./plan.js";

const run = (args: JsonObjectT): string => createPlanTool().handler(args) as string;

describe("plan tool (the in-session task ledger, §4.9.7 / §8.6)", () => {
  it("renders items with status glyphs under a Plan header, in order", () => {
    const out = run({
      items: [
        { text: "reproduce failure", status: "done" },
        { text: "patch refresh-token expiry", status: "current" },
        { text: "run auth tests", status: "pending" },
      ],
    });
    expect(out).toBe(
      ["Plan", "✓ reproduce failure", "→ patch refresh-token expiry", "□ run auth tests"].join(
        "\n",
      ),
    );
  });

  it("renderLedger is deterministic and reused by the handler", () => {
    const items = [{ text: "only step", status: "current" as const }];
    expect(renderLedger(items)).toBe("Plan\n→ only step");
  });

  it("is a non-mutating attention anchor", () => {
    const tool = createPlanTool();
    expect(tool.spec.name).toBe(PLAN_TOOL_NAME);
    expect(tool.staticCapability).toEqual({
      toolName: PLAN_TOOL_NAME,
      effectEnvelope: ["fs_read"],
      broad: false,
    });
  });

  it("rejects an empty plan and an unknown status", () => {
    expect(() => run({ items: [] })).toThrow(ToolError);
    expect(() => run({ items: [{ text: "x", status: "blocked" }] })).toThrow(ToolError);
    expect(() => run({ items: [{ text: "", status: "pending" }] })).toThrow(ToolError);
  });
});
