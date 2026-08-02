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
    "patches/connect-time-destination-resolver.patch",
    "patches/read-hidden-write-deny.patch",
    "patches/wait-for-linux-proxy-readiness.patch",
    "patches/reemit-macos-glob-read-denies.patch",
    "package.json",
    "package-lock.json",
    "src/index.ts",
    "src/sandbox/destination-dial.ts",
    "src/sandbox/http-proxy.ts",
    "src/sandbox/sandbox-manager.ts",
    "src/sandbox/linux-sandbox-utils.ts",
    "src/sandbox/macos-sandbox-utils.ts",
    "src/sandbox/windows-sandbox-utils.ts",
    "test/sandbox/wrap-with-sandbox.test.ts",
    "test/sandbox/linux-proxy-readiness.test.ts",
    "test/sandbox/destination-dial.test.ts",
    "test/sandbox/destination-guard-proxy.test.ts",
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

const resolverPatch = await readFile(
  new URL("patches/connect-time-destination-resolver.patch", vendorDir),
  "utf8",
);
for (const requiredPath of [
  "src/sandbox/destination-dial.ts",
  "src/sandbox/http-proxy.ts",
  "src/sandbox/socks-proxy.ts",
  "src/sandbox/tls-terminate-proxy.ts",
  "src/sandbox/sandbox-manager.ts",
]) {
  assert(resolverPatch.includes(requiredPath), `resolver patch omits ${requiredPath}`);
}
for (const [path, token] of [
  ["src/sandbox/destination-dial.ts", "prepareDestinationDial"],
  ["src/sandbox/destination-dial.ts", "MAX_CONCURRENT_GUARDED_CONNECTIONS"],
  ["src/sandbox/destination-dial.ts", "TOTAL_GUARDED_DIAL_TIMEOUT_MS"],
  ["src/sandbox/destination-dial.ts", "trackPreparedDestinationRequest"],
  ["src/sandbox/http-proxy.ts", "blocked-address-policy"],
  ["src/sandbox/http-proxy.ts", "trackPreparedDestinationRequest"],
  ["src/sandbox/socks-proxy.ts", "resolveDestination"],
  ["src/sandbox/tls-terminate-proxy.ts", "prepareDestinationDial"],
  ["src/sandbox/tls-terminate-proxy.ts", "trackPreparedDestinationRequest"],
  ["src/sandbox/sandbox-manager.ts", "assertDestinationGuardRoutesCompatible"],
  ["src/sandbox/sandbox-manager.ts", "resetDestinationGuardConnections"],
]) {
  const source = await readFile(new URL(path, vendorDir), "utf8");
  assert(source.includes(token), `${path} is missing resolver patch token ${token}`);
}

console.log(
  `sandbox-runtime vendor verified: ${expected.name}@${expected.version} (${expected.license})`,
);
