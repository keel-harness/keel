import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeMarker, parseMarkerLine } from "./marker.js";
import {
  ProcessLeaseRegistry,
  type ProcessLease,
  type ProcessLeaseCleanupResult,
  type ProcessLeaseKind,
  type ProcessLeaseRegistryDeps,
  type ProcessLeaseScope,
} from "./process-lease.js";
import { truncateHeadTail } from "./truncate.js";

export type RunOutcome = "ok" | "timeout" | "aborted" | "shell-died";

export interface RunResult {
  readonly output: string;
  readonly exitCode: number | null;
  readonly outcome: RunOutcome;
  readonly truncated: boolean;
  /** Only meaningful for `outcome: "timeout"`: whether the idle-progress timer or absolute command
   *  ceiling fired. Omitted for legacy/injected fake results that do not classify the timeout. */
  readonly timeoutKind?: "idle" | "absolute";
  /** Only meaningful for `outcome: "timeout"`. `false` (the norm): the command's process subtree was
   *  terminated but the persistent shell — and its cwd/env — survived. `true`: the shell could not be
   *  re-synchronised after the kill and was reset (cwd/env lost), the legacy fallback. */
  readonly shellReset?: boolean;
  /** Only meaningful when `shellReset === true`: WHY the shell was reset, so the caller can tell the
   *  truth instead of always blaming a timeout (F4 honesty, keel14/keel59 review).
   *  · `"timeout"` — a command that genuinely ran (it produced output) stalled and could not resync.
   *  · `"wedge"`   — the shell never acknowledged the command at all (zero output, no marker): a
   *                  STRUCTURAL wedge, e.g. a heredoc fed to an interpreter (`python3 <<'EOF'`). No
   *                  meaningful time elapsed running anything, so calling it a "timeout" would be a lie. */
  readonly resetCause?: "timeout" | "wedge";
}

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Optional live-output sink (Epic 1.5c — purposeful liveness): called with the latest completed
   *  non-blank line each time a stdout chunk lands, for the TUI to surface what a long command is
   *  doing. Best-effort and ephemeral — the authoritative output is the returned `RunResult.output`;
   *  the protocol marker line is never passed. Absent = no streaming (unchanged behavior). */
  readonly onOutput?: (line: string) => void;
}

export interface LeaseStartOptions {
  readonly kind: ProcessLeaseKind;
  readonly ownerToolCallId: string;
  readonly scope: ProcessLeaseScope;
  readonly logPath: string;
  readonly healthCommand?: string;
  readonly statusCommand?: string;
  readonly signal?: AbortSignal;
}

export type ProcessLeaseStartResult = ProcessLease;

export interface ShellSession {
  run(command: string, opts?: RunOptions): Promise<RunResult>;
  startLeased?(command: string, opts: LeaseStartOptions): Promise<ProcessLeaseStartResult>;
  activeLeases?(): readonly ProcessLease[];
  cleanupLeases?(scope?: ProcessLeaseScope): Promise<ProcessLeaseCleanupResult[]>;
  dispose(): Promise<void>;
}

/** The minimal shell-process surface the session needs — abstracted so tests inject a fake. */
export interface ShellChild {
  readonly pid: number | undefined;
  write(data: string): void;
  onStdout(cb: (chunk: string) => void): () => void; // returns an unsubscribe fn
  onExit(cb: (code: number | null) => void): () => void;
  /** SIGKILL the whole process group (the shell included). Used on reset/abort/dispose. */
  killGroup(): void;
  /** Terminate the shell's descendant processes (the running command's subtree) but leave the shell
   *  process itself alive, so cwd/env survive a per-command timeout (ADR-0050). */
  killChildren(): void;
}

/** Parse a `/proc/<pid>/stat` line → its PPID, or undefined. `comm` (field 2) can contain spaces and
 *  ')', so the numeric fields are read AFTER the last ')': [state, ppid, …]. */
