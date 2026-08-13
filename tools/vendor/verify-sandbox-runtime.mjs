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
    "patches/preserve-linux-hidden-authority.patch",
    "patches/preserve-endpointless-runtime-env.patch",
    "patches/retry-released-endpoint-lease-locks.patch",
    "patches/preserve-posix-literal-argv.patch",
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
    "src/sandbox/posix-shell-quote.ts",
    "src/sandbox/windows-sandbox-utils.ts",
    "test/sandbox/wrap-with-sandbox.test.ts",
    "test/sandbox/mandatory-deny-paths.test.ts",
    "test/sandbox/posix-shell-quote.test.ts",
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
const hiddenAuthorityPatchPath = "patches/preserve-linux-hidden-authority.patch";
const hiddenAuthorityPatch = await readFile(new URL(hiddenAuthorityPatchPath, vendorDir), "utf8");
for (const token of [
  "index 2ef2475..c34975f 100644",
  "index 3fb14f7..b3fbfc6 100644",
  "writePath.startsWith(denySep)",
  "readMaskOutsideExactWriteAllow",
  "firstReadOnlyRemount",
  "does not re-expose a read-hidden directory when exact allowWrite and denyWrite overlap it",
]) {
  assert(hiddenAuthorityPatch.includes(token), `hidden-authority patch omits ${token}`);
}
assert(
  (await sha256(hiddenAuthorityPatchPath)) ===
    "c5b9da2829d8df9b4a59f303739ce323aaedc5b637bab493f1de81558fa121f0",
  "hidden-authority patch record digest mismatch",
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
  "authenticated Linux bridge binds follow filesystem masks and precede read-only remount",
  "Linux launch tests distinguish inner bridge ports from host authority ports",
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
    "c40873e8f1aa01a8911ce9e0f87992f099194f53a61064c6681a7f066edc22cf",
  "src/sandbox/http-proxy.ts":
    "40b7ab556a176e923ec9581ee42f85820dad609f83973006abe192b79a4c9d7d",
  "src/sandbox/linux-sandbox-utils.ts":
    "2a481864d3a3fe2daf638853bdcb718508f7afe0d28bf9c3fd5b21451bdd8e6b",
  "src/sandbox/sandbox-manager.ts":
    "1035d4ffc297d6f176207fdf619bcfbe12956c42279014dd9b4f0b6ca4ecb483",
  "src/sandbox/socks-proxy.ts":
    "f9e4ff4007adee881e7078fde7e0bed561f02afd254b89fb6c2ae5d2b641f011",
  "src/sandbox/tls-terminate-proxy.ts":
    "f326bda46a0c61223abf1a9f6544c6420478797937c3d3cb991c24d5d5eeda5c",
  "test/sandbox/endpoint-lease-registry.test.ts":
    "fdea7a1ac92fcff604135fcde4fa2c972718f1ba842ccec30981d2a5f4ebcc7d",
  "test/sandbox/endpoint-lease-registry-aba.test.ts":
    "47e177dc94ecedc1de3a4ed6f7c077b258be439ad5c2b68c65e5c3bb350d1a80",
  "test/sandbox/endpoint-lease-child.ts":
    "4a90fe2910cbd9744368b5de46ed89ecb8aee8a39d5927feeb40ee62350cf420",
  "test/sandbox/http-server-lifecycle.test.ts":
    "2734ddae95ad7dde284d081252b45f5a1a315a8438c915499883a12be549a196",
  "test/sandbox/launch-authority-lifecycle.test.ts":
    "66cda3cb8eb159064f22cb708844bfa2120dc897067686b0c6ed1fb903ee45a1",
  "test/sandbox/launch-authority.test.ts":
    "93ad19c677e297c28875ed19130fd85a6380bd7bab856ef9ae16d62d3d95ef54",
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
const releasedLockPatchPath = "patches/retry-released-endpoint-lease-locks.patch";
const releasedLockPatch = await readFile(new URL(releasedLockPatchPath, vendorDir), "utf8");
for (const token of [
  "src/sandbox/endpoint-lease-registry.ts",
  "test/sandbox/endpoint-lease-registry-aba.test.ts",
  "this.lock?.released === false",
  "sequential operations reacquire the lock",
]) {
  assert(releasedLockPatch.includes(token), `released-lock patch omits ${token}`);
}
assert(
  (await sha256(releasedLockPatchPath)) ===
    "4b869b8c937c17d9286aa28ea0a90c497f625b57ec4032a1b3b9e7938e097355",
  "released-lock patch record digest mismatch",
);
const literalArgvPatch = await readFile(
  new URL("patches/preserve-posix-literal-argv.patch", vendorDir),
  "utf8",
);
for (const token of [
  "src/sandbox/posix-shell-quote.ts",
  "src/sandbox/macos-sandbox-utils.ts",
  "src/sandbox/linux-sandbox-utils.ts",
  "test/sandbox/posix-shell-quote.test.ts",
  "quotePosixShellArgs",
  "no shell composition, environment, cwd, stdin, background, or retry authority",
]) {
  assert(literalArgvPatch.includes(token), `literal-argv patch omits ${token}`);
}
assert(
  (await sha256("patches/preserve-posix-literal-argv.patch")) ===
    "c337e8592012a044dbef96b75d0627c2868f3e476fd924ac1cf00585cd43b237",
  "literal-argv patch record digest mismatch",
);
for (const [path, digest] of Object.entries({
  "src/sandbox/posix-shell-quote.ts":
    "e363395052f4563f81a3158c9ad93e5873210f08ca89bf16290735f946ccc8ea",
  "src/sandbox/macos-sandbox-utils.ts":
    "9faddbbdf3ff183b76a51874688ca4b8afadab455fd97e17b6d798ff3c17f5f2",
  "src/sandbox/linux-sandbox-utils.ts":
    "2a481864d3a3fe2daf638853bdcb718508f7afe0d28bf9c3fd5b21451bdd8e6b",
  "test/sandbox/posix-shell-quote.test.ts":
    "14b07eaf3dbb6a161a93d484d649778a87676571a3535de304b5ddb90a3435d0",
})) {
  assert((await sha256(path)) === digest, `literal-argv patch postimage drifted: ${path}`);
}
const endpointlessRuntimeEnvPatchPath = "patches/preserve-endpointless-runtime-env.patch";
const endpointlessRuntimeEnvPatch = await readFile(
  new URL(endpointlessRuntimeEnvPatchPath, vendorDir),
  "utf8",
);
for (const token of [
  "src/sandbox/linux-sandbox-utils.ts",
  "test/sandbox/launch-authority-lifecycle.test.ts",
  "test/sandbox/launch-authority.test.ts",
  "endpointless profiles receive SANDBOX_RUNTIME=1",
  "endpointless filesystem profiles receive the trusted sandbox-owned TMPDIR",
  "proxy credentials and CA paths require both authenticated bridge sockets",
  "empty bridge paths cannot project proxy credentials or CA paths",
]) {
  assert(
    endpointlessRuntimeEnvPatch.includes(token),
    `endpointless runtime-env patch omits ${token}`,
  );
}
assert(
  (await sha256(endpointlessRuntimeEnvPatchPath)) ===
    "164f27f7bca2e575edc9b24d15dd32c7ba0aee968d10fcc1c3c2904b84044d01",
  "endpointless runtime-env patch record digest mismatch",
);
assert(
  (await sha256("src/sandbox/linux-sandbox-utils.ts")) ===
    "2a481864d3a3fe2daf638853bdcb718508f7afe0d28bf9c3fd5b21451bdd8e6b",
  "endpointless runtime-env source postimage drifted",
);
assert(
  (await sha256("test/sandbox/launch-authority-lifecycle.test.ts")) ===
    "66cda3cb8eb159064f22cb708844bfa2120dc897067686b0c6ed1fb903ee45a1",
  "endpointless runtime-env argv regression postimage drifted",
);
assert(
  (await sha256("test/sandbox/launch-authority.test.ts")) ===
    "93ad19c677e297c28875ed19130fd85a6380bd7bab856ef9ae16d62d3d95ef54",
  "endpointless runtime-env regression postimage drifted",
);
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
