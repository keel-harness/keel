import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ToolSpec, type ToolSpecT } from "@keel/shared";
import { READ_MAX_OUTPUT_BYTES, ReadArgs, SPEC as readSpec } from "./read.js";
import { WriteArgs, SPEC as writeSpec } from "./write.js";
import { EditArgs, SPEC as editSpec } from "./edit.js";
import { BashArgs, SPEC as bashSpec } from "./bash.js";
import { SearchArgs, SPEC as searchSpec } from "./search.js";
import { PlanArgs, SPEC as planSpec } from "./plan.js";
import { providerHostileSchemaPaths } from "../providers/schema-compat.js";

/**
 * Drift-guard for the model-facing `ToolSpec.parameters` JSON Schema vs. each tool's real zod
 * arg schema (design §11). Verifies EXACTLY:
 *   1. The authored parameters satisfies the frozen ToolSpec schema.
 *   2. Representative valid args parse under the zod schema.
 *   3. JSON-Schema property keys match the zod schema's keys exactly.
 *   4. JSON-Schema `required` set matches the zod schema's non-optional fields exactly.
 *   5. Each authored JSON-Schema property `type` matches the type derived from the zod field
 *      (string/integer/boolean — derived from zod, not a hand-maintained map, so a zod type
 *      change is caught in both directions).
 *   6. `additionalProperties: false` is present (mirrors `.strict()` on the zod object).
 *   7. Value constraints present in the zod schema are reflected in the JSON Schema:
 *      `minLength` for `.min(n)` string fields, `minimum` for `.positive()`/`.min(n)` numeric
 *      fields. This catches the two proven drift directions: changing `read.offset` minimum 1→0
 *      and removing `read.path` minLength:1 both previously passed undetected.
 *
 * No JSON-Schema-validator dependency: zod schema internals are introspected structurally.
 */

// ---------------------------------------------------------------------------
// Zod introspection helpers
// ---------------------------------------------------------------------------

/** Shared structural type for the _def we read from zod internals. */
type ZodDef = {
  typeName: string;
  schema?: ZodDef;
  innerType?: { _def: ZodDef };
  checks?: Array<{ kind: string; value?: number; inclusive?: boolean }>;
  values?: string[];
  value?: unknown;
};

/** Unwrap a zod schema to the underlying ZodObject (edit's schema is a refined ZodEffects). */
function toObjectSchema(schema: z.ZodTypeAny): z.ZodObject<Record<string, z.ZodTypeAny>, "strict"> {
  const def = (schema as { _def: ZodDef })._def;
  if (def.typeName === "ZodEffects" && def.schema !== undefined) {
    return toObjectSchema(def.schema as unknown as z.ZodTypeAny);
  }
  return schema as z.ZodObject<Record<string, z.ZodTypeAny>, "strict">;
}

/**
 * Unwrap a single field's zod schema through Optional to reach the core type.
 * Returns the unwrapped schema and whether it was optional.
 */
function unwrapField(field: z.ZodTypeAny): z.ZodTypeAny {
  const def = (field as { _def: ZodDef })._def;
  if (def.typeName === "ZodOptional" && def.innerType !== undefined) {
    return def.innerType as unknown as z.ZodTypeAny;
  }
  return field;
}

/** The set of property keys and the set of REQUIRED (non-optional) keys of a zod arg schema. */
function zodShape(schema: z.ZodTypeAny): { keys: string[]; required: string[] } {
  const shape = toObjectSchema(schema).shape;
  const keys = Object.keys(shape).sort();
  const required = keys.filter((k) => !shape[k]!.isOptional()).sort();
  return { keys, required };
}

/** Read the `properties` keys and `required` set off a JSON-Schema parameters object. */
function jsonShape(parameters: ToolSpecT["parameters"]): { keys: string[]; required: string[] } {
  const p = parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  return {
    keys: Object.keys(p.properties ?? {}).sort(),
    required: [...(p.required ?? [])].sort(),
  };
}

/**
 * Derive the expected JSON-Schema `type` string from a zod field.
 * Unwraps Optional. Maps: ZodString→"string", ZodNumber+int→"integer", ZodNumber→"number",
 * ZodBoolean→"boolean", ZodEnum→"string". Returns undefined for unrecognized types.
 */
