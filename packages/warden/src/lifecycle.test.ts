import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_MANIFEST_VERSION,
  LifecycleManifest,
  canonicalLifecycleManifestHash,
} from "@keel/shared";
import {
  LIFECYCLE_MANIFEST_CONFIG_ENV,
  LifecycleResolutionError,
  lifecycleManifestFromEnv,
  parseLifecycleManifestConfig,
  parseValidationPostureId,
  renderLifecycleArgv,
  resolveLifecycleAction,
} from "./lifecycle.js";

const MANIFEST = LifecycleManifest.parse({
  schemaVersion: LIFECYCLE_MANIFEST_VERSION,
  env: {
    required: [
      { name: "GLOBAL_TOKEN", secret: true },
      { name: "DATABASE_URL", secret: true, requiredFor: ["test.integration"] },
    ],
    optional: [{ name: "CI", secret: false }],
  },
  actions: {
    "test.unit": { argv: ["echo", "unit ok"], requiresEnv: ["CI"] },
    "test.integration": { argv: ["pnpm", "test:integration"], requiresEnv: ["DATABASE_URL"] },
    "test.targeted": {
      discover: { kind: "node-vitest", fileGlobs: ["packages/**/*.test.ts"] },
    },
  },
  validationTiers: {
    minimal: { required: ["test.unit"] },
    strict: { required: ["test.integration"] },
  },
});

const HASH = canonicalLifecycleManifestHash(MANIFEST);
const LOADED = { manifest: MANIFEST, hash: HASH };

describe("lifecycle manifest resolver", () => {
  it("renders argv with shell quoting only for arguments that need it", () => {
    expect(renderLifecycleArgv(["pnpm", "test", "--filter=@keel/warden"])).toBe(
      "pnpm test --filter=@keel/warden",
    );
    expect(renderLifecycleArgv(["echo", "needs space", "don't"])).toBe(
      "echo 'needs space' 'don'\\''t'",
    );
  });

  it("parses parent-provided manifest config and fails closed on hash mismatch", () => {
    expect(
      parseLifecycleManifestConfig(JSON.stringify({ manifest: MANIFEST, hash: HASH })),
    ).toEqual(LOADED);
    expect(() =>
      parseLifecycleManifestConfig(
        JSON.stringify({ manifest: MANIFEST, hash: `sha256:${"9".repeat(64)}` }),
      ),
    ).toThrow("lifecycle manifest hash mismatch");
  });

  it("reads lifecycle config and validation posture from env with safe defaults", () => {
    expect(lifecycleManifestFromEnv({})).toBeUndefined();
    expect(lifecycleManifestFromEnv({ [LIFECYCLE_MANIFEST_CONFIG_ENV]: "  " })).toBeUndefined();
    expect(
      lifecycleManifestFromEnv({
        [LIFECYCLE_MANIFEST_CONFIG_ENV]: JSON.stringify({ manifest: MANIFEST, hash: HASH }),
      }),
    ).toEqual(LOADED);

    expect(parseValidationPostureId(undefined)).toBe("guided");
    expect(parseValidationPostureId("locked-down")).toBe("locked-down");
    expect(parseValidationPostureId("regulated")).toBe("guided");
  });

  it("resolves an action with posture and env-name audit metadata but no env values", () => {
    const resolved = resolveLifecycleAction(
      { action: "test.unit", manifestHash: HASH, posture: "locked-down" },
      LOADED,
      { postureId: "locked-down", env: { GLOBAL_TOKEN: "secret", CI: "true" } },
    );

    expect(resolved.command).toBe("echo 'unit ok'");
    expect(resolved.auditPayload).toMatchObject({
      actionId: "test.unit",
      manifestHash: HASH,
      requestedManifestHash: HASH,
      resolvedCommand: { argv: ["echo", "unit ok"] },
      cwd: ".",
      validationTier: "minimal",
      activePostureId: "locked-down",
      env: {
        required: ["GLOBAL_TOKEN"],
        optional: ["CI"],
        missingRequired: [],
      },
    });
    expect(JSON.stringify(resolved)).not.toContain("secret");
    expect(JSON.stringify(resolved)).not.toContain('"true"');
  });

  it("denies discovery-only and missing-action requests before command execution", () => {
    expect(() =>
      resolveLifecycleAction({ action: "test.targeted" }, LOADED, {
        env: { GLOBAL_TOKEN: "secret" },
      }),
    ).toThrow(LifecycleResolutionError);

    try {
      resolveLifecycleAction({}, LOADED, { env: { GLOBAL_TOKEN: "secret" } });
      throw new Error("expected missing action to deny");
    } catch (error) {
      expect(error).toBeInstanceOf(LifecycleResolutionError);
      if (!(error instanceof LifecycleResolutionError)) throw error;
      expect(error.commandForAudit).toBe("lifecycle.run unknown");
      expect(error.auditPayload.actionId).toBe("");
    }
  });
});
