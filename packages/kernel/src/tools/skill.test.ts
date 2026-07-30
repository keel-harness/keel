import { describe, expect, it } from "vitest";
import type { SkillRegistry } from "../context/skills.js";
import { ToolError } from "./errors.js";
import { SKILL_TOOL_NAME, createSkillTool } from "./skill.js";

const registry: SkillRegistry = {
  stubs: [
    { name: "commit", description: "Use when committing", source: "builtin", dir: "/b/commit" },
    { name: "deploy", description: "Use when deploying", source: "project", dir: "/p/deploy" },
  ],
  stubText: "stub list",
  loadBody: (name) =>
    name === "commit" ? "COMMIT-BODY" : name === "deploy" ? "DEPLOY-BODY" : undefined,
};

describe("createSkillTool — the declarative skill trigger (loads a SKILL.md body on demand)", () => {
  it("is a read-only tool named 'skill'", () => {
    const tool = createSkillTool(registry);
    expect(tool.spec.name).toBe(SKILL_TOOL_NAME);
    expect(tool.staticCapability).toEqual({
      toolName: SKILL_TOOL_NAME,
      effectEnvelope: ["fs_read"],
      broad: false,
    });
  });

  it("returns a built-in skill's body VERBATIM (keel-curated, trusted)", () => {
    const tool = createSkillTool(registry);
    expect(tool.handler({ name: "commit" })).toBe("COMMIT-BODY"); // no fence on a built-in
  });

  it("fences a WORKSPACE (project/user) skill body with a provenance marker (CTX-1)", () => {
    const tool = createSkillTool(registry);
    const out = tool.handler({ name: "deploy" }) as string; // 'deploy' source is "project"
    expect(out).toContain("DEPLOY-BODY"); // the real body is still delivered…
    expect(out).toContain("provenance: workspace-supplied skill"); // …prefixed with the provenance fence
    expect(out).toContain("deploy"); // names the skill
    // The built-in path carries NO such marker — the fence is workspace-only.
    expect(tool.handler({ name: "commit" })).not.toContain("provenance");
  });

  it("an unknown skill returns structured guidance listing the available skills (self-correct)", () => {
    const tool = createSkillTool(registry);
    expect(() => tool.handler({ name: "nope" })).toThrow(ToolError);
    expect(() => tool.handler({ name: "nope" })).toThrow(/no such skill/i);
    expect(() => tool.handler({ name: "nope" })).toThrow(/commit/); // lists what IS available
    expect(() => tool.handler({ name: "nope" })).toThrow(/deploy/);
  });

  it("rejects bad args with model-facing guidance", () => {
    const tool = createSkillTool(registry);
    expect(() => tool.handler({})).toThrow(ToolError);
  });

  it("reports '(none)' available when the registry is empty", () => {
    const empty: SkillRegistry = { stubs: [], loadBody: () => undefined };
    const tool = createSkillTool(empty);
    expect(() => tool.handler({ name: "x" })).toThrow(/\(none\)/);
  });
});
