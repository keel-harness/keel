#!/usr/bin/env node

import { spawn } from "node:child_process";

const [, , command, ...args] = process.argv;
if (process.platform === "win32") {
  throw new Error("process-group guardian requires POSIX process groups");
}
if (command === undefined || typeof process.send !== "function") {
  throw new Error("process-group guardian requires a target command and an IPC parent");
}

// The guardian is the persistent group leader. TERM reaches the target and its descendants while
// this handler keeps the exact group anchor alive for a later, unambiguous KILL request.
process.on("SIGTERM", () => {});

const target = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

process.stdin.pipe(target.stdin);
target.stdout.pipe(process.stdout);
target.stderr.pipe(process.stderr);

/** @param {unknown} error */
function serializeError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    code:
      error !== null && typeof error === "object" && "code" in error
        ? String(error.code)
        : "UNKNOWN",
  };
}

/** @param {Record<string, unknown>} message */
function send(message) {
  if (typeof process.send !== "function" || !process.connected) return false;
  return process.send(message);
}

/** @param {unknown} value @returns {value is number} */
function isRequestId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

target.once("error", (error) => {
  send({ type: "target-error", error: serializeError(error) });
});
target.once("exit", (code, signal) => {
  send({ type: "target-exit", exit: { code, signal } });
});

/** @type {number | undefined} */
let preparedKillId;

process.on("message", (/** @type {unknown} */ message) => {
  const candidate = /** @type {{ type?: unknown, id?: unknown, signal?: unknown }} */ (message);
  if (
    message !== null &&
    typeof message === "object" &&
    candidate.type === "signal-commit" &&
    preparedKillId !== undefined &&
    isRequestId(candidate.id) &&
    candidate.id === preparedKillId
  ) {
    preparedKillId = undefined;
    process.kill(0, "SIGKILL");
    return;
  }
  if (
    message === null ||
    typeof message !== "object" ||
    candidate.type !== "signal-group" ||
    !isRequestId(candidate.id) ||
    (candidate.signal !== "SIGTERM" && candidate.signal !== "SIGKILL")
  ) {
    return;
  }

  const { id, signal } = candidate;
  if (signal === "SIGTERM") {
    try {
      process.kill(0, signal);
      send({ type: "signal-ack", id });
    } catch (error) {
      send({
        type: "signal-error",
        id,
        error: serializeError(error),
      });
    }
    return;
  }

  // The parent must receive readiness and send the matching commit before this guardian performs
  // the fatal group signal. The exact guardian exit is then the cleanup receipt; no ACK races exit.
  preparedKillId = id;
  send({ type: "signal-ready", id });
});

process.once("disconnect", () => {
  process.kill(0, "SIGKILL");
});
