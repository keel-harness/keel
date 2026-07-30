import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { WARDEN_METHODS } from "@keel/shared";
import { InvalidEgressConfigError } from "./egress-profile.js";
import {
  createEgressReviewState,
  createPendingCommandReview,
  createPendingEgressReview,
  exactOneLineReviewText,
  formatEgressDomainForReview,
  extractExplicitEgressTarget,
  normalizeEgressGrantDomain,
  oneLineReviewText,
  profileAllowsEgressDomain,
  withAdditionalEgressDomains,
} from "./egress-review.js";
import type { SandboxProfile } from "./sandbox.js";
import { buildPolicyInputForBash } from "./policy.js";

const EXECUTE_PARAMS = WARDEN_METHODS["warden.execute"].params.parse({
  sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  toolCall: { id: "tc_egress", name: "bash", args: { command: "curl https://example.com" } },
  provenanceContext: { inputTags: ["workspace"] },
});
const COMMAND_POLICY_INPUT = buildPolicyInputForBash(EXECUTE_PARAMS, {
  workspaceRoot: "/repo",
  env: {},
  workspaceTrusted: true,
});

const BIDI_CONTROLS = [
  "\u061c",
  "\u200e",
  "\u200f",
  "\u202a",
  "\u202b",
  "\u202c",
  "\u202d",
  "\u202e",
  "\u2066",
  "\u2067",
  "\u2068",
  "\u2069",
] as const;

