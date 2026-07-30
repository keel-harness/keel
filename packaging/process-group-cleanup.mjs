const DEFAULT_TERM_GRACE_MS = 250;
const DEFAULT_KILL_TIMEOUT_MS = 1_000;

/** @typedef {"SIGTERM" | "SIGKILL"} GuardianSignal */
/** @typedef {{ code: number | null, signal: NodeJS.Signals | null }} ProcessExit */
/** @typedef {{ exited: false } | { exited: true, exit: ProcessExit }} GuardianSettlement */
/** @typedef {"owned" | "reaped" | "indeterminate"} ProcessGroupLeaseState */
/**
 * @typedef {object} GuardedProcessGroupLease
 * @property {number} processGroupId
 * @property {ProcessGroupLeaseState} state
 * @property {(message: string, error?: unknown) => Error} fail
 * @property {(signal: GuardianSignal) => Promise<boolean>} signal
 * @property {(exit: ProcessExit) => void} markReaped
 */

export class ProcessGroupExitTimeoutError extends Error {
  /** @param {number} processGroupId @param {string} context */
  constructor(processGroupId, context) {
    super(`compiled warden process group survived ${context}: ${processGroupId}`);
    this.name = "ProcessGroupExitTimeoutError";
    this.processGroupId = processGroupId;
    this.context = context;
  }
}

/** @param {unknown} error */
function errorCode(error) {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : "UNKNOWN";
}

/**
 * @param {Promise<ProcessExit>} guardianExit
 * @param {number} timeoutMs
 * @returns {Promise<GuardianSettlement>}
 */
async function defaultSettleGuardian(guardianExit, timeoutMs) {
  return await new Promise((resolveSettlement) => {
    let settled = false;
    /** @param {GuardianSettlement} settlement */
    const settle = (settlement) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveSettlement(settlement);
    };
    const timer = setTimeout(() => settle({ exited: false }), timeoutMs);
    void guardianExit.then((exit) => settle({ exited: true, exit }));
  });
}

/**
 * Retain cleanup authority for one detached POSIX process group behind its exact guardian child.
 *
 * The parent never probes or signals the numeric PGID. It asks the still-connected guardian to
 * signal group 0 from inside its own group, then accepts only that exact guardian ChildProcess's
 * SIGKILL exit as terminal evidence. Losing the guardian or its IPC channel is indeterminate and
 * permanently disables further control requests.
 *
 * @param {number} processGroupId
 * @param {{ signalGroup: (signal: GuardianSignal) => Promise<void> }} control
 * @returns {GuardedProcessGroupLease}
 */
export function createGuardedProcessGroupLease(processGroupId, { signalGroup }) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 1) {
    throw new Error("compiled warden process group id must be an integer greater than 1");
  }
  if (typeof signalGroup !== "function") {
    throw new Error("compiled warden process group guardian control is required");
  }

  /** @type {ProcessGroupLeaseState} */
  let state = "owned";
  /** @type {Error | undefined} */
  let indeterminateError;

  /** @param {string} message @param {unknown} [error] */
  const fail = (message, error) => {
    if (state === "indeterminate" && indeterminateError !== undefined) return indeterminateError;
    indeterminateError = new Error(
      `compiled warden process group ownership is indeterminate; ${message}: ${processGroupId}`,
      error === undefined ? undefined : { cause: error },
    );
    state = "indeterminate";
    return indeterminateError;
  };

  return {
    get processGroupId() {
      return processGroupId;
    },
    get state() {
      return state;
    },
    fail,
    async signal(signal) {
      if (state === "reaped") return false;
      if (state === "indeterminate") throw fail("control retried after authority was lost");
      try {
        await signalGroup(signal);
        return true;
      } catch (error) {
        throw fail(`guardian refused ${signal} with ${errorCode(error)}`, error);
      }
    },
    markReaped(exit) {
      if (state === "reaped") return;
      if (state === "indeterminate") throw fail("reap retried after authority was lost");
      if (exit?.code !== null || exit.signal !== "SIGKILL") {
        throw fail(`guardian did not exit from SIGKILL; observed ${JSON.stringify(exit)}`);
      }
      state = "reaped";
    },
  };
}

/**
 * @param {GuardedProcessGroupLease} lease
 * @param {Promise<ProcessExit>} guardianExit
 * @param {{
 *   settleGuardian?: (guardianExit: Promise<ProcessExit>, timeoutMs: number) => Promise<GuardianSettlement>,
 *   termGraceMs?: number,
 *   killTimeoutMs?: number,
 * }} [options]
 * @returns {Promise<ProcessGroupLeaseState>}
 */
export async function terminateProcessGroup(
  lease,
  guardianExit,
  {
    settleGuardian = defaultSettleGuardian,
    termGraceMs = DEFAULT_TERM_GRACE_MS,
    killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS,
  } = {},
) {
  if (lease.state === "reaped") return lease.state;
  if (lease.state === "indeterminate") throw lease.fail("cleanup retried after authority was lost");

  const beforeCleanup = await settleGuardian(guardianExit, 0);
  if (beforeCleanup.exited) {
    throw lease.fail(`guardian exited before cleanup with ${JSON.stringify(beforeCleanup.exit)}`);
  }

  await lease.signal("SIGTERM");
  const afterTerm = await settleGuardian(guardianExit, termGraceMs);
  if (afterTerm.exited) {
    throw lease.fail(`guardian exited during TERM cleanup with ${JSON.stringify(afterTerm.exit)}`);
  }

  await lease.signal("SIGKILL");
  const afterKill = await settleGuardian(guardianExit, killTimeoutMs);
  if (!afterKill.exited) {
    lease.fail("guardian survived SIGKILL cleanup");
    throw new ProcessGroupExitTimeoutError(lease.processGroupId, "SIGKILL cleanup");
  }
  lease.markReaped(afterKill.exit);
  return lease.state;
}
