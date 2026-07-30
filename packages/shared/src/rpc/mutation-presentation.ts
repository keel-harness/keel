import { z } from "zod";
import { SessionId, Sha256 } from "../common/formats.js";
import { AuditSeq } from "./primitives.js";

/** Protocol-1.1 mutation-presentation capability identifier (ADR-0078). */
export const MUTATION_PRESENTATION_CAPABILITY_V1 = "mutation-presentation/v1" as const;

export const MutationPresentationSegmentV1 = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), text: z.string() }).strict(),
  z.object({ kind: z.literal("redacted") }).strict(),
]);
export type MutationPresentationSegmentV1T = z.infer<typeof MutationPresentationSegmentV1>;

export const MutationPresentationTextV1 = z
  .object({
    segments: z.array(MutationPresentationSegmentV1),
    redactionCount: z.number().int().nonnegative(),
  })
  .strict();
export type MutationPresentationTextV1T = z.infer<typeof MutationPresentationTextV1>;

const FullyInspectedRegularFileImageV1 = z
  .object({
    status: z.literal("file-observed"),
    sha256: Sha256,
    bytes: z.number().int().nonnegative(),
    mode: z.number().int().min(0).max(0o777),
    contentClass: z.enum(["text", "binary"]),
    finalNewline: z.boolean(),
  })
  .strict();

export const MutationPresentationObservedBeforeV1 = z.discriminatedUnion("status", [
  FullyInspectedRegularFileImageV1,
  z.object({ status: z.literal("absent-observed") }).strict(),
  z.object({ status: z.literal("not-inspected") }).strict(),
]);
export type MutationPresentationObservedBeforeV1T = z.infer<
  typeof MutationPresentationObservedBeforeV1
>;

export const MutationPresentationVerifiedInstalledAfterV1 = FullyInspectedRegularFileImageV1;
export type MutationPresentationVerifiedInstalledAfterV1T = z.infer<
  typeof MutationPresentationVerifiedInstalledAfterV1
>;

const ExactOrUnknownCountV1 = z.number().int().nonnegative().or(z.literal("unknown"));

const ComparisonLineTextV1 = {
  segments: z.array(MutationPresentationSegmentV1),
  redactionCount: z.number().int().nonnegative(),
} as const;

export const MutationPresentationComparisonLineV1 = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("context"),
      observedBeforeLine: z.number().int().positive(),
      installedAfterLine: z.number().int().positive(),
      ...ComparisonLineTextV1,
    })
    .strict(),
  z
    .object({
      kind: z.literal("observed-before"),
      observedBeforeLine: z.number().int().positive(),
      ...ComparisonLineTextV1,
    })
    .strict(),
  z
    .object({
      kind: z.literal("installed-after"),
      installedAfterLine: z.number().int().positive(),
      ...ComparisonLineTextV1,
    })
    .strict(),
]);
export type MutationPresentationComparisonLineV1T = z.infer<
  typeof MutationPresentationComparisonLineV1
>;

export const MutationPresentationHunkV1 = z
  .object({
    observedBeforeStart: z.number().int().nonnegative(),
    observedBeforeLines: z.number().int().nonnegative(),
    installedAfterStart: z.number().int().nonnegative(),
    installedAfterLines: z.number().int().nonnegative(),
    lines: z.array(MutationPresentationComparisonLineV1),
  })
  .strict();
export type MutationPresentationHunkV1T = z.infer<typeof MutationPresentationHunkV1>;

export const MutationPresentationComparisonV1 = z
  .object({
    coverage: z.enum(["complete", "truncated", "summary-only", "unknown"]),
    totals: z
      .object({
        observedBeforeLines: ExactOrUnknownCountV1,
        installedAfterLines: ExactOrUnknownCountV1,
        shownLines: ExactOrUnknownCountV1,
        hiddenLines: ExactOrUnknownCountV1,
      })
      .strict(),
    hunks: z.array(MutationPresentationHunkV1),
    redactionCount: z.number().int().nonnegative(),
  })
  .strict();
export type MutationPresentationComparisonV1T = z.infer<typeof MutationPresentationComparisonV1>;

/** Strict, versioned, JSON-safe presentation artifact. It is a UI carrier, not audit evidence. */
export const MutationPresentationV1 = z
  .object({
    schemaVersion: z.literal(MUTATION_PRESENTATION_CAPABILITY_V1),
    producer: z.literal("warden-typed-mutation"),
    operation: z.enum(["write", "edit"]),
    auditSeq: AuditSeq,
    displayPath: MutationPresentationTextV1,
    pathIdentity: z.string().min(1),
    observedBefore: MutationPresentationObservedBeforeV1,
    verifiedInstalledAfter: MutationPresentationVerifiedInstalledAfterV1,
    transitionBinding: z.literal("not-atomic"),
    concurrentMutation: z.literal("not-excluded"),
    comparison: MutationPresentationComparisonV1,
    freshness: z
      .object({
        basis: z.literal("warden-observation"),
        currentWorkspace: z.literal("not-observed"),
      })
      .strict(),
  })
  .strict();
export type MutationPresentationV1T = z.infer<typeof MutationPresentationV1>;

export const MutationPresentationTakeParamsV1 = z
  .object({
    sessionId: SessionId,
    toolCallId: z.string().min(1),
    auditSeq: AuditSeq,
  })
  .strict();
export type MutationPresentationTakeParamsV1T = z.infer<typeof MutationPresentationTakeParamsV1>;

export const MutationPresentationUnavailableReasonV1 = z.enum([
  "not-found-or-consumed",
  "capture-unavailable",
  "capture-budget",
  "redaction-failed",
]);
export type MutationPresentationUnavailableReasonV1T = z.infer<
  typeof MutationPresentationUnavailableReasonV1
>;

export const MutationPresentationTakeResultV1 = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), artifact: MutationPresentationV1 }).strict(),
  z
    .object({ status: z.literal("pending"), retryAfterMs: z.number().int().min(1).max(25) })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reason: MutationPresentationUnavailableReasonV1,
    })
    .strict(),
]);
export type MutationPresentationTakeResultV1T = z.infer<typeof MutationPresentationTakeResultV1>;
