import { z } from "zod";
import { FinishReason, IsoTimestamp, ModelRole, ModelUsage } from "@keel/shared";

/**
 * One recorded event in a run. The union is rich enough that EVERY §8.2 trajectory-quality metric
 * derives from it with no rework:
 * - tool-call & argument-validity rate → `tool-call.argsValid`
 * - redundant/duplicate reads → `tool-call.name` + `tool-call.args`
 * - error→recovery rate → `tool-result.ok` + the events that follow it
 * - premature-completion intercepts → `completion-attempt.intercepted`
 * - context-window pollution → `compaction` (before/after tokens) + `turn.usage` growth between
 *   compactions
 * - mean tool-calls / wall-clock / tokens → `turn.usage` + `turn.wallClockMs` (+ `totals`)
 *
 * P0 NOTE (measured-not-asserted): simulator-driven P0 trajectories record `argsValid: true`
 * (scripted args are valid by construction — a real per-tool arg validator lands in Phase 1),
 * `wallClockMs: 0` (no real clock), and `inputTokens: 0` (the simulator models output usage only;
 * real prompt-token accounting arrives with providers in Phase 1 — the P0 scoreboard must not read
 * `totals.inputTokens` as a measured value). The schema permits real values, so Phase 1 fills them
 * in with zero rework; the P0 scoreboard must not read these stubbed fields as if measured.
 */
export const TrajectoryEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), role: ModelRole, content: z.string() }).strict(),
  z.object({ type: z.literal("assistant-text"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("tool-call"),
      id: z.string().min(1),
      name: z.string().min(1),
      args: z.record(z.string(), z.unknown()),
      argsValid: z.boolean(), // P0: always true (scripted args valid); real validator in Phase 1
    })
    .strict(),
  z
    .object({
      type: z.literal("tool-result"),
      id: z.string().min(1),
      ok: z.boolean(),
      content: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("turn"),
      index: z.number().int().nonnegative(),
      reason: FinishReason,
      usage: ModelUsage,
      wallClockMs: z.number().int().nonnegative(), // P0: 0 (no real clock); real timings in Phase 1
    })
    .strict(),
  z
    .object({
      type: z.literal("completion-attempt"),
      accepted: z.boolean(),
      intercepted: z.boolean(),
    })
    .strict(),
  // Context-discipline boundary (Phase 1, Epic 1.5). Recording the context size before/after a
  // compaction is what makes the §8.2 "context-window pollution" metric computable without rework.
  // P0 simulator replay never compacts, so it emits none; the variant exists so Phase 1 needs no
  // schema change.
  z
    .object({
      type: z.literal("compaction"),
      beforeTokens: z.number().int().nonnegative(),
      afterTokens: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type TrajectoryEventT = z.infer<typeof TrajectoryEvent>;

/** Aggregate totals for a run (cheap to recompute; stored for scoreboard convenience). */
const TrajectoryTotals = z
  .object({
    turns: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    wallClockMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();

/**
 * A full raw run trajectory (§2.3 iteration-loop substrate). `schemaVersion` is pinned to 1 so a
 * format change is explicit. `wallClockMs` is 0 for P0 simulator-driven trajectories (no real
 * clock; real timings arrive with providers in Phase 1).
 */
export const Trajectory = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    task: z.string().min(1),
    suite: z.string().min(1),
    model: z.string().min(1),
    startedAt: IsoTimestamp,
    events: z.array(TrajectoryEvent),
    outcome: z.enum(["resolved", "unresolved", "infra-error"]),
    totals: TrajectoryTotals,
  })
  .strict();
export type TrajectoryT = z.infer<typeof Trajectory>;
