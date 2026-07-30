import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRESTOP_CHECK_MAX_OUTPUT_BYTES,
  DEFAULT_PRESTOP_CHECK_TIMEOUT_MS,
  MAX_PRESTOP_CHECK_MAX_OUTPUT_BYTES,
  MAX_PRESTOP_CHECK_TIMEOUT_MS,
  renderPreStopFailurePrompt,
  runFreshPreStopCheck,
} from "./prestop-check.js";

function commandExists(command: string): boolean {
  try {
    execFileSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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

function readPidFile(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

describe("runFreshPreStopCheck", () => {
  it("rejects an empty command without launching a subprocess", async () => {
    const result = await runFreshPreStopCheck({ command: "   " });
    expect(result).toEqual({
      ok: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      output: "empty pre-stop check command",
      truncated: false,
    });
  });

  it("returns ok only from the fresh subprocess exit status", async () => {
    const pass = await runFreshPreStopCheck({
      command: "node -e \"process.stdout.write('ok')\"",
      timeoutMs: DEFAULT_PRESTOP_CHECK_TIMEOUT_MS,
    });
    expect(pass).toMatchObject({
      ok: true,
      exitCode: 0,
      timedOut: false,
      output: "ok",
      truncated: false,
    });

    const fail = await runFreshPreStopCheck({
      command: "node -e \"process.stderr.write('nope'); process.exit(7)\"",
      timeoutMs: DEFAULT_PRESTOP_CHECK_TIMEOUT_MS,
    });
    expect(fail).toMatchObject({
      ok: false,
      exitCode: 7,
      timedOut: false,
      output: "nope",
      truncated: false,
    });
  });

  it("enforces a timeout and reports it as a failed check", async () => {
    const result = await runFreshPreStopCheck({
      command: 'node -e "setTimeout(() => {}, 10000)"',
      timeoutMs: 50,
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it("captures shell parse errors before the verifier command can redirect output", async () => {
    const result = await runFreshPreStopCheck({
      command: "printf 'unterminated",
      timeoutMs: DEFAULT_PRESTOP_CHECK_TIMEOUT_MS,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/unexpected eof|syntax error|unterminated/i);
  });

  it.runIf(commandExists("python3"))(
    "returns when a successful check leaves a detached daemon holding stdout",
    async () => {
      const pidFile = join(
        tmpdir(),
        `keel-prestop-daemon-${String(process.pid)}-${String(Date.now())}.pid`,
      );
      const running = runFreshPreStopCheck({
        command:
          "python3 -c 'import os, subprocess; " +
          'p=subprocess.Popen(["sh","-c","while :; do sleep 60; done"], ' +
          "stdin=subprocess.DEVNULL, start_new_session=True); " +
          'open(os.environ["KEEL_PRESTOP_PID_FILE"], "w").write(str(p.pid)); ' +
          'print("started")\'',
        env: { KEEL_PRESTOP_PID_FILE: pidFile },
        timeoutMs: 2_000,
      });
      const raced = await Promise.race([
        running,
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 500)),
      ]);
      const daemonPid = readPidFile(pidFile);
      if (daemonPid !== undefined) killProcessGroup(daemonPid);
      if (raced === "hung") await running;

      expect(raced).not.toBe("hung");
      expect(raced).toMatchObject({
        ok: true,
        exitCode: 0,
        timedOut: false,
        output: "started\n",
        truncated: false,
      });
    },
  );

  it("honors an already-aborted signal without waiting for the timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();

    const result = await runFreshPreStopCheck(
      {
        command: 'node -e "setTimeout(() => {}, 10000)"',
        timeoutMs: 1500,
      },
      controller.signal,
    );

    expect(Date.now() - started).toBeLessThan(1200);
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("honors an abort while the subprocess is already running", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const running = runFreshPreStopCheck(
      {
        command: 'node -e "setTimeout(() => {}, 10000)"',
        timeoutMs: 5000,
      },
      controller.signal,
    );

    setTimeout(() => controller.abort(), 50);
    const result = await running;

    expect(Date.now() - started).toBeLessThan(1200);
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("does not inherit provider keys from the parent process environment", async () => {
    const secret = "sk-ant-api03-supersecretvalue1234567890ABCDEF";
    const prev = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = secret;
    try {
      const result = await runFreshPreStopCheck({
        command: "node -e \"process.stdout.write(process.env.ANTHROPIC_API_KEY ?? 'absent')\"",
        timeoutMs: DEFAULT_PRESTOP_CHECK_TIMEOUT_MS,
      });
      expect(result.ok).toBe(true);
      expect(result.output).toBe("absent");
      expect(result.output).not.toContain(secret);
    } finally {
      if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = prev;
    }
  });

  it("returns a redacted spawn error when the subprocess cannot start", async () => {
    const result = await runFreshPreStopCheck({
      command: "true",
      cwd: "/definitely/not/a/real/prestop/cwd",
      timeoutMs: DEFAULT_PRESTOP_CHECK_TIMEOUT_MS,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.output).toMatch(/ENOENT|no such file|cwd/i);
  });

  it("redacts known secret shapes from check output before it can be shown to the model", async () => {
    const secret = "sk-ant-api03-supersecretvalue1234567890ABCDEF";
    const result = await runFreshPreStopCheck({
      command:
        "node -e \"process.stdout.write(process.env.PRINT_ME ?? 'missing'); process.exit(1)\"",
      env: { PRINT_ME: secret },
      timeoutMs: DEFAULT_PRESTOP_CHECK_TIMEOUT_MS,
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("[redacted:anthropic-key]");
    expect(result.output).not.toContain(secret);
  });

  it("caps model-visible output without treating truncation as success", async () => {
    const result = await runFreshPreStopCheck({
      command: "node -e \"process.stdout.write('x'.repeat(2048)); process.exit(1)\"",
      timeoutMs: DEFAULT_PRESTOP_CHECK_TIMEOUT_MS,
      maxOutputBytes: 64,
    });
    expect(result.ok).toBe(false);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(64);
  });
});

describe("renderPreStopFailurePrompt", () => {
  it("gives the model bounded execution evidence and no environment dump", () => {
    const secret = "sk-ant-api03-supersecretvalue1234567890ABCDEF";
    const prompt = renderPreStopFailurePrompt(
      { command: "python -m pytest -q", maxOutputBytes: DEFAULT_PRESTOP_CHECK_MAX_OUTPUT_BYTES },
      {
        ok: false,
        exitCode: 1,
        signal: null,
        timedOut: false,
        output: `ModuleNotFoundError: No module named 'cryptography'\n${secret}`,
        truncated: false,
      },
    );

    expect(prompt).toContain("Fresh pre-stop verification failed");
    expect(prompt).toContain("python -m pytest -q");
    expect(prompt).toContain("exit code 1");
    expect(prompt).toContain("ModuleNotFoundError");
    expect(prompt).not.toContain("process.env");
    expect(prompt).not.toContain(secret);
    expect(prompt).toContain("[redacted:anthropic-key]");
  });

  it("names timeout and truncation explicitly", () => {
    const prompt = renderPreStopFailurePrompt(
      { command: "pytest", timeoutMs: MAX_PRESTOP_CHECK_TIMEOUT_MS },
      {
        ok: false,
        exitCode: null,
        signal: "SIGKILL",
        timedOut: true,
        output: "x".repeat(10),
        truncated: true,
      },
    );

    expect(prompt).toContain(`${String(MAX_PRESTOP_CHECK_TIMEOUT_MS)}ms`);
    expect(prompt).toContain("output truncated");
    expect(prompt).toContain("SIGKILL");
  });

  it("renders signal/failure-without-exit, blank output, long command, and clamped timeout paths", () => {
    const longCommand = `pytest ${"x".repeat(600)}`;
    const signalPrompt = renderPreStopFailurePrompt(
      { command: longCommand, timeoutMs: MAX_PRESTOP_CHECK_TIMEOUT_MS + 1 },
      {
        ok: false,
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        output: "",
        truncated: false,
      },
    );
    expect(signalPrompt).toContain("signal SIGTERM");
    expect(signalPrompt).toContain("(no output)");
    expect(signalPrompt).toContain("Command: pytest ");
    expect(signalPrompt).toContain("...");

    const noExitPrompt = renderPreStopFailurePrompt(
      { command: "pytest" },
      {
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        output: "",
        truncated: false,
      },
    );
    expect(noExitPrompt).toContain("failed before exit");

    const clamped = renderPreStopFailurePrompt(
      { command: "pytest", timeoutMs: MAX_PRESTOP_CHECK_TIMEOUT_MS + 1 },
      {
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: true,
        output: "",
        truncated: false,
      },
    );
    expect(clamped).toContain(`${String(MAX_PRESTOP_CHECK_TIMEOUT_MS)}ms`);
  });

  it("exports conservative public caps for env parsing", () => {
    expect(DEFAULT_PRESTOP_CHECK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(MAX_PRESTOP_CHECK_TIMEOUT_MS).toBeGreaterThan(DEFAULT_PRESTOP_CHECK_TIMEOUT_MS);
    expect(DEFAULT_PRESTOP_CHECK_MAX_OUTPUT_BYTES).toBeGreaterThan(0);
    expect(MAX_PRESTOP_CHECK_MAX_OUTPUT_BYTES).toBeGreaterThan(
      DEFAULT_PRESTOP_CHECK_MAX_OUTPUT_BYTES,
    );
  });
});