describe("egress review helper", () => {
  it("normalizes exact grant domains through canonical ASCII without accepting patterns or URLs", () => {
    expect(normalizeEgressGrantDomain(" Example.COM ")).toBe("example.com");
    expect(normalizeEgressGrantDomain("Bücher.Example")).toBe("xn--bcher-kva.example");

    for (const domain of ["*.example.com", "https://example.com", "", "127.0.0.1"]) {
      expect(() => normalizeEgressGrantDomain(domain)).toThrow(InvalidEgressConfigError);
    }
  });

  it("extracts only explicit external http(s) targets from command text", () => {
    expect(extractExplicitEgressTarget("printf no-network")).toEqual({ kind: "none" });
    expect(extractExplicitEgressTarget("curl http://[")).toEqual({ kind: "none" });
    expect(extractExplicitEgressTarget("curl http://localhost:3000/ok")).toEqual({
      kind: "none",
    });
    expect(extractExplicitEgressTarget("curl https://Example.COM/releases/latest).")).toEqual({
      kind: "domain",
      domain: "example.com",
      url: "https://Example.COM/releases/latest",
    });

    const invalid = extractExplicitEgressTarget("curl http://127.0.0.1/secret");
    expect(invalid).toMatchObject({ kind: "invalid", target: "127.0.0.1" });
    if (invalid.kind !== "invalid") throw new Error("expected invalid egress target");
    expect(invalid.reason).toMatch(/IP-like|invalid/i);
  });

  it("SEC-001: rejects allowlist-bypassing IP literal forms before review/grant", () => {
    for (const url of [
      "http://127.0.0.1/secret",
      "http://127.1/secret",
      "http://2130706433/secret",
      "http://0177.0.0.1/secret",
      "http://0x7f000001/secret",
      "http://[::1]/secret",
      "http://[::ffff:127.0.0.1]/secret",
      "http://169.254.169.254/latest/meta-data",
    ]) {
      const target = extractExplicitEgressTarget(`curl ${url}`);
      expect(target, url).toMatchObject({ kind: "invalid" });
      if (target.kind !== "invalid") throw new Error(`expected invalid target for ${url}`);
      expect(target.reason, url).toMatch(/IP-like|invalid/i);
    }
  });

  it("creates stored reviews with one-line command copy and monotonically increasing ids", () => {
    const state = createEgressReviewState();
    const first = createPendingEgressReview(state, {
      domain: "example.com",
      command: "curl\nhttps://example.com",
      executeParams: EXECUTE_PARAMS,
    });
    const second = createPendingEgressReview(state, {
      domain: "example.org",
      command: "curl https://example.org",
      executeParams: EXECUTE_PARAMS,
    });

    expect(first.reviewId).toBe("egress_review_1");
    expect(first.summary).toContain("curl https://example.com");
    expect(first.allowCommand).toBe(
      "keel approve egress_review_1 --scope once --domain example.com",
    );
    expect(second.reviewId).toBe("egress_review_2");
    expect(state.pending.get(first.reviewId)).toBe(first);
    expect(state.pending.get(second.reviewId)).toBe(second);
  });

  it("keeps initialized project grant data inactive until the warden activates Project Autopilot", () => {
    const state = createEgressReviewState(
      ["Example.COM"],
      [
        {
          key: `sha256:${"a".repeat(64)}`,
          updatedAt: "2026-07-06T00:00:00.000Z",
        },
      ],
    );

    expect(state.projectGrants.has("example.com")).toBe(true);
    expect(state.projectCommandGrants.has(`sha256:${"a".repeat(64)}`)).toBe(true);
    expect(state.projectGrantsActive).toBe(false);
  });

  it("renders IDN review domains with canonical ASCII plus Unicode display form", () => {
    expect(formatEgressDomainForReview("example.com")).toBe("example.com");
    expect(formatEgressDomainForReview("xn--bcher-kva.example")).toBe(
      "xn--bcher-kva.example (unicode: bücher.example)",
    );

    const state = createEgressReviewState();
    const review = createPendingEgressReview(state, {
      domain: "xn--bcher-kva.example",
      command: "curl https://bücher.example",
      executeParams: EXECUTE_PARAMS,
    });

    expect(review.summary).toContain("xn--bcher-kva.example");
    expect(review.summary).toContain("unicode: bücher.example");
    expect(review.allowCommand).toContain("--domain xn--bcher-kva.example");
  });

  it("renders bounded one-line review text and preserves exact profile matching semantics", () => {
    expect(oneLineReviewText("a\n\tb")).toBe("a b");
    const abbreviated = oneLineReviewText(`PREFIX-${"x".repeat(220)}-DANGEROUS-SUFFIX`);
    expect(abbreviated).toHaveLength(180);
    expect(abbreviated).toMatch(/^PREFIX-/u);
    expect(abbreviated).toMatch(/\[\d+ chars omitted\]/u);
    expect(abbreviated).toMatch(/-DANGEROUS-SUFFIX$/u);

    const profile: SandboxProfile = {
      network: {
        allowedDomains: ["example.com", "*.github.com"],
        deniedDomains: [],
        strictAllowlist: true,
      },
    };
    expect(profileAllowsEgressDomain(profile, "example.com")).toBe(true);
    expect(profileAllowsEgressDomain(profile, "api.github.com")).toBe(true);
    expect(profileAllowsEgressDomain(profile, "github.com")).toBe(false);
    expect(profileAllowsEgressDomain({}, "example.com")).toBe(false);
  });

  it("returns destructive review text only when every character remains exactly visible", () => {
    const visible = "rm -f -- 'ordinary fixture.txt'";
    expect(exactOneLineReviewText(visible)).toBe(visible);
    expect(exactOneLineReviewText(`rm -f -- '${"x".repeat(220)}'`)).toBeUndefined();
    expect(exactOneLineReviewText(`rm -f -- 'sk-ant-${"A1".repeat(24)}'`)).toBeUndefined();
    expect(exactOneLineReviewText("rm -f -- 'line\nbreak'")).toBeUndefined();
    expect(exactOneLineReviewText("rm -f -- 'ALLOW\u202eDENY\u202c'")).toBeUndefined();
    for (const invisible of ["\u00ad", "\u200b", "\u200c", "\u200d", "\u2060", "\ufeff"]) {
      expect(exactOneLineReviewText(`rm safe${invisible}name`), invisible).toBeUndefined();
    }
  });

  it("redacts a secret-shaped command suffix before preserving the review tail", () => {
    const secret = `sk-ant-${"A1".repeat(24)}`;
    const rendered = oneLineReviewText(`curl ${"x".repeat(220)} --header Authorization:${secret}`);

    expect(rendered).toContain("[redacted:anthropic-key]");
    expect(rendered).not.toContain(secret);
  });

  it("redacts secret shapes reconstituted by removing default-ignorable characters", () => {
    const visibleSecret = `sk-ant-${"A1".repeat(24)}`;
    const obfuscatedSecret = `${visibleSecret.slice(0, 18)}\u200b${visibleSecret.slice(18)}`;

    const rendered = oneLineReviewText(`Authorization: ${obfuscatedSecret}`);

    expect(rendered).toContain("[redacted:anthropic-key]");
    expect(rendered).not.toContain(visibleSecret);
  });

  it("removes every Unicode bidi control from human review summaries", () => {
    const state = createEgressReviewState();

    for (const control of BIDI_CONTROLS) {
      expect(oneLineReviewText(`ALLOW${control} DENY`)).toBe("ALLOW DENY");
    }

    const egress = createPendingEgressReview(state, {
      domain: "example.com",
      command: `curl https://example.com && printf 'ALLOW\u202eDENY\u202c'`,
      executeParams: EXECUTE_PARAMS,
    });
    const command = createPendingCommandReview(state, {
      grantKey: `sha256:${"a".repeat(64)}`,
      command: `deploy \u2066--scope once\u2069 \u202eDENY\u202c`,
      executeParams: EXECUTE_PARAMS,
      auditPolicyInput: COMMAND_POLICY_INPUT,
    });

    expect(egress.summary).toBe(
      "egress to example.com requires review: curl https://example.com && printf 'ALLOWDENY'",
    );
    expect(command.summary).toBe("command review requires approval: deploy --scope once DENY");
    expect(oneLineReviewText("left\u009bright")).toBe("left right");
  });

  it("removes arbitrary bidi-control sequences without changing review-label order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...BIDI_CONTROLS), { minLength: 1, maxLength: 64 }),
        (controls) => {
          const injected = controls.join("");
          expect(oneLineReviewText(`review ${injected}ALLOW${injected} DENY${injected}`)).toBe(
            "review ALLOW DENY",
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("merges additional exact domains without changing a profile when no additions are needed", () => {
    const base: SandboxProfile = {
      filesystem: { allowRead: ["/repo"] },
      network: { allowedDomains: ["example.com"], deniedDomains: [], strictAllowlist: true },
    };

    expect(withAdditionalEgressDomains(base, [])).toBe(base);
    expect(withAdditionalEgressDomains(base, ["Example.ORG"])).toEqual({
      filesystem: { allowRead: ["/repo"] },
      network: {
        allowedDomains: ["example.com", "example.org"],
        deniedDomains: [],
        strictAllowlist: true,
      },
    });
  });
});