export function parseProcStat(line: string): number | undefined {
  const rparen = line.lastIndexOf(")");
  if (rparen === -1) return undefined;
  const ppid = Number(line.slice(rparen + 2).split(" ")[1]);
  return Number.isInteger(ppid) ? ppid : undefined;
}

/** Parse `ps -A -o pid=,ppid=` output → `(pid, ppid)` rows (non-matching lines, e.g. a header, skipped). */
export function parsePsTable(text: string): { pid: number; ppid: number }[] {
  const out: { pid: number; ppid: number }[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  return out;
}

/** Read `(pid, ppid)` for every live process. Linux uses `/proc` (dependency-free, fast); other
 *  platforms (macOS dev/CI) fall back to `ps`. Best-effort — a process that vanishes mid-scan is
 *  simply skipped. (The OS branch is a thin shim; the parsing it delegates to is unit-tested.) */
function readProcessTable(): { pid: number; ppid: number }[] {
  try {
    const out: { pid: number; ppid: number }[] = [];
    for (const entry of readdirSync("/proc")) {
      const pid = Number(entry);
      if (!Number.isInteger(pid)) continue;
      try {
        const ppid = parseProcStat(readFileSync(`/proc/${entry}/stat`, "utf8"));
        if (ppid !== undefined) out.push({ pid, ppid });
      } catch {
        /* the process exited between readdir and read — skip it */
      }
    }
    return out;
  } catch {
    return parsePsTable(execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }));
  }
}

/** The transitive descendants of `rootPid` in a `(pid, ppid)` table — children, grandchildren, …,
 *  EXCLUDING `rootPid` itself. Pure (table injected) so the tree walk is unit-tested on every OS. */
export function descendantPids(
  table: readonly { readonly pid: number; readonly ppid: number }[],
  rootPid: number,
): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const { pid, ppid } of table) {
    const kids = childrenOf.get(ppid);
    if (kids) kids.push(pid);
    else childrenOf.set(ppid, [pid]);
  }
  const out: number[] = [];
  // The table comes from untrusted /proc | ps text; a row asserting a PPID cycle would loop forever.
  // Seed `seen` with the root so a cycle pointing back at it neither re-processes nor includes it, and
  // visit every other pid at most once — the walk is total regardless of the input (EXEC-3).
  const seen = new Set<number>([rootPid]);
  const stack = [...(childrenOf.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    const kids = childrenOf.get(pid);
    if (kids) stack.push(...kids);
  }
  return out;
}

/** Terminate the process subtree rooted at `rootPid` (SIGTERM, then a SIGKILL sweep for stragglers
 *  after a grace), EXCLUDING `rootPid`. Dependencies are injected so every branch is unit-tested
 *  without touching real processes (ADR-0050). */
export function killSubtree(
  rootPid: number | undefined,
  deps: {
    readTable: () => { pid: number; ppid: number }[];
    kill: (pid: number, sig: NodeJS.Signals) => void;
    schedule: (fn: () => void, ms: number) => void;
  },
): void {
  if (rootPid === undefined) return;
  const descendants = descendantPids(deps.readTable(), rootPid);
  for (const d of descendants) deps.kill(d, "SIGTERM");
  if (descendants.length > 0) {
    deps.schedule(() => {
      for (const d of descendants) deps.kill(d, "SIGKILL");
    }, 250);
  }
}

