import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PipeShellSession,
  descendantPids,
  killSubtree,
  parseProcStat,
  parsePsTable,
  signalPid,
  type ShellChild,
  type SpawnShell,
} from "./shell-session.js";

const requireFromRoot = createRequire(`${process.cwd()}/package.json`);
const TSX_ESM_LOADER = pathToFileURL(requireFromRoot.resolve("tsx/esm")).href;
const SHELL_SESSION_SOURCE = pathToFileURL(
  resolve(process.cwd(), "packages/kernel/src/tools/shell-session.ts"),
).href;

/** A controllable fake shell: tests drive stdout/exit and observe writes + kills. */
class FakeChild implements ShellChild {
  pid: number | undefined = 4242;
  writes: string[] = [];
  killed = 0; // killGroup() calls — the whole-group SIGKILL (reset/abort/dispose)
  killedChildren = 0; // killChildren() calls — the command-subtree kill that keeps the shell
  #stdout: ((c: string) => void)[] = [];
  #exit: ((code: number | null) => void)[] = [];
  write(d: string): void {
    this.writes.push(d);
  }
  onStdout(cb: (c: string) => void): () => void {
    this.#stdout.push(cb);
    return () => (this.#stdout = this.#stdout.filter((f) => f !== cb));
  }
  onExit(cb: (code: number | null) => void): () => void {
    this.#exit.push(cb);
    return () => (this.#exit = this.#exit.filter((f) => f !== cb));
  }
  killGroup(): void {
    this.killed += 1;
  }
  killChildren(): void {
    this.killedChildren += 1;
  }
  emit(chunk: string): void {
    for (const cb of this.#stdout) cb(chunk);
  }
  exit(code: number | null): void {
    for (const cb of this.#exit) cb(code);
  }
  /** Echo the marker line a real shell would print for the last command (drives "ok"). */
  complete(exitCode: number, output = ""): void {
    const w = this.writes.at(-1) ?? "";
    const marker = /(__keel_done_[0-9a-f]{32}__)/.exec(w)?.[1] ?? "MISSING";
    this.emit(`${output}\n${marker}:${String(exitCode)}\n`);
  }
}

const sessionWith = (child: FakeChild): PipeShellSession => {
  const spawn: SpawnShell = () => child;
  return new PipeShellSession({ cwd: "/tmp", spawn });
};

function commandExists(command: string): boolean {
  try {
    execFileSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detachedStdoutHoldingDaemonCommand(): string | undefined {
  if (commandExists("setsid")) return "setsid sh -c 'while :; do sleep 60; done' & echo $!";
  if (commandExists("python3")) {
    return [
      "python3 -c ",
      "'import subprocess; ",
      'p=subprocess.Popen(["sh","-c","while :; do sleep 60; done"], ',
      "stdin=subprocess.DEVNULL, start_new_session=True); ",
      "print(p.pid)'",
    ].join("");
  }
  return undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i += 1) {
    if (!pidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !pidAlive(pid);
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Best-effort test cleanup.
    }
  }
}

async function runScriptWithTimeout(
  script: string,
  timeoutMs: number,
  startTimeoutAfter?: string,
): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}> {
  return await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", TSX_ESM_LOADER, "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let operationTimerArmed = startTimeoutAfter === undefined;
    let operationTimer: ReturnType<typeof setTimeout> | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      const match = /^daemon:(\d+)$/mu.exec(stdout);
      if (match !== null) killProcessGroup(Number(match[1]));
      if (child.pid !== undefined) killProcessGroup(child.pid);
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (operationTimer !== undefined) clearTimeout(operationTimer);
      if (startupTimer !== undefined) clearTimeout(startupTimer);
      resolve({ stdout, stderr, code, signal, timedOut });
    };
    const onTimeout = (): void => {
      timedOut = true;
      cleanup();
    };
    if (operationTimerArmed) {
      operationTimer = setTimeout(onTimeout, timeoutMs);
      operationTimer.unref();
    } else {
      startupTimer = setTimeout(onTimeout, Math.max(5_000, timeoutMs));
      startupTimer.unref();
    }
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!operationTimerArmed && stdout.includes(startTimeoutAfter ?? "")) {
        operationTimerArmed = true;
        if (startupTimer !== undefined) clearTimeout(startupTimer);
        operationTimer = setTimeout(onTimeout, timeoutMs);
        operationTimer.unref();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      stderr += err.message;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

describe("process-tree helpers (descendant-subtree kill, ADR-0050)", () => {
  it("parseProcStat reads the PPID after the last ')' (comm may contain spaces/parens)", () => {
    expect(parseProcStat("123 (bash) S 100 123 123 0 -1")).toBe(100);
    expect(parseProcStat("42 ((odd) cmd name) R 7 42 0")).toBe(7); // comm with spaces + parens
    expect(parseProcStat("5 (x) S 0 0 0")).toBe(0);
    expect(parseProcStat("no-paren-line")).toBeUndefined();
    expect(parseProcStat("9 (x) S notanumber 0")).toBeUndefined();
  });

  it("parsePsTable parses pid/ppid rows and skips non-matching lines", () => {
    const text = "  PID  PPID\n  100    1\n  200  100\ngarbage line\n  300  200\n";
    expect(parsePsTable(text)).toEqual([
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 },
    ]);
    expect(parsePsTable("")).toEqual([]);
  });

  it("descendantPids returns the transitive subtree, excluding the root", () => {
    const table = [
      { pid: 100, ppid: 1 }, // the shell
      { pid: 200, ppid: 100 }, // child
      { pid: 300, ppid: 200 }, // grandchild
      { pid: 400, ppid: 100 }, // sibling child
      { pid: 999, ppid: 2 }, // unrelated
    ];
    expect(descendantPids(table, 100).sort((a, b) => a - b)).toEqual([200, 300, 400]);
    expect(descendantPids(table, 200)).toEqual([300]); // grandchild only
    expect(descendantPids(table, 300)).toEqual([]); // leaf → none
    expect(descendantPids(table, 12345)).toEqual([]); // root absent → none
  });

  it("terminates on a cyclic (pid,ppid) table — a corrupted/hostile process table cannot wedge the kill (EXEC-3)", () => {
    // The table is parsed from untrusted /proc | ps text; a row asserting a PPID cycle (1↔2) would
    // loop the tree-walk forever without a visited guard. Each pid must be visited at most once, and
    // the root (1) is never re-added even when a cycle points back at it.
    const table = [
      { pid: 2, ppid: 1 }, // 2 is a child of root 1
      { pid: 1, ppid: 2 }, // ...and 1 is a "child" of 2 → cycle
      { pid: 3, ppid: 2 }, // a real grandchild under 2
      { pid: 4, ppid: 4 }, // a self-parented pid (degenerate) elsewhere in the table
    ];
    expect(descendantPids(table, 1).sort((a, b) => a - b)).toEqual([2, 3]); // terminates; root excluded
  }, 2000);

  it("killSubtree SIGTERMs descendants then SIGKILL-sweeps stragglers (root never signalled)", () => {
    const kills: [number, string][] = [];
    const scheduled: (() => void)[] = [];
    killSubtree(100, {
      readTable: () => [
        { pid: 100, ppid: 1 },
        { pid: 200, ppid: 100 },
        { pid: 300, ppid: 200 },
      ],
      kill: (pid, sig) => kills.push([pid, sig]),
      schedule: (fn) => scheduled.push(fn),
    });
    expect(kills).toEqual([
      [200, "SIGTERM"],
      [300, "SIGTERM"],
    ]); // root 100 is never signalled
    expect(scheduled).toHaveLength(1);
    scheduled[0]!(); // run the sweep
    expect(kills.slice(2)).toEqual([
      [200, "SIGKILL"],
      [300, "SIGKILL"],
    ]);
  });

  it("killSubtree is a no-op for an undefined pid, or a pid with no descendants", () => {
    let killCount = 0;
    let scheduleCount = 0;
    const deps = {
      readTable: () => [{ pid: 100, ppid: 1 }],
      kill: () => (killCount += 1),
      schedule: () => (scheduleCount += 1),
    };
    killSubtree(undefined, deps); // undefined root
    killSubtree(100, deps); // present, but nothing descends from it
    expect(killCount).toBe(0);
    expect(scheduleCount).toBe(0);
  });

  it("signalPid swallows ESRCH but rethrows other process.kill errors", () => {
    const kill = vi.spyOn(process, "kill");
    try {
      kill.mockImplementation(() => {
        const err = new Error("gone") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      });
      expect(() => signalPid(12345, "SIGTERM")).not.toThrow();

      kill.mockImplementation(() => {
        const err = new Error("denied") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      });
      expect(() => signalPid(12345, "SIGTERM")).toThrow(/denied/);
    } finally {
      kill.mockRestore();
    }
  });
});

describe("PipeShellSession (deterministic, fake child)", () => {
  it("runs a command and returns ok + exit code + output (marker stripped)", async () => {
    const child = new FakeChild();
    const s = sessionWith(child);
    const p = s.run("echo hi");
    child.complete(0, "hi");
    const r = await p;
    expect(r).toMatchObject({ outcome: "ok", exitCode: 0, output: "hi", truncated: false });
    expect(child.writes[0]).toContain('</dev/null > "$__keel_output" 2>&1');
  });

  it("surfaces a non-zero exit code", async () => {
    const child = new FakeChild();
    const s = sessionWith(child);
    const p = s.run("false");
    child.complete(1, "");
    expect((await p).exitCode).toBe(1);
  });

  it("detects the marker even when split across stdout chunks", async () => {
    const child = new FakeChild();
    const s = sessionWith(child);
    const p = s.run("x");
    const marker = /(__keel_done_[0-9a-f]{32}__)/.exec(child.writes[0] ?? "")?.[1] ?? "";
    child.emit("partial");
    child.emit(`\n${marker}`);
    child.emit(":0\n"); // marker line completed across three chunks
    expect((await p).outcome).toBe("ok");
  });

  it("does NOT complete early on output containing a marker-like but non-terminal line", async () => {
    const child = new FakeChild();
    const s = sessionWith(child);
    const p = s.run("x");
    const marker = /(__keel_done_[0-9a-f]{32}__)/.exec(child.writes[0] ?? "")?.[1] ?? "";
    child.emit(`prefix ${marker}:0 suffix\n`); // not anchored → ignored
    child.complete(0, "real");
    expect((await p).output).toContain("real");
  });

  it("onOutput streams the latest completed non-blank line per chunk (Epic 1.5c liveness)", async () => {
    const child = new FakeChild();
    const s = sessionWith(child);
    const lines: string[] = [];
    const p = s.run("build", { onOutput: (l) => lines.push(l) });
    child.emit("compiling a.ts\n"); // one completed line → emit it
    child.emit("compiling b.ts\nlinking\n"); // two in one chunk → emit only the latest
    child.emit("partial-no-newline"); // no newline yet → nothing emitted
    child.emit("\n   \n"); // completes the partial then a blank line → latest non-blank = the partial
    child.complete(0, ""); // marker chunk — never streamed as output
    await p;
    expect(lines).toEqual(["compiling a.ts", "linking", "partial-no-newline"]);
  });

  it("onOutput never emits the marker line, and a blank-only chunk emits nothing", async () => {
    const child = new FakeChild();
    const s = sessionWith(child);
    const lines: string[] = [];
    const p = s.run("x", { onOutput: (l) => lines.push(l) });
    child.emit("\n\n   \n"); // only blank lines → nothing
    child.complete(0, "final-with-marker"); // the line sharing the marker chunk is not streamed live
    await p;
    expect(lines).toEqual([]); // no blank, no marker, no superseded final line
  });

  it("does not fabricate elapsed-time output for silent long-running commands", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const s = new PipeShellSession({
        cwd: "/tmp",
        spawn: () => child,
        defaultTimeoutMs: 1000,
        progressIntervalMs: 100,
      });
      const lines: string[] = [];
      const p = s.run("long-running", { onOutput: (l) => lines.push(l) });

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      child.complete(0, "");
      await p;

      expect(lines).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("on timeout, terminates the command's children and KEEPS the shell when it resyncs", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const s = new PipeShellSession({ cwd: "/tmp", spawn: () => child, defaultTimeoutMs: 100 });
      const p = s.run("sleep 999");
      await vi.advanceTimersByTimeAsync(100); // command timeout fires
      expect(child.killedChildren).toBe(1); // command subtree killed…
      expect(child.killed).toBe(0); // …but the shell is NOT group-killed
      child.complete(137); // shell recovers and emits the marker for the killed command
      const r = await p;
      expect(r.outcome).toBe("timeout");
      expect(r.shellReset).toBe(false); // shell + cwd/env intact
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats timeoutMs as an idle timeout and extends it on command output", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const s = new PipeShellSession({
        cwd: "/tmp",
        spawn: () => child,
        defaultTimeoutMs: 100,
        maxTimeoutMs: 300,
      });
      const p = s.run("make build");

      await vi.advanceTimersByTimeAsync(90);
      child.emit("compiling a\n");
      await vi.advanceTimersByTimeAsync(90);
      expect(child.killedChildren).toBe(0);

      child.complete(0, "done");
      const r = await p;
      expect(r.outcome).toBe("ok");
      expect(r.output).toContain("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("absolute timeout still wins even when command output keeps growing", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const s = new PipeShellSession({
        cwd: "/tmp",
        spawn: () => child,
        defaultTimeoutMs: 100,
        maxTimeoutMs: 250,
      });
      const p = s.run("make build");

      await vi.advanceTimersByTimeAsync(80);
      child.emit("phase 1\n");
      await vi.advanceTimersByTimeAsync(80);
      child.emit("phase 2\n");
      await vi.advanceTimersByTimeAsync(80);
      child.emit("phase 3\n");
      expect(child.killedChildren).toBe(0);

      await vi.advanceTimersByTimeAsync(11);
      expect(child.killedChildren).toBe(1);
      child.complete(137);

      const r = await p;
      expect(r.outcome).toBe("timeout");
      expect(r.shellReset).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("on timeout, falls back to a full reset if the shell does not resync within the grace window", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const s = new PipeShellSession({
        cwd: "/tmp",
        spawn: () => child,
        defaultTimeoutMs: 100,
        graceTimeoutMs: 100,
      });
      const p = s.run("sleep 999");
      await vi.advanceTimersByTimeAsync(100); // timeout → killChildren + arm the grace window
      expect(child.killedChildren).toBe(1);
      await vi.advanceTimersByTimeAsync(100); // grace elapses with no marker → fallback reset
      const r = await p;
      expect(r.outcome).toBe("timeout");
      expect(r.shellReset).toBe(true); // shell was reset (legacy fallback)
      expect(child.killed).toBe(1); // group-killed in the fallback
    } finally {
      vi.useRealTimers();
    }
  });

  it("on timeout, falls back to a full reset if command-subtree cleanup throws", async () => {
    vi.useFakeTimers();
    try {
      class CleanupThrowChild extends FakeChild {
        override killChildren(): void {
          this.killedChildren += 1;
          throw new Error("spawnSync ps EPERM");
        }
      }
      const child = new CleanupThrowChild();
      const s = new PipeShellSession({
        cwd: "/tmp",
        spawn: () => child,
        defaultTimeoutMs: 100,
        graceTimeoutMs: 100,
      });
      const p = s.run("sleep 999");
      await vi.advanceTimersByTimeAsync(100);
      const r = await p;
      expect(r.outcome).toBe("timeout");
      expect(r.shellReset).toBe(true);
      expect(r.resetCause).toBe("wedge");
      expect(child.killedChildren).toBe(1);
      expect(child.killed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("labels a reset 'wedge' when the command produced NO output before the reset (F4 honesty)", async () => {
    // A heredoc fed to an interpreter wedges stdin: the shell never acknowledges the command (zero
    // output, no marker) and the fallback resets it. That is a STRUCTURAL wedge, not a slow command
    // that ran out its budget — so the cause is recorded as "wedge", and the bash tool tells the truth.
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const s = new PipeShellSession({
        cwd: "/tmp",
        spawn: () => child,
        defaultTimeoutMs: 100,
        graceTimeoutMs: 100,
      });
      const p = s.run("python3 <<'EOF'\nprint(1)\nEOF");
      await vi.advanceTimersByTimeAsync(100); // timeout fires; shell never emitted anything
      await vi.advanceTimersByTimeAsync(100); // grace elapses with no marker → fallback reset
      const r = await p;
      expect(r.outcome).toBe("timeout");
      expect(r.shellReset).toBe(true);
      expect(r.resetCause).toBe("wedge"); // no output ever → the shell wedged, it did not "time out"
    } finally {
      vi.useRealTimers();
    }
  });

  it("labels a reset 'timeout' when the command DID produce output before wedging (genuine timeout)", async () => {
    // A genuinely long-running command emits output, then stops responding and cannot resync. The
    // command really did run for its budget — the reset cause is an honest "timeout", not a wedge.
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const s = new PipeShellSession({
        cwd: "/tmp",
        spawn: () => child,
        defaultTimeoutMs: 100,
        graceTimeoutMs: 100,
      });
      const p = s.run("make build");
      child.emit("compiling…\n"); // the command acknowledged + did work before stalling
      await vi.advanceTimersByTimeAsync(100); // timeout fires
      await vi.advanceTimersByTimeAsync(100); // grace elapses with no marker → fallback reset
      const r = await p;
      expect(r.outcome).toBe("timeout");
      expect(r.shellReset).toBe(true);
      expect(r.resetCause).toBe("timeout"); // it ran and produced output → a real timeout
    } finally {
      vi.useRealTimers();
    }
  });

  it("on a kept-shell timeout (resync), leaves resetCause unset (no reset, nothing to classify)", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const s = new PipeShellSession({ cwd: "/tmp", spawn: () => child, defaultTimeoutMs: 100 });
      const p = s.run("sleep 999");
      await vi.advanceTimersByTimeAsync(100); // command timeout fires
      child.complete(137); // shell recovers and emits the marker → no reset
      const r = await p;
      expect(r.outcome).toBe("timeout");
      expect(r.shellReset).toBe(false);
      expect(r.resetCause).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors an AbortSignal mid-command: kills the group, reports 'aborted'", async () => {
    const child = new FakeChild();
    const s = sessionWith(child);
    const ac = new AbortController();
    const p = s.run("sleep 999", { signal: ac.signal });
    ac.abort();
    const r = await p;
    expect(r.outcome).toBe("aborted");
    expect(child.killed).toBe(1);
  });

  it("reports 'shell-died' if the shell exits before the marker", async () => {
    const child = new FakeChild();
    const s = sessionWith(child);
    const p = s.run("exit");
    child.exit(0); // shell gone, no marker
    expect((await p).outcome).toBe("shell-died");
  });

  it("rejects a concurrent run (sequential use only)", async () => {
    const child = new FakeChild();
    const s = sessionWith(child);
    const p1 = s.run("a");
    await expect(s.run("b")).rejects.toThrow(/sequential|already running/i);
    child.complete(0);
    await p1;
  });

  it("truncates output that exceeds the cap", async () => {
    const child = new FakeChild();
    const s = new PipeShellSession({ cwd: "/tmp", spawn: () => child, maxOutputBytes: 100 });
    const p = s.run("big");
    child.complete(0, "Q".repeat(500));
    const r = await p;
    expect(r.truncated).toBe(true);
    expect(r.output).toMatch(/elided/);
  });

  it("truncates captured output on UTF-8 boundaries", async () => {
    const child = new FakeChild();
    const s = new PipeShellSession({ cwd: "/tmp", spawn: () => child, maxOutputBytes: 101 });
    const p = s.run("big");
    const outputPath = /__keel_output='([^']+)'/u.exec(child.writes[0] ?? "")?.[1];
    expect(outputPath).toBeDefined();
    appendFileSync(outputPath!, "€".repeat(200));
    child.complete(0);

    const result = await p;

    expect(result.truncated).toBe(true);
    expect(result.output).toMatch(/elided/);
    expect(result.output).not.toContain("�");
  });

