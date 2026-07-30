#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { KEEL_VERSION } from "../packages/kernel/src/version.ts";
import {
  parseNpmPackOutput,
  sbomCompletenessProblems,
  shrinkwrapPackageIdentities,
  type PackageIdentity,
} from "./release-artifacts.ts";
import {
  assertReleaseContext,
  candidateMetadata,
  releasePacklistProblems,
  type ReleaseContext,
} from "./release-candidate.ts";
import {
  PUBLIC_PACKAGE_NAME,
  PUBLIC_REPOSITORY,
  publicManifestProblems,
} from "./release-metadata.ts";
import {
  mergeBundledComponentsIntoSyft,
  normalizeCycloneDx,
  normalizeSpdx,
  type BundledInventory,
  type SyftNativeDocument,
} from "./sbom-bridge.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const NPX_DIR = join(REPO_ROOT, "build", "npx");
const RELEASE_DIR = join(REPO_ROOT, "build", "release");
const SIMULATE = process.env["KEEL_RELEASE_SIMULATE"] === "1";

function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> } = {},
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${String(result.status)}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function git(args: readonly string[]): string {
  return run("git", args);
}

function registryVersionExists(): boolean {
  const result = spawnSync(
    "npm",
    ["view", `${PUBLIC_PACKAGE_NAME}@${KEEL_VERSION}`, "version", "--json"],
    { cwd: REPO_ROOT, encoding: "utf8", env: process.env },
  );
  if (result.status === 0) return result.stdout.trim().length > 0;
  if (/E404|404 Not Found|No match found/iu.test(result.stderr)) return false;
  throw new Error(`npm registry version check failed: ${result.stderr.trim()}`);
}

function readContext(): ReleaseContext {
  const tag = SIMULATE ? `v${KEEL_VERSION}` : (process.env["GITHUB_REF_NAME"] ?? "");
  if (!SIMULATE && process.env["GITHUB_REF_TYPE"] !== "tag") {
    throw new Error("release workflow is not running for a tag");
  }
  const headCommit = SIMULATE ? git(["rev-parse", "HEAD"]) : git(["rev-list", "-n", "1", tag]);
  return {
    version: KEEL_VERSION,
    tag,
    tagObjectType: SIMULATE ? "tag" : git(["cat-file", "-t", tag]),
    headCommit,
    mainCommit: SIMULATE ? headCommit : git(["rev-parse", "origin/main"]),
    repository: SIMULATE ? PUBLIC_REPOSITORY : (process.env["GITHUB_REPOSITORY"] ?? ""),
    sourceDirty: git(["status", "--porcelain", "--untracked-files=normal"]).length > 0,
    registryVersionExists: SIMULATE ? false : registryVersionExists(),
  };
}

