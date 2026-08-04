import { z } from "zod";
import { IsoTimestamp, SessionId } from "../common/formats.js";
import { ToolCall, Verdict } from "../rpc/primitives.js";
import { ModelUsage } from "../ports/model-port.js";
import { CompactionEvent, ContextCompressionEvent } from "../context/task-state.js";
import { Goal, GoalCompletionAudit } from "../run/goal.js";
import { ModelRoutingDecision } from "../model-routing/schema.js";

/** The conversation/message event types (NOT frozen — refined as sessions evolve).
 *  Metadata events (session_meta, run_status, and later steering) are envelope records,
 *  not members of this taxonomy. tool_call is folded into assistant.toolCalls (Epic 1.4). */
export const SessionEventType = z.enum(["user", "assistant", "tool_result", "system"]);
export type SessionEventTypeT = z.infer<typeof SessionEventType>;

/**
 * Why the agent loop stopped. Shared (not kernel-local) so both the kernel's live
 * `KernelEvent` and the durable `run_status` ledger event speak one vocabulary; the
 * kernel re-exports it for back-compat. (Distinct from the provider-level `FinishReason`.)
 */
export const StopReason = z.enum([
  "model-stop",
  "max-turns",
  "budget",
  "aborted",
  "error",
  "loop-detected",
  "length",
  // Wall-clock run budget exceeded (ADR-0051 / Lever C) — a graceful self-stop before an external hard
  // cap. Distinct from `budget` (tokens) and `aborted` (caller cancel) so the durable record stays honest.
  "deadline",
]);
export type StopReasonT = z.infer<typeof StopReason>;

/**
 * Per-record schema version field (ADR-0008). Every SessionEvent variant carries
 * `v: 1` so consumers can evolve the format in a backward-compatible way without
 * inspecting the `type` discriminant to guess the version.
 */
const schemaVersion = z.literal(1);

/** Explicit, task-scoped terminal-answer bound (ADR-0087). This is presentation authority only;
 * it does not change provider, tool, Warden, or task-success authority. */
export const FinalAnswerContract = z
  .object({
    version: z.literal(1),
    maxWords: z.number().int().min(40).max(2_000),
  })
  .strict();
export type FinalAnswerContractT = z.infer<typeof FinalAnswerContract>;

/** Durable identity for one message in a controller-owned final-answer settlement transaction. */
export const FinalAnswerOccurrence = z.discriminatedUnion("kind", [
  z
    .object({
      settlementId: z.string().min(1).max(128),
      kind: z.literal("attempt"),
      attempt: z.enum(["original", "rewrite"]),
      contract: FinalAnswerContract,
    })
    .strict(),
  z
    .object({
      settlementId: z.string().min(1).max(128),
      kind: z.literal("rewrite-prompt"),
      contract: FinalAnswerContract,
    })
    .strict(),
]);
export type FinalAnswerOccurrenceT = z.infer<typeof FinalAnswerOccurrence>;

/** Terminal presentation decision for a settlement. Cumulative run usage remains on run_status;
 * rewriteUsage attributes only the optional second provider request. */
export const FinalAnswerSettlement = z
  .object({
    settlementId: z.string().min(1).max(128),
    outcome: z.enum([
      "accepted-original",
      "accepted-rewrite",
      "fallback-budget",
      "fallback-cancelled",
      "fallback-length",
      "fallback-error",
      "fallback-tool-call",
      "fallback-oversized",
    ]),
    rewriteUsage: ModelUsage.optional(),
  })
  .strict();
export type FinalAnswerSettlementT = z.infer<typeof FinalAnswerSettlement>;

const UserEvent = z
  .object({
    type: z.literal("user"),
    v: schemaVersion,
    ts: IsoTimestamp,
    content: z.string(),
    finalAnswer: FinalAnswerOccurrence.optional(),
  })
  .strict();
