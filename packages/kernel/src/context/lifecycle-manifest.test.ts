import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { type ProjectFs, ProjectReader } from "./project-reader.js";
import {
  LIFECYCLE_MANIFEST_PROJECT_PATH,
  loadLifecycleManifestFromProjectReader,
} from "./lifecycle-manifest.js";

function spyFs(seed: { readonly files?: Record<string, string> }): ProjectFs & { calls: number } {
  const fs = {
    calls: 0,
    listDir: () => [],
    readFile(path: string): string | undefined {
      fs.calls++;
      return seed.files?.[path];
    },
    probeVersion: () => undefined,
    realpath(path: string): string | undefined {
      fs.calls++;
      return path;
    },
  };
  return fs;
}

const VALID_YAML = [
  "schemaVersion: lifecycle.keel.dev/v1",
  "packageManager: pnpm",
  "root: .",
  "actions:",
  "  lint:",
  "    argv: [pnpm, lint]",
  "  test.unit:",
  "    argv: [pnpm, test]",
  "validationTiers:",
  "  standard:",
  "    required: [lint, test.unit]",
  "",
].join("\n");

describe("loadLifecycleManifestFromProjectReader", () => {
  it("does not read .keel/lifecycle.yaml before workspace trust", () => {
    const workspace = "/workspace";
    const path = join(workspace, LIFECYCLE_MANIFEST_PROJECT_PATH);
    const fs = spyFs({ files: { [path]: VALID_YAML } });
    const reader = new ProjectReader(fs, { trusted: false });

    const result = loadLifecycleManifestFromProjectReader(reader, workspace);

    expect(result).toEqual({ kind: "absent" });
    expect(fs.calls).toBe(0);
    expect(reader.accesses).toEqual([{ op: "readFile", target: path, served: false }]);
  });

  it("loads a trusted manifest as inert validated data with a canonical hash", () => {
    const workspace = "/workspace";
    const path = join(workspace, LIFECYCLE_MANIFEST_PROJECT_PATH);
    const fs = spyFs({ files: { [path]: VALID_YAML } });
    const reader = new ProjectReader(fs, { trusted: true });

    const result = loadLifecycleManifestFromProjectReader(reader, workspace);

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") throw new Error("expected loaded lifecycle manifest");
    expect(result.path).toBe(path);
    expect(result.hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.manifest.actions["test.unit"]?.argv).toEqual(["pnpm", "test"]);
    expect(result.publicSummary.actions).toEqual(["lint", "test.unit"]);
    expect(JSON.stringify(result)).not.toContain("process.env");
    expect(reader.accesses).toEqual([{ op: "readFile", target: path, served: true }]);
  });

  it("treats malformed or authority-bearing manifests as inert invalid data", () => {
    const workspace = "/workspace";
    const path = join(workspace, LIFECYCLE_MANIFEST_PROJECT_PATH);
    const fs = spyFs({
      files: {
        [path]: [
          "schemaVersion: lifecycle.keel.dev/v1",
          "actions:",
          "  test.unit:",
          "    argv: [pnpm, test]",
          "egress: [evil.example]",
          "",
        ].join("\n"),
      },
    });
    const reader = new ProjectReader(fs, { trusted: true });

    const result = loadLifecycleManifestFromProjectReader(reader, workspace);

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") throw new Error("expected invalid lifecycle manifest");
    expect(result.path).toBe(path);
    expect(result.message).toContain("lifecycle manifest");
    expect(JSON.stringify(result)).not.toContain("evil.example");
  });

  it("treats YAML parser failures as inert invalid data", () => {
    const workspace = "/workspace";
    const path = join(workspace, LIFECYCLE_MANIFEST_PROJECT_PATH);
    const fs = spyFs({
      files: {
        [path]: ["schemaVersion: lifecycle.keel.dev/v1", "actions:", "  lint: [", ""].join("\n"),
      },
    });
    const reader = new ProjectReader(fs, { trusted: true });

    const result = loadLifecycleManifestFromProjectReader(reader, workspace);

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") throw new Error("expected invalid lifecycle manifest");
    expect(result.message).toContain("could not be parsed");
  });

  it("applies a byte-size cap before parsing hostile manifests", () => {
    const workspace = "/workspace";
    const path = join(workspace, LIFECYCLE_MANIFEST_PROJECT_PATH);
    const fs = spyFs({
      files: { [path]: `schemaVersion: lifecycle.keel.dev/v1\nactions:\n${"x".repeat(70_000)}` },
    });
    const reader = new ProjectReader(fs, { trusted: true });

    const result = loadLifecycleManifestFromProjectReader(reader, workspace);

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") throw new Error("expected invalid lifecycle manifest");
    expect(result.message).toContain("too large");
  });
});
