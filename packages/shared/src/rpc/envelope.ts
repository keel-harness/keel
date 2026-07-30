import { z } from "zod";
import { JsonObject } from "../common/json.js";
import { ErrorCode } from "./primitives.js";

const Jsonrpc = z.literal("2.0");
/** JSON-RPC ids are string or integer number (non-integer / Infinity rejected). */
const RpcId = z.union([z.string(), z.number().int()]);

/** A request expects a response (has an id). `params` is method-specific and is
 *  validated per-method in methods.ts; here it is a JSON-safe generic object. */
export const JsonRpcRequest = z
  .object({
    jsonrpc: Jsonrpc,
    id: RpcId,
    method: z.string().min(1),
    params: JsonObject.optional(),
  })
  .strict();
export type JsonRpcRequestT = z.infer<typeof JsonRpcRequest>;

/** A notification expects no response (no id). Used for warden->kernel events. */
export const JsonRpcNotification = z
  .object({
    jsonrpc: Jsonrpc,
    method: z.string().min(1),
    params: JsonObject.optional(),
  })
  .strict();
export type JsonRpcNotificationT = z.infer<typeof JsonRpcNotification>;

/** The error object. `data.code` is a keel error code string. The wire accepts
 *  any non-empty string for forward-compatibility with future codes; consumers
 *  MUST treat unrecognized codes as opaque. The recognized set is ErrorCode
 *  (primitives.ts); adding a recognized code is a MINOR protocol bump (ADR-0012). */
export const JsonRpcError = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: z
      .object({ code: ErrorCode.or(z.string().min(1)) })
      .passthrough()
      .optional(),
  })
  .strict();
export type JsonRpcErrorT = z.infer<typeof JsonRpcError>;

export const JsonRpcSuccessResponse = z
  .object({ jsonrpc: Jsonrpc, id: RpcId, result: z.unknown() })
  .strict();
export type JsonRpcSuccessResponseT = z.infer<typeof JsonRpcSuccessResponse>;

export const JsonRpcErrorResponse = z
  .object({ jsonrpc: Jsonrpc, id: RpcId.nullable(), error: JsonRpcError })
  .strict();
export type JsonRpcErrorResponseT = z.infer<typeof JsonRpcErrorResponse>;