/** An assistant turn. `toolCalls` mirrors `ModelMessage.toolCalls` (Epic 1.3 / ADR-0019)
 *  so the durable ledger reconstructs the assistant→tool-result linkage exactly — tool
 *  calls live on their assistant turn, not as standalone events. */
const AssistantEvent = z
  .object({
    type: z.literal("assistant"),
    v: schemaVersion,
    ts: IsoTimestamp,
    content: z.string(),
    toolCalls: z.array(ToolCall).optional(),
    finalAnswer: FinalAnswerOccurrence.optional(),
  })
  .strict();

/**
 * A tool result, mirroring the loop's tool message (`loop.ts`): `output` is the string
 * the executor returned (`ToolResult.output`), `name` is the tool, `isError` = `!ok`.
 * (The Phase-0 stub stored an open `result: JsonValue`; the real executor yields a
 * string, so the ledger records that — refined when sessions landed, per the schema's
 * own note. A structured tool-result payload is a separate later extension.)
 */
const ToolResultEvent = z
  .object({
    type: z.literal("tool_result"),
    v: schemaVersion,
    ts: IsoTimestamp,
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    output: z.string(),
    isError: z.boolean().optional(),
  })
  .strict();
const SystemEvent = z
  .object({
    type: z.literal("system"),
    v: schemaVersion,
    ts: IsoTimestamp,
    content: z.string(),
  })
  .strict();

/**
 * Metadata header — the FIRST line of every session ledger (Epic 1.4). Unlike the
 * conversation events above it carries `createdAt` (not `ts`): it is the file header,
 * not a turn. `parent` records branch lineage (the source session + the fork index)
 * for `keel sessions branch`. Not a `SessionEventType` member — it is an envelope
 * record, distinct from the conversation/message taxonomy.
 */
