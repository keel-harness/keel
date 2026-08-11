import type { ToolSpecT } from "@keel/shared";
import {
  GITHUB_PR_CREATE_CAPABILITY_V1,
  GITHUB_PR_CREATE_TOOL_NAME,
} from "../github-pr-create-projection.js";

export { GITHUB_PR_CREATE_CAPABILITY_V1, GITHUB_PR_CREATE_TOOL_NAME };

/**
 * ADR-0091 GitHub-only model projection. The Warden independently validates every field, resolves
 * repository identity, presents the complete request, and owns the once-only REST mutation.
 */
export const SPEC: ToolSpecT = {
  name: GITHUB_PR_CREATE_TOOL_NAME,
  description:
    "Request creation of one pull request in the exact GitHub repository for an already-pushed " +
    "branch and full commit OID. Requires a separate human once-only approval. This tool does not " +
    "merge, auto-merge, label, review, release, deploy, or mutate a Git branch.",
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
      repository: {
        type: "string",
        minLength: 3,
        maxLength: 140,
        description: "Exact same-repository GitHub owner/name identity.",
      },
      head: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "Exact already-pushed source branch name.",
      },
      expectedHead: {
        type: "string",
        pattern: "^[0-9a-f]{40}$",
        description: "Exact full lowercase SHA-1 OID expected at the pushed head branch.",
      },
      base: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "Exact existing destination branch name.",
      },
      title: { type: "string", minLength: 1, maxLength: 256 },
      body: { type: "string", maxLength: 1_536 },
      draft: { type: "boolean" },
      maintainerCanModify: { type: "boolean" },
    },
    required: [
      "remote",
      "repository",
      "head",
      "expectedHead",
      "base",
      "title",
      "body",
      "draft",
      "maintainerCanModify",
    ],
    additionalProperties: false,
  },
};
