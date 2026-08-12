#!/usr/bin/env node
/* global console, URL */
import { createHash } from "node:crypto";
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
    "patches/flush-tls-loopback-response.patch",
    "patches/runtime-aware-http-proxy-close.patch",
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
    "test/sandbox/mandatory-deny-paths.test.ts",
    "test/sandbox/linux-proxy-readiness.test.ts",
    "test/sandbox/destination-dial.test.ts",
    "test/sandbox/destination-guard-proxy.test.ts",
    "test/sandbox/http-server-lifecycle.test.ts",
    "test/sandbox/tls-loopback-lifecycle.test.ts",
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

async function sha256(relativePath) {
  const bytes = await readFile(new URL(relativePath, vendorDir));
  return createHash("sha256").update(bytes).digest("hex");
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

const tlsFlushPatch = await readFile(
  new URL("patches/flush-tls-loopback-response.patch", vendorDir),
  "utf8",
);
assert(
  tlsFlushPatch.includes("src/sandbox/tls-terminate-proxy.ts"),
  "TLS response-flush patch omits tls-terminate-proxy.ts",
);
const tlsTerminateSource = await readFile(
  new URL("src/sandbox/tls-terminate-proxy.ts", vendorDir),
  "utf8",
);
assert(
  !tlsTerminateSource.includes("loop.once('close', () => socket.destroy())"),
  "TLS terminator still destroys the client on normal loopback close",
);
assert(
  tlsTerminateSource.includes("socket.once('finish', () => void cleanup())"),
  "TLS terminator does not clean up after the client write finishes",
);

const httpClosePatch = await readFile(
  new URL("patches/runtime-aware-http-proxy-close.patch", vendorDir),
  "utf8",
);
assert(
  httpClosePatch.includes("src/sandbox/sandbox-manager.ts"),
  "runtime-aware HTTP close patch omits sandbox-manager.ts",
);
assert(
  httpClosePatch.includes("src/sandbox/http-proxy.ts"),
  "runtime-aware HTTP close patch omits upgraded-socket tracking",
);
assert(
  httpClosePatch.includes("index 6fa3dae..b6749c3 100644"),
  "runtime-aware HTTP close patch does not record the exact http-proxy postimage",
);
const httpProxySource = await readFile(
  new URL("src/sandbox/http-proxy.ts", vendorDir),
  "utf8",
);
assert(
  httpProxySource.includes("destroyTrackedHttpProxyConnections"),
  "HTTP proxy teardown does not track CONNECT-upgraded sockets",
);
assert(
  httpProxySource.includes("state.draining = true"),
  "HTTP proxy teardown does not persistently drain late socket events",
);
const sandboxManagerSource = await readFile(
  new URL("src/sandbox/sandbox-manager.ts", vendorDir),
  "utf8",
);
assert(
  sandboxManagerSource.includes("typeof (globalThis as { Bun?: unknown }).Bun === 'object'"),
  "HTTP proxy teardown does not select a runtime-safe close order",
);
assert(
  sandboxManagerSource.includes("close()\n        closeAllConnections()"),
  "Node HTTP proxy teardown does not stop acceptance before force-close",
);
assert(
  sandboxManagerSource.includes("destroyTrackedHttpProxyConnections("),
  "HTTP proxy teardown does not invoke upgraded-socket draining",
);
const launchAuthorityPatch = await readFile(
  new URL("patches/per-launch-srt-authority.patch", vendorDir),
  "utf8",
);
for (const token of [
  "src/sandbox/endpoint-lease-registry.ts",
  "src/sandbox/sandbox-manager.ts",
  "src/sandbox/socks-proxy.ts",
  "src/sandbox/tls-terminate-proxy.ts",
  "LAUNCH_AUTHORITY_DRAIN_TIMEOUT_MS = 2_000",
  "per-launch proxy authority requires a destination resolver",
  "launchLifecycleTail",
  "revoke(): Promise<void>",
  "release(): Promise<void>",
  "releaseLaunchFilesystemState",
  "generated nested-deny bind sources follow invocation ownership and settlement",
]) {
  assert(
    launchAuthorityPatch.includes(token),
    `per-launch SRT authority patch omits ${token}`,
  );
}
assert(
  sandboxManagerSource.includes("export const LAUNCH_AUTHORITY_DRAIN_TIMEOUT_MS = 2_000"),
  "per-launch authority cleanup is missing its fixed drain bound",
);
assert(
  sandboxManagerSource.includes("launchLifecycleTail"),
  "per-launch authority preparation and reset are not lifecycle-serialized",
);
assert(
  sandboxManagerSource.includes("releaseLaunchFilesystemState"),
  "per-launch authority does not separate network revocation from filesystem settlement",
);
const launchAuthorityPostimage = {
  "src/sandbox/endpoint-lease-registry.ts":
    "6bd8e7e4f48f0fc6c3f210a45006b4bb36db1c8263568f1dd14ac2aa62cc3583",
  "src/sandbox/http-proxy.ts":
    "40b7ab556a176e923ec9581ee42f85820dad609f83973006abe192b79a4c9d7d",
  "src/sandbox/linux-sandbox-utils.ts":
    "a6f4bc22b124e6760a4961d7d8ed746625b4148f6ffe90d12058345a0a3c165d",
  "src/sandbox/sandbox-manager.ts":
    "1035d4ffc297d6f176207fdf619bcfbe12956c42279014dd9b4f0b6ca4ecb483",
  "src/sandbox/socks-proxy.ts":
    "f9e4ff4007adee881e7078fde7e0bed561f02afd254b89fb6c2ae5d2b641f011",
  "src/sandbox/tls-terminate-proxy.ts":
    "f326bda46a0c61223abf1a9f6544c6420478797937c3d3cb991c24d5d5eeda5c",
  "test/sandbox/endpoint-lease-registry.test.ts":
    "fdea7a1ac92fcff604135fcde4fa2c972718f1ba842ccec30981d2a5f4ebcc7d",
  "test/sandbox/endpoint-lease-registry-aba.test.ts":
    "8be035029d226f2733e3baa08689eb3fce81f6d1ef5dda459d90b99f1d6acf82",
  "test/sandbox/endpoint-lease-child.ts":
    "4a90fe2910cbd9744368b5de46ed89ecb8aee8a39d5927feeb40ee62350cf420",
  "test/sandbox/http-server-lifecycle.test.ts":
    "2734ddae95ad7dde284d081252b45f5a1a315a8438c915499883a12be549a196",
  "test/sandbox/launch-authority-lifecycle.test.ts":
    "b8c6e2d8ee0e06a4e4ef0449373690360b5b36de505f2882040cc61599409996",
  "test/sandbox/launch-authority.test.ts":
    "a72bd0698e14cbf65e82a371f2e243e3e74ccad2777ee28df7ff12210e1a31e8",
  "test/sandbox/linux-bridge-process-group.test.ts":
    "d83c523bac7beff3d2815eed527c55de7ed052c9936f4bb47da79cfd20dbb7f8",
  "test/sandbox/mandatory-deny-paths.test.ts":
    "e2e2031665b435a118072406c1f098aa9b6ecea2598b8aa4ee083fc3d9fb2a52",
  "test/sandbox/socks-server-lifecycle.test.ts":
    "1845900b163e17a97a0e2f898ba289af1591756cd3404ea5373f56d391df1b3f",
  "test/sandbox/tls-loopback-lifecycle.test.ts":
    "6f819e2d8d659978b9c2032cf2c1081ac3aa435e7f4335941be5b7780d61cd6a",
};
for (const [path, digest] of Object.entries(launchAuthorityPostimage)) {
  assert((await sha256(path)) === digest, `per-launch authority postimage drifted: ${path}`);
}
const endpointRegistrySource = await readFile(
  new URL("src/sandbox/endpoint-lease-registry.ts", vendorDir),
  "utf8",
);
assert(
  endpointRegistrySource.includes("claimGeneration(): void"),
  "per-launch authority is missing generation ownership",
);
const socksProxySource = await readFile(
  new URL("src/sandbox/socks-proxy.ts", vendorDir),
  "utf8",
);
assert(
  socksProxySource.includes("if (draining || options.isProxyAuthActive?.() === false)"),
  "SOCKS proxy teardown does not persistently drain late sockets",
);

console.log(
  `sandbox-runtime vendor verified: ${expected.name}@${expected.version} (${expected.license})`,
);
