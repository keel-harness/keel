import type { JSONSchema7 } from "ai";

export const PROVIDER_HOSTILE_SCHEMA_KEYS = new Set([
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "allOf",
  "anyOf",
  "const",
  "dependencies",
  "definitions",
  "dependentRequired",
  "dependentSchemas",
  "else",
  "if",
  "not",
  "oneOf",
  "patternProperties",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

function providerCompatibleJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => providerCompatibleJsonValue(entry));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (PROVIDER_HOSTILE_SCHEMA_KEYS.has(key)) {
      if (key === "const" && !("enum" in out)) {
        out["enum"] = [providerCompatibleJsonValue(entry)];
      }
      continue;
    }
    out[key] = providerCompatibleJsonValue(entry);
  }
  return out;
}

export function toProviderCompatibleJsonSchema(schema: JSONSchema7): JSONSchema7 {
  return providerCompatibleJsonValue(schema) as JSONSchema7;
}

export function providerHostileSchemaPaths(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => providerHostileSchemaPaths(entry, `${path}[${index}]`));
  }
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    ...(PROVIDER_HOSTILE_SCHEMA_KEYS.has(key) ? [`${path}.${key}`] : []),
    ...providerHostileSchemaPaths(entry, `${path}.${key}`),
  ]);
}
