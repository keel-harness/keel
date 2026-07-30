import { z } from "zod";
import { DateOnly, MemId, SessionId } from "../common/formats.js";

export const MemoryCategory = z.enum([
  "project-fact",
  "preference",
  "decision",
  "environment",
  "procedural",
]);
export type MemoryCategoryT = z.infer<typeof MemoryCategory>;

export const MemoryState = z.enum(["active", "superseded", "redacted"]);
export type MemoryStateT = z.infer<typeof MemoryState>;

export const MemoryConfidence = z.enum(["stated", "inferred"]);
export type MemoryConfidenceT = z.infer<typeof MemoryConfidence>;

/** YAML frontmatter on a vault entry (MASTER_SPEC Appendix C). Not frozen. */
export const MemoryFrontmatter = z
  .object({
    id: MemId,
    category: MemoryCategory,
    valid_from: DateOnly,
    valid_until: DateOnly.nullable(),
    invalidated_by: MemId.nullable(),
    state: MemoryState,
    entities: z.array(z.string()),
    source_session: SessionId,
    confidence: MemoryConfidence,
    occurrences: z.number().int().min(1),
  })
  .strict()
  .superRefine((data, ctx) => {
    // When both bounds are present, valid_until must be on or after valid_from.
    // YYYY-MM-DD lexicographic order is equivalent to calendar order.
    if (data.valid_until !== null && data.valid_until < data.valid_from) {
      ctx.addIssue({
        code: "custom",
        path: ["valid_until"],
        message: `valid_until (${data.valid_until}) must be >= valid_from (${data.valid_from})`,
      });
    }
  });
export type MemoryFrontmatterT = z.infer<typeof MemoryFrontmatter>;
