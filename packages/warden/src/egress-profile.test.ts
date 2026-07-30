import { describe, expect, it } from "vitest";
import {
  buildEgressNetworkProfile,
  describeDnsRebindingPosture,
  InvalidEgressConfigError,
} from "./egress-profile.js";

describe("egress profile", () => {
  it("defaults to strict deny-all when no allowlist is configured", () => {
    expect(buildEgressNetworkProfile()).toEqual({
      allowedDomains: [],
      deniedDomains: ["*"],
      strictAllowlist: true,
    });
  });

  it("allows localhost as an explicit development-only host without opening IP literals", () => {
    expect(buildEgressNetworkProfile({ allowedDomains: ["localhost"] })).toEqual({
      allowedDomains: ["localhost"],
      deniedDomains: [],
      strictAllowlist: true,
    });
  });

  it("deduplicates normalized domains without using ambient presets", () => {
    expect(
      buildEgressNetworkProfile({
        allowedDomains: ["Example.COM", "example.com"],
      }),
    ).toEqual({
      allowedDomains: ["example.com"],
      deniedDomains: [],
      strictAllowlist: true,
    });
  });

  it("does not include telemetry or control-plane domains by default", () => {
    const profile = buildEgressNetworkProfile();

    expect(profile).toEqual({
      allowedDomains: [],
      deniedDomains: ["*"],
      strictAllowlist: true,
    });
    expect(profile.allowedDomains).toEqual(
      expect.not.arrayContaining([
        "telemetry.keel.dev",
        "analytics.keel.dev",
        "o11y.keel.dev",
        "sentry.io",
        "api.segment.io",
      ]),
    );
  });

  it("rejects malformed explicit domain patterns fail-closed", () => {
    for (const domain of [
      "*",
      "exa*mple.com",
      "*.com",
      "bad_domain.com",
      "-bad.example.com",
      "bad-.example.com",
      "example..com",
      "127.0.0.1",
      "127.1",
      "2130706433",
      "[::1]",
      "",
    ]) {
      expect(() => buildEgressNetworkProfile({ allowedDomains: [domain] })).toThrow(
        InvalidEgressConfigError,
      );
    }
  });

  it("records DNS rebinding as a documented limitation until resolved IPs are denied", () => {
    const posture = describeDnsRebindingPosture(
      buildEgressNetworkProfile({ allowedDomains: ["example.com"] }),
    );

    expect(posture).toMatchObject({
      status: "documented-limitation",
      requiredBackendControl: "deny-private-resolved-addresses",
    });
    expect(posture.reason).toContain("requested host");
    expect(posture.reason).toContain("resolved address");
  });

  it("treats deny-all egress as not applicable for DNS rebinding", () => {
    expect(describeDnsRebindingPosture(buildEgressNetworkProfile())).toEqual({
      status: "not-applicable",
      reason: "network profile allows no requested host, so DNS rebinding has no allowed target",
    });
  });
});
