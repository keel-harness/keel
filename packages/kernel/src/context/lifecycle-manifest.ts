import { join } from "node:path";
import yaml from "yaml";
import {
  LifecycleManifest,
  canonicalLifecycleManifestHash,
  lifecycleActionIds,
  lifecycleManifestPublicSummary,
  type LifecycleManifestPublicSummary,
  type LifecycleManifestT,
} from "@keel/shared";
import type { ToolSpecT } from "@keel/shared";
import type { ProjectReader } from "./project-reader.js";

export const LIFECYCLE_MANIFEST_PROJECT_PATH = ".keel/lifecycle.yaml";
export const MAX_LIFECYCLE_MANIFEST_BYTES = 64 * 1024;
const { parseDocument } = yaml;

export interface LoadedLifecycleManifest {
  readonly kind: "loaded";
  readonly path: string;
  readonly manifest: LifecycleManifestT;
  readonly hash: string;
  readonly publicSummary: LifecycleManifestPublicSummary;
}

export interface InvalidLifecycleManifest {
  readonly kind: "invalid";
  readonly path: string;
  readonly message: string;
}

export type LifecycleManifestLoadResult =
  | { readonly kind: "absent" }
  | InvalidLifecycleManifest
  | LoadedLifecycleManifest;

export interface WardenLifecycleManifestEnv {
  readonly manifest: LifecycleManifestT;
  readonly hash: string;
}

function lifecycleManifestPath(workspaceRoot: string): string {
  return join(workspaceRoot, LIFECYCLE_MANIFEST_PROJECT_PATH);
}

function invalid(path: string, message: string): InvalidLifecycleManifest {
  return { kind: "invalid", path, message: `lifecycle manifest ${message}` };
}

function parseYamlDocument(raw: string): unknown {
  const document = parseDocument(raw, {
    keepBlobsInJSON: false,
    maxAliasCount: 0,
    prettyErrors: false,
  });
  if (document.errors.length > 0) {
    throw new Error("YAML parse failed");
  }
  return document.toJSON();
}

function issueSummary(issues: readonly { readonly path: readonly (string | number)[] }[]): string {
  const paths = issues
    .map((issue) => issue.path.join("."))
    .filter((path) => path !== "")
    .slice(0, 5);
  return paths.length === 0 ? "schema rejected" : `schema rejected at ${paths.join(", ")}`;
}

export function loadLifecycleManifestFromProjectReader(
  reader: ProjectReader,
  workspaceRoot: string,
): LifecycleManifestLoadResult {
  const path = lifecycleManifestPath(workspaceRoot);
  const raw = reader.readFile(path);
  if (raw === undefined) return { kind: "absent" };
  if (Buffer.byteLength(raw, "utf8") > MAX_LIFECYCLE_MANIFEST_BYTES) {
    return invalid(path, "is too large");
  }
  let parsedYaml: unknown;
  try {
    parsedYaml = parseYamlDocument(raw);
  } catch {
    return invalid(path, "could not be parsed");
  }
  const parsed = LifecycleManifest.safeParse(parsedYaml);
  if (!parsed.success) {
    return invalid(path, issueSummary(parsed.error.issues));
  }
  const hash = canonicalLifecycleManifestHash(parsed.data);
  return {
    kind: "loaded",
    path,
    manifest: parsed.data,
    hash,
    publicSummary: lifecycleManifestPublicSummary(parsed.data),
  };
}

export function lifecycleManifestEnvValue(loaded: LoadedLifecycleManifest): string {
  const value: WardenLifecycleManifestEnv = {
    manifest: loaded.manifest,
    hash: loaded.hash,
  };
  return JSON.stringify(value);
}

export function lifecycleToolSpecForManifest(manifest: LifecycleManifestT): ToolSpecT {
  const actions = lifecycleActionIds(manifest);
  return {
    name: "lifecycle.run",
    description:
      "Run a trusted repo lifecycle action through the spawned keel warden. The warden resolves the " +
      "configured argv from .keel/lifecycle.yaml and still applies normal governed-bash policy, " +
      "sandbox, egress, and audit.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: actions,
          description: "Lifecycle action id from the trusted manifest.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}
