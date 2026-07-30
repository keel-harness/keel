#!/usr/bin/env node
// Release-eligible npx launcher (ADR-0082). Keep this file deliberately small: Node must paint
// before it parses the private Kernel bundle. The public npm bin continues to point here.
if (process.env.NO_COLOR !== undefined && process.env.FORCE_COLOR === undefined) {
  process.env.FORCE_COLOR = "0";
}

const hostNodeEnv = process.env.NODE_ENV;
process.env.KEEL_HOST_NODE_ENV_MANAGED = "1";
if (hostNodeEnv === undefined) delete process.env.KEEL_HOST_NODE_ENV;
else process.env.KEEL_HOST_NODE_ENV = hostNodeEnv;
process.env.NODE_ENV = "production";

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
const interactiveLaunch =
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

await import("./keel-kernel.mjs");
