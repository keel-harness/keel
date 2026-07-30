import { z } from "zod";

/**
 * A value that survives a JSON serialize→parse round-trip unchanged: string,
 * FINITE number, boolean, null, and arrays/objects thereof. Rejects undefined,
 * NaN, ±Infinity, bigint, symbol, function — i.e. anything that drops or mutates
 * over `JSON.parse(JSON.stringify(x))`. Use this for every field whose value
 * crosses the warden JSON-RPC wire or is hashed over canonical JSON.
 */
export type JsonValueT =
  | string
  | number
  | boolean
  | null
  | JsonValueT[]
  | { [k: string]: JsonValueT };

/**
 * JSON-safe number: finite and NOT negative zero (-0 serialises to "0" over
 * JSON so it cannot survive a round-trip and is excluded).
 */
const JsonNumber = z
  .number()
  .finite()
  .refine((n) => !Object.is(n, -0), { message: "negative zero is not JSON-safe" });

export const JsonValue: z.ZodType<JsonValueT> = z.lazy(() =>
  z.union([
    z.string(),
    JsonNumber,
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);

/** Convenience for object-shaped JSON payloads (tool args, audit payload, etc.). */
export const JsonObject = z.record(z.string(), JsonValue);
export type JsonObjectT = z.infer<typeof JsonObject>;
