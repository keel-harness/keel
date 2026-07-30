import { describe, expect, it } from "vitest";
import type { ToolSpecT } from "@keel/shared";
import { SPEC as bashSpec } from "../tools/bash.js";
import { SPEC as editSpec } from "../tools/edit.js";
import { SPEC as planSpec } from "../tools/plan.js";
import { SPEC as realReadSpec } from "../tools/read.js";
import { createRetrieveTool } from "../tools/retrieve.js";
import { SPEC as realSearchSpec } from "../tools/search.js";
import { createSkillTool } from "../tools/skill.js";
import { SPEC as writeSpec } from "../tools/write.js";
import { providerHostileSchemaPaths } from "./schema-compat.js";
import { EMPTY_OBJECT_SCHEMA, toSdkToolName, toSdkTools, toSdkToolsProjection } from "./tools.js";

/**
 * `jsonSchema()` wraps the raw JSON Schema as `{ jsonSchema }` on the resulting Schema (it
 * can also be a promise; for the sync inputs we pass it is the object). This narrows it for
 * assertions on the schema actually advertised to the provider.
 */
function rawSchema(inputSchema: unknown): unknown {
  return (inputSchema as { jsonSchema: unknown }).jsonSchema;
}

const readSpec: ToolSpecT = {
  name: "read",
  description: "Read a file.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};

const optionalRuntimeSpecs = [
  createSkillTool({
    stubs: [
      { name: "review", description: "Review code.", source: "builtin", dir: "/skills/review" },
    ],
    loadBody: () => "Review code.",
  }).spec,
  createRetrieveTool(() => []).spec,
];
const realAdvertisedSpecs = [
  bashSpec,
  realReadSpec,
  realSearchSpec,
  writeSpec,
  editSpec,
  planSpec,
  ...optionalRuntimeSpecs,
];

describe("toSdkTools — keel ToolSpecT[] → SDK tools object", () => {
  it("keys the result by tool name", () => {
    const tools = toSdkTools([readSpec, { name: "bash" }]);
    expect(Object.keys(tools).sort()).toEqual(["bash", "read"]);
  });

  it("carries the spec description onto each SDK tool", () => {
    const tools = toSdkTools([readSpec]);
    expect(tools["read"]?.description).toBe("Read a file.");
  });

  it("omits description (does not set it to a string) when the spec has none", () => {
    const tools = toSdkTools([{ name: "bash" }]);
    // The frozen ToolSpec.description is optional; exactOptionalPropertyTypes means we must
    // not materialize `description: undefined`. Assert the key is genuinely absent.
    expect("description" in (tools["bash"] ?? {})).toBe(false);
  });

  it("passes provider-compatible ToolSpec.parameters through as the tool's JSON Schema", () => {
    const tools = toSdkTools([readSpec]);
    expect(rawSchema(tools["read"]?.inputSchema)).toEqual(readSpec.parameters);
  });

  it("uses an empty-object schema when a spec has no parameters", () => {
    const tools = toSdkTools([{ name: "bash" }]);
    expect(rawSchema(tools["bash"]?.inputSchema)).toEqual(EMPTY_OBJECT_SCHEMA);
  });

  it("EMPTY_OBJECT_SCHEMA is a closed empty object schema (no free-form args advertised)", () => {
    expect(EMPTY_OBJECT_SCHEMA).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("attaches NO execute function — the native-tool path surfaces the call for keel to dispatch", () => {
    // This is the load-bearing assertion of native tool calling: without `execute`, the SDK
    // emits the tool-call part and stops instead of running the tool itself (design §7/§8).
    const tools = toSdkTools([readSpec, { name: "bash" }]);
    for (const name of ["read", "bash"]) {
      expect(tools[name]).toBeDefined();
      expect("execute" in (tools[name] ?? {})).toBe(false);
    }
  });

  it("returns an empty object for an empty spec list", () => {
    expect(toSdkTools([])).toEqual({});
  });

  it("fails closed when two specs share a tool name", () => {
    const a: ToolSpecT = { name: "dup", description: "first" };
    const b: ToolSpecT = { name: "dup", description: "second" };

    expect(() => toSdkTools([a, b])).toThrow(/duplicate SDK tool name/);
  });

  it("projects dotted keel tool names to provider-safe names with a reversible map", () => {
    const projected = toSdkToolsProjection([
      { name: "interactive_console.open", description: "Open console." },
      { name: "lifecycle.run" },
      { name: "bash" },
    ]);
    const wireNames = Object.keys(projected.tools).sort();

    expect(wireNames).toContain("bash");
    expect(wireNames).not.toContain("interactive_console.open");
    expect(wireNames.every((name) => /^[a-zA-Z0-9_-]{1,128}$/.test(name))).toBe(true);
    expect(projected.keelNameBySdkName.get(toSdkToolName("interactive_console.open"))).toBe(
      "interactive_console.open",
    );
    expect(projected.keelNameBySdkName.get(toSdkToolName("lifecycle.run"))).toBe("lifecycle.run");
    expect(projected.keelNameBySdkName.get("bash")).toBe("bash");
  });

  it("fails closed when two different keel names project to the same SDK tool name", () => {
    const projectedName = toSdkToolName("a.b");

    expect(() => toSdkToolsProjection([{ name: "a.b" }, { name: projectedName }])).toThrow(
      /SDK tool name collision/,
    );
  });

  it("sanitizes provider-hostile schema keywords before advertising SDK tools", () => {
    const tools = toSdkTools([
      {
        name: "unsafe",
        parameters: {
          type: "object",
          dependencies: { a: ["b"] },
          allOf: [{ required: ["a"] }],
          properties: {
            fixed: { type: "string", const: "x" },
            nested: {
              anyOf: [{ type: "string" }, { type: "number" }],
              items: { oneOf: [{ type: "string" }] },
            },
          },
        },
      },
    ]);

    const schema = rawSchema(tools["unsafe"]?.inputSchema) as {
      readonly properties?: Record<string, Record<string, unknown>>;
    };
    expect(providerHostileSchemaPaths(schema)).toEqual([]);
    expect(schema.properties?.["fixed"]?.["enum"]).toEqual(["x"]);
  });

  it("does not advertise provider-hostile schema keywords for built-in and optional runtime tools", () => {
    const projected = toSdkToolsProjection(realAdvertisedSpecs);

    for (const [sdkName, sdkTool] of Object.entries(projected.tools)) {
      expect(providerHostileSchemaPaths(rawSchema(sdkTool.inputSchema)), sdkName).toEqual([]);
    }
  });
});