const SessionMetaEvent = z
  .object({
    type: z.literal("session_meta"),
    v: schemaVersion,
    id: SessionId,
    createdAt: IsoTimestamp,
    cwd: z.string(),
    /** A one-way SHA-256 of the launch cwd (ADR-0054) — the STABLE, collision-free workspace identity
     *  used to scope `keel --continue` to sessions started in the SAME directory. Optional for backward
     *  compatibility: ledgers written before this field omit it (and are not `--continue`-resumable, only
     *  by explicit `--resume <id>`). Distinct from `cwd`, which is redacted (SEC-014) hence lossy — deep
     *  paths collapse under the high-entropy net to one literal, so `cwd` must NOT be used as an identity
     *  key. The hash never reveals the path and survives the redaction filter intact as plain hex. */
    cwdHash: z.string().optional(),
    parent: z
      .object({ id: SessionId, atIndex: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict();

/** Run-lifecycle metadata, recorded once per run on completion: why the loop stopped
 *  and the cumulative usage. Optional `code`/`message` mirror terminal stop detail when available
 *  (provider error codes for `error`, or non-error recovery detail); older ledgers omit them.
 *  Lets resume report finished/lastStop/usage without heuristics.
 *  Not a conversation message (excluded from the rebuilt message history). */
const RunStatusEvent = z
  .object({
    type: z.literal("run_status"),
    v: schemaVersion,
    ts: IsoTimestamp,
    reason: StopReason,
    code: z.string().optional(),
    message: z.string().optional(),
    usage: ModelUsage,
    finalAnswer: FinalAnswerSettlement.optional(),
  })
  .strict();

const EXACT_EGRESS_DOMAIN_RE =
  /^(?:(?:[a-z1-9](?:[a-z0-9-]{0,61}[a-z0-9])?|0|0[a-wy-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?|0-(?:[a-z0-9-]{0,60}[a-z0-9]))\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const WardenAutoResolvedResource = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("domain"),
      value: z.string().min(1).max(253).regex(EXACT_EGRESS_DOMAIN_RE, "expected exact domain"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("command-key"),
      value: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    })
    .strict(),
]);

/**
 * Durable kernel-session fact for a warden-reviewed action that was auto-resolved
 * through an already-authorized exact resource. This is not a new warden audit event;
 * it links the session receipt to the authoritative `review.resolved` audit sequence
 * returned by the warden.
 */
const WardenAutoResolvedEvent = z
  .object({
    type: z.literal("warden_auto_resolved"),
    v: schemaVersion,
    ts: IsoTimestamp,
    source: z.enum(["session-grant", "plan-approval", "autopilot-command"]),
    planId: z.string().min(1).optional(),
    resource: WardenAutoResolvedResource,
    reviewId: z.string().min(1),
    scope: z.literal("once"),
    auditSeq: z.number().int().nonnegative(),
    verdict: Verdict,
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
  })
  .strict();

/** Mid-run user input classes (§4.10). */
export const SteeringClass = z.enum(["queued", "interrupt", "urgent"]);
export type SteeringClassT = z.infer<typeof SteeringClass>;

/**
 * A mid-run steering input (§4.10 — keel-internal JSONL, no frozen-schema change). Phase 1
 * PERSISTS these; application (injecting at a safe boundary, setting `insertedAt`/the flags)
 * is Epic 1.5/1.6. A still-pending queued comment = `class === "queued" && insertedAt === null`,
 * so it rehydrates as pending across resume. Field names map §4.10's reserved set to the
 * union's camelCase idiom (`input_id→inputId`, `inserted_at→insertedAt`, etc.; ADR-0035).
 */
const SteeringEvent = z
  .object({
    type: z.literal("steering"),
    v: schemaVersion,
    ts: IsoTimestamp,
    inputId: z.string().min(1),
    class: SteeringClass,
    content: z.string(),
    insertedAt: z.number().int().nonnegative().nullable(),
    changedTaskState: z.boolean(),
    invalidatedPlan: z.boolean(),
  })
  .strict();

const GoalStartedEvent = z
  .object({
    type: z.literal("goal_started"),
    v: schemaVersion,
    ts: IsoTimestamp,
    goal: Goal,
  })
  .strict();

const GoalAuditEvent = z
  .object({
    type: z.literal("goal_audit"),
    v: schemaVersion,
    ts: IsoTimestamp,
    audit: GoalCompletionAudit,
  })
  .strict();

const GoalCompletedEvent = z
  .object({
    type: z.literal("goal_completed"),
    v: schemaVersion,
    ts: IsoTimestamp,
    goalId: z.string().min(1).max(128),
    auditRef: z.string().min(1).max(512),
  })
  .strict();

const GoalFailedEvent = z
  .object({
    type: z.literal("goal_failed"),
    v: schemaVersion,
    ts: IsoTimestamp,
    goalId: z.string().min(1).max(128),
    reason: z.enum(["incomplete", "unverified", "aborted", "error"]),
    auditRef: z.string().min(1).max(512).optional(),
  })
  .strict();

const LoopIterationEvent = z
  .object({
    type: z.literal("loop_iteration"),
    v: schemaVersion,
    ts: IsoTimestamp,
    loopId: z.string().min(1).max(128),
    iteration: z.number().int().positive(),
    status: z.enum(["running", "exit-check-passed", "exit-check-failed", "no-progress"]),
    evidenceRefs: z.array(z.string().min(1).max(512)).max(64),
  })
  .strict();

const LoopStoppedEvent = z
  .object({
    type: z.literal("loop_stopped"),
    v: schemaVersion,
    ts: IsoTimestamp,
    loopId: z.string().min(1).max(128),
    reason: z.enum([
      "succeeded",
      "loop-max-iterations",
      "loop-deadline",
      "loop-budget",
      "loop-no-progress",
      "aborted",
      "error",
    ]),
    iterations: z.number().int().nonnegative(),
    evidenceRefs: z.array(z.string().min(1).max(512)).max(64),
  })
  .strict();

const ModelRouteEvent = z
  .object({
    type: z.literal("model_route"),
    v: schemaVersion,
    ts: IsoTimestamp,
    decision: ModelRoutingDecision,
  })
  .strict();

export const SessionEvent = z.discriminatedUnion("type", [
  UserEvent,
  AssistantEvent,
  ToolResultEvent,
  SystemEvent,
  SessionMetaEvent,
  RunStatusEvent,
  WardenAutoResolvedEvent,
  SteeringEvent,
  GoalStartedEvent,
  GoalAuditEvent,
  GoalCompletedEvent,
  GoalFailedEvent,
  LoopIterationEvent,
  LoopStoppedEvent,
  ModelRouteEvent,
  // §4.7.4 step 8 (ADR-0025): the auditable record that a compaction folded a message range into the
  // typed summary. Like session_meta/run_status it is envelope metadata, NOT a conversation message —
  // `rebuild` (resume.ts) skips it, so the full pre-compaction history stays the source of truth.
  CompactionEvent,
  // Epic 1.6c (ADR-0045): the deterministic content-aware compression record. Like CompactionEvent
  // it is envelope metadata, NOT a conversation message — `rebuild` skips it (the full output stays
  // in the ledger; SEC-023 compress-the-view-not-the-record).
  ContextCompressionEvent,
]);
export type SessionEventT = z.infer<typeof SessionEvent>;

/** The steering variant of the ledger union (§4.10). */
export type SteeringEventT = Extract<SessionEventT, { type: "steering" }>;

/**
 * The session-ledger schema version this keel recognizes (the `v` on every event, ADR-0008). A
 * ledger event carrying a HIGHER `v` was written by a newer keel; an older reader refuses to resume
 * it with an honest upgrade message (ADR-0072 §4), NOT the corruption vocabulary.
 */
export const SESSION_SCHEMA_VERSION = 1;

/** The event-type discriminants this keel understands. An unrecognized `type` is a record variant a
 *  newer keel introduced — the reader must interpret events to resume, so it refuses honestly. */
export const KNOWN_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set(
  SessionEvent.options.map((branch) => branch.shape.type.value),
);

/**
 * Read-tolerant variant of {@link SessionEvent} (ADR-0072 §1): the known fields of a known event
 * type are still validated, but UNKNOWN additive fields are retained instead of rejected, so an
 * older keel resumes a newer keel's ledger rather than calling it corrupt. The session ledger has no
 * hash chain, so retaining vs. dropping an unknown field is immaterial to integrity — the point is to
 * not fail closed on it. The WRITE path keeps the strict {@link SessionEvent}. Version/type gating (a
 * higher `v` or an unknown `type` → honest upgrade) is done by the reader BEFORE this parse; a `v`
 * mismatch or a malformed known field still fails here, so genuine corruption stays caught.
 */
const SessionEventTolerantBase = z.discriminatedUnion(
  "type",
  SessionEvent.options.map((branch) => branch.passthrough()) as unknown as [
    (typeof SessionEvent.options)[number],
    ...(typeof SessionEvent.options)[number][],
  ],
);

/** Invalid ADR-0087 presentation extensions cannot hide or corrupt otherwise-valid message bytes.
 * Normalize only this known optional extension before the existing tolerant base parse; arbitrary
 * unknown additive fields remain retained by each passthrough branch. */
function omitMalformedFinalAnswer(input: unknown): unknown {
  if (typeof input !== "object" || input === null || !("type" in input)) return input;
  const record = input as Record<string, unknown>;
  if (!("finalAnswer" in record)) return input;
  const schema =
    record["type"] === "user" || record["type"] === "assistant"
      ? FinalAnswerOccurrence
      : record["type"] === "run_status"
        ? FinalAnswerSettlement
        : undefined;
  if (schema === undefined || schema.safeParse(record["finalAnswer"]).success) return input;
  const normalized = { ...record };
  delete normalized["finalAnswer"];
  return normalized;
}

export const SessionEventTolerant = Object.assign(
  z.preprocess(omitMalformedFinalAnswer, SessionEventTolerantBase),
  { options: SessionEventTolerantBase.options },
);
