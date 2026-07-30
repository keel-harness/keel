import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import { createGuardedProcessGroupLease } from "./process-group-cleanup.mjs";

const PROCESS_GROUP_GUARDIAN = fileURLToPath(
  new URL("./process-group-guardian.mjs", import.meta.url),
);
const DEFAULT_CONTROL_TIMEOUT_MS = 1_000;
const KNOWN_SIGNALS = new Set(Object.keys(osConstants.signals));

/** @typedef {"SIGTERM" | "SIGKILL"} GuardianSignal */
/** @typedef {{ code: number | null, signal: NodeJS.Signals | null }} ProcessExit */
/** @typedef {{ exit: ProcessExit } | { error: Error & { code?: string } }} TargetSettlement */
/**
 * @typedef {object} PendingSignal
 * @property {() => void} resolve
 * @property {(error: unknown) => void} reject
 * @property {NodeJS.Timeout} timer
 * @property {GuardianSignal} signal
 */

/** @param {unknown} value @returns {Record<string, unknown> | undefined} */
function recordOf(value) {
  return value !== null && typeof value === "object"
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined;
}

/** @param {unknown} value @param {string} fallback */
function remoteError(value, fallback) {
  const record = recordOf(value);
  return Object.assign(
    new Error(typeof record?.["message"] === "string" ? record["message"] : fallback),
    {
      code: typeof record?.["code"] === "string" ? record["code"] : "UNKNOWN",
    },
  );
}