function zodJsonType(field: z.ZodTypeAny): string | undefined {
  const core = unwrapField(field);
  const def = (core as { _def: ZodDef })._def;
  switch (def.typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber": {
      const checks = def.checks ?? [];
      const isInt = checks.some((c) => c.kind === "int");
      return isInt ? "integer" : "number";
    }
    case "ZodBoolean":
      return "boolean";
    case "ZodEnum":
      return "string";
    case "ZodLiteral":
      return typeof def.value;
    default:
      return undefined;
  }
}

/**
 * The authored JSON-Schema `type` for one property (read from the hand-authored SPEC parameters).
 */
function propType(parameters: ToolSpecT["parameters"], key: string): unknown {
  const props = (parameters as { properties: Record<string, { type?: unknown; enum?: unknown }> })
    .properties;
  return props[key]?.type;
}

/**
 * Derive expected value constraints from a zod field:
 * - ZodString with a `min` check → `{ minLength: value }`
 * - ZodNumber with int + a `min` check → `{ minimum: effective_minimum }` where exclusive
 *   min(V, inclusive=false) on integers maps to minimum=V+1.
 * Returns an empty object if the field has no relevant constraints.
 */
function zodValueConstraints(field: z.ZodTypeAny): Record<string, number> {
  const core = unwrapField(field);
  const def = (core as { _def: ZodDef })._def;
  const checks = def.checks ?? [];
  const result: Record<string, number> = {};

  if (def.typeName === "ZodString") {
    const minCheck = checks.find((c) => c.kind === "min");
    if (minCheck !== undefined && minCheck.value !== undefined) {
      result["minLength"] = minCheck.value;
    }
  } else if (def.typeName === "ZodNumber") {
    const isInt = checks.some((c) => c.kind === "int");
    const minCheck = checks.find((c) => c.kind === "min");
    if (minCheck !== undefined && minCheck.value !== undefined) {
      // For integer types with exclusive min (positive()), V+1 is the effective minimum.
      const effective = isInt && minCheck.inclusive === false ? minCheck.value + 1 : minCheck.value;
      result["minimum"] = effective;
    }
  }

  return result;
}

/**
 * Read a single value constraint from the authored JSON-Schema parameters for one property.
 * Returns `undefined` if the key or constraint is absent.
 */
function propConstraint(
  parameters: ToolSpecT["parameters"],
  key: string,
  constraintKey: string,
): unknown {
  const props = (parameters as { properties: Record<string, Record<string, unknown>> }).properties;
  return props[key]?.[constraintKey];
}

function propLiteralValue(parameters: ToolSpecT["parameters"], key: string): unknown {
  const props = (parameters as { properties: Record<string, Record<string, unknown>> }).properties;
  const prop = props[key];
  if (prop === undefined) return undefined;
  if ("const" in prop) return prop["const"];
  const values = prop["enum"];
  return Array.isArray(values) && values.length === 1 ? values[0] : undefined;
}

function zodConstValue(field: z.ZodTypeAny): unknown {
  const core = unwrapField(field);
  const def = (core as { _def: ZodDef })._def;
  return def.typeName === "ZodLiteral" ? def.value : undefined;
}

// ---------------------------------------------------------------------------
// Test table
// ---------------------------------------------------------------------------

/** Structural view of a tool SPEC — the shape all five `as const` SPECs satisfy. */
interface ToolUnderTest {
  readonly name: string;
  readonly spec: { readonly name: string; readonly parameters: ToolSpecT["parameters"] };
  readonly args: z.ZodTypeAny;
  /** Representative VALID args (must parse under the zod schema). */
  readonly valid: Record<string, unknown>;
}

const TOOLS: readonly ToolUnderTest[] = [
  {
    name: "read",
    spec: readSpec,
    args: ReadArgs,
    valid: { path: "src/a.ts", offset: 2, limit: 50, followSymlink: true },
  },
  {
    name: "write",
    spec: writeSpec,
    args: WriteArgs,
    valid: { path: "out.txt", content: "hello" },
  },
  {
    name: "edit",
    spec: editSpec,
    args: EditArgs,
    valid: { path: "f.ts", oldString: "a", newString: "b" },
  },
  {
    name: "bash",
    spec: bashSpec,
    args: BashArgs,
    valid: { command: "echo hi", timeoutMs: 1000, analysis: "why", plan: "how" },
  },
  {
    name: "search",
    spec: searchSpec,
    args: SearchArgs,
    valid: { pattern: "TODO", kind: "content", glob: "*.ts", maxResults: 10 },
  },
  {
    name: "plan",
    spec: planSpec,
    args: PlanArgs,
    valid: { items: [{ text: "step one", status: "current" }] },
  },
];

