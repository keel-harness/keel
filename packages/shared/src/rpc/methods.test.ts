import { describe, expect, it } from "vitest";
import {
  JUNK,
  assertRejects,
  assertRoundTrips,
  assertWireRoundTrips,
} from "../testing/property.js";
import {
  WARDEN_METHODS,
  WARDEN_NOTIFICATIONS,
  WardenMethodName,
  type WardenMethodNameT,
  type WardenNotificationNameT,
} from "./methods.js";

describe("warden RPC methods (Appendix A — frozen)", () => {
  it("registry covers exactly the 13 protocol-1.1 methods", () => {
    expect(WardenMethodName.options).toEqual([
      "warden.hello",
      "warden.trust.grant",
      "warden.execute",
      "warden.resolveReview",
      "warden.egress.grant",
      "warden.provenance.declassify",
      "warden.audit.append",
      "warden.audit.export",
      "warden.policy.test",
      "warden.policy.explain",
      "warden.status",
      "warden.presentation.take",
      "warden.shutdown",
    ]);
    expect(Object.keys(WARDEN_METHODS).sort()).toEqual([...WardenMethodName.options].sort());
  });

  it("every method's params and result round-trip", () => {
    for (const name of WardenMethodName.options) {
      assertRoundTrips(WARDEN_METHODS[name].params);
      assertRoundTrips(WARDEN_METHODS[name].result);
    }
  });

  // I3: WARDEN_NOTIFICATIONS registry
  it("WARDEN_NOTIFICATIONS: registry binds warden.event -> WardenEvent schema", () => {
    // Must export the registry
    expect(WARDEN_NOTIFICATIONS).toBeDefined();
    expect(Object.keys(WARDEN_NOTIFICATIONS)).toContain("warden.event");

    // The schema must parse a valid WardenEvent
    const notificationName: WardenNotificationNameT = "warden.event";
    const schema = WARDEN_NOTIFICATIONS[notificationName].params;
    expect(schema.parse({ eventType: "checkpoint.written", payload: { seq: 128 } })).toBeTruthy();
    assertRejects(schema, [...JUNK, { eventType: "unknown.event", payload: {} }]);
  });

  // N9: per-method params negative coverage — every method's params schema is
  // `.strict()` (rejects unknown keys, proving the frozen wire surface is closed)
  // and rejects universally-invalid JUNK.
  const VALID_PARAMS: Record<WardenMethodNameT, Record<string, unknown>> = {
    "warden.hello": { kernelVersion: "0.0.0", protocolVersion: "1.0.0" },
    "warden.trust.grant": {
      workspacePath: "/repo",
      principal: {
        osUser: "c",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
      userConfirmed: true,
    },
    "warden.execute": {
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      toolCall: { id: "tc_1", name: "bash", args: { command: "ls" } },
      provenanceContext: { inputTags: ["workspace"] },
    },
    "warden.resolveReview": {
      reviewId: "rv_1",
      approved: true,
      principal: {
        osUser: "c",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
    },
    "warden.egress.grant": {
      domain: "example.com",
      scope: "once",
      principal: {
        osUser: "c",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
    },
    "warden.provenance.declassify": {
      resultId: "res_1",
      principal: {
        osUser: "c",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
      reason: "approved by operator",
    },
    "warden.audit.append": {
      event: { eventType: "session.start", payload: { seq: 1 } },
    },
    "warden.audit.export": {
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      outPath: "/tmp/out",
    },
    "warden.policy.test": { packPath: "/policy/pack" },
    "warden.policy.explain": {
      toolCall: { id: "tc_1", name: "bash", args: { command: "ls" } },
      provenanceContext: { inputTags: ["workspace"] },
    },
    "warden.status": {},
    "warden.presentation.take": {
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      toolCallId: "tc_1",
      auditSeq: 0,
    },
    "warden.shutdown": {},
  };

  it("every method's params is strict (rejects unknown keys) and rejects JUNK", () => {
    // The fixture map is exhaustive over the registry (typed Record<WardenMethodNameT,…>);
    // entries() yields non-optional values, so no fixture can be silently missing.
    for (const [name, valid] of Object.entries(VALID_PARAMS) as [
      WardenMethodNameT,
      Record<string, unknown>,
    ][]) {
      const params = WARDEN_METHODS[name].params;
      // The valid fixture parses (guards the fixture itself against drift).
      expect(params.safeParse(valid).success).toBe(true);
      // Strict: a valid fixture plus one unknown key must be rejected. For the
      // empty-params methods (status/shutdown) {__extra:1} alone must reject.
      expect(params.safeParse({ ...valid, __extra: 1 }).success).toBe(false);
      // Universally-invalid values are rejected. The no-arg methods (status/shutdown)
      // legitimately accept the empty object as valid params, so drop {} from their
      // reject set — the strict check above already proves they reject unknown keys.
      const noArgParams = Object.keys(valid).length === 0;
      const junk = noArgParams
        ? JUNK.filter((v) => !(typeof v === "object" && v !== null && !Array.isArray(v)))
        : JUNK;
      assertRejects(params, junk);
    }
  });

  it("execute: accepts a well-formed call and rejects malformed", () => {
    const { params, result } = WARDEN_METHODS["warden.execute"];
    expect(
      params.parse({
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolCall: { id: "tc_1", name: "bash", args: { command: "ls" } },
        provenanceContext: { inputTags: ["workspace"] },
      }),
    ).toBeTruthy();
    expect(result.parse({ verdict: "allow", auditSeq: 7 })).toBeTruthy();
    assertRejects(params, [
      ...JUNK,
      {
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolCall: { id: "t", name: "bash" },
        provenanceContext: { inputTags: [] },
      }, // toolCall.args missing
      { toolCall: { id: "t", name: "bash", args: {} }, provenanceContext: { inputTags: [] } }, // sessionId missing
    ]);
    assertRejects(result, [...JUNK, { verdict: "permit", auditSeq: 1 }, { verdict: "allow" }]);
  });

  // I2: sessionId must be SessionId format
  it("execute/auditExport: sessionId must be ses_<ULID>; bare 'x' rejects", () => {
    const executeParams = WARDEN_METHODS["warden.execute"].params;
    const validCall = {
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      toolCall: { id: "tc_1", name: "bash", args: {} },
      provenanceContext: { inputTags: [] },
    };
    expect(executeParams.parse(validCall)).toBeTruthy();
    assertRejects(executeParams, [
      { ...validCall, sessionId: "x" },
      { ...validCall, sessionId: "" },
      { ...validCall, sessionId: "ses_tooshort" },
    ]);

    const auditExportParams = WARDEN_METHODS["warden.audit.export"].params;
    const validExport = { sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV", outPath: "/tmp/out" };
    expect(auditExportParams.parse(validExport)).toBeTruthy();
    assertRejects(auditExportParams, [
      { ...validExport, sessionId: "x" },
      { ...validExport, sessionId: "" },
    ]);
  });

  // N3: hash fields must be Sha256 digests
  it("auditExport result rootHash and status auditHead.hash must be sha256 digests", () => {
    const goodHash = "sha256:" + "a".repeat(64);
    const auditExportResult = WARDEN_METHODS["warden.audit.export"].result;
    expect(auditExportResult.parse({ bundlePath: "/out/bundle", rootHash: goodHash })).toBeTruthy();
    assertRejects(auditExportResult, [
      { bundlePath: "/out/bundle", rootHash: "" },
      { bundlePath: "/out/bundle", rootHash: "garbage" },
      { bundlePath: "/out/bundle", rootHash: "sha256:tooshort" },
    ]);

    const statusResult = WARDEN_METHODS["warden.status"].result;
    expect(
      statusResult.parse({
        enforcementTier: "strict",
        sandboxBackend: "bwrap",
        policyPack: { name: "default", hash: goodHash },
        auditHead: { seq: 0, hash: goodHash },
        pendingReviews: 0,
      }),
    ).toBeTruthy();
    assertRejects(statusResult, [
      {
        enforcementTier: "strict",
        sandboxBackend: "bwrap",
        policyPack: { name: "d", hash: goodHash },
        auditHead: { seq: 0, hash: "" },
        pendingReviews: 0,
      },
    ]);
  });

  // N3: ShutdownResult.finalCheckpoint must be non-empty
  it("shutdown result finalCheckpoint must be non-empty string", () => {
    const shutdownResult = WARDEN_METHODS["warden.shutdown"].result;
    expect(shutdownResult.parse({ finalCheckpoint: "/var/keel/checkpoint-001" })).toBeTruthy();
    assertRejects(shutdownResult, [{ finalCheckpoint: "" }]);
  });

  // C3: JSON-safe fields wire round-trip
  it("execute and presentation carrier params/results wire round-trip (JSON-safe fields)", () => {
    assertWireRoundTrips(WARDEN_METHODS["warden.execute"].params);
    assertWireRoundTrips(WARDEN_METHODS["warden.execute"].result);
    assertWireRoundTrips(WARDEN_METHODS["warden.resolveReview"].result);
    assertWireRoundTrips(WARDEN_METHODS["warden.presentation.take"].params);
    assertWireRoundTrips(WARDEN_METHODS["warden.presentation.take"].result);
  });

  it("hello / trust.grant / resolveReview shape checks", () => {
    expect(
      WARDEN_METHODS["warden.hello"].params.parse({
        kernelVersion: "0.0.0",
        protocolVersion: "1.0.0",
      }),
    ).toBeTruthy();
    expect(
      WARDEN_METHODS["warden.trust.grant"].params.parse({
        workspacePath: "/repo",
        principal: {
          osUser: "c",
          configuredId: null,
          authProvider: "local",
          assurance: "local-os-user",
        },
        userConfirmed: true,
      }),
    ).toBeTruthy();
    assertRejects(WARDEN_METHODS["warden.trust.grant"].params, [
      ...JUNK,
      {
        workspacePath: "/repo",
        principal: {
          osUser: "c",
          configuredId: null,
          authProvider: "local",
          assurance: "local-os-user",
        },
        userConfirmed: false,
      }, // must be literal true
    ]);
  });
});
