#!/usr/bin/env node
// Ink's color dependency reads FORCE_COLOR during module initialization. Map the standard
// NO_COLOR opt-out before importing any renderer modules so compiled and npx entrypoints agree.
if (process.env.NO_COLOR !== undefined && process.env.FORCE_COLOR === undefined) {
  process.env.FORCE_COLOR = "0";
}

const interactiveFlags = new Set([
  "--trust",
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--autopilot",
  "--yolo",
]);
const args = process.argv.slice(2);
const internalWarden = process.env.KEEL_INTERNAL_WARDEN_STDIO === "1";
const interactiveLaunch =
  !internalWarden &&
  process.stdin.isTTY === true &&
  process.stdout.isTTY === true &&
  (args.length === 0 || interactiveFlags.has(args[0]));

if (interactiveLaunch) {
  process.stdout.write("keel · starting");
  let pending = true;
  globalThis.__keelClearBootstrapPaint = () => {
    if (!pending) return;
    pending = false;
    process.stdout.write("\r\x1b[2K");
  };
}

if (internalWarden) {
  const { importBundledVendoredSrtRuntime } =
    await import("../packages/warden/src/bundled-srt-runtime.js");
  globalThis.__keelBundledSrtRuntime = await importBundledVendoredSrtRuntime();
  await import("../packages/warden/src/bin-entry.ts");
} else {
  // The self-contained Bun carrier has no node_modules at runtime. Register an immutable loader for
  // its exact bundled TypeScript parser; the npx/source carriers resolve the same dependency lazily
  // from their reviewed runtime installation.
  Object.defineProperty(globalThis, Symbol.for("keel.internal.typescript-loader.v1"), {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- static call makes Bun embed the exact parser while preserving lazy evaluation
    value: () => require("typescript"),
    configurable: false,
    enumerable: false,
    writable: false,
  });
  await import("../packages/kernel/src/cli/bin.ts");
}