describe.each(TOOLS)("ToolSpec.parameters drift-guard — $name", (tool) => {
  it("the authored parameters is a valid ToolSpec (frozen schema accepts it)", () => {
    // The whole SPEC must satisfy the frozen ToolSpec zod schema (name + opaque parameters).
    expect(() => ToolSpec.parse(tool.spec)).not.toThrow();
  });

  it("representative args parse under the tool's real zod arg schema", () => {
    const parsed: unknown = tool.args.parse(tool.valid);
    expect(parsed).toEqual(tool.valid);
  });

  it("JSON-Schema property keys match the zod schema's keys exactly", () => {
    const z = zodShape(tool.args);
    const j = jsonShape(tool.spec.parameters);
    expect(j.keys).toEqual(z.keys);
  });

  it("JSON-Schema required set matches the zod schema's required (non-optional) fields exactly", () => {
    const z = zodShape(tool.args);
    const j = jsonShape(tool.spec.parameters);
    expect(j.required).toEqual(z.required);
  });

  it("each authored property type matches the type derived from the zod field (string/integer/boolean)", () => {
    // Derived from zod — not a hardcoded map — so a zod type change is caught in both directions.
    const shape = toObjectSchema(tool.args).shape;
    for (const key of Object.keys(shape)) {
      const expected = zodJsonType(shape[key]!);
      if (expected !== undefined) {
        expect(propType(tool.spec.parameters, key), `${tool.name}.${key} type`).toBe(expected);
      }
    }
  });

  it("declares additionalProperties:false (closed schema, mirroring the .strict() zod object)", () => {
    expect((tool.spec.parameters as { additionalProperties?: boolean }).additionalProperties).toBe(
      false,
    );
  });

  it("does not advertise provider-hostile schema keywords", () => {
    expect(providerHostileSchemaPaths(tool.spec.parameters), tool.name).toEqual([]);
  });

  it("value constraints in the JSON Schema match the zod schema (minLength for strings, minimum for numbers)", () => {
    // Catches the two proven drift directions:
    //   - Changing read.offset JSON-Schema minimum 1→0 (zod is .positive() → effective min 1)
    //   - Removing read.path's minLength:1 (zod is .min(1) → minLength 1)
    // Any string field with zod .min(n) must have minLength:n in the JSON Schema.
    // Any integer field with zod .positive() or .min(n) must have minimum:N in the JSON Schema.
    const shape = toObjectSchema(tool.args).shape;
    for (const key of Object.keys(shape)) {
      const constraints = zodValueConstraints(shape[key]!);
      for (const [constraintKey, expected] of Object.entries(constraints)) {
        expect(
          propConstraint(tool.spec.parameters, key, constraintKey),
          `${tool.name}.${key} ${constraintKey}`,
        ).toBe(expected);
      }
    }
  });

  it("literal values in the JSON Schema match zod literal fields", () => {
    const shape = toObjectSchema(tool.args).shape;
    for (const key of Object.keys(shape)) {
      const expected = zodConstValue(shape[key]!);
      if (expected !== undefined) {
        expect(propLiteralValue(tool.spec.parameters, key), `${tool.name}.${key} literal`).toBe(
          expected,
        );
      }
    }
  });
});

describe("search.kind enum mirrors the zod enum", () => {
  it("the JSON-Schema enum equals the zod enum options exactly", () => {
    const inner = toObjectSchema(SearchArgs).shape["kind"];
    // ZodOptional → unwrap to the ZodEnum to read its options.
    const enumDef = (inner as { _def: { innerType?: { _def?: { values?: string[] } } } })._def
      .innerType?._def;
    const zodOptions = enumDef?.values ?? [];
    const jsonEnum = (searchSpec.parameters.properties.kind as { enum?: readonly string[] }).enum;
    expect([...(jsonEnum ?? [])].sort()).toEqual([...zodOptions].sort());
    expect(jsonEnum).toEqual(["content", "filename"]);
  });
});

