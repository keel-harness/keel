#!/usr/bin/env node
/* global console, process */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MINIMUM_RELEASE_AGE_MINUTES = 10_080;
const MINIMUM_PNPM_FOR_RELEASE_AGE = [10, 16, 0];

const ALLOWED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
]);

const APPROVED_INSTALLED_PACKAGE_EXCEPTIONS = new Map([
  [
    "argparse@2.0.1",
    {
      license: "Python-2.0",
      reason: "dev-tooling transitive via eslint/js-yaml; exact-pinned and not bundled at runtime",
    },
  ],
  [
    "jackspeak@3.4.3",
    {
      license: "BlueOak-1.0.0",
      reason: "dev-tooling transitive via minimatch/glob; exact-pinned and not bundled at runtime",
    },
  ],
  [
    "minimatch@10.2.5",
    {
      license: "BlueOak-1.0.0",
      reason:
        "dev-tooling transitive via typescript-eslint/test-exclude; exact-pinned and not bundled at runtime",
    },
  ],
  [
    "minipass@7.1.3",
    {
      license: "BlueOak-1.0.0",
      reason:
        "dev-tooling transitive via minimatch/path-scurry; exact-pinned and not bundled at runtime",
    },
  ],
  [
    "package-json-from-dist@1.0.1",
    {
      license: "BlueOak-1.0.0",
      reason: "dev-tooling transitive via path-scurry; exact-pinned and not bundled at runtime",
    },
  ],
  [
    "path-scurry@1.11.1",
    {
      license: "BlueOak-1.0.0",
      reason: "dev-tooling transitive via minimatch; exact-pinned and not bundled at runtime",
    },
  ],
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
  throw new Error(message);
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  if (match === null) fail(`unsupported pnpm version string ${JSON.stringify(version)}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i += 1) {
    const delta = left[i] - right[i];
    if (delta !== 0) return delta;
  }
  return 0;
}

function checkPnpmMinimumReleaseAge() {
  const pkg = readJson(join(REPO_ROOT, "package.json"));
  const packageManager = pkg.packageManager;
  if (typeof packageManager !== "string") fail("package.json must set packageManager");
  const match = /^pnpm@(.+)$/u.exec(packageManager);
  if (match === null) fail(`packageManager must pin pnpm, got ${JSON.stringify(packageManager)}`);
  const version = parseVersion(match[1]);
  if (compareVersions(version, MINIMUM_PNPM_FOR_RELEASE_AGE) < 0) {
    fail(
      `packageManager ${packageManager} cannot enforce minimumReleaseAge; require pnpm >= ${MINIMUM_PNPM_FOR_RELEASE_AGE.join(
        ".",
      )}`,
    );
  }

  const workspaceYaml = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const minimumAgePattern = new RegExp(
    `^minimumReleaseAge:\\s*${String(MINIMUM_RELEASE_AGE_MINUTES)}\\s*(?:#.*)?$`,
    "mu",
  );
  if (!minimumAgePattern.test(workspaceYaml)) {
    fail(`pnpm-workspace.yaml must set minimumReleaseAge: ${String(MINIMUM_RELEASE_AGE_MINUTES)}`);
  }

  const npmrc = readFileSync(join(REPO_ROOT, ".npmrc"), "utf8");
  if (/^minimum-release-age\s*=/mu.test(npmrc)) {
    fail("minimum-release-age belongs in pnpm-workspace.yaml as minimumReleaseAge");
  }
}

function licenseValue(pkg) {
  if (typeof pkg.license === "string" && pkg.license.trim().length > 0) return pkg.license.trim();
  if (Array.isArray(pkg.licenses)) {
    const values = pkg.licenses
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object" && typeof entry.type === "string") {
          return entry.type;
        }
        return undefined;
      })
      .filter((entry) => typeof entry === "string" && entry.length > 0);
    if (values.length > 0) return values.join(" OR ");
  }
  return undefined;
}

function licenseTokenAllowed(token) {
  const normalized = token.trim().replace(/^\(+|\)+$/gu, "");
  return ALLOWED_LICENSES.has(normalized);
}

