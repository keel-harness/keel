import type { ToolSpecT } from "@keel/shared";
import {
  PROCESS_RUN_CAPABILITY_V1,
  PROCESS_RUN_TOOL_NAME,
  renderProcessRunArgv,
} from "../process-run-projection.js";

export { PROCESS_RUN_CAPABILITY_V1, PROCESS_RUN_TOOL_NAME, renderProcessRunArgv };

/**
 * Model-facing projection for the governed argv-only process surface. The spawned Warden remains
 * the independent parser and enforcement authority; this schema is provider guidance, not trust.
 */
export const SPEC: ToolSpecT = {
  name: PROCESS_RUN_TOOL_NAME,
  description:
    "Run one executable directly through the spawned keel warden, passing each argv entry as " +
    "literal data without shell parsing. Prefer this for one build, test, check, or other direct " +
    "process invocation. Use bash for deliberate shell composition or persistent shell state. " +
    "Policy, sandbox availability, and audit are enforced by the warden.",
  parameters: {
    type: "object",
    properties: {
      argv: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: { type: "string", maxLength: 1024 },
        description:
          "Exact executable and arguments. Each entry is passed as literal data without shell interpretation.",
      },
    },
    required: ["argv"],
    additionalProperties: false,
  },
};
