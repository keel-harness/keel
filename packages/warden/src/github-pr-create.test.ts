import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  GITHUB_PR_CREATE_CAPABILITY_V1,
  GITHUB_PR_CREATE_REVIEW_TTL_MS,
  GITHUB_PR_CREATE_TOOL_NAME,
  GithubPrCreateInvalidParamsError,
  escapeGithubReviewText,
  githubPrCreateCapabilityAvailable,
  githubPrCreateReviewSummary,
  parseGithubPrCreateRequest,
} from "./github-pr-create.js";

const oid = "1".repeat(40);

const validArgs = {
  remote: "origin",
  repository: "keel-harness/keel",
  head: "feature/github-pr",
  expectedHead: oid,
  base: "main",
  title: "feat: governed PR creation",
  body: "Complete body\n\n- exact",
  draft: true,
  maintainerCanModify: false,
};

describe("github.pr.create strict contract", () => {
  it("freezes the distinct tool, capability, and once-only TTL", () => {
    expect(GITHUB_PR_CREATE_TOOL_NAME).toBe("github.pr.create");
    expect(GITHUB_PR_CREATE_CAPABILITY_V1).toBe("github-pr-create/v1");
    expect(GITHUB_PR_CREATE_REVIEW_TTL_MS).toBe(120_000);
  });

  it("accepts only the exact bounded same-repository request", () => {
    expect(parseGithubPrCreateRequest(validArgs)).toEqual(validArgs);
    for (const invalid of [
      { ...validArgs, extra: true },
      { ...validArgs, remote: 7 },
      { ...validArgs, remote: ".hidden" },
      { ...validArgs, repository: 7 },
      { ...validArgs, repository: "https://github.com/keel-harness/keel" },
      { ...validArgs, repository: "keel-harness/keel/extra" },
      { ...validArgs, repository: `${"o".repeat(40)}/repo` },
      { ...validArgs, repository: "keel-harness/." },
      { ...validArgs, repository: "keel-harness/.." },
      { ...validArgs, repository: "keel-harness/-keel" },
      { ...validArgs, repository: "keel-harness/keel." },
      { ...validArgs, head: 7 },
      { ...validArgs, head: "HEAD" },
      { ...validArgs, head: "@" },
      { ...validArgs, head: "refs/heads/feature" },
      { ...validArgs, head: "feature..hidden" },
      { ...validArgs, head: "feature.lock" },
      { ...validArgs, head: "feature@{1}" },
      { ...validArgs, head: ".feature" },
      { ...validArgs, head: "feature." },
      { ...validArgs, head: "feature~hidden" },
      { ...validArgs, base: "feature/github-pr" },
      { ...validArgs, expectedHead: 7 },
      { ...validArgs, expectedHead: oid.slice(0, 39) },
      { ...validArgs, expectedHead: "A".repeat(40) },
      { ...validArgs, title: "" },
      { ...validArgs, title: 7 },
      { ...validArgs, title: "x".repeat(257) },
      { ...validArgs, title: "broken\ud800" },
      { ...validArgs, body: 7 },
      { ...validArgs, body: "x".repeat(1_537) },
      { ...validArgs, body: "broken\udc00" },
      { ...validArgs, draft: "yes" },
      { ...validArgs, maintainerCanModify: "yes" },
    ]) {
      expect(() => parseGithubPrCreateRequest(invalid)).toThrow(GithubPrCreateInvalidParamsError);
    }
  });

  it("escapes review text losslessly without hidden line or bidi controls", () => {
    expect(escapeGithubReviewText('line 1\n"line 2" \\ end \b\f\r\t\u0085\u2028\u2029\u202e')).toBe(
      '"line 1\\n\\"line 2\\" \\\\ end \\b\\f\\r\\t\\u0085\\u2028\\u2029\\u202e"',
    );
    expect(escapeGithubReviewText("paired 😀")).toBe('"paired 😀"');
    expect(() => escapeGithubReviewText("broken\ud800")).toThrow(GithubPrCreateInvalidParamsError);
    expect(() => escapeGithubReviewText("broken\udc00")).toThrow(GithubPrCreateInvalidParamsError);
  });

  it("builds one complete bounded review with exact escaped title and body", () => {
    const summary = githubPrCreateReviewSummary({
      request: parseGithubPrCreateRequest(validArgs),
      canonicalRemote: "https://github.com/keel-harness/keel.git",
      credentialSourceClass: "operator Git credential helper (system/global config)",
    });
    expect(summary).toContain(`Head: refs/heads/feature/github-pr @ ${oid}`);
    expect(summary).toContain('Title JSON: "feat: governed PR creation"');
    expect(summary).toContain('Body JSON: "Complete body\\n\\n- exact"');
    expect(summary).toContain("Draft: yes");
    expect(summary).toContain("Maintainers may modify: no");
    expect(summary.split("\n")).toHaveLength(13);
    expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(2_048);

    const maximal = parseGithubPrCreateRequest({
      ...validArgs,
      title: "t".repeat(256),
      body: "b".repeat(1_536),
    });
    expect(() =>
      githubPrCreateReviewSummary({
        request: maximal,
        canonicalRemote: "https://github.com/keel-harness/keel.git",
        credentialSourceClass: "operator Git credential helper (system/global config)",
      }),
    ).toThrow(/2,048-cell/u);
  });

  it("withholds capability unless every enforcing production prerequisite is active", () => {
    const enforcing = {
      workspaceTrusted: true,
      auditAvailable: true,
      authorityHealthy: true,
      sandbox: {
        available: true,
        backend: "srt:vendored",
        enforcementTier: "sandbox:srt",
        features: ["egress-address-guard/v1", "credential-tls-termination/v1"],
      },
    } as const;
    expect(githubPrCreateCapabilityAvailable(enforcing)).toBe(true);
    expect(githubPrCreateCapabilityAvailable({ ...enforcing, workspaceTrusted: false })).toBe(
      false,
    );
    expect(githubPrCreateCapabilityAvailable({ ...enforcing, auditAvailable: false })).toBe(false);
    expect(githubPrCreateCapabilityAvailable({ ...enforcing, authorityHealthy: false })).toBe(
      false,
    );
    expect(
      githubPrCreateCapabilityAvailable({
        ...enforcing,
        sandbox: { ...enforcing.sandbox, available: false },
      }),
    ).toBe(false);
    expect(
      githubPrCreateCapabilityAvailable({
        ...enforcing,
        sandbox: { ...enforcing.sandbox, backend: "fake" },
      }),
    ).toBe(false);
    expect(
      githubPrCreateCapabilityAvailable({
        ...enforcing,
        sandbox: { ...enforcing.sandbox, enforcementTier: "none" },
      }),
    ).toBe(false);
    expect(
      githubPrCreateCapabilityAvailable({
        ...enforcing,
        sandbox: { ...enforcing.sandbox, features: ["egress-address-guard/v1"] },
      }),
    ).toBe(false);
    expect(
      githubPrCreateCapabilityAvailable({
        ...enforcing,
        sandbox: { ...enforcing.sandbox, features: ["credential-tls-termination/v1"] },
      }),
    ).toBe(false);
  });
});