/** Signal a pid, swallowing ESRCH (already gone). Exported for the process-tree helper tests. */
export function signalPid(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

export type SpawnShell = (opts: { cwd: string; shell: string }) => ShellChild;

export interface PipeShellSessionOptions {
  readonly cwd: string;
  readonly shell?: string;
  readonly maxOutputBytes?: number;
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly minTimeoutMs?: number;
  /** After a timeout kills the command's subtree, how long to wait for the shell to re-synchronise
   *  (emit its marker) before falling back to a full reset. */
  readonly graceTimeoutMs?: number;
  /** @deprecated Retained as an ignored source-compatibility field. Elapsed time belongs to the
   * controller-owned presentation clock; `onOutput` now carries only observed tool output. */
  readonly progressIntervalMs?: number;
  readonly leaseDeps?: ProcessLeaseRegistryDeps;
  readonly spawn?: SpawnShell;
}

const DEFAULTS = {
  shell: "bash",
  maxOutputBytes: 64 * 1024,
  // Legitimate long operations are common in real tasks (compiles, `pip install`, model/dataset
  // downloads). 30s/120s killed real builds + downloads on the TB-2 probe and reset the shell (lost
  // cwd/env), so the floor is higher: a 2-min default and a 10-min ceiling the model can opt into via
  // `timeoutMs`. A genuinely hung command is still bounded; it is just rarer to hit the cap by accident.
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  minTimeoutMs: 100,
  graceTimeoutMs: 2_000,
};

/** Real `node:child_process` shell: `bash --norc --noprofile`, detached (process-group leader), with a
 *  deterministic minimal env. `killGroup` SIGKILLs the whole group (no orphaned children);
 *  `killChildren` terminates just the running command's subtree and leaves the shell alive. */
const realSpawn: SpawnShell = ({ cwd, shell }) => {
  const child = nodeSpawn(shell, ["--norc", "--noprofile"], {
    cwd,
    detached: true,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.resume(); // drain to avoid backpressure (command stderr is merged via 2>&1 anyway)
  return {
    pid: child.pid,
    write: (data) => void child.stdin.write(data),
    onStdout: (cb) => {
      const h = (c: string): void => cb(c);
      child.stdout.on("data", h);
      return () => child.stdout.off("data", h);
    },
    onExit: (cb) => {
      const h = (code: number | null): void => cb(code);
      child.on("exit", h);
      return () => child.off("exit", h);
    },
    killGroup: () => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        // Kill the whole process group (child is a detached group leader, so PGID == pid). Residual
        // hazard, inherent to any PID-based group kill: if the group fully exits and the OS recycles
        // the PID into an unrelated group before this fires, that group is signalled — very low
        // probability within one bounded session, and not worsened by anything here.
        process.kill(-pid, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err; // ESRCH = already gone
      }
    },
    // Kill the running command's subtree but NOT the shell (`child.pid`). SIGTERM first so well-behaved
    // children clean up; a SIGKILL sweep clears stragglers after a short grace (fire-and-forget — it
    // must not block the shell's re-synchronisation). A deliberately detached `setsid <cmd> &` daemon is
    // a *new* session, not a descendant, so it is intentionally left running.
    killChildren: () =>
      killSubtree(child.pid, {
        readTable: readProcessTable,
        kill: signalPid,
        schedule: (fn, ms) => {
          const t = setTimeout(fn, ms);
          t.unref?.();
        },
      }),
  };
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

const CAPTURE_READ_CHUNK_BYTES = 64 * 1024;
const CAPTURE_TAMPER_NOTICE =
  "[keel] command output capture was replaced or removed; output may be incomplete";

function decodeDropTrailingPartial(buf: Buffer): string {
  return new TextDecoder("utf-8").decode(buf, { stream: true });
}

function decodeDropLeadingPartial(buf: Buffer): string {
  let start = 0;
  while (start < buf.length && ((buf[start] as number) & 0xc0) === 0x80) start += 1;
  return new TextDecoder("utf-8").decode(buf.subarray(start));
}

class BoundedOutputBuffer {
  readonly #maxBytes: number;
  readonly #headBytes: number;
  readonly #tailBytes: number;
  #raw = Buffer.alloc(0);
  #head = Buffer.alloc(0);
  #tail = Buffer.alloc(0);
  #totalBytes = 0;
  #truncated = false;

  constructor(maxBytes: number) {
    this.#maxBytes = Math.max(1, maxBytes);
    this.#headBytes = Math.max(1, Math.floor(this.#maxBytes / 2));
    this.#tailBytes = Math.max(1, this.#maxBytes - this.#headBytes);
  }

  get hasOutput(): boolean {
    return this.#totalBytes > 0;
  }

  append(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    const nextTotal = this.#totalBytes + chunk.byteLength;
    if (!this.#truncated && nextTotal <= this.#maxBytes) {
      this.#raw = Buffer.concat([this.#raw, chunk], nextTotal);
      this.#totalBytes = nextTotal;
      return;
    }

    if (!this.#truncated) {
      const combined = Buffer.concat([this.#raw, chunk], nextTotal);
      this.#truncated = true;
      this.#raw = Buffer.alloc(0);
      this.#head = Buffer.from(combined.subarray(0, this.#headBytes));
      this.#tail = Buffer.from(combined.subarray(combined.byteLength - this.#tailBytes));
    } else {
      const combinedTail = Buffer.concat([this.#tail, chunk]);
      this.#tail = Buffer.from(
        combinedTail.subarray(Math.max(0, combinedTail.byteLength - this.#tailBytes)),
      );
    }
    this.#totalBytes = nextTotal;
  }

  snapshot(): { text: string; truncated: boolean } {
    if (!this.#truncated) return { text: this.#raw.toString("utf8"), truncated: false };
    const head = decodeDropTrailingPartial(this.#head);
    const tail = decodeDropLeadingPartial(this.#tail);
    const elided = Math.max(
      0,
      this.#totalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"),
    );
    return { text: `${head}\n… [${String(elided)} bytes elided] …\n${tail}`, truncated: true };
  }
}

class CommandOutputCapture {
  readonly path: string;
  readonly #dir: string;
  readonly #fd: number;
  readonly #dev: number;
  readonly #ino: number;
  readonly #buffer: BoundedOutputBuffer;
  #offset = 0;
  #tampered = false;
  #closed = false;

  constructor(maxOutputBytes: number) {
    this.#dir = mkdtempSync(join(tmpdir(), "keel-shell-"));
    this.path = join(this.#dir, "output.log");
    this.#fd = openSync(
      this.path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    const identity = fstatSync(this.#fd);
    this.#dev = identity.dev;
    this.#ino = identity.ino;
    this.#buffer = new BoundedOutputBuffer(maxOutputBytes);
  }

  get hasOutput(): boolean {
    return this.#buffer.hasOutput;
  }

  #checkPathIdentity(): void {
    if (this.#tampered) return;
    try {
      const current = lstatSync(this.path);
      if (current.dev !== this.#dev || current.ino !== this.#ino) this.#tampered = true;
    } catch {
      this.#tampered = true;
    }
  }

  readIncremental(): boolean {
    if (this.#closed) return false;
    this.#checkPathIdentity();
    let readAny = false;
    try {
      const size = fstatSync(this.#fd).size;
      if (size < this.#offset) {
        this.#tampered = true;
        this.#offset = size;
      }
      while (this.#offset < size) {
        const buffer = Buffer.allocUnsafe(Math.min(CAPTURE_READ_CHUNK_BYTES, size - this.#offset));
        const bytesRead = readSync(this.#fd, buffer, 0, buffer.byteLength, this.#offset);
        if (bytesRead <= 0) break;
        readAny = true;
        this.#buffer.append(buffer.subarray(0, bytesRead));
        this.#offset += bytesRead;
      }
      /* c8 ignore next 3 -- defensive fd-read race; identity tamper handling is covered separately. */
    } catch {
      this.#tampered = true;
    }
    return readAny;
  }

  snapshot(): { text: string; truncated: boolean } {
    this.readIncremental();
    const captured = this.#buffer.snapshot();
    if (!this.#tampered) return captured;
    const text =
      captured.text.length > 0
        ? `${CAPTURE_TAMPER_NOTICE}\n${captured.text}`
        : CAPTURE_TAMPER_NOTICE;
    return { text, truncated: true };
  }

  cleanup(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      closeSync(this.#fd);
      /* c8 ignore next 3 -- best-effort cleanup only; close races are not deterministic to force. */
    } catch {
      // Best-effort cleanup only.
    }
    try {
      rmSync(this.#dir, { recursive: true, force: true });
      /* c8 ignore next 3 -- best-effort cleanup only; directory removal races are not deterministic. */
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function unsafeLeaseLogPath(path: string): boolean {
  return (
    path === "/dev/stdout" ||
    path === "/dev/stderr" ||
    path.startsWith("/dev/fd/") ||
    path.startsWith("/proc/self/fd/")
  );
}

function parseLeasePid(
  output: string,
  token: string,
): { pid: number; logPath: string } | undefined {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `(?:^|\\n)keel lease ${escaped} pid=(\\d+) log=(.*?)(?:\\n|$)`,
    "u",
  ).exec(output);
  if (match === null) return undefined;
  const pid = Number(match[1]);
  const logPath = match[2]?.trim() ?? "";
  return Number.isInteger(pid) && pid > 0 && logPath !== "" ? { pid, logPath } : undefined;
}

export class PipeShellSession implements ShellSession {
  readonly #cwd: string;
  readonly #shell: string;
  readonly #maxOutputBytes: number;
  readonly #defaultTimeoutMs: number;
  readonly #maxTimeoutMs: number;
  readonly #minTimeoutMs: number;
  readonly #graceTimeoutMs: number;
  readonly #spawn: SpawnShell;
  readonly #leases: ProcessLeaseRegistry;
  #child: ShellChild | undefined;
  #busy = false;

  constructor(opts: PipeShellSessionOptions) {
    this.#cwd = opts.cwd;
    this.#shell = opts.shell ?? DEFAULTS.shell;
    this.#maxOutputBytes = opts.maxOutputBytes ?? DEFAULTS.maxOutputBytes;
    this.#defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULTS.defaultTimeoutMs;
    this.#maxTimeoutMs = opts.maxTimeoutMs ?? DEFAULTS.maxTimeoutMs;
    this.#minTimeoutMs = opts.minTimeoutMs ?? DEFAULTS.minTimeoutMs;
    this.#graceTimeoutMs = opts.graceTimeoutMs ?? DEFAULTS.graceTimeoutMs;
    this.#spawn = opts.spawn ?? realSpawn;
    this.#leases = new ProcessLeaseRegistry(opts.leaseDeps);
  }

  async run(command: string, opts?: RunOptions): Promise<RunResult> {
    if (this.#busy) {
      throw new Error("PipeShellSession: a command is already running (sequential use only)");
    }
    this.#busy = true;
    try {
      if (opts?.signal?.aborted === true) {
        return { output: "", exitCode: null, outcome: "aborted", truncated: false };
      }
      this.#child ??= this.#spawn({ cwd: this.#cwd, shell: this.#shell });
      return await this.#runOnce(this.#child, command, opts);
    } finally {
      this.#busy = false;
    }
  }

  async dispose(): Promise<void> {
    this.#child?.killGroup();
    this.#child = undefined;
    await Promise.resolve();
  }

  async cleanupLeases(scope?: ProcessLeaseScope): Promise<ProcessLeaseCleanupResult[]> {
    return await this.#leases.cleanupAll(scope);
  }

  activeLeases(): readonly ProcessLease[] {
    return this.#leases.active();
  }

  async startLeased(command: string, opts: LeaseStartOptions): Promise<ProcessLeaseStartResult> {
    if (opts.ownerToolCallId.trim() === "") {
      throw new Error("executor-provided owner tool call id must be non-empty");
    }
    if (unsafeLeaseLogPath(opts.logPath)) {
      throw new Error("lease log path must be a regular file path, not stdout/stderr/fd");
    }
    const logDir = dirname(opts.logPath);
    const token = randomBytes(8).toString("hex");
    const pidPath = join(logDir, `.keel-lease-${token}.pid`);
    const leaseChild = [
      `printf '%s\\n' "$$" > ${shellQuote(pidPath)}`,
      [
        "exec",
        shellQuote(this.#shell),
        "--norc",
        "--noprofile",
        "-lc",
        '"$1"',
        "</dev/null",
        `>>${shellQuote(opts.logPath)}`,
        "2>&1",
      ].join(" "),
    ].join("\n");
    const wrapper = [
      "trap - DEBUG",
      "if ! command -v setsid >/dev/null 2>&1; then",
      "  echo 'keel lease error: setsid is required for verifier-handoff leases' >&2",
      "  exit 127",
      "fi",
      `mkdir -p ${shellQuote(logDir)}`,
      `__keel_lease_pid_path=${shellQuote(pidPath)}`,
      'rm -f "$__keel_lease_pid_path"',
      `setsid ${shellQuote(this.#shell)} --norc --noprofile -lc ${shellQuote(leaseChild)} keel-lease ${shellQuote(
        command,
      )} &`,
      "__keel_lease_wait=0",
      'while [ ! -s "$__keel_lease_pid_path" ] && [ "$__keel_lease_wait" -lt 100 ]; do',
      "  __keel_lease_wait=$((__keel_lease_wait + 1))",
      "  sleep 0.05",
      "done",
      'if [ ! -s "$__keel_lease_pid_path" ]; then',
      "  echo 'keel lease error: pid handshake timed out' >&2",
      "  exit 124",
      "fi",
      '__keel_lease_pid=$(cat "$__keel_lease_pid_path")',
      'rm -f "$__keel_lease_pid_path"',
      'case "$__keel_lease_pid" in',
      "  ''|*[!0-9]*) echo 'keel lease error: pid handshake was malformed' >&2; exit 125 ;;",
      "esac",
      `printf 'keel lease %s pid=%s log=%s\\n' ${shellQuote(token)} "$__keel_lease_pid" ${shellQuote(
        opts.logPath,
      )}`,
    ].join("\n");
    const started = await this.run(wrapper, {
      timeoutMs: 10_000,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    if (started.outcome !== "ok" || started.exitCode !== 0) {
      throw new Error(`leased ${opts.kind} failed to start: ${started.output || started.outcome}`);
    }
    const parsed = parseLeasePid(started.output, token);
    if (parsed === undefined) {
      throw new Error("leased process start did not report a pid");
    }
    return this.#leases.create({
      kind: opts.kind,
      ownerToolCallId: opts.ownerToolCallId,
      command,
      pid: parsed.pid,
      logPath: parsed.logPath,
      scope: opts.scope,
      ...(opts.healthCommand === undefined ? {} : { healthCommand: opts.healthCommand }),
      ...(opts.statusCommand === undefined ? {} : { statusCommand: opts.statusCommand }),
    });
  }

  #runOnce(child: ShellChild, command: string, opts?: RunOptions): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      const marker = makeMarker();
      const capture = new CommandOutputCapture(this.#maxOutputBytes);
      let settled = false;
      let timedOut = false; // the command was killed by a timeout; a later marker means the shell recovered
      let sawOutput = false; // the shell ever emitted ANY byte for this command (vs a silent wedge)
      let buffer = "";
      let output = "";
      let fileProgressTextLength = 0;
      let fileProgressBuffer = "";
      const signal = opts?.signal;

      // Mutable cleanup handles — assigned synchronously before any event can fire.
      // Using a container object avoids `let` re-assignments while letting the closures close over
      // a stable reference they can call after setup completes.
      const cleanup = {
        offStdout: null as null | (() => void),
        offExit: null as null | (() => void),
        idleTimer: undefined as ReturnType<typeof setTimeout> | undefined,
        absoluteTimer: undefined as ReturnType<typeof setTimeout> | undefined,
        resyncTimer: undefined as ReturnType<typeof setTimeout> | undefined,
        fileProgressTimer: undefined as ReturnType<typeof setInterval> | undefined,
      };

      const idleMs = clamp(
        opts?.timeoutMs ?? this.#defaultTimeoutMs,
        this.#minTimeoutMs,
        this.#maxTimeoutMs,
      );
      const absoluteMs = this.#maxTimeoutMs;
      const progressPollMs =
        opts?.onOutput !== undefined ? 25 : Math.max(25, Math.min(250, Math.floor(idleMs / 2)));
      let timeoutKind: RunResult["timeoutKind"];

      const noteProgress = (): void => {
        sawOutput = true;
        if (timedOut || settled) return;
        armIdleTimer();
      };

      const emitFileProgress = (): void => {
        const readAny = capture.readIncremental();
        const current = capture.snapshot().text;
        if (readAny) noteProgress();
        if (current.length <= fileProgressTextLength) return;
        fileProgressBuffer += current.slice(fileProgressTextLength);
        fileProgressTextLength = current.length;
        if (opts?.onOutput === undefined) return;
        let nl: number;
        let lastLine: string | undefined;
        while ((nl = fileProgressBuffer.indexOf("\n")) !== -1) {
          const line = fileProgressBuffer.slice(0, nl);
          fileProgressBuffer = fileProgressBuffer.slice(nl + 1);
          if (line.trim() !== "") lastLine = line;
        }
        if (lastLine !== undefined) opts.onOutput(lastLine);
      };

      const observedCommandOutput = (): boolean => {
        capture.readIncremental();
        return sawOutput || capture.hasOutput;
      };

      const startResyncTimer = (): void => {
        cleanup.resyncTimer = setTimeout(() => {
          recycle();
          // F4 honesty: classify WHY we are resetting. If the shell never emitted a single byte for
          // this command, it never even acknowledged it — a structural WEDGE (e.g. a heredoc fed to an
          // interpreter), not a command that ran out its time. Only a command that produced output and
          // then stalled is an honest "timeout". The caller renders the truth from this, not a blanket
          // "timed out" (the keel14/keel59 bug: a ~9 ms wedge was reported as a timeout that never was).
          settle("timeout", null, true, observedCommandOutput() ? "timeout" : "wedge");
        }, this.#graceTimeoutMs);
        cleanup.resyncTimer.unref?.();
      };

      const triggerTimeout = (kind: NonNullable<RunResult["timeoutKind"]>): void => {
        if (settled || timedOut) return;
        timeoutKind = kind;
        timedOut = true;
        if (cleanup.idleTimer) clearTimeout(cleanup.idleTimer);
        if (cleanup.absoluteTimer) clearTimeout(cleanup.absoluteTimer);
        // Keep-shell-alive (ADR-0050): terminate the command's subtree, then give the shell a grace
        // window to re-synchronise (emit its marker — see onData). If it does, cwd/env survive. If it
        // wedges, fall back to a full reset so the session can never hang.
        try {
          child.killChildren();
        } catch {
          // Process-table enumeration is a best-effort portability aid (`/proc`, then `ps` on macOS).
          // If it is unavailable in a restricted runner, fall back to the older full shell reset and
          // settle honestly rather than throwing from a timer or leaving the run unresolved.
          recycle();
          settle("timeout", null, true, observedCommandOutput() ? "timeout" : "wedge");
          return;
        }
        startResyncTimer();
      };

      function armIdleTimer(): void {
        if (cleanup.idleTimer) clearTimeout(cleanup.idleTimer);
        cleanup.idleTimer = setTimeout(() => triggerTimeout("idle"), idleMs);
        cleanup.idleTimer.unref?.();
      }

      const settle = (
        outcome: RunOutcome,
        exitCode: number | null,
        shellReset = false,
        resetCause?: "timeout" | "wedge",
      ): void => {
        if (settled) return;
        settled = true;
        if (cleanup.idleTimer) clearTimeout(cleanup.idleTimer);
        if (cleanup.absoluteTimer) clearTimeout(cleanup.absoluteTimer);
        if (cleanup.resyncTimer) clearTimeout(cleanup.resyncTimer);
        if (cleanup.fileProgressTimer) clearInterval(cleanup.fileProgressTimer);
        cleanup.offStdout?.();
        cleanup.offExit?.();
        if (signal) signal.removeEventListener("abort", onAbort);
        emitFileProgress();
        // Strip trailing newlines: the marker's leading \n contributes an empty separator line, and
        // the command's own output typically ends with a newline too. Strip both so the caller gets
        // the command output without a trailing newline (matching shell $(...) semantics).
        const controlOutput = output.replace(/\n+$/, "");
        const fileSnapshot = capture.snapshot();
        capture.cleanup();
        const fileOutput = fileSnapshot.text;
        const raw = [controlOutput, fileOutput]
          .filter((part) => part.length > 0)
          .join("\n")
          .replace(/\n+$/, "");
        const { text, truncated } = truncateHeadTail(raw, this.#maxOutputBytes);
        resolve({
          output: text,
          exitCode,
          outcome,
          truncated: truncated || fileSnapshot.truncated,
          ...(outcome === "timeout" && timeoutKind !== undefined ? { timeoutKind } : {}),
          shellReset,
          ...(resetCause !== undefined ? { resetCause } : {}),
        });
      };

      const recycle = (): void => {
        child.killGroup();
        this.#child = undefined;
      };

      const onData = (chunk: string): void => {
        if (chunk.length > 0) noteProgress(); // the shell IS alive for this command (not a silent wedge)
        buffer += chunk;
        let nl: number;
        let lastLine: string | undefined; // latest non-blank line completed in THIS chunk (1.5c liveness)
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const code = parseMarkerLine(line, marker);
          if (code !== null) {
            // A marker after a timeout means the shell re-synchronised post-kill: keep it alive
            // (cwd/env intact) and report the timeout. Otherwise it is a normal completion. We return
            // BEFORE the onOutput emit below, so the final output line (which shares the marker chunk)
            // is never streamed live — the result supersedes it the instant the command settles.
            settle(timedOut ? "timeout" : "ok", code, false);
            return;
          }
          output += `${line}\n`;
          if (line.trim() !== "") lastLine = line;
        }
        // Surface the latest meaningful line of this chunk (coalescing — one event per stdout flush,
        // not per line; the reducer keeps only the latest, so coarser granularity is always safe).
        if (lastLine !== undefined) opts?.onOutput?.(lastLine);
      };

      const onExit = (_code: number | null): void => {
        // Shell died before the marker (e.g. the command ran `exit`/`exec`, or it crashed).
        this.#child = undefined;
        settle("shell-died", null);
      };

      const onAbort = (): void => {
        recycle();
        settle("aborted", null);
      };

      cleanup.offStdout = child.onStdout(onData);
      cleanup.offExit = child.onExit(onExit);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      cleanup.fileProgressTimer = setInterval(emitFileProgress, progressPollMs);
      cleanup.fileProgressTimer.unref?.();

      armIdleTimer();
      cleanup.absoluteTimer = setTimeout(() => triggerTimeout("absolute"), absoluteMs);
      cleanup.absoluteTimer.unref?.();

      // Put the model command on its own lines inside the redirected group. This preserves normal
      // heredoc syntax: the terminator must be alone on a line, so appending `; }` to the command's
      // final line makes valid `<<EOF ... EOF` commands wedge. The group redirection keeps interactive
      // stdin at EOF (commands cannot steal the protocol) and sends command stdout/stderr to an owned
      // file, so a daemon that inherits command output cannot keep the shell control pipe open after
      // the session owner exits. The persistent shell's stdout is now only the completion control
      // channel; fake tests still inject output there directly.
      //
      // Capture status before printing the marker, then clear DEBUG traps while the marker is not
      // present in BASH_COMMAND. Otherwise a command can install a DEBUG trap, observe the literal
      // marker in the wrapper's printf command, and print a forged marker first.
      child.write(
        `__keel_output=${shellQuote(capture.path)}\n: > "$__keel_output"\n{\n${command}\n} </dev/null > "$__keel_output" 2>&1\n__keel_status=$?\ntrap - DEBUG\nprintf '\\n%s:%s\\n' "${marker}" "$__keel_status"\n`,
      );
    });
  }
}
