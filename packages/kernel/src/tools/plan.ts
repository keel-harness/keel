import { z } from "zod";
import type { JsonObjectT } from "@keel/shared";
import { parseArgs } from "./args.js";
import { staticCapability, type CoreTool } from "./registry.js";

/** The tool name — referenced by the compactor to preserve the latest ledger verbatim (§4.7.2). */
export const PLAN_TOOL_NAME = "plan";

/** A single task-ledger item: what it is + where it stands (§4.9.7). */
export const PlanItem = z
  .object({ text: z.string().min(1), status: z.enum(["done", "current", "pending"]) })
  .strict();
export type PlanItemT = z.infer<typeof PlanItem>;

export const PlanArgs = z.object({ items: z.array(PlanItem).min(1) }).strict();

/** Status → the §4.9.7 glyph: done ✓, current →, pending □. */
const GLYPH: Record<PlanItemT["status"], string> = { done: "✓", current: "→", pending: "□" };

/** Render the ledger exactly as §4.9.7 shows it — a `Plan` header then one glyphed line per item.
 *  Deterministic: this exact string is what compaction preserves verbatim. */
export function renderLedger(items: readonly PlanItemT[]): string {
  return ["Plan", ...items.map((i) => `${GLYPH[i.status]} ${i.text}`)].join("\n");
}

export const SPEC = {
  name: PLAN_TOOL_NAME,
  description:
    "Record and update your task ledger — the ordered list of steps with status (done · current · " +
    "pending). Call it as your plan forms and after each step changes state; send the FULL current " +
    "list each time (it replaces the previous ledger). The ledger is your attention anchor: it stays " +
    "visible and is preserved verbatim across context compaction, so a long task does not lose its plan.",
  // Model-facing JSON Schema — mirrors `PlanArgs` (the drift-guard test asserts the two agree).
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        minItems: 1,
        description: "The full current task list, in order.",
        items: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, description: "What the step is." },
            status: {
              type: "string",
              enum: ["done", "current", "pending"],
              description: "Where the step stands.",
            },
          },
          required: ["text", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
} as const;

/**
 * The in-session task ledger tool (§4.9.7 / §8.6 plan-todo visibility). A side-effect-free attention
 * anchor: the model sends its full ordered plan, and the rendered ledger becomes the tool result —
 * which is persisted in the session ledger (resume-safe) and preserved verbatim across compaction: the
 * deterministic pass NEVER compresses the latest plan body (`compress/pass.ts`), and `compact()` then
 * re-pins that verbatim ledger, so the plan survives a long, compacting session. Stateless: the latest
 * call's content IS the current ledger (full-list replace, like a progress artifact) — older snapshots
 * are superseded by the next full list, so only the latest is preserved verbatim (which is the live one).
 */
export function createPlanTool(): CoreTool {
  const handler = (raw: JsonObjectT): string => {
    const args = parseArgs(PLAN_TOOL_NAME, PlanArgs, raw);
    return renderLedger(args.items);
  };
  return { spec: SPEC, handler, staticCapability: staticCapability(SPEC.name, ["fs_read"]) };
}
