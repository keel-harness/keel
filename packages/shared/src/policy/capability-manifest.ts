import { z } from "zod";
import { JsonObject } from "../common/json.js";
import { StaticCapability } from "./side-effect.js";

/**
 * Internal Phase-2A capability manifest contract (ADR-0056).
 *
 * This is not an end-user policy file. It is the build-time/source-of-truth shape used to keep the
 * warden's static capability envelope, sandbox profile, egress posture, and future policy bindings from
 * drifting apart. The first slice is deliberately small: it covers the plain-data sandbox/egress
 * profile vocabulary already implemented by the warden and leaves policy evaluation/audit mismatch
 * emission to later Phase-2A slices.
 */
export const CAPABILITY_MANIFEST_VERSION = "capability-manifest/v1" as const;

const NAMESPACE_RE = /^(?=.+[./])[a-z0-9]+(?:[.-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[.-][a-z0-9]+)*)*$/;

export const NamespacedManifestExtensions = JsonObject.superRefine((value, ctx) => {
  for (const key of Object.keys(value)) {
    if (!NAMESPACE_RE.test(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: "extension keys must be namespaced (for example com.example.feature)",
      });
    }
  }
});
export type NamespacedManifestExtensionsT = z.infer<typeof NamespacedManifestExtensions>;

export const SandboxReadAllowToken = z.enum(["workspace", "declared_temp"]);
export const SandboxWriteAllowToken = z.enum(["workspace", "declared_temp"]);
export const SandboxReadDenyToken = z.enum([
  "home_secret_roots",
  "keel_config",
  "keel_audit",
  "keel_policy",
  "workspace_dotenv_files",
]);
// QC §4: workspace dotenv files are deny-WRITE as well as deny-read, so a secret file's integrity
// is protected (an agent cannot clobber/plant `.env`), not only its confidentiality. Home secret
// roots need no write-deny token: they are outside the workspace/temp allow-write roots and so are
// already unwritable. Additive to `capability-manifest/v1` — existing manifests validate unchanged.
export const SandboxWriteDenyToken = z.enum([
  "keel_audit",
  "keel_policy",
  "keel_config",
  "workspace_dotenv_files",
  // Additive v1 tokens. They protect shell-interpreted workspace control data without changing
  // existing manifests or the end-user policy surface.
  "workspace_package_manager_execution_metadata",
  "workspace_vcs_execution_metadata",
]);
export type SandboxReadAllowTokenT = z.infer<typeof SandboxReadAllowToken>;
export type SandboxWriteAllowTokenT = z.infer<typeof SandboxWriteAllowToken>;
export type SandboxReadDenyTokenT = z.infer<typeof SandboxReadDenyToken>;
export type SandboxWriteDenyTokenT = z.infer<typeof SandboxWriteDenyToken>;

export const CapabilitySandboxFilesystem = z
  .object({
    allowRead: z.array(SandboxReadAllowToken).max(32),
    allowWrite: z.array(SandboxWriteAllowToken).max(32),
    denyRead: z.array(SandboxReadDenyToken).max(32),
    denyWrite: z.array(SandboxWriteDenyToken).max(32),
  })
  .strict();
export type CapabilitySandboxFilesystemT = z.infer<typeof CapabilitySandboxFilesystem>;

export const CapabilitySandboxNetwork = z
  .object({
    /** Domain syntax is validated by the warden egress-profile builder at projection time. */
    allowedDomains: z.array(z.string()).max(128),
  })
  .strict();
export type CapabilitySandboxNetworkT = z.infer<typeof CapabilitySandboxNetwork>;

export const CapabilitySandboxPosture = z
  .object({
    filesystem: CapabilitySandboxFilesystem,
    network: CapabilitySandboxNetwork,
  })
  .strict();
export type CapabilitySandboxPostureT = z.infer<typeof CapabilitySandboxPosture>;

export const CapabilityManifestTool = z
  .object({
    toolName: z.string().min(1),
    staticCapability: StaticCapability,
    sandbox: CapabilitySandboxPosture,
    policyRules: z.array(z.string().min(1)).max(64),
    extensions: NamespacedManifestExtensions.optional(),
  })
  .strict()
  .superRefine((tool, ctx) => {
    if (tool.staticCapability.toolName !== tool.toolName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["staticCapability", "toolName"],
        message: "staticCapability.toolName must match toolName",
      });
    }
  });
export type CapabilityManifestToolT = z.infer<typeof CapabilityManifestTool>;

export const CapabilityManifest = z
  .object({
    manifestVersion: z.literal(CAPABILITY_MANIFEST_VERSION),
    tools: z.array(CapabilityManifestTool).min(1).max(256),
    extensions: NamespacedManifestExtensions.optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    manifest.tools.forEach((tool, index) => {
      if (seen.has(tool.toolName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tools", index, "toolName"],
          message: `duplicate tool manifest entry: ${tool.toolName}`,
        });
      }
      seen.add(tool.toolName);
    });
  });
export type CapabilityManifestT = z.infer<typeof CapabilityManifest>;
