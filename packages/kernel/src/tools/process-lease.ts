import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

export type ProcessLeaseKind = "service" | "job";
export type ProcessLeaseScope = "until-prestop" | "until-verifier-handoff" | "until-explicit-stop";
export type ProcessLeaseCleanupStatus =
  | "cleaned"
  | "identity-mismatch"
  | "missing"
  | "signal-failed"
  | "still-running";

export interface ProcessLease {
  readonly id: string;
  readonly kind: ProcessLeaseKind;
  readonly ownerToolCallId: string;
  readonly command: string;
  readonly pid: number;
  readonly processGroupId: number;
  readonly startIdentity: string;
  readonly startedAtMs: number;
  readonly logPath: string;
  readonly outputOffset: number;
  readonly scope: ProcessLeaseScope;
  readonly cleanupOwner: "kernel";
  readonly healthCommand?: string;
  readonly statusCommand?: string;
}

export interface CreateProcessLeaseInput {
  readonly kind: ProcessLeaseKind;
  readonly ownerToolCallId: string;
  readonly command: string;
  readonly pid: number;
  readonly logPath: string;
  readonly scope: ProcessLeaseScope;
  readonly healthCommand?: string;
  readonly statusCommand?: string;
}

export interface ProcessLeaseCleanupResult {
  readonly id: string;
  readonly status: ProcessLeaseCleanupStatus;
  readonly error?: string;
}

export interface ProcessLeaseRegistryDeps {
  readonly readStartIdentity?: (pid: number) => string | undefined;
  readonly signalProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly makeId?: () => string;
  readonly killGraceMs?: number;
}

function defaultId(): string {
  return `lease_${randomBytes(8).toString("hex")}`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function defaultSignalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function procStartIdentity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const rparen = stat.lastIndexOf(")");
    if (rparen === -1) return undefined;
    const fields = stat
      .slice(rparen + 2)
      .trim()
      .split(/\s+/u);
    const startTicks = fields[19];
    return startTicks === undefined ? undefined : `proc:${startTicks}`;
  } catch {
    return undefined;
  }
}

function psStartIdentity(pid: number): string | undefined {
  try {
    const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output === "" ? undefined : `ps:${output}`;
  } catch {
    return undefined;
  }
}

export function readProcessStartIdentity(pid: number): string | undefined {
  return procStartIdentity(pid) ?? psStartIdentity(pid);
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim() === "") throw new Error(`${label} must be non-empty`);
}

function assertPositivePid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("process lease pid must be positive");
}

export class ProcessLeaseRegistry {
  readonly #leases = new Map<string, ProcessLease>();
  readonly #readStartIdentity: (pid: number) => string | undefined;
  readonly #signalProcessGroup: (pgid: number, signal: NodeJS.Signals) => void;
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #makeId: () => string;
  readonly #killGraceMs: number;

  constructor(deps: ProcessLeaseRegistryDeps = {}) {
    this.#readStartIdentity = deps.readStartIdentity ?? readProcessStartIdentity;
    this.#signalProcessGroup = deps.signalProcessGroup ?? defaultSignalProcessGroup;
    this.#isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#now = deps.now ?? (() => Date.now());
    this.#makeId = deps.makeId ?? defaultId;
    this.#killGraceMs = deps.killGraceMs ?? 250;
  }

  create(input: CreateProcessLeaseInput): ProcessLease {
    assertNonEmpty(input.ownerToolCallId, "executor-provided owner tool call id");
    assertNonEmpty(input.command, "process lease command");
    assertNonEmpty(input.logPath, "process lease log path");
    assertPositivePid(input.pid);
    const id = this.#makeId();
    const startIdentity = this.#readStartIdentity(input.pid);
    if (startIdentity === undefined) {
      throw new Error("process start identity unavailable for lease pid");
    }
    const lease: ProcessLease = {
      id,
      kind: input.kind,
      ownerToolCallId: input.ownerToolCallId,
      command: input.command,
      pid: input.pid,
      processGroupId: input.pid,
      startedAtMs: this.#now(),
      startIdentity,
      logPath: input.logPath,
      outputOffset: 0,
      scope: input.scope,
      cleanupOwner: "kernel",
      ...(input.healthCommand === undefined ? {} : { healthCommand: input.healthCommand }),
      ...(input.statusCommand === undefined ? {} : { statusCommand: input.statusCommand }),
    };
    this.#leases.set(id, lease);
    return lease;
  }

  active(): ProcessLease[] {
    return [...this.#leases.values()];
  }

  async cleanup(id: string): Promise<ProcessLeaseCleanupResult> {
    const lease = this.#leases.get(id);
    if (lease === undefined) return { id, status: "missing" };
    const current = this.#readStartIdentity(lease.pid);
    if (current !== lease.startIdentity) {
      this.#leases.delete(id);
      return { id, status: "identity-mismatch" };
    }
    try {
      this.#signalProcessGroup(lease.processGroupId, "SIGTERM");
      await this.#sleep(this.#killGraceMs);
      this.#signalProcessGroup(lease.processGroupId, "SIGKILL");
    } catch (error) {
      return {
        id,
        status: "signal-failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (this.#isProcessAlive(lease.pid)) return { id, status: "still-running" };
    this.#leases.delete(id);
    return { id, status: "cleaned" };
  }

  async cleanupAll(scope?: ProcessLeaseScope): Promise<ProcessLeaseCleanupResult[]> {
    const leases = this.active().filter((lease) => scope === undefined || lease.scope === scope);
    return await Promise.all(leases.map((lease) => this.cleanup(lease.id)));
  }
}
