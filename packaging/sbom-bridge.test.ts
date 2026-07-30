import { describe, expect, it } from "vitest";
import {
  mergeBundledComponentsIntoSyft,
  normalizeCycloneDx,
  normalizeSpdx,
} from "./sbom-bridge.js";

const native = {
  artifacts: [
    {
      id: "root-id",
      name: "keel-harness",
      version: "0.1.0",
      type: "npm",
      foundBy: "javascript-lock-cataloger",
      locations: [{ path: "/package-lock.json", accessPath: "/package-lock.json" }],
      licenses: [{ value: "Apache-2.0", spdxExpression: "Apache-2.0", type: "declared" }],
      language: "javascript",
      cpes: [],
      purl: "pkg:npm/keel-harness@0.1.0",
      metadataType: "javascript-npm-package-lock-entry",
      metadata: {},
    },
  ],
  artifactRelationships: [],
  files: [],
  source: { id: "source", name: "keel-harness", version: "0.1.0", type: "directory" },
  descriptor: { name: "syft", version: "1.49.0" },
  schema: { version: "16.1.10", url: "https://example.invalid/schema.json" },
};

const inventory = {
  version: 2,
  generatedFrom: "bun-metafile",
  graphInputCount: 1,
  graphSha256: "b".repeat(64),
  components: [
    { name: "ink", version: "7.0.5", license: "MIT", source: "npm" },
    {
      name: "@anthropic-ai/sandbox-runtime",
      version: "0.0.59",
      license: "Apache-2.0",
      source: "vendored",
    },
  ],
};

describe("Syft bundled-component bridge", () => {
  it("adds deterministic exact packages and dependency-of-root relationships", () => {
    const merged = mergeBundledComponentsIntoSyft(native, inventory);
    expect(merged.artifacts.map(({ name, version }) => `${name}@${version}`)).toEqual([
      "@anthropic-ai/sandbox-runtime@0.0.59",
      "ink@7.0.5",
      "keel-harness@0.1.0",
    ]);
    for (const name of ["@anthropic-ai/sandbox-runtime", "ink"]) {
      const component = merged.artifacts.find((artifact) => artifact.name === name)!;
      expect(component.purl).toBe(
        `pkg:npm/${name.startsWith("@") ? "%40anthropic-ai/sandbox-runtime" : name}@${component.version}`,
      );
      expect(component.locations).toEqual([
        { path: `/THIRD_PARTY_LICENSES/components.json#${name}@${component.version}` },
      ]);
      expect(merged.artifactRelationships).toContainEqual({
        parent: component.id,
        child: "root-id",
        type: "dependency-of",
      });
    }
    expect(mergeBundledComponentsIntoSyft(native, inventory)).toEqual(merged);
    expect(JSON.stringify(merged)).not.toContain("package-lock.json");
    expect(JSON.stringify(merged)).toContain("npm-shrinkwrap.json");
  });

  it("does not duplicate a lock-resolved package and fails on invalid inventory", () => {
    const withInk = {
      ...native,
      artifacts: [
        ...native.artifacts,
        {
          ...native.artifacts[0],
          id: "ink-lock-id",
          name: "ink",
          version: "7.0.5",
          purl: "pkg:npm/ink@7.0.5",
        },
      ],
    };
    expect(
      mergeBundledComponentsIntoSyft(withInk, inventory).artifacts.filter(
        ({ name, version }) => name === "ink" && version === "7.0.5",
      ),
    ).toHaveLength(1);
    expect(() =>
      mergeBundledComponentsIntoSyft(native, {
        ...inventory,
        components: [{ name: "bad", version: "^1.0.0", license: "GPL-3.0", source: "npm" }],
      }),
    ).toThrow("unsupported bundled license");
  });

  it("normalizes both standards documents to the exact source, time, and tarball digest", () => {
    const identity = {
      version: "0.1.0",
      sourceCommit: "1".repeat(40),
      sourceDateEpoch: 1_775_000_000,
      tarballSha256: "a".repeat(64),
    };
    const spdx = normalizeSpdx(
      {
        name: ".",
        documentNamespace: "https://anchore.invalid/random",
        creationInfo: { created: "now" },
        packages: [{ name: "keel-harness", versionInfo: "0.1.0" }],
      },
      identity,
    );
    expect(spdx).toMatchObject({
      name: "keel-harness-0.1.0",
      documentNamespace: `https://github.com/keel-harness/keel/sbom/${identity.sourceCommit}/${identity.tarballSha256}/spdx`,
      packages: [
        {
          name: "keel-harness",
          versionInfo: "0.1.0",
          checksums: [{ algorithm: "SHA256", checksumValue: identity.tarballSha256 }],
        },
      ],
    });
    expect((spdx.creationInfo as { created: string }).created).toBe("2026-03-31T23:33:20.000Z");

    const cycloneDx = normalizeCycloneDx(
      {
        serialNumber: "urn:uuid:random",
        metadata: { timestamp: "now", component: { name: "." } },
        components: [{ name: "keel-harness", version: "0.1.0" }],
      },
      identity,
    );
    expect(cycloneDx).toMatchObject({
      serialNumber: "urn:uuid:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      metadata: {
        timestamp: "2026-03-31T23:33:20.000Z",
        component: {
          type: "application",
          name: "keel-harness",
          version: "0.1.0",
          purl: "pkg:npm/keel-harness@0.1.0",
          hashes: [{ alg: "SHA-256", content: identity.tarballSha256 }],
        },
      },
    });
  });
});
