import { describe, expect, it } from "vitest";
import {
  CAPABILITY_MANIFEST_VERSION,
  CapabilityManifest,
  type CapabilityManifestT,
} from "./capability-manifest.js";

const bashManifest: CapabilityManifestT = {
  manifestVersion: CAPABILITY_MANIFEST_VERSION,
  tools: [
    {
      toolName: "bash",
      staticCapability: {
        toolName: "bash",
        effectEnvelope: ["fs_read", "fs_write", "network_read", "network_write", "process_exec"],
        broad: true,
      },
      sandbox: {
        filesystem: {
          allowRead: ["workspace", "declared_temp"],
          allowWrite: ["workspace", "declared_temp"],
          denyRead: [
            "home_secret_roots",
            "keel_config",
            "keel_audit",
            "keel_policy",
            "workspace_dotenv_files",
          ],
          denyWrite: ["keel_audit", "keel_policy", "keel_config"],
        },
        network: { allowedDomains: [] },
      },
      policyRules: ["phase2a.bash.default"],
    },
  ],
};
const bashTool = bashManifest.tools[0]!;

describe("CapabilityManifest schema", () => {
  it("parses the Phase-2A manifest shape over the frozen side-effect taxonomy", () => {
    expect(CapabilityManifest.parse(bashManifest)).toEqual(bashManifest);
  });

  it("accepts additive execution-metadata write protections without invalidating v1 manifests", () => {
    const hardened = {
      ...bashManifest,
      tools: [
        {
          ...bashTool,
          sandbox: {
            ...bashTool.sandbox,
            filesystem: {
              ...bashTool.sandbox.filesystem,
              denyWrite: [
                ...bashTool.sandbox.filesystem.denyWrite,
                "workspace_package_manager_execution_metadata",
                "workspace_vcs_execution_metadata",
              ],
            },
          },
        },
      ],
    };

    expect(CapabilityManifest.parse(hardened)).toEqual(hardened);
    expect(CapabilityManifest.parse(bashManifest)).toEqual(bashManifest);
  });

  it("supports additive namespaced fork/enterprise extensions without changing keel core", () => {
    const parsed = CapabilityManifest.parse({
      ...bashManifest,
      extensions: {
        "com.example.enterprise": {
          controls: ["internal-review"],
        },
      },
      tools: [
        {
          ...bashTool,
          extensions: {
            "com.example.enterprise/bash": {
              owner: "platform-security",
            },
          },
        },
      ],
    });

    expect(parsed.extensions?.["com.example.enterprise"]).toEqual({
      controls: ["internal-review"],
    });
    expect(parsed.tools[0]!.extensions?.["com.example.enterprise/bash"]).toEqual({
      owner: "platform-security",
    });
  });

  it("rejects duplicate tool entries and static-capability drift", () => {
    expect(() =>
      CapabilityManifest.parse({
        ...bashManifest,
        tools: [bashManifest.tools[0], bashManifest.tools[0]],
      }),
    ).toThrow(/duplicate tool/i);

    expect(() =>
      CapabilityManifest.parse({
        ...bashManifest,
        tools: [
          {
            ...bashTool,
            staticCapability: { ...bashTool.staticCapability, toolName: "read" },
          },
        ],
      }),
    ).toThrow(/staticCapability.toolName/i);
  });

  it("rejects unnamespaced extension keys and unsafe filesystem token placement", () => {
    expect(() =>
      CapabilityManifest.parse({
        ...bashManifest,
        extensions: { enterprise: { controls: [] } },
      }),
    ).toThrow(/namespaced/i);

    expect(() =>
      CapabilityManifest.parse({
        ...bashManifest,
        tools: [
          {
            ...bashTool,
            sandbox: {
              ...bashTool.sandbox,
              filesystem: {
                ...bashTool.sandbox.filesystem,
                allowWrite: ["workspace", "home_secret_roots"],
              },
            },
          },
        ],
      }),
    ).toThrow(/Invalid enum value|expected/i);
  });
});