function assertPinnedReleaseToolchain(): void {
  if (SIMULATE) return;
  if (process.version !== "v24.18.1") {
    throw new Error(`release requires Node 24.18.1, received ${process.version}`);
  }
  const npmVersion = run("npm", ["--version"]);
  if (npmVersion !== "11.16.0") {
    throw new Error(`release requires npm 11.16.0, received ${npmVersion}`);
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function uniqueIdentities(values: readonly PackageIdentity[]): PackageIdentity[] {
  const unique = new Map(
    values.map((identity) => [`${identity.name}@${identity.version}`, identity]),
  );
  return [...unique.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  );
}

async function assertContextCommand(): Promise<void> {
  assertPinnedReleaseToolchain();
  const context = readContext();
  assertReleaseContext(context);
  process.stdout.write(
    `${SIMULATE ? "simulated " : ""}release context accepted: ${context.tag} @ ${context.headCommit}\n`,
  );
}

async function packReleaseCandidate(): Promise<void> {
  assertPinnedReleaseToolchain();
  const context = readContext();
  assertReleaseContext(context);
  const sourceDateEpoch = Number.parseInt(
    git(["show", "-s", "--format=%ct", context.headCommit]),
    10,
  );
  if (!Number.isSafeInteger(sourceDateEpoch))
    throw new Error("source commit has no valid timestamp");

  const manifestPath = join(NPX_DIR, "package.json");
  const manifest = await readJson(manifestPath);
  const manifestProblems = publicManifestProblems(manifest);
  if (manifestProblems.length > 0) throw new Error(manifestProblems.join("; "));
  const source = manifest["keelSource"] as Record<string, unknown> | undefined;
  if (
    manifest["version"] !== context.version ||
    source?.["commit"] !== context.headCommit ||
    source?.["dirty"] !== false
  ) {
    throw new Error("generated carrier source identity does not match the release context");
  }

  run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: NPX_DIR,
  });
  run("npm", ["shrinkwrap", "--ignore-scripts"], { cwd: NPX_DIR });
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: NPX_DIR });
  run("npm", ["audit", "--omit=dev", "--audit-level=high"], { cwd: NPX_DIR });
  const shrinkwrapPath = join(NPX_DIR, "npm-shrinkwrap.json");
  const shrinkwrap = await readJson(shrinkwrapPath);
  const inventory = (await readJson(
    join(NPX_DIR, "THIRD_PARTY_LICENSES", "components.json"),
  )) as BundledInventory;

  await rm(RELEASE_DIR, { recursive: true, force: true });
  await mkdir(RELEASE_DIR, { recursive: true });
  const syft = process.env["SYFT_BIN"] ?? "syft";
  const nativePath = join(RELEASE_DIR, `keel-harness-${context.version}.syft.json`);
  const mergedPath = join(RELEASE_DIR, `keel-harness-${context.version}.merged.syft.json`);
  const syftEnv = {
    SYFT_CHECK_FOR_APP_UPDATE: "false",
    SYFT_CACHE_DIR: join(RELEASE_DIR, ".syft-cache"),
  };
  // Syft 1.49's JavaScript cataloger recognizes package-lock.json but not npm-shrinkwrap.json.
  // Mirror the exact bytes only during the scan, then remove the non-publishable filename before
  // npm pack. npm-shrinkwrap.json remains the carrier's sole lock authority.
  const syftLockMirrorPath = join(NPX_DIR, "package-lock.json");
  await copyFile(shrinkwrapPath, syftLockMirrorPath);
  try {
    run(
      syft,
      [
        "scan",
        `dir:${NPX_DIR}`,
        "--source-name",
        `${PUBLIC_PACKAGE_NAME}-release-tree`,
        "--source-version",
        context.version,
        "-o",
        `syft-json=${nativePath}`,
        "--quiet",
      ],
      { env: syftEnv },
    );
  } finally {
    await rm(syftLockMirrorPath, { force: true });
  }
  const nativeDocument = (await readJson(nativePath)) as SyftNativeDocument;
  const mergedDocument = mergeBundledComponentsIntoSyft(nativeDocument, inventory);
  await writeFile(mergedPath, JSON.stringify(mergedDocument, null, 2) + "\n");

  const packOutput = run(
    "npm",
    ["pack", "--json", "--ignore-scripts", `--pack-destination=${RELEASE_DIR}`],
    { cwd: NPX_DIR },
  );
  const packed = parseNpmPackOutput(packOutput, context.version);
  const tarballPath = join(RELEASE_DIR, packed.filename);
  const actualMembers = run("tar", ["-tzf", tarballPath])
    .split("\n")
    .filter((member) => member.length > 0 && !member.endsWith("/"));
  const actualProblems = releasePacklistProblems(actualMembers);
  if (actualProblems.length > 0) throw new Error(actualProblems.join("; "));
  if (JSON.stringify([...actualMembers].sort()) !== JSON.stringify([...packed.members].sort())) {
    throw new Error("npm pack JSON inventory does not match the actual tarball members");
  }
  const digest = await sha256(tarballPath);

  const spdxPath = join(RELEASE_DIR, `keel-harness-${context.version}.spdx.json`);
  const cyclonePath = join(RELEASE_DIR, `keel-harness-${context.version}.cdx.json`);
  run(
    syft,
    ["convert", mergedPath, "-o", `spdx-json=${spdxPath}`, "-o", `cyclonedx-json=${cyclonePath}`],
    { env: syftEnv },
  );
  const sbomIdentity = {
    version: context.version,
    sourceCommit: context.headCommit,
    sourceDateEpoch,
    tarballSha256: digest,
  };
  const spdx = normalizeSpdx(await readJson(spdxPath), sbomIdentity);
  const cycloneDx = normalizeCycloneDx(await readJson(cyclonePath), sbomIdentity);
  await writeFile(spdxPath, JSON.stringify(spdx, null, 2) + "\n");
  await writeFile(cyclonePath, JSON.stringify(cycloneDx, null, 2) + "\n");

  const bundledIdentities = inventory.components.map(({ name, version }) => ({ name, version }));
  const expected = uniqueIdentities([
    ...shrinkwrapPackageIdentities(shrinkwrap),
    ...bundledIdentities,
  ]);
  const sbomProblems = sbomCompletenessProblems(spdx, cycloneDx, expected, digest);
  if (sbomProblems.length > 0) throw new Error(sbomProblems.join("; "));

  const metadata = {
    ...candidateMetadata({
      ...context,
      tarball: packed.filename,
      tarballSha256: digest,
    }),
    sourceDateEpoch,
    sbom: {
      spdx: basename(spdxPath),
      cycloneDx: basename(cyclonePath),
      packageCount: expected.length,
      bundledComponentCount: inventory.components.length,
      syftVersion: "1.49.0",
    },
  };
  await writeFile(
    join(RELEASE_DIR, `keel-harness-${context.version}.candidate.json`),
    JSON.stringify(metadata, null, 2) + "\n",
  );
  await writeFile(join(RELEASE_DIR, "SHA256SUMS"), `${digest}  ${packed.filename}\n`);
  await copyFile(
    join(NPX_DIR, "THIRD_PARTY_LICENSES", "components.json"),
    join(RELEASE_DIR, `keel-harness-${context.version}.components.json`),
  );
  process.stdout.write(
    `${SIMULATE ? "simulated " : ""}release candidate: ${packed.filename} sha256:${digest}\n`,
  );
}

const command = process.argv[2];
try {
  if (command === "assert-release-context") {
    await assertContextCommand();
  } else if (command === "pack-release-candidate") {
    await packReleaseCandidate();
  } else {
    throw new Error("usage: release-cli.ts <assert-release-context|pack-release-candidate>");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`release error: ${message}\n`);
  process.exitCode = 1;
}