/** @param {unknown} value @returns {ProcessExit} */
function processExitOf(value) {
  const record = recordOf(value);
  const code = record?.["code"];
  const signal = record?.["signal"];
  const validCode = code === null || (Number.isInteger(code) && Number(code) >= 0);
  const validSignal = signal === null || (typeof signal === "string" && KNOWN_SIGNALS.has(signal));
  if (
    !validCode ||
    !validSignal ||
    (code === null && signal === null) ||
    (code !== null && signal !== null)
  ) {
    throw Object.assign(new Error("process-group guardian sent an invalid target exit"), {
      code: "EBADMSG",
    });
  }
  return {
    code: /** @type {number | null} */ (code),
    signal: /** @type {NodeJS.Signals | null} */ (signal),
  };
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @returns {Promise<ProcessExit>}
 */
function exactChildExit(child) {
  return new Promise((resolveExit) => {
    let settled = false;
    /** @param {ProcessExit} exit */
    const settle = (exit) => {
      if (settled) return;
      settled = true;
      resolveExit(exit);
    };
    child.once("error", () => settle({ code: null, signal: null }));
    child.once("exit", (code, signal) => settle({ code, signal }));
  });
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {Promise<ProcessExit>} guardianExit
 * @param {{ timeoutMs?: number }} [options]
 */
export function createGuardianControl(
  child,
  guardianExit,
  { timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS } = {},
) {
  let nextRequestId = 1;
  /** @type {Map<number, PendingSignal>} */
  const pendingSignals = new Map();
  /** @type {((settlement: TargetSettlement) => void) | undefined} */
  let resolveTargetSettlement;
  /** @type {Promise<TargetSettlement>} */
  const targetSettled = new Promise((resolveTarget) => {
    resolveTargetSettlement = resolveTarget;
  });

  /** @param {TargetSettlement} settlement */
  const settleTarget = (settlement) => {
    if (resolveTargetSettlement === undefined) return;
    const resolveTarget = resolveTargetSettlement;
    resolveTargetSettlement = undefined;
    resolveTarget(settlement);
  };

  child.on("message", (/** @type {unknown} */ message) => {
    const record = recordOf(message);
    if (record === undefined || typeof record["type"] !== "string") return;
    if (record["type"] === "target-exit") {
      try {
        settleTarget({ exit: processExitOf(record["exit"]) });
      } catch (error) {
        settleTarget({ error: /** @type {Error & { code?: string }} */ (error) });
      }
      return;
    }
    if (record["type"] === "target-error") {
      settleTarget({ error: remoteError(record["error"], "guardian target failed") });
      return;
    }
    if (
      (record["type"] !== "signal-ack" &&
        record["type"] !== "signal-ready" &&
        record["type"] !== "signal-error") ||
      typeof record["id"] !== "number"
    ) {
      return;
    }
    const pending = pendingSignals.get(record["id"]);
    if (pending === undefined) return;
    pendingSignals.delete(record["id"]);
    clearTimeout(pending.timer);
    if (record["type"] === "signal-error") {
      pending.reject(remoteError(record["error"], "guardian signal request failed"));
    } else if (record["type"] === "signal-ack" && pending.signal === "SIGTERM") {
      pending.resolve();
    } else if (record["type"] === "signal-ready" && pending.signal === "SIGKILL") {
      try {
        // The exact guardian stays alive through readiness. Queue the commit, then let cleanup use
        // only the exact guardian's later SIGKILL exit as the group-reaped receipt; no fatal
        // child-to-parent acknowledgement is required.
        if (typeof child.send !== "function") {
          throw Object.assign(new Error("process-group guardian IPC is closed"), {
            code: "EPIPE",
          });
        }
        child.send({ type: "signal-commit", id: record["id"] });
        pending.resolve();
      } catch (error) {
        pending.reject(error);
      }
    } else {
      pending.reject(
        Object.assign(new Error("process-group guardian sent an invalid signal phase"), {
          code: "EBADMSG",
        }),
      );
    }
  });

  void guardianExit.then((exit) => {
    const error = Object.assign(
      new Error(`process-group guardian exited: ${exit.code ?? exit.signal ?? "unknown"}`),
      { code: "EPIPE" },
    );
    for (const pending of pendingSignals.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingSignals.clear();
    settleTarget({ error });
  });

  return {
    /** @param {GuardianSignal} signal @returns {Promise<void>} */
    signalGroup(signal) {
      return new Promise((resolveSignal, rejectSignal) => {
        if (!child.connected || typeof child.send !== "function") {
          rejectSignal(
            Object.assign(new Error("process-group guardian IPC is closed"), { code: "EPIPE" }),
          );
          return;
        }
        const id = nextRequestId++;
        const timer = setTimeout(() => {
          pendingSignals.delete(id);
          rejectSignal(
            Object.assign(new Error(`process-group guardian did not acknowledge ${signal}`), {
              code: "ETIMEDOUT",
            }),
          );
        }, timeoutMs);
        pendingSignals.set(id, { resolve: resolveSignal, reject: rejectSignal, timer, signal });
        try {
          child.send({ type: "signal-group", id, signal }, (error) => {
            if (error == null) return;
            const pending = pendingSignals.get(id);
            if (pending === undefined) return;
            pendingSignals.delete(id);
            clearTimeout(pending.timer);
            pending.reject(error);
          });
        } catch (error) {
          pendingSignals.delete(id);
          clearTimeout(timer);
          rejectSignal(error);
        }
      });
    },
    /** @returns {Promise<ProcessExit>} */
    async waitTargetExit() {
      const settlement = await targetSettled;
      if ("error" in settlement) throw settlement.error;
      return settlement.exit;
    },
  };
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnOptions} options
 */
export function spawnControlledTarget(command, args, options) {
  if (process.platform === "win32") {
    const child = spawn(command, args, {
      ...options,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const childExit = exactChildExit(child);
    return {
      child,
      guardianExit: childExit,
      waitTargetExit: async () => await childExit,
      processGroupLease: undefined,
    };
  }

  const child = spawn(process.execPath, [PROCESS_GROUP_GUARDIAN, command, ...args], {
    ...options,
    detached: true,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const guardianExit = exactChildExit(child);
  const control = createGuardianControl(child, guardianExit);
  if (child.pid === undefined) throw new Error("process-group guardian did not spawn");
  const processGroupLease = createGuardedProcessGroupLease(child.pid, {
    signalGroup: control.signalGroup,
  });
  return {
    child,
    guardianExit,
    waitTargetExit: control.waitTargetExit,
    processGroupLease,
  };
}