  it("keeps idle-progress alive from command output even after visible capture is truncated", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const s = new PipeShellSession({
        cwd: "/tmp",
        spawn: () => child,
        maxOutputBytes: 64,
        defaultTimeoutMs: 100,
        maxTimeoutMs: 1_000,
      });
      const p = s.run("very noisy build", { onOutput: () => undefined });
      const outputPath = /__keel_output='([^']+)'/u.exec(child.writes[0] ?? "")?.[1];
      expect(outputPath).toBeDefined();

      for (let i = 0; i < 5; i += 1) {
        appendFileSync(outputPath!, `${"x".repeat(200)}\n`);
        await vi.advanceTimersByTimeAsync(30);
      }
      expect(child.killedChildren).toBe(0);

      child.complete(0);
      const result = await p;
      expect(result.outcome).toBe("ok");
      expect(result.truncated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports capture tamper if the command output file shrinks after progress was read", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const s = new PipeShellSession({
        cwd: "/tmp",
        spawn: () => child,
        defaultTimeoutMs: 100,
      });
      const p = s.run("truncate capture", { onOutput: () => undefined });
      const outputPath = /__keel_output='([^']+)'/u.exec(child.writes[0] ?? "")?.[1];
      expect(outputPath).toBeDefined();

      appendFileSync(outputPath!, "first line\n");
      await vi.advanceTimersByTimeAsync(30);
      writeFileSync(outputPath!, "");
      child.complete(0);

      const result = await p;
      expect(result.truncated).toBe(true);
      expect(result.output).toContain("command output capture was replaced or removed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns aborted immediately when signal is already aborted before run", async () => {
    const child = new FakeChild();
    const s = sessionWith(child);
    const ac = new AbortController();
    ac.abort();
    const r = await s.run("never", { signal: ac.signal });
    expect(r.outcome).toBe("aborted");
    expect(child.writes).toHaveLength(0); // no command was written
  });

  it("dispose without a running child is a no-op", async () => {
    const child = new FakeChild();
    const s = sessionWith(child);
    await expect(s.dispose()).resolves.toBeUndefined();
    expect(child.killed).toBe(0);
  });

  it("starts leased work in a detached wrapper, records its pid, and leaves dispose to reap only the shell group", async () => {
    const child = new FakeChild();
    const signals: Array<[number, NodeJS.Signals]> = [];
    const s = new PipeShellSession({
      cwd: "/tmp",
      spawn: () => child,
      leaseDeps: {
        readStartIdentity: (pid) => `start:${String(pid)}`,
        signalProcessGroup: (pgid, signal) => signals.push([pgid, signal]),
        isProcessAlive: () => false,
        sleep: async () => {},
      },
    });

    const p = s.startLeased("python3 -m http.server 8000", {
      kind: "service",
      ownerToolCallId: "call_http",
      scope: "until-verifier-handoff",
      logPath: "/tmp/keel-http.log",
      healthCommand: "curl -fsS http://127.0.0.1:8000/",
    });
    expect(child.writes[0]).toContain("setsid");
    expect(child.writes[0]).toContain("python3 -m http.server 8000");
    expect(child.writes[0]).toContain('"$$"');
    expect(child.writes[0]).toContain("__keel_lease_pid_path=");
    expect(child.writes[0]).toContain('while [ ! -s "$__keel_lease_pid_path" ]');
    expect(child.writes[0]).not.toContain("__keel_lease_pid=$!");
    const token = /keel lease %s pid=%s log=%s\\n[\s\S]*?([0-9a-f]{16})/u.exec(
      child.writes[0] ?? "",
    )?.[1];
    expect(token).toBeDefined();
    child.complete(
      0,
      `keel lease deadbeef pid=1 log=/tmp/forged.log\nkeel lease ${token ?? ""} pid=777 log=/tmp/keel-http.log`,
    );

    const lease = await p;
    expect(lease.id).toMatch(/^lease_/);
    expect(lease).toMatchObject({
      ownerToolCallId: "call_http",
      pid: 777,
      processGroupId: 777,
      startIdentity: "start:777",
      logPath: "/tmp/keel-http.log",
      scope: "until-verifier-handoff",
    });
    expect(s.activeLeases()).toEqual([lease]);

    await s.dispose();
    expect(child.killed).toBe(1);
    expect(signals).toEqual([]);

    await expect(s.cleanupLeases()).resolves.toEqual([{ id: lease.id, status: "cleaned" }]);
    expect(s.activeLeases()).toEqual([]);
    expect(signals).toEqual([
      [777, "SIGTERM"],
      [777, "SIGKILL"],
    ]);
  });

  it("rejects lease log paths that route command output back into the control channel", async () => {
    const child = new FakeChild();
    const s = new PipeShellSession({ cwd: "/tmp", spawn: () => child });

    await expect(
      s.startLeased("python3 -m http.server 8000", {
        kind: "service",
        ownerToolCallId: "call_http",
        scope: "until-verifier-handoff",
        logPath: "/dev/stdout",
      }),
    ).rejects.toThrow(/not stdout\/stderr\/fd/i);
    expect(child.writes).toEqual([]);
  });

  it("rejects leased starts with an empty owner tool call id", async () => {
    const child = new FakeChild();
    const s = new PipeShellSession({ cwd: "/tmp", spawn: () => child });

    await expect(
      s.startLeased("python3 -m http.server 8000", {
        kind: "service",
        ownerToolCallId: "",
        scope: "until-verifier-handoff",
        logPath: "/tmp/keel-http.log",
      }),
    ).rejects.toThrow(/executor-provided owner tool call id/i);
    expect(child.writes).toEqual([]);
  });

  it("reports leased start failures and malformed pid output", async () => {
    const failedChild = new FakeChild();
    const failed = new PipeShellSession({ cwd: "/tmp", spawn: () => failedChild });
    const failedStart = failed.startLeased("python3 -m http.server 8000", {
      kind: "service",
      ownerToolCallId: "call_http",
      scope: "until-verifier-handoff",
      logPath: "/tmp/keel-http.log",
    });
    failedChild.complete(127, "keel lease error: setsid is required");
    await expect(failedStart).rejects.toThrow(/failed to start/i);

    const malformedChild = new FakeChild();
    const malformed = new PipeShellSession({ cwd: "/tmp", spawn: () => malformedChild });
    const malformedStart = malformed.startLeased("python3 -m http.server 8000", {
      kind: "service",
      ownerToolCallId: "call_http",
      scope: "until-verifier-handoff",
      logPath: "/tmp/keel-http.log",
    });
    malformedChild.complete(0, "lease started without pid");
    await expect(malformedStart).rejects.toThrow(/did not report a pid/i);
  });

  it("respawns after shell-died on the next run", async () => {
    let spawnCount = 0;
    const children = [new FakeChild(), new FakeChild()];
    const spawn: SpawnShell = () => {
      const c = children[spawnCount] ?? children[0]!;
      spawnCount += 1;
      return c;
    };
    const s = new PipeShellSession({ cwd: "/tmp", spawn });
    // First run: shell dies
    const p1 = s.run("exit");
    children[0]!.exit(0);
    expect((await p1).outcome).toBe("shell-died");
    // Second run: should use a new child
    const p2 = s.run("ok");
    children[1]!.complete(0, "fresh");
    const r2 = await p2;
    expect(r2.outcome).toBe("ok");
    expect(spawnCount).toBe(2); // a new shell was spawned
  });
});

