import { describe, expect, it } from "vitest";
import {
  JUNK,
  assertRejects,
  assertRoundTrips,
  assertWireRoundTrips,
} from "../testing/property.js";
import {
  JsonRpcError,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
} from "./envelope.js";

describe("JSON-RPC 2.0 envelope", () => {
  it("request: requires jsonrpc '2.0', id, method", () => {
    expect(
      JsonRpcRequest.parse({ jsonrpc: "2.0", id: 1, method: "warden.status", params: {} }),
    ).toBeTruthy();
    assertRoundTrips(JsonRpcRequest);
    assertRejects(JsonRpcRequest, [
      ...JUNK,
      { jsonrpc: "1.0", id: 1, method: "m" }, // wrong version
      { jsonrpc: "2.0", method: "m" }, // missing id
      { jsonrpc: "2.0", id: 1 }, // missing method
      { jsonrpc: "2.0", id: true, method: "m" }, // id must be string|number
    ]);
  });

  // RpcId: must be integer (not float/Infinity) or string
  it("RpcId: rejects 1.5, Infinity, boolean; accepts integer and string", () => {
    expect(JsonRpcRequest.parse({ jsonrpc: "2.0", id: 42, method: "m" })).toBeTruthy();
    expect(JsonRpcRequest.parse({ jsonrpc: "2.0", id: "req-1", method: "m" })).toBeTruthy();
    assertRejects(JsonRpcRequest, [
      { jsonrpc: "2.0", id: 1.5, method: "m" },
      { jsonrpc: "2.0", id: Infinity, method: "m" },
      { jsonrpc: "2.0", id: -Infinity, method: "m" },
      { jsonrpc: "2.0", id: true, method: "m" },
    ]);
  });

  it("notification: no id, used for warden->kernel events", () => {
    expect(
      JsonRpcNotification.parse({ jsonrpc: "2.0", method: "warden.event", params: {} }),
    ).toBeTruthy();
    assertRoundTrips(JsonRpcNotification);
    assertRejects(JsonRpcNotification, [...JUNK, { jsonrpc: "2.0", id: 1, method: "m" }]); // id not allowed
  });

  it("success response carries result; error response carries a typed error", () => {
    expect(
      JsonRpcSuccessResponse.parse({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
    ).toBeTruthy();
    assertRoundTrips(JsonRpcSuccessResponse);
    assertRoundTrips(JsonRpcErrorResponse);
    assertRoundTrips(JsonRpcError);
    assertRejects(JsonRpcErrorResponse, [
      ...JUNK,
      { jsonrpc: "2.0", id: 1, error: { message: "x" } }, // error.code (number) required
      { jsonrpc: "2.0", id: 1, error: { code: 1 } }, // error.message required
    ]);
  });

  // I1: ErrorCode forward-tolerant — wire accepts unknown codes as opaque strings
  it("JsonRpcError.data.code: accepts known ErrorCode and unknown future string; rejects empty string", () => {
    expect(
      JsonRpcError.parse({
        code: -32000,
        message: "policy tampered",
        data: { code: "POLICY_PACK_TAMPERED" },
      }),
    ).toBeTruthy();
    expect(
      JsonRpcError.parse({
        code: -32001,
        message: "future error",
        data: { code: "FUTURE_UNKNOWN_CODE" },
      }),
    ).toBeTruthy();
    assertRejects(JsonRpcError, [
      { code: -32000, message: "x", data: { code: "" } }, // empty string rejected
      { code: -32000, message: "x", data: { code: 42 } }, // number not a code
    ]);
  });

  // Wire round-trips for envelope types
  it("envelope schemas wire round-trip", () => {
    assertWireRoundTrips(JsonRpcRequest);
    assertWireRoundTrips(JsonRpcNotification);
    assertWireRoundTrips(JsonRpcError);
  });
});