function licenseExpressionAllowed(expression) {
  const normalized = expression
    .replace(/\bWITH\b.+$/iu, "")
    .replace(/[()]/gu, " ")
    .trim();
  if (normalized.length === 0) return false;
  return normalized.split(/\s+OR\s+/iu).some((branch) =>
    branch
      .split(/\s+AND\s+/iu)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .every(licenseTokenAllowed),
  );
}

function packageLabel(pkg) {
  const name = typeof pkg.name === "string" ? pkg.name : "(unknown)";
  const version = typeof pkg.version === "string" ? pkg.version : "(unknown)";
  return `${name}@${version}`;
}

function checkWorkspacePackageLicenses() {
  const packagePaths = [join(REPO_ROOT, "package.json")];
  const packagesDir = join(REPO_ROOT, "packages");
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, "package.json");
    if (existsSync(manifestPath)) packagePaths.push(manifestPath);
  }

  const failures = [];
  for (const path of packagePaths) {
    const pkg = readJson(path);
    const license = licenseValue(pkg);
    if (license === undefined || !licenseExpressionAllowed(license)) {
      failures.push(
        `${path}: ${packageLabel(pkg)} has unsupported license ${license ?? "(missing)"}`,
      );
    }
  }
  if (failures.length > 0) fail(failures.join("\n"));
  return packagePaths.length;
}

function installedPackageManifests() {
  const storeDir = join(REPO_ROOT, "node_modules", ".pnpm");
  if (!existsSync(storeDir)) fail("node_modules/.pnpm is missing; run pnpm install first");
  const paths = new Map();

  for (const storeEntry of readdirSync(storeDir, { withFileTypes: true })) {
    if (!storeEntry.isDirectory() || storeEntry.name === "node_modules") continue;
    const nodeModulesDir = join(storeDir, storeEntry.name, "node_modules");
    if (!existsSync(nodeModulesDir)) continue;

    for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        const scopeDir = join(nodeModulesDir, entry.name);
        for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
          if (!scoped.isDirectory()) continue;
          const manifestPath = join(scopeDir, scoped.name, "package.json");
          if (!existsSync(manifestPath)) continue;
          const pkg = readJson(manifestPath);
          paths.set(packageLabel(pkg), manifestPath);
        }
      } else {
        const manifestPath = join(nodeModulesDir, entry.name, "package.json");
        if (!existsSync(manifestPath)) continue;
        const pkg = readJson(manifestPath);
        paths.set(packageLabel(pkg), manifestPath);
      }
    }
  }

  return [...paths.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function approvedInstalledException(label, license) {
  const exception = APPROVED_INSTALLED_PACKAGE_EXCEPTIONS.get(label);
  if (exception === undefined) return undefined;
  return exception.license === license ? exception : undefined;
}

function checkInstalledPackageLicenses() {
  const manifests = installedPackageManifests();
  const failures = [];
  const exceptions = [];

  for (const [label, manifestPath] of manifests) {
    const pkg = readJson(manifestPath);
    const license = licenseValue(pkg);
    const exception =
      license === undefined ? undefined : approvedInstalledException(label, license);
    if (license !== undefined && exception !== undefined) {
      exceptions.push(`${label} (${license}): ${exception.reason}`);
    } else if (license === undefined || !licenseExpressionAllowed(license)) {
      failures.push(`${label}: unsupported license ${license ?? "(missing)"} (${manifestPath})`);
    }
  }

  if (failures.length > 0) fail(failures.join("\n"));
  return { packageCount: manifests.length, exceptionCount: exceptions.length };
}

try {
  checkPnpmMinimumReleaseAge();
  const workspaceCount = checkWorkspacePackageLicenses();
  const { packageCount: installedCount, exceptionCount } = checkInstalledPackageLicenses();
  console.log(
    `supply-chain: checked minimumReleaseAge=${String(
      MINIMUM_RELEASE_AGE_MINUTES,
    )}, ${String(workspaceCount)} workspace manifests, ${String(installedCount)} installed packages, ${String(
      exceptionCount,
    )} exact installed-package license exceptions`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