describe("PipeShellSession (real bash smoke)", () => {
  let session: PipeShellSession | undefined;
  afterEach(async () => {
    await session?.dispose();
    session = undefined;
  });

  it("runs real commands, persisting cwd across runs", async () => {
    session = new PipeShellSession({ cwd: process.cwd() });
    const a = await session.run("echo hello");
    expect(a.output).toBe("hello");
    expect(a.exitCode).toBe(0);
    await session.run("cd /tmp");
    const b = await session.run("pwd");
    expect(b.output).toMatch(/tmp/); // cwd persisted across runs
    const f = await session.run("false");
    expect(f.exitCode).toBe(1);
  });

  it("runs heredoc-fed commands without wedging, and preserves cwd/env afterward", async () => {
    session = new PipeShellSession({ cwd: process.cwd() });
    await session.run("cd /tmp && export KEEL_HEREDOC_OK=still-here");

    const heredoc = await session.run("node <<'EOF'\nconsole.log('heredoc ok')\nEOF", {
      timeoutMs: 2_000,
    });
    expect(heredoc).toMatchObject({
      outcome: "ok",
      exitCode: 0,
      output: "heredoc ok",
      shellReset: false,
    });

    const persisted = await session.run('printf \'%s:%s\\n\' "$PWD" "$KEEL_HEREDOC_OK"');
    expect(persisted.output).toMatch(/\/tmp:still-here$/);
  });

  it("does not let a DEBUG trap discover and forge the completion marker", async () => {
    session = new PipeShellSession({ cwd: process.cwd() });
    const attack = [
      "trap '",
      'case "$BASH_COMMAND" in',
      "*__keel_done_*)",
      '  forged="${BASH_COMMAND#*__keel_done_}";',
      '  forged="__keel_done_${forged%%__*}__";',
      '  printf "\\n%s:0\\n" "$forged";',
      "  ;;",
      "esac",
      "' DEBUG",
      "false",
    ].join("\n");

    const result = await session.run(attack, { timeoutMs: 2_000 });
    expect(result.outcome).toBe("ok");
    expect(result.exitCode).toBe(1);
    expect(result.output).not.toContain("__keel_done_");
  });

  it("does not follow a replaced command-output capture path", async () => {
    session = new PipeShellSession({ cwd: process.cwd() });
    const result = await session.run('rm "$__keel_output"\nln -s /etc/passwd "$__keel_output"', {
      timeoutMs: 2_000,
    });

    expect(result.outcome).toBe("ok");
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("command output capture was replaced or removed");
    expect(result.output).not.toContain("root:");
  });

  it("supports file-writing heredocs and still gives interactive commands EOF", async () => {
    session = new PipeShellSession({ cwd: process.cwd() });
    const path = `/tmp/keel-heredoc-${String(process.pid)}.txt`;
    await session.run(`rm -f ${path}`);

    const write = await session.run(`cat <<'EOF' > ${path}\nalpha\nbeta\nEOF`, {
      timeoutMs: 2_000,
    });
    expect(write.outcome).toBe("ok");

    const read = await session.run(`cat ${path}`);
    expect(read.output).toBe("alpha\nbeta");

    const interactive = await session.run("cat", { timeoutMs: 2_000 });
    expect(interactive).toMatchObject({ outcome: "ok", exitCode: 0, output: "" });
  });

  it("bounds large heredoc output with the existing truncation guard", async () => {
    session = new PipeShellSession({ cwd: process.cwd(), maxOutputBytes: 256 });
    const r = await session.run("node <<'EOF'\nprocess.stdout.write('x'.repeat(20_000))\nEOF", {
      timeoutMs: 2_000,
    });
    expect(r.outcome).toBe("ok");
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.output, "utf8")).toBeLessThan(1_000);
  });

  it("terminates a timed-out heredoc-launched command and recovers the shell", async () => {
    session = new PipeShellSession({ cwd: process.cwd() });
    await session.run("cd /tmp && export KEEL_HEREDOC_TIMEOUT=survived");

    const r = await session.run(
      "node <<'EOF'\nconsole.log('heredoc started')\nsetInterval(() => {}, 1000)\nEOF",
      { timeoutMs: 300 },
    );
    expect(r.outcome).toBe("timeout");
    expect(r.output).toContain("heredoc started");
    expect(r.resetCause).not.toBe("wedge");

    const recovered = await session.run('printf \'%s:%s\\n\' "$PWD" "$KEEL_HEREDOC_TIMEOUT"');
    expect(recovered.outcome).toBe("ok");
    if (r.shellReset === true) {
      // Restricted runners may block process-tree cleanup; the shell may be reset, but the next
      // command must still run and the reset must be reported as a timeout, not a heredoc wedge.
      expect(r.resetCause).toBe("timeout");
    } else {
      expect(recovered.output).toMatch(/\/tmp:survived$/);
    }
  });

  it("streams real intermediate output lines live via onOutput, never blank or the marker (Epic 1.5c)", async () => {
    session = new PipeShellSession({ cwd: process.cwd() });
    const lines: string[] = [];
    const acknowledgements = mkdtempSync(join(tmpdir(), "keel-shell-stream-"));
    const oneObserved = join(acknowledgements, "one");
    const twoObserved = join(acknowledgements, "two");
    try {
      // Each intermediate line waits for the callback to acknowledge it. This proves live delivery
      // without assuming a loaded CI runner will schedule a polling timer within a fixed sleep.
      const r = await session.run(
        [
          "echo one",
          `while [ ! -e ${JSON.stringify(oneObserved)} ]; do sleep 0.01; done`,
          "echo two",
          `while [ ! -e ${JSON.stringify(twoObserved)} ]; do sleep 0.01; done`,
          "echo three",
        ].join("\n"),
        {
          timeoutMs: 5_000,
          onOutput: (line) => {
            lines.push(line);
            if (line === "one") writeFileSync(oneObserved, "");
            if (line === "two") writeFileSync(twoObserved, "");
          },
        },
      );
      expect(r.outcome).toBe("ok");
      expect(r.output).toBe("one\ntwo\nthree"); // authoritative output unchanged
      expect(lines).toContain("one");
      expect(lines).toContain("two");
      expect(lines.every((line) => line.trim() !== "" && !line.includes("__keel_done_"))).toBe(
        true,
      );
    } finally {
      rmSync(acknowledgements, { recursive: true, force: true });
    }
  });

  it("on timeout, terminates the command's subtree and keeps the shell alive when cleanup is available", async () => {
    session = new PipeShellSession({ cwd: process.cwd() });
    await session.run("cd /tmp");
    // Background a child that writes its pid, then waits; the command never returns → timeout.
    const r = await session.run("sleep 999 & echo $!; wait", { timeoutMs: 300 });
    expect(r.outcome).toBe("timeout");
    const pid = Number.parseInt(r.output.trim().split("\n")[0] ?? "0", 10);
    expect(pid).toBeGreaterThan(0);
    // Poll briefly: the backgrounded child must be reaped (no orphan).
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((res) => setTimeout(res, 20));
      } catch {
        alive = false; // ESRCH → gone
      }
    }
    expect(alive).toBe(false); // no orphan
    const pwd = await session.run("pwd");
    if (r.shellReset === true) {
      // Restricted runners may disallow the process-table scan (`ps` fallback). In that case the
      // session honestly falls back to a full shell reset; the next command still works, but cwd/env are
      // not preserved.
      expect(r.resetCause).toBe("timeout");
      expect(pwd.outcome).toBe("ok");
    } else {
      // Normal path: the persistent shell survived with its cwd intact across the timeout.
      expect(r.resetCause).toBeUndefined();
      expect(pwd.output).toMatch(/tmp/);
    }
  });

  it("dispose reaps unleased background jobs that remain in the shell process group", async () => {
    session = new PipeShellSession({ cwd: process.cwd() });
    const r = await session.run("sleep 999 & echo $!", { timeoutMs: 2_000 });
    expect(r.outcome).toBe("ok");
    const pid = Number.parseInt(r.output.trim().split("\n")[0] ?? "0", 10);
    expect(pid).toBeGreaterThan(0);
    expect(pidAlive(pid)).toBe(true);

    await session.dispose();
    session = undefined;

    await expect(waitForPidGone(pid)).resolves.toBe(true);
  });

  it.runIf(commandExists("setsid"))(
    "leased jobs survive session dispose and are reaped by explicit lease cleanup",
    async () => {
      session = new PipeShellSession({ cwd: process.cwd() });
      const logPath = `/tmp/keel-lease-${String(process.pid)}-${String(Date.now())}.log`;
      const lease = await session.startLeased("node -e 'setInterval(() => {}, 1000)'", {
        kind: "job",
        ownerToolCallId: "call_long_job",
        scope: "until-verifier-handoff",
        logPath,
        statusCommand: "ps -p $PID",
      });
      try {
        expect(pidAlive(lease.pid)).toBe(true);
        await session.dispose();
        expect(pidAlive(lease.pid)).toBe(true);

        await expect(session.cleanupLeases()).resolves.toEqual([
          { id: lease.id, status: "cleaned" },
        ]);
        await expect(waitForPidGone(lease.pid)).resolves.toBe(true);
      } finally {
        await session.cleanupLeases();
      }
    },
  );

  it.runIf(detachedStdoutHoldingDaemonCommand() !== undefined)(
    "session owner exits after dispose even when an unleased daemon inherited command stdout",
    async () => {
      const command = detachedStdoutHoldingDaemonCommand();
      if (command === undefined) throw new Error("no detached-daemon helper available");
      const script = `
        import { PipeShellSession } from ${JSON.stringify(SHELL_SESSION_SOURCE)};

        process.stdout.write("wrapper-ready\\n");
        const session = new PipeShellSession({ cwd: process.cwd() });
        const result = await session.run(${JSON.stringify(command)}, { timeoutMs: 2000 });
        const daemonPid = Number.parseInt(result.output.trim().split("\\n").at(-1) ?? "0", 10);
        process.stdout.write(\`daemon:\${daemonPid}\\n\`);
        await session.dispose();
        process.stdout.write("wrapper-exiting\\n");
      `;

      const result = await runScriptWithTimeout(script, 1_500, "wrapper-ready\n");

      expect(result.stdout).toContain("wrapper-exiting");
      expect(result.stderr).toBe("");
      expect(result.timedOut).toBe(false);
      expect(result).toMatchObject({ code: 0, signal: null });
    },
  );
});
