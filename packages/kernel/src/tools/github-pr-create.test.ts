import { describe, expect, it } from "vitest";
import {
  GITHUB_PR_CREATE_CAPABILITY_V1,
  GITHUB_PR_CREATE_TOOL_NAME,
  SPEC,
} from "./github-pr-create.js";

describe("github.pr.create model projection", () => {
  it("projects the exact GitHub-only, separately approved request", () => {
    expect(GITHUB_PR_CREATE_TOOL_NAME).toBe("github.pr.create");
    expect(GITHUB_PR_CREATE_CAPABILITY_V1).toBe("github-pr-create/v1");
    expect(SPEC.name).toBe(GITHUB_PR_CREATE_TOOL_NAME);
    expect(SPEC.parameters).toMatchObject({
      type: "object",
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
    });
    expect(SPEC.description).toContain("separate human once-only approval");
    expect(SPEC.description).toContain("does not merge");
  });
});
