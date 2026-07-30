import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  LIFECYCLE_MANIFEST_VERSION,
  LifecycleManifest,
  ValidationPosture,
  canonicalLifecycleManifestHash,
  lifecycleActionIds,
  lifecycleManifestPublicSummary,
} from "./manifest.js";

const minimalManifest = {
  schemaVersion: LIFECYCLE_MANIFEST_VERSION,
  packageManager: "pnpm",
  root: ".",
  env: {
    required: [{ name: "DATABASE_URL", secret: true, requiredFor: ["test.integration"] }],
    optional: [{ name: "CI", secret: false }],
  },
  actions: {
    lint: { argv: ["pnpm", "lint"], timeoutMs: 120_000 },
    typecheck: { argv: ["pnpm", "typecheck"] },
    "test.unit": { argv: ["pnpm", "test"], requiresEnv: ["CI"] },
    "test.targeted": {
      discover: { kind: "node-vitest", fileGlobs: ["packages/**/*.test.ts"] },
      timeoutMs: 60_000,
    },
  },
  validationTiers: {
    standard: { required: ["lint", "typecheck", "test.unit"] },
  },
  extensions: {
    "dev.keel.fixture": { note: "namespaced extension data only" },
  },
};

describe("LifecycleManifest schema", () => {
  it("accepts a minimal repo validation contract and exposes stable action ids", () => {
    const manifest = LifecycleManifest.parse(minimalManifest);

    expect(lifecycleActionIds(manifest)).toEqual([
      "lint",
      "typecheck",
      "test.unit",
      "test.targeted",
    ]);
    expect(manifest.validationTiers?.standard?.required).toEqual([
      "lint",
      "typecheck",
      "test.unit",
    ]);
    expect(canonicalLifecycleManifestHash(manifest)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("rejects unsupported major versions, authority-like fields, shell strings, and env values", () => {
    expect(
      LifecycleManifest.safeParse({ ...minimalManifest, schemaVersion: "lifecycle.keel.dev/v2" })
        .success,
    ).toBe(false);
    expect(
      LifecycleManifest.safeParse({ ...minimalManifest, egress: ["evil.example"] }).success,
    ).toBe(false);
    expect(
      LifecycleManifest.safeParse({ ...minimalManifest, sandbox: { allowWrite: ["/"] } }).success,
    ).toBe(false);
    expect(
      LifecycleManifest.safeParse({
        ...minimalManifest,
        actions: { lint: { shell: "pnpm lint" } },
      }).success,
    ).toBe(false);
    expect(
      LifecycleManifest.safeParse({
        ...minimalManifest,
        env: { required: [{ name: "DATABASE_URL", secret: true, value: "postgres://secret" }] },
      }).success,
    ).toBe(false);
  });

  it("rejects path roots and action references that could escape or lie about the manifest", () => {
    expect(LifecycleManifest.safeParse({ ...minimalManifest, root: "/tmp/project" }).success).toBe(
      false,
    );
    expect(LifecycleManifest.safeParse({ ...minimalManifest, root: "../other" }).success).toBe(
      false,
    );
    expect(
      LifecycleManifest.safeParse({
        ...minimalManifest,
        validationTiers: { standard: { required: ["lint", "test.integration"] } },
      }).success,
    ).toBe(false);
    expect(
      LifecycleManifest.safeParse({
        ...minimalManifest,
        actions: { "com.example.custom": { argv: ["pnpm", "test"] } },
      }).success,
    ).toBe(false);
  });

  it("rejects ambiguous actions, duplicate env declarations, unsafe discover paths, and undeclared env refs", () => {
    expect(LifecycleManifest.safeParse({ ...minimalManifest, root: "C:\\repo" }).success).toBe(
      false,
    );
    expect(LifecycleManifest.safeParse({ ...minimalManifest, root: "bad\u0000path" }).success).toBe(
      false,
    );
    expect(
      LifecycleManifest.safeParse({
        ...minimalManifest,
        env: {
          required: [{ name: "CI", secret: true }],
          optional: [{ name: "CI", secret: false }],
        },
      }).success,
    ).toBe(false);
    expect(
      LifecycleManifest.safeParse({
        ...minimalManifest,
        env: { optional: [{ name: "CI", secret: false, requiredFor: ["test.unit"] }] },
      }).success,
    ).toBe(false);
    expect(
      LifecycleManifest.safeParse({
        ...minimalManifest,
        actions: {
          lint: { argv: ["pnpm", "lint"], discover: { kind: "node-vitest", fileGlobs: ["a.ts"] } },
        },
      }).success,
    ).toBe(false);
    expect(
      LifecycleManifest.safeParse({
        ...minimalManifest,
        actions: { "test.targeted": { discover: { kind: "node-vitest", fileGlobs: ["../*.ts"] } } },
      }).success,
    ).toBe(false);
    expect(
      LifecycleManifest.safeParse({
        ...minimalManifest,
        actions: { "test.unit": { argv: ["pnpm", "test"], requiresEnv: ["MISSING_TOKEN"] } },
      }).success,
    ).toBe(false);
    expect(
      LifecycleManifest.safeParse({
        schemaVersion: LIFECYCLE_MANIFEST_VERSION,
        actions: {},
      }).success,
    ).toBe(false);
  });

  it("enforces bounded arrays and namespaced extensions only", () => {
    expect(
      LifecycleManifest.safeParse({
        ...minimalManifest,
        actions: { lint: { argv: ["pnpm", ...Array.from({ length: 65 }, () => "--flag")] } },
      }).success,
    ).toBe(false);
    expect(
      LifecycleManifest.safeParse({ ...minimalManifest, extensions: { custom: {} } }).success,
    ).toBe(false);
  });

  it("summarizes only non-secret metadata and never accepts secret values", () => {
    const manifest = LifecycleManifest.parse(minimalManifest);
    const summary = lifecycleManifestPublicSummary(manifest);

    expect(summary).toEqual({
      schemaVersion: LIFECYCLE_MANIFEST_VERSION,
      packageManager: "pnpm",
      root: ".",
      actions: ["lint", "typecheck", "test.unit", "test.targeted"],
      validationTiers: ["standard"],
      env: {
        required: [{ name: "DATABASE_URL", secret: true, requiredFor: ["test.integration"] }],
        optional: [{ name: "CI", secret: false }],
      },
    });
    expect(JSON.stringify(summary)).not.toContain("postgres://");
  });

  it("omits optional public-summary fields when the manifest does not declare them", () => {
    const manifest = LifecycleManifest.parse({
      schemaVersion: LIFECYCLE_MANIFEST_VERSION,
      actions: { lint: { argv: ["pnpm", "lint"] } },
    });

    expect(lifecycleManifestPublicSummary(manifest)).toEqual({
      schemaVersion: LIFECYCLE_MANIFEST_VERSION,
      root: ".",
      actions: ["lint"],
      validationTiers: [],
      env: { required: [], optional: [] },
    });
  });

  it("hashes canonical parsed data, not object insertion order", () => {
    const a = LifecycleManifest.parse(minimalManifest);
    const b = LifecycleManifest.parse({
      schemaVersion: LIFECYCLE_MANIFEST_VERSION,
      root: ".",
      packageManager: "pnpm",
      actions: {
        "test.targeted": {
          timeoutMs: 60_000,
          discover: { fileGlobs: ["packages/**/*.test.ts"], kind: "node-vitest" },
        },
        "test.unit": { requiresEnv: ["CI"], argv: ["pnpm", "test"] },
        typecheck: { argv: ["pnpm", "typecheck"] },
        lint: { timeoutMs: 120_000, argv: ["pnpm", "lint"] },
      },
      env: {
        optional: [{ secret: false, name: "CI" }],
        required: [{ requiredFor: ["test.integration"], secret: true, name: "DATABASE_URL" }],
      },
      validationTiers: { standard: { required: ["lint", "typecheck", "test.unit"] } },
      extensions: { "dev.keel.fixture": { note: "namespaced extension data only" } },
    });

    expect(canonicalLifecycleManifestHash(a)).toBe(canonicalLifecycleManifestHash(b));
  });

  it("changes the manifest hash when the resolved argv changes", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((value) => !/\s/u.test(value)),
        fc.string({ minLength: 1, maxLength: 20 }).filter((value) => !/\s/u.test(value)),
        (first, second) => {
          fc.pre(first !== second);
          const a = LifecycleManifest.parse({
            schemaVersion: LIFECYCLE_MANIFEST_VERSION,
            actions: { lint: { argv: ["pnpm", first] } },
          });
          const b = LifecycleManifest.parse({
            schemaVersion: LIFECYCLE_MANIFEST_VERSION,
            actions: { lint: { argv: ["pnpm", second] } },
          });
          expect(canonicalLifecycleManifestHash(a)).not.toBe(canonicalLifecycleManifestHash(b));
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("ValidationPosture schema", () => {
  it("keeps Phase-2 posture names implementation-honest and data-only", () => {
    const posture = ValidationPosture.parse({
      id: "locked-down",
      policyProfileRef: "builtin:phase2a-starter",
      sandboxProfileRef: "builtin:srt-default",
      egressProfileRef: "builtin:deny-by-default",
      validation: {
        tier: "strict",
        requiredLifecycleActions: ["lint", "typecheck", "test.unit"],
        requireCleanWorktree: true,
        requireTargetedTestsForTouchedFiles: true,
      },
      approvals: {
        promptOnReview: true,
        allowProjectGrants: false,
        batchReviews: true,
      },
      retry: { readOnlyInfraRetry: "off" },
      audit: {
        requireHashChain: true,
        requireDeniedActionRecords: true,
        requireValidationReceipt: false,
      },
    });

    expect(posture.id).toBe("locked-down");
    expect(ValidationPosture.safeParse({ ...posture, id: "regulated" }).success).toBe(false);
    expect(ValidationPosture.safeParse({ ...posture, verdict: "allow" }).success).toBe(false);
  });
});
