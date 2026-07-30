import { z } from "zod";
import { IsoTimestamp } from "../common/formats.js";

/**
 * §4.7 Context-lifecycle schemas (ADR-0025). The structured `TaskState` is the schema-driven (not
 * prose-only) task summary that is always in active context and validated against the ledger; the
 * factual parts (files read/modified, test state) are DERIVED from the ledger, never invented.
 *
 * These are internal `@keel/shared` schemas, NOT a frozen cross-process protocol (ADR-0025 non-goal)
 * — refined as Epic 1.6b lands. `TrustLevel` is the SINGLE source shared with the Phase-3 provenance
 * work (ADR-0010): the format carries taint now; enforcement is Phase 3.
 */

/** Provenance/taint level. `unknown` is the fail-closed default (treated as untrusted; §4.7.8). */
export const TrustLevel = z.enum(["user", "workspace", "untrusted", "mixed", "unknown"]);
export type TrustLevelT = z.infer<typeof TrustLevel>;

/** A reference to a persisted tool artifact whose raw body lives outside active context (§4.7 D). */
export const ArtifactRef = z
  .object({
    artifactId: z.string().min(1),
    toolCallId: z.string().min(1).optional(),
    type: z.enum([
      "file_read",
      "command_output",
      "test_output",
      "search_result",
      "diff",
      "fetch_result",
      "other",
    ]),
    summary: z.string(),
    sha256: z.string().optional(),
    truncated: z.boolean().optional(),
    trust: TrustLevel.optional(),
  })
  .strict();
export type ArtifactRefT = z.infer<typeof ArtifactRef>;

export const FileState = z
  .object({
    path: z.string().min(1),
    status: z.enum(["read", "modified", "created", "deleted", "unknown"]),
    summary: z.string(),
    artifactRefs: z.array(z.string()),
    trust: TrustLevel.optional(),
  })
  .strict();
export type FileStateT = z.infer<typeof FileState>;

export const TestState = z
  .object({
    command: z.string().min(1),
    status: z.enum(["passed", "failed", "not_run", "skipped", "unknown"]),
    summary: z.string(),
    artifactRef: z.string().optional(),
  })
  .strict();
export type TestStateT = z.infer<typeof TestState>;

export const Decision = z
  .object({
    decision: z.string(),
    reason: z.string(),
    evidenceRefs: z.array(z.string()),
    trust: TrustLevel.optional(),
  })
  .strict();
export type DecisionT = z.infer<typeof Decision>;

export const FailedAttempt = z
  .object({
    attempt: z.string(),
    result: z.string(),
    reasonNotContinuing: z.string(),
    artifactRefs: z.array(z.string()),
  })
  .strict();
export type FailedAttemptT = z.infer<typeof FailedAttempt>;

/** A proposed durable-memory entry. Compaction only PROPOSES these; it never writes durable memory
 *  (Epic 3.4 owns writes). Categories mirror §4.7.7 / the Appendix-C taxonomy. */
export const MemoryCandidate = z
  .object({
    content: z.string(),
    type: z.enum([
      "project_fact",
      "procedural",
      "decision",
      "environment_quirk",
      "flaky_test",
      "security_policy",
      "preference",
      "other",
    ]),
    proposedTopic: z.string(),
    evidenceRefs: z.array(z.string()),
    confidence: z.enum(["low", "medium", "high"]),
    proposedScope: z.enum(["session", "repo", "project", "user", "team"]),
    trust: TrustLevel.optional(),
  })
  .strict();
export type MemoryCandidateT = z.infer<typeof MemoryCandidate>;

/** The schema-driven current-task summary (§4.7.7) — always in active context, updated at task
 *  boundaries and around compaction, validated against the ledger (§4.7.6). */
