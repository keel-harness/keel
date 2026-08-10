import type { ToolSpecT } from "@keel/shared";
import { GIT_PUSH_CAPABILITY_V1, GIT_PUSH_TOOL_NAME } from "../git-push-projection.js";

export { GIT_PUSH_CAPABILITY_V1, GIT_PUSH_TOOL_NAME };

/**
 * ADR-0091 model projection. The spawned Warden independently parses, binds, reviews, and executes
 * the request; this schema is guidance and provider compatibility only.
 */
export const SPEC: ToolSpecT = {
  name: GIT_PUSH_TOOL_NAME,
  description:
    "Request one exact create-or-fast-forward Git branch publication through the keel Warden. " +
    "Requires the current full commit object ID and a human once-only approval. Force, deletion, " +
    "tags, hooks, redirects, submodule recursion, and default-branch writes remain blocked.",
  parameters: {
    type: "object",
    properties: {
      remote: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
        description: "Exact repository-local remote name.",
      },
      branch: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "Exact short destination branch name. The Warden validates Git ref grammar.",
      },
      expectedHead: {
        type: "string",
        pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
        description: "Exact full lowercase commit object ID currently at local HEAD.",
      },
    },
    required: ["remote", "branch", "expectedHead"],
    additionalProperties: false,
  },
};
