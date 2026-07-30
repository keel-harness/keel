import { describe, expect, it } from "vitest";
import {
  parseNpmPackOutput,
  sbomCompletenessProblems,
  shrinkwrapPackageIdentities,
} from "./release-artifacts.js";

describe("release artifact closure", () => {
  it("accepts one exact npm pack result and its narrow member set", () => {
    const result = parseNpmPackOutput(
      JSON.stringify([
        {
          filename: "keel-harness-0.1.0.tgz",
          files: [
            { path: "package.json" },
            { path: "README.md" },
            { path: "npm-shrinkwrap.json" },
            { path: "LICENSE" },
            { path: "NOTICE" },
            { path: "bin/keel.mjs" },
            { path: "bin/keel-kernel.mjs" },
            { path: "bin/keel-warden.mjs" },
            { path: "THIRD_PARTY_LICENSES/components.json" },
          ],
        },
      ]),
      "0.1.0",
    );
    expect(result.filename).toBe("keel-harness-0.1.0.tgz");
    expect(() => parseNpmPackOutput("[]", "0.1.0")).toThrow("exactly one npm pack result");
    expect(() =>
      parseNpmPackOutput(
        JSON.stringify([
          {
            filename: "keel-harness-0.1.0.tgz",
            files: [{ path: "src/private.ts" }],
          },
        ]),
        "0.1.0",
      ),
    ).toThrow("unexpected tarball member");
  });

  it("derives production identities from npm shrinkwrap without dev-only packages", () => {
    expect(
      shrinkwrapPackageIdentities({
        packages: {
          "": { name: "keel-harness", version: "0.1.0" },
          "node_modules/zod": { version: "3.25.76" },
          "node_modules/@scope/pkg": { version: "1.2.3" },
          "node_modules/dev-only": { version: "9.9.9", dev: true },
        },
      }),
    ).toEqual([
      { name: "@scope/pkg", version: "1.2.3" },
      { name: "keel-harness", version: "0.1.0" },
      { name: "zod", version: "3.25.76" },
    ]);
  });

  it("requires every external and bundled package plus the tarball digest in both standards", () => {
    const expected = [
      { name: "keel-harness", version: "0.1.0" },
      { name: "zod", version: "3.25.76" },
      { name: "ink", version: "7.0.5" },
    ];
    const digest = "a".repeat(64);
    const spdx = {
      packages: expected.map(({ name, version }) => ({
        name,
        versionInfo: version,
        ...(name === "keel-harness"
          ? { checksums: [{ algorithm: "SHA256", checksumValue: digest }] }
          : {}),
      })),
    };
    const cycloneDx = {
      metadata: {
        component: {
          name: "keel-harness",
          version: "0.1.0",
          hashes: [{ alg: "SHA-256", content: digest }],
        },
      },
      components: expected.map(({ name, version }) => ({ name, version })),
    };
    expect(sbomCompletenessProblems(spdx, cycloneDx, expected, digest)).toEqual([]);
    expect(
      sbomCompletenessProblems(
        { ...spdx, packages: spdx.packages.filter(({ name }) => name !== "ink") },
        cycloneDx,
        expected,
        digest,
      ),
    ).toContain("SPDX missing ink@7.0.5");
    expect(
      sbomCompletenessProblems(
        spdx,
        { ...cycloneDx, metadata: { component: { name: "keel-harness" } } },
        expected,
        digest,
      ),
    ).toContain("CycloneDX root is not bound to the tarball SHA-256");
    expect(
      sbomCompletenessProblems(
        {
          ...spdx,
          packages: [...spdx.packages, { name: "unexpected", versionInfo: "1.0.0" }],
        },
        cycloneDx,
        expected,
        digest,
      ),
    ).toContain("SPDX unexpected unexpected@1.0.0");
    expect(
      sbomCompletenessProblems(
        spdx,
        { ...cycloneDx, components: [...cycloneDx.components, cycloneDx.components[1]] },
        expected,
        digest,
      ),
    ).toContain("CycloneDX duplicate zod@3.25.76");
  });

  it("rejects private archive and absolute builder paths in public evidence", () => {
    expect(
      sbomCompletenessProblems(
        { packages: [], sourceInfo: "/Users/private-builder/private-repo" },
        { components: [], repository: "https://github.com/private-owner/keel.git" },
        [],
        "a".repeat(64),
      ),
    ).toEqual(
      expect.arrayContaining([
        "SPDX contains a private or absolute builder path",
        "CycloneDX contains a private or absolute builder path",
      ]),
    );
  });
});
