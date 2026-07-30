import { z } from "zod";
import { JsonObject } from "../common/json.js";

/** Events the KERNEL submits to the warden via `warden.audit.append`. (The full
 *  audit record, incl. tool.execute/deny etc. written by the warden itself, is
 *  Appendix B / Plan 2b.) */
export const KernelAuditEventType = z.enum([
  "session.start",
  "session.end",
  "memory.accept",
  "memory.decline",
  "mode.change",
]);
export type KernelAuditEventTypeT = z.infer<typeof KernelAuditEventType>;

export const KernelAuditEvent = z
  .object({
    eventType: KernelAuditEventType,
    // JsonObject (not z.record(z.unknown())) so the payload is JSON-safe — no NaN/±Infinity/undefined/
    // bigint can cross the warden wire or corrupt a hash-over-canonical-JSON once this becomes
    // audit-chain content (SCH-1 / ADR-0061), matching AuditRecord.payload.
    payload: JsonObject,
  })
  .strict();
export type KernelAuditEventT = z.infer<typeof KernelAuditEvent>;

/** Async warden->kernel notifications (carried as `warden.event` params). */
export const WardenEventType = z.enum(["proxy.denied", "checkpoint.written"]);
export type WardenEventTypeT = z.infer<typeof WardenEventType>;

export const WardenEvent = z
  .object({
    eventType: WardenEventType,
    payload: JsonObject, // JSON-safe payload (SCH-1 / ADR-0061), as for KernelAuditEvent
  })
  .strict();
export type WardenEventT = z.infer<typeof WardenEvent>;
