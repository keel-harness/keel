#!/usr/bin/env node
/* global console, URL */
import { access, readFile } from "node:fs/promises";

const root = new URL("../..", import.meta.url);
const vendorDir = new URL("vendor/sandbox-runtime/", root);

const expected = {
  name: "@anthropic-ai/sandbox-runtime",
  version: "0.0.59",
  license: "Apache-2.0",
  repository: "git+https://github.com/anthropic-experimental/sandbox-runtime.git",
  requiredSubpaths: [
    "LICENSE",
    "README.md",
    "VENDOR.md",
    "patches/wait-for-linux-proxy-readiness.patch",
    "package.json",
    "package-lock.json",
    "src/index.ts",
    "src/sandbox/sandbox-manager.ts",
    "src/sandbox/linux-sandbox-utils.ts",
    "src/sandbox/macos-sandbox-utils.ts",
    "src/sandbox/windows-sandbox-utils.ts",
    "test/sandbox/wrap-with-sandbox.test.ts",
    "test/sandbox/linux-proxy-readiness.test.ts",
    "vendor/seccomp-src/apply-seccomp.c",
    "vendor/srt-win-src/Cargo.toml",
  ],
  excludedSubpaths: [
    ".git",
    ".github",
    ".husky",
    ".vscode",
    ".dockerignore",
    ".gitignore",
    ".npmrc",
    ".prettierrc.json",
    "NOTICE",
  ],
  runtimeDependencyLicenses: {
    "@pondwader/socks5-server": "MIT",
    commander: "MIT",
    "node-forge": "(BSD-3-Clause OR GPL-2.0)",
    "shell-quote": "MIT",
    zod: "MIT",
  },
};

async function exists(relativePath) {
  try {
    await access(new URL(relativePath, vendorDir));
    return true;
  } catch {
    return false;
  }
}

async function readJson(relativePath) {
  const content = await readFile(new URL(relativePath, vendorDir), "utf8");
  return JSON.parse(content);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const packageJson = await readJson("package.json");
assert(packageJson.name === expected.name, `unexpected package name: ${packageJson.name}`);
assert(packageJson.version === expected.version, `unexpected package version: ${packageJson.version}`);
assert(packageJson.license === expected.license, `unexpected package license: ${packageJson.license}`);
assert(
  packageJson.repository?.url === expected.repository,
  `unexpected package repository: ${packageJson.repository?.url ?? "<missing>"}`,
);

const lockfile = await readJson("package-lock.json");
assert(lockfile.packages?.[""]?.license === expected.license, "root lockfile license mismatch");
for (const [name, license] of Object.entries(expected.runtimeDependencyLicenses)) {
  const entry = lockfile.packages?.[`node_modules/${name}`];
  assert(entry !== undefined, `missing runtime dependency in lockfile: ${name}`);
  assert(entry.license === license, `unexpected license for ${name}: ${entry.license}`);
}

for (const path of expected.requiredSubpaths) {
  assert(await exists(path), `missing vendored subpath: ${path}`);
}

for (const path of expected.excludedSubpaths) {
  assert(!(await exists(path)), `excluded upstream subpath is present: ${path}`);
}

const licenseText = await readFile(new URL("LICENSE", vendorDir), "utf8");
assert(licenseText.includes("Apache License"), "LICENSE does not look like Apache-2.0 text");

console.log(
  `sandbox-runtime vendor verified: ${expected.name}@${expected.version} (${expected.license})`,
);
