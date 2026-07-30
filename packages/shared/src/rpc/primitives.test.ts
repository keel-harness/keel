import { describe, expect, it } from "vitest";
import {
  JUNK,
  assertRejects,
  assertRoundTrips,
  assertWireRoundTrips,
} from "../testing/property.js";
import {
  ErrorCode,
  Principal,
  PolicyPackRef,
  ProtocolVersion,
  ProvenanceContext,
  ProvenanceTag,
  ToolCall,
  Verdict,
  provenanceTagFromTrustLevel,
} from "./primitives.js";
import { TrustLevel } from "../context/task-state.js";

describe("RPC primitives", () => {
  it("Principal: accepts the v1 local default and round-trips", () => {
    expect(
      Principal.parse({
        osUser: "alice",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      }),
    ).toMatchObject({ osUser: "alice", authProvider: "local" });
    assertRoundTrips(Principal);
  });

  it("Principal: rejects unknown authProvider / assurance and junk", () => {
    assertRejects(Principal, [
      ...JUNK,
      { osUser: "c", configuredId: null, authProvider: "google", assurance: "local-os-user" },
      { osUser: "c", configuredId: null, authProvider: "local", assurance: "root" },
      { osUser: "c", configuredId: null, authProvider: "local" }, // missing assurance
      { configuredId: null, authProvider: "local", assurance: "local-os-user" }, // missing osUser
      { osUser: 1, configuredId: null, authProvider: "local", assurance: "local-os-user" }, // wrong type
      { osUser: "c", configuredId: 5, authProvider: "local", assurance: "local-os-user" }, // configuredId wrong type
      {
        osUser: "c",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
        extra: 1,
      }, // strict: extra key
    ]);
  });

  it("Verdict / ProvenanceTag enums round-trip and reject unknowns", () => {
    expect(Verdict.options).toEqual(["allow", "deny", "modify", "review", "warn"]);
    expect(ProvenanceTag.options).toEqual(["user", "workspace", "untrusted", "mixed"]);
    assertRoundTrips(Verdict);
    assertRoundTrips(ProvenanceTag);
    assertRejects(Verdict, [...JUNK, "ALLOW", "permit"]);
    assertRejects(ProvenanceTag, [...JUNK, "trusted", "tainted"]);
  });

  it("R1 freeze: TrustLevel unknown maps fail-closed at the provenance boundary", () => {
    expect(TrustLevel.options).toEqual(["user", "workspace", "untrusted", "mixed", "unknown"]);
    expect(TrustLevel.options.map((tag) => [tag, provenanceTagFromTrustLevel(tag)])).toEqual([
      ["user", "user"],
      ["workspace", "workspace"],
      ["untrusted", "untrusted"],
      ["mixed", "mixed"],
      ["unknown", "untrusted"],
    ]);
    expect(provenanceTagFromTrustLevel("future-taint")).toBe("untrusted");
  });

  it("ToolCall / ProvenanceContext / PolicyPackRef / ProtocolVersion / ErrorCode round-trip", () => {
    expect(ToolCall.parse({ id: "tc_1", name: "bash", args: { command: "ls" } })).toBeTruthy();
    assertRoundTrips(ToolCall);
    assertRoundTrips(ProvenanceContext);
    assertRoundTrips(PolicyPackRef);
    assertRoundTrips(ProtocolVersion);
    assertRoundTrips(ErrorCode);
    assertRejects(ToolCall, [
      ...JUNK,
      { id: "x", name: "bash" },
      { id: 1, name: "bash", args: {} },
    ]);
    assertRejects(ErrorCode, [...JUNK, "NOPE", "policy_pack_tampered"]);
  });

  // N9: negative coverage for the remaining frozen primitives.
  it("ProvenanceContext / PolicyPackRef / ProtocolVersion reject JUNK and unknown keys", () => {
    const goodHash = "sha256:" + "a".repeat(64);
    assertRejects(ProvenanceContext, [...JUNK]);
    assertRejects(PolicyPackRef, [...JUNK]);
    assertRejects(ProtocolVersion, [...JUNK]);
    // strict: a valid object plus an unknown key must be rejected.
    expect(ProvenanceContext.safeParse({ inputTags: ["workspace"], __extra: 1 }).success).toBe(
      false,
    );
    expect(PolicyPackRef.safeParse({ name: "default", hash: goodHash, __extra: 1 }).success).toBe(
      false,
    );
  });

  // C3: ToolCall.args is JsonObject — wire-safe
  it("ToolCall: args is JsonObject — wire round-trips", () => {
    assertWireRoundTrips(ToolCall);
  });

  // N3: PolicyPackRef.hash must be a sha256:<64hex> digest
  it("PolicyPackRef: hash accepts sha256 digest; rejects empty string and garbage", () => {
    const goodHash = "sha256:" + "a".repeat(64);
    expect(PolicyPackRef.parse({ name: "default", hash: goodHash })).toBeTruthy();
    assertRejects(PolicyPackRef, [
      { name: "p", hash: "" },
      { name: "p", hash: "garbage" },
      { name: "p", hash: "sha256:tooshort" },
      { name: "p", hash: "sha256:" + "g".repeat(64) }, // non-hex chars
    ]);
    assertWireRoundTrips(PolicyPackRef);
  });
});