export const TaskState = z
  .object({
    taskGoal: z.string(),
    currentStatus: z.string(),
    currentPhase: z.enum([
      "intake",
      "inspect",
      "plan",
      "edit",
      "test",
      "review",
      "finalize",
      "blocked",
    ]),
    constraints: z.array(z.string()),
    plan: z.array(z.string()),
    completedSteps: z.array(z.string()),
    nextSteps: z.array(z.string()),
    filesRead: z.array(FileState),
    filesModified: z.array(FileState),
    decisions: z.array(Decision),
    failedAttempts: z.array(FailedAttempt),
    testState: z.array(TestState),
    currentErrors: z.array(z.string()),
    blockers: z.array(z.string()),
    artifactRefs: z.array(ArtifactRef),
    policyNotes: z.array(z.string()),
    provenanceNotes: z.array(z.string()),
    memoryCandidates: z.array(MemoryCandidate),
    unresolvedQuestions: z.array(z.string()),
  })
  .strict();
export type TaskStateT = z.infer<typeof TaskState>;

/**
 * The auditable record a compaction emits (§4.7.4 step 8). `trust` is the MAX taint of the summary's
 * inputs (§4.7.8 — a summary is never less tainted than its sources; Phase 1 has no taint tracking,
 * so the fail-closed `unknown` is recorded until Phase 3/ADR-0010 computes the real max). A member of
 * the `SessionEvent` ledger union (Epic 1.6b slice 6) — recorded by the runner when it folds context;
 * `rebuild` treats it as metadata, never a conversation message, so the full history is preserved.
 */
export const CompactionEvent = z
  .object({
    type: z.literal("compaction"),
    v: z.literal(1),
    compactionId: z.string().min(1),
    ts: IsoTimestamp,
    inputRange: z
      .object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() })
      .strict(),
    summaryHash: z.string(),
    artifactRefs: z.array(z.string()),
    tokensBefore: z.number().int().nonnegative(),
    tokensAfter: z.number().int().nonnegative(),
    trigger: z.enum([
      "task_boundary",
      "token_soft",
      "token_hard",
      "manual",
      "phase_change",
      "pre_risky_write",
      "pre_fork",
      "resume",
    ]),
    /** The compactor model/version, recorded per event (OQ-10 tunable). */
    compactorModel: z.string().optional(),
    validation: z.enum(["passed", "repaired", "failed"]),
    probesPassed: z.boolean(),
    trust: TrustLevel,
  })
  .strict();
export type CompactionEventT = z.infer<typeof CompactionEvent>;

/** The deterministic compressors the pre-fold tier (Epic 1.6c) can apply (ADR-0045). */
export const CompressorKind = z.enum(["log", "search", "generic"]);
export type CompressorKindT = z.infer<typeof CompressorKind>;

/**
 * The auditable record the DETERMINISTIC content-aware compression tier emits (ADR-0045) — distinct
 * from `CompactionEvent` (the lossy model fold) so the two operations stay distinguishable in the
 * ledger. It records that aged tool-result bodies were mechanically compressed in place before the
 * fold; the FULL output stays in the session ledger, so this is audit metadata, not a history
 * rewrite (SEC-023: compress the view, never the record). `rebuild` (resume.ts) skips it, like
 * `CompactionEvent`. `trust` is fail-closed `unknown` in Phase 1 (taint computed in Phase 3 /
 * ADR-0010) — no trust laundering. Per-kind ratios are derivable from `items`, so they are not stored.
 */
export const ContextCompressionEvent = z
  .object({
    type: z.literal("context_compression"),
    v: z.literal(1),
    compressionId: z.string().min(1),
    ts: IsoTimestamp,
    inputRange: z
      .object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() })
      .strict(),
    /** Per rewritten model-visible item: which compressor ran, the tool/surface, and the char delta.
     *  Initially this covered aged tool-result bodies; Slice 2 also records aged assistant tool-call
     *  argument rewrites as `tool-call-args:<tool>`, without changing the wire shape. */
    items: z.array(
      z
        .object({
          kind: CompressorKind,
          name: z.string().min(1),
          beforeChars: z.number().int().nonnegative(),
          afterChars: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    tokensBefore: z.number().int().nonnegative(),
    tokensAfter: z.number().int().nonnegative(),
    /** The deterministic tier fires at the soft/hard token boundary (mirrors the fold's gating). */
    trigger: z.enum(["token_soft", "token_hard"]),
    trust: TrustLevel,
  })
  .strict();
export type ContextCompressionEventT = z.infer<typeof ContextCompressionEvent>;
