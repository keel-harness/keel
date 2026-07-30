import type { z } from "zod";

/** Tool guidance microcopy (charter §6.4 — microcopy is a product surface). */

/** Render a zod validation failure as one clean, model-facing line (never a raw multi-line dump). */
export function badArgsMessage(toolName: string, error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue && issue.path.length > 0 ? `'${issue.path.join(".")}'` : "arguments";
  const why = issue?.message ?? "invalid arguments";
  return `tool '${toolName}': invalid ${where} — ${why}`;
}

/** Safely extract a human-readable message from an unknown thrown value. */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
}
