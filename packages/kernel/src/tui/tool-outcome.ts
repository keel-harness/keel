import type { UiToolActivity } from "@keel/shared";
import { toolPresentationOutcome } from "../tool-presentation-outcome.js";

export type ToolOutcome =
  | "running"
  | "done"
  | "limited"
  | "partial"
  | "review"
  | "blocked"
  | "skipped"
  | "stopped"
  | "failed";

/** Classifies only typed tool/control-plane state. Assistant prose never enters this boundary. */
export function toolOutcome(item: UiToolActivity): ToolOutcome {
  if (item.status === "running") return "running";
  return toolPresentationOutcome(item) ?? (item.status === "ok" ? "done" : "failed");
}
