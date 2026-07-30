import { describe, expect, it } from "vitest";
import { JUNK, assertRejects, assertWireRoundTrips } from "../testing/property.js";
import { KernelAuditEvent, KernelAuditEventType, WardenEvent, WardenEventType } from "./events.js";

describe("RPC event payloads", () => {
  it("KernelAuditEvent: kernel-side event types only", () => {
    expect(KernelAuditEventType.options).toEqual([
      "session.start",
      "session.end",
      "memory.accept",
      "memory.decline",
      "mode.change",
    ]);
    expect(
      KernelAuditEvent.parse({ eventType: "session.start", payload: { sessionId: "s1" } }),
    ).toBeTruthy();
    // SCH-1: the payload becomes audit-chain content, so it must be JSON-safe (no NaN/Infinity/
    // undefined/bigint that would corrupt a hash-over-canonical-JSON). assertWireRoundTrips is the
    // executable proof; the prior assertRoundTrips passed trivially with the old z.unknown() field.
    assertWireRoundTrips(KernelAuditEvent);
    assertRejects(KernelAuditEvent, [
      ...JUNK,
      { eventType: "tool.execute", payload: {} }, // not a kernel-side event
      { eventType: "session.start" }, // missing payload
      { eventType: "session.start", payload: { x: NaN } }, // JSON-unsafe value rejected
      { eventType: "session.start", payload: { x: Infinity } },
      { eventType: "session.start", payload: { x: undefined } },
    ]);
  });

  it("WardenEvent: async warden->kernel surfaces", () => {
    expect(WardenEventType.options).toEqual(["proxy.denied", "checkpoint.written"]);
    expect(
      WardenEvent.parse({ eventType: "checkpoint.written", payload: { seq: 128 } }),
    ).toBeTruthy();
    assertWireRoundTrips(WardenEvent);
    assertRejects(WardenEvent, [
      ...JUNK,
      { eventType: "nope", payload: {} },
      { eventType: "proxy.denied", payload: { x: NaN } }, // JSON-unsafe value rejected
    ]);
  });
});