describe("cross-field tool schema constraints", () => {
  it("read byte-slice dependencies and caps are advertised and enforced", () => {
    const params = readSpec.parameters as {
      readonly properties: Record<string, Record<string, unknown>>;
    };

    expect(params.properties["byteLimit"]?.["maximum"]).toBe(READ_MAX_OUTPUT_BYTES);
    expect(params.properties["start"]).toMatchObject({ type: "integer", minimum: 1 });
    expect(params.properties["start_line"]).toMatchObject({ type: "integer", minimum: 1 });

    expect(() => ReadArgs.parse({ path: "README.md", start: 2 })).not.toThrow();
    expect(() => ReadArgs.parse({ path: "README.md", start_line: 2 })).not.toThrow();
    expect(() => ReadArgs.parse({ path: "README.md", byteOffset: 1 })).toThrow(
      /byteOffset and byteLimit/u,
    );
    expect(() =>
      ReadArgs.parse({ path: "README.md", byteOffset: 1, byteLimit: 2, offset: 1 }),
    ).toThrow(/cannot be combined/u);
    expect(() =>
      ReadArgs.parse({
        path: "README.md",
        byteOffset: 1,
        byteLimit: READ_MAX_OUTPUT_BYTES + 1,
      }),
    ).toThrow(/byteLimit is too large/u);
    expect(() => ReadArgs.parse({ path: "README.md", start: 2, start_line: 3 })).toThrow(
      /conflicting/u,
    );
    expect(() =>
      ReadArgs.parse({ path: "README.md", byteOffset: 1, byteLimit: 2, start: 1 }),
    ).toThrow(/cannot be combined/u);
  });

  it("search compatibility aliases and content-only scoping are advertised and enforced", () => {
    const params = searchSpec.parameters as {
      readonly properties: Record<string, Record<string, unknown>>;
    };

    expect(params.properties["path"]).toMatchObject({ type: "string", minLength: 1 });
    expect(params.properties["output_mode"]).toMatchObject({
      type: "string",
      enum: ["content"],
    });
    expect(() =>
      SearchArgs.parse({ pattern: "TODO", path: "src", output_mode: "content" }),
    ).not.toThrow();
    expect(() => SearchArgs.parse({ pattern: "*.ts", kind: "filename", glob: "src/**" })).toThrow(
      /glob is only supported/u,
    );
    expect(() => SearchArgs.parse({ pattern: "*.ts", kind: "filename", path: "src" })).toThrow(
      /path is only supported/u,
    );
    expect(() => SearchArgs.parse({ pattern: "*.ts", glob: "src/**", path: "src" })).toThrow(
      /conflicting 'path' and 'glob'/u,
    );
    expect(() =>
      SearchArgs.parse({ pattern: "*.ts", kind: "filename", output_mode: "content" }),
    ).toThrow(/conflicting output_mode/u);
  });
});

describe("bash.lease nested schema mirrors the supported local lease contract", () => {
  it("advertises only verifier-handoff leases and the same required nested fields that zod accepts", () => {
    const lease = (bashSpec.parameters.properties.lease ?? {}) as {
      readonly properties?: Record<
        string,
        { readonly enum?: readonly string[]; readonly minLength?: number }
      >;
      readonly required?: readonly string[];
      readonly additionalProperties?: boolean;
    };

    expect(lease.required).toEqual(["kind", "scope", "logPath"]);
    expect(lease.additionalProperties).toBe(false);
    expect(lease.properties?.["kind"]?.enum).toEqual(["service", "job"]);
    expect(lease.properties?.["scope"]?.enum).toEqual(["until-verifier-handoff"]);
    expect(lease.properties?.["logPath"]?.minLength).toBe(1);

    expect(() =>
      BashArgs.parse({
        command: "python3 -m http.server 8000",
        lease: {
          kind: "service",
          scope: "until-verifier-handoff",
          logPath: "/tmp/keel-http.log",
        },
      }),
    ).not.toThrow();
    expect(() =>
      BashArgs.parse({
        command: "john hash.txt",
        lease: {
          kind: "job",
          scope: "until-explicit-stop",
          logPath: "/tmp/keel-john.log",
        },
      }),
    ).toThrow();
  });
});
