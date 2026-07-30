import { describe, expect, it } from "vitest";
import { ToolError } from "./errors.js";
import { createBashTool, extractLeasableServiceCommand } from "./bash.js";
import type {
  LeaseStartOptions,
  ProcessLeaseStartResult,
  RunOptions,
  RunResult,
  ShellSession,
} from "./shell-session.js";

const fakeSession = (
  result: RunResult,
  capture?: (cmd: string, opts?: RunOptions) => void,
): ShellSession => ({
  run: (command, opts) => {
    capture?.(command, opts);
    return Promise.resolve(result);
  },
  dispose: () => Promise.resolve(),
});
const ok = (output: string, exitCode = 0): RunResult => ({
  output,
  exitCode,
  outcome: "ok",
  truncated: false,
});

const advertisedTimeoutMaximum = (tool: ReturnType<typeof createBashTool>): number => {
  const parameters = tool.spec.parameters as {
    readonly properties: { readonly timeoutMs: { readonly maximum: number } };
  };
  return parameters.properties.timeoutMs.maximum;
};

describe("bash tool", () => {
  it("returns command output on success", async () => {
    const tool = createBashTool(fakeSession(ok("hello")));
    expect(await tool.handler({ command: "echo hello" })).toBe("hello");
  });

  it("forwards the executor's onOutput hook into session.run (Epic 1.5c liveness)", async () => {
    let captured: RunOptions | undefined;
    const tool = createBashTool(
      fakeSession(ok("done"), (_cmd, opts) => {
        captured = opts;
      }),
    );
    const sink = (_l: string): void => {};
    await tool.handler({ command: "build" }, { onOutput: sink });
    expect(captured?.onOutput).toBe(sink);
  });

  it("advertises the structured lease path for services/jobs that must survive verifier handoff", () => {
    const tool = createBashTool(fakeSession(ok("")));
    const desc = tool.spec.description ?? "";
    expect(desc).toContain("lease");
    expect(desc).toContain("verifier");
    expect(desc.toLowerCase()).toContain("background");
  });

  it("advertises exact-command fidelity and its built-in exit-status result", () => {
    const tool = createBashTool(fakeSession(ok("")));
    const desc = tool.spec.description ?? "";
    const parameters = tool.spec.parameters as {
      readonly properties: { readonly command: { readonly description?: string } };
    };
    const command = parameters.properties.command.description ?? "";
    expect(desc).toMatch(/exact command/i);
    expect(desc).toMatch(/exit (?:code|status)/i);
    expect(desc).toMatch(/do not append.{0,100}(?:echo|status|\$\?)/i);
    expect(command).toMatch(/unchanged|byte-for-byte/i);
  });

  it("advertises nonzero command failure without laundering procedure compliance into success", () => {
    const tool = createBashTool(fakeSession(ok("")));
    const desc = tool.spec.description ?? "";
    expect(desc).toMatch(/non[- ]?zero exit.{0,120}(?:command|process).{0,80}fail/is);
    expect(desc).toMatch(/followed.{0,120}(?:request|procedure)/is);
    expect(desc).toMatch(
      /do not describe.{0,120}(?:command|execution|outcome).{0,120}(?:successful|partially successful)/is,
    );
    expect(desc).toMatch(/requested task.{0,100}(?:did not|didn't|has not) succeed/is);
    expect(desc).toMatch(/(?:may|can) say.{0,120}executed.{0,60}(?:as requested|as instructed)/is);
  });

  it("surfaces a non-zero exit code in the output (still ok)", async () => {
    const tool = createBashTool(fakeSession(ok("boom", 2)));
    const out = await tool.handler({ command: "false" });
    expect(String(out)).toContain("exit code: 2");
  });

  it("maps timeout/aborted/shell-died outcomes to a ToolError with distinct message content", async () => {
    const cases = [
      {
        outcome: "timeout",
        substrings: ["timed out"],
      },
      {
        outcome: "aborted",
        substrings: ["cancelled"],
      },
      {
        outcome: "shell-died",
        substrings: ["exited during"],
      },
    ] as const;

    for (const { outcome, substrings } of cases) {
      const tool = createBashTool(
        fakeSession({ output: "", exitCode: null, outcome, truncated: false }),
      );
      let caught: unknown;
      try {
        await tool.handler({ command: "x" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ToolError);
      for (const sub of substrings) {
        expect((caught as Error).message).toMatch(new RegExp(sub));
      }
    }
  });

  it("renders a kept-shell timeout distinctly from a reset-fallback timeout", async () => {
    // shellReset:false (the norm) — the command was terminated but the shell/cwd/env survived.
    const intact = createBashTool(
      fakeSession({
        output: "",
        exitCode: 137,
        outcome: "timeout",
        truncated: false,
        shellReset: false,
      }),
    );
    let intactMsg = "";
    try {
      await intact.handler({ command: "x" });
    } catch (err) {
      intactMsg = (err as Error).message;
    }
    expect(intactMsg).toMatch(/timed out/);
    expect(intactMsg).toMatch(/intact|terminated/);
    expect(intactMsg).not.toMatch(/cwd\/env lost/);

    // shellReset:true — the rare fallback where the shell could not be recovered and was reset.
    const reset = createBashTool(
      fakeSession({
        output: "",
        exitCode: null,
        outcome: "timeout",
        truncated: false,
        shellReset: true,
      }),
    );
    let resetMsg = "";
    try {
      await reset.handler({ command: "x" });
    } catch (err) {
      resetMsg = (err as Error).message;
    }
    expect(resetMsg).toMatch(/reset/);
  });

  it("timeout copy shows timeoutMs as a literal tool argument", async () => {
    const tool = createBashTool(
      fakeSession({
        output: "",
        exitCode: 137,
        outcome: "timeout",
        truncated: false,
        shellReset: false,
      }),
    );
    let msg = "";
    try {
      await tool.handler({ command: "make build" });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain("timeoutMs");
    expect(msg).toContain('"timeoutMs": 600000');
  });

  it("timeout copy distinguishes idle and absolute command timeouts", async () => {
    const messages: string[] = [];
    for (const timeoutKind of ["idle", "absolute"] as const) {
      const tool = createBashTool(
        fakeSession({
          output: "",
          exitCode: 137,
          outcome: "timeout",
          truncated: false,
          timeoutKind,
          shellReset: false,
        }),
      );
      try {
        await tool.handler({ command: "build" });
      } catch (err) {
        messages.push((err as Error).message);
      }
    }

    expect(messages[0]).toContain("idle timeout");
    expect(messages[1]).toContain("absolute timeout");
    expect(messages[0]).toContain("timeoutMs");
    expect(messages[1]).not.toContain("timeoutMs");
    expect(messages[1]).toContain("absolute command ceiling");
  });

  it("timeout copy and spec can reflect an eval-gated higher timeout ceiling", async () => {
    let captured: RunOptions | undefined;
    const tool = createBashTool(
      fakeSession(
        {
          output: "",
          exitCode: 137,
          outcome: "timeout",
          truncated: false,
          shellReset: false,
        },
        (_cmd, opts) => {
          captured = opts;
        },
      ),
      { maxTimeoutMs: 10_800_000 },
    );
    expect(tool.spec.description).toContain("max 10800s");
    expect(advertisedTimeoutMaximum(tool)).toBe(10_800_000);
    let msg = "";
    try {
      await tool.handler({ command: "make build", timeoutMs: 10_800_000 });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(captured?.timeoutMs).toBe(10_800_000);
    expect(msg).toContain('"timeoutMs": 10800000');
  });

  it("advertises the production timeout ceiling by default", () => {
    const tool = createBashTool(fakeSession(ok("hello")));
    expect(advertisedTimeoutMaximum(tool)).toBe(600_000);
  });

  it("timeout copy calls out foreground sleep commands that exceed the default ceiling", async () => {
    const tool = createBashTool(
      fakeSession({
        output: "",
        exitCode: 137,
        outcome: "timeout",
        truncated: false,
        shellReset: false,
      }),
    );
    let msg = "";
    try {
      await tool.handler({ command: "sleep 300" });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg.toLowerCase()).toContain("foreground sleep");
    expect(msg).toContain("120s");
  });

  it("timeout copy treats tiny probe commands as likely hangs, not slow work", async () => {
    const tool = createBashTool(
      fakeSession({
        output: "",
        exitCode: 137,
        outcome: "timeout",
        truncated: false,
        shellReset: false,
      }),
    );
    let msg = "";
    try {
      await tool.handler({ command: "head -5 data.txt" });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg.toLowerCase()).toContain("interactive hang");
  });

  it("on a WEDGE reset, tells the truth (a wedge, NOT a timeout) and steers to safe alternatives (F4, default-on)", async () => {
    // F4 (keel14/keel59 trajectory review): a heredoc fed to an interpreter (`python3 <<'EOF'`,
    // `R --vanilla <<EOF`, even `cat > f <<EOF`) wedges stdin and forces a hard reset (cwd/env lost) in
    // ~9 ms — an INSTANT STRUCTURAL WEDGE, not a timeout. Asserting "command timed out" here is an
    // honesty bug (no timeout elapsed). The message must say it was a wedge and steer toward the paths
    // that never wedge (`-c`, the `write` tool, `cmd < file`). resetCause:"wedge" drives the truthful copy.
    const reset = createBashTool(
      fakeSession({
        output: "",
        exitCode: null,
        outcome: "timeout",
        truncated: false,
        shellReset: true,
        resetCause: "wedge",
      }),
      { env: {} }, // hermetic: flag unset → default-on guidance
    );
    let msg = "";
    try {
      await reset.handler({ command: "python3 <<'EOF'\nprint(1)\nEOF" });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/reset/); // the shell was reset (cwd/env lost) — still stated
    expect(msg.toLowerCase()).toContain("wedge"); // ...truthfully labelled a wedge
    expect(msg.toLowerCase()).toContain("not a timeout"); // ...explicitly NOT a timeout
    expect(msg).not.toMatch(/timed out/); // ...never asserts a timeout that did not occur
    expect(msg.toLowerCase()).toContain("heredoc"); // diagnosis: a heredoc likely wedged it
    expect(msg).toMatch(/python3 -c/); // points at the non-wedging alternative
    expect(msg).toContain("write"); // ...and the write tool
  });

  it("suppresses the wedge guidance when KEEL_NO_SHELL_RESET_HINT is set (ablation)", async () => {
    const reset = createBashTool(
      fakeSession({
        output: "",
        exitCode: null,
        outcome: "timeout",
        truncated: false,
        shellReset: true,
        resetCause: "wedge",
      }),
      { env: { KEEL_NO_SHELL_RESET_HINT: "1" } },
    );
    let msg = "";
    try {
      await reset.handler({ command: "python3 <<'EOF'\nprint(1)\nEOF" });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/reset/); // the base reset notice still fires
    expect(msg).not.toMatch(/timed out/); // ...and still does not lie about a timeout
    expect(msg.toLowerCase()).not.toContain("heredoc"); // ...but the added alternatives are gone
  });

  it("on a GENUINE timeout reset, keeps the 'timed out' message (no wedge copy)", async () => {
    // A slow command that ran out its budget and could not resync IS an honest timeout — the legacy
    // message is correct here. resetCause:"timeout" (or unset) must NOT be relabelled a wedge.
    const reset = createBashTool(
      fakeSession({
        output: "",
        exitCode: null,
        outcome: "timeout",
        truncated: false,
        shellReset: true,
        resetCause: "timeout",
      }),
      { env: {} },
    );
    let msg = "";
    try {
      await reset.handler({ command: "make build" });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/timed out/); // a real timeout — stated honestly
    expect(msg).toMatch(/reset/); // ...and the shell was reset
    expect(msg.toLowerCase()).not.toContain("wedge"); // not a wedge
  });

  it("does NOT add heredoc guidance on a kept-shell (soft keep-alive) timeout", async () => {
    // The guidance is specific to the HARD reset (cwd/env lost). A soft keep-alive timeout
    // (shellReset:false) kept the shell, so the heredoc hint would be noise — it must not appear.
    const intact = createBashTool(
      fakeSession({
        output: "",
        exitCode: 137,
        outcome: "timeout",
        truncated: false,
        shellReset: false,
      }),
      { env: {} },
    );
    let msg = "";
    try {
      await intact.handler({ command: "sleep 999" });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/timed out/);
    expect(msg.toLowerCase()).not.toContain("heredoc");
  });

  it("on a backgrounded server command, appends daemon-survival guidance to a successful result (F3, default-on)", async () => {
    // F3 (keel59 trajectory review): a server launched as a SESSION CHILD (`nohup … &`, `setsid … &`,
    // bare `&`) is frequently DEAD when the grader checks it from a separate process — the agent→grader
    // process boundary reaps session children. This silently sank `pypi-server`, sshd, and a gRPC kv-store;
    // the one task that passed used an init-managed `service nginx start`. One machine-readable line steers
    // the model toward an init-managed/fully-detached service and a pre-finish listening check.
    const tool = createBashTool(fakeSession(ok("Serving on http://0.0.0.0:8080")), { env: {} });
    const out = await tool.handler({
      command: "nohup pypi-server run -p 8080 ./packages >/tmp/pypi.log 2>&1 &",
    });
    expect(String(out)).toContain("Serving on http://0.0.0.0:8080"); // raw output preserved
    expect(String(out).toLowerCase()).toContain("fresh verifier/handoff process"); // survival warning
    expect(String(out)).toContain('"lease"'); // points at the structured harness-owned lease path
  });

  it("fires the daemon hint for a setsid/disown/bare-& server with a listener signal", async () => {
    const cmds = [
      "setsid python3 -m http.server 8000 &",
      "uvicorn app:api --host 0.0.0.0 --port 8000 & disown",
      "node server.js &",
    ];
    for (const command of cmds) {
      const tool = createBashTool(fakeSession(ok("ready")), { env: {} });
      const out = String(await tool.handler({ command }));
      expect(out.toLowerCase(), `expected daemon hint for: ${command}`).toContain(
        "fresh verifier/handoff process",
      );
    }
  });

  it("suppresses the daemon-survival guidance when KEEL_NO_DAEMON_HINT is set (ablation)", async () => {
    const tool = createBashTool(fakeSession(ok("Serving on http://0.0.0.0:8080")), {
      env: { KEEL_NO_DAEMON_HINT: "1" },
    });
    const out = String(await tool.handler({ command: "pypi-server run -p 8080 &" }));
    expect(out).toContain("Serving on http://0.0.0.0:8080"); // raw output still there
    expect(out.toLowerCase()).not.toContain("fresh verifier/handoff process"); // guidance is gone
  });

  it("does NOT add daemon guidance to a backgrounded NON-server command (conservative heuristic)", async () => {
    // A backgrounded job with no server/listener signal must not fire — false negatives are cheaper
    // than noise. A background `sleep`/build/copy is not a daemon the grader will probe.
    for (const command of ["sleep 999 &", "cp -r src dst &", "tar czf out.tgz big/ &"]) {
      const tool = createBashTool(fakeSession(ok("")), { env: {} });
      const out = String(await tool.handler({ command }));
      expect(out.toLowerCase(), `unexpected daemon hint for: ${command}`).not.toContain(
        "fresh verifier/handoff process",
      );
    }
  });

  it("does NOT add daemon guidance to a foreground server command (must background to need it)", async () => {
    // No backgrounding token ⇒ the command is blocking the session, not left running for the grader.
    // (A real long-lived foreground server would just time out — a different code path.)
    const tool = createBashTool(fakeSession(ok("listening on :8000")), { env: {} });
    const out = String(await tool.handler({ command: "python3 -m http.server 8000" }));
    expect(out.toLowerCase()).not.toContain("fresh verifier/handoff process");
  });

  it("does NOT add daemon guidance to an ordinary successful command", async () => {
    const tool = createBashTool(fakeSession(ok("hello")), { env: {} });
    const out = String(await tool.handler({ command: "echo hello" }));
    expect(out.toLowerCase()).not.toContain("fresh verifier/handoff process");
  });

  it("does NOT add daemon guidance to a non-ok outcome (no hint on timeout)", async () => {
    // The hint attaches only to a SUCCESSFUL result; a timeout/reset takes the ToolError path.
    const tool = createBashTool(
      fakeSession({ output: "", exitCode: null, outcome: "timeout", truncated: false }),
      { env: {} },
    );
    let msg = "";
    try {
      await tool.handler({ command: "uvicorn app:api --port 8000 &" });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg.toLowerCase()).not.toContain("fresh verifier/handoff process");
  });

  it("passes through timeoutMs and the abort signal; ignores analysis/plan for execution", async () => {
    let seen: { cmd: string; opts: RunOptions | undefined } | undefined;
    const ac = new AbortController();
    const tool = createBashTool(fakeSession(ok("x"), (cmd, opts) => (seen = { cmd, opts })));
    await tool.handler(
      { command: "echo x", timeoutMs: 1234, analysis: "thinking", plan: "do it" },
      { signal: ac.signal },
    );
    expect(seen?.cmd).toBe("echo x");
    expect(seen?.opts?.timeoutMs).toBe(1234);
    expect(seen?.opts?.signal).toBe(ac.signal);
  });

  it("starts a leased service through the shell session with executor-provided owner identity", async () => {
    class LeasingSession implements ShellSession {
      started: { readonly command: string; readonly options: LeaseStartOptions } | undefined;
      run(): Promise<RunResult> {
        throw new Error("leased command must not use foreground run");
      }
      dispose(): Promise<void> {
        return Promise.resolve();
      }
      startLeased(command: string, options: LeaseStartOptions): Promise<ProcessLeaseStartResult> {
        this.started = { command, options };
        return Promise.resolve({
          id: "lease_01",
          kind: options.kind,
          ownerToolCallId: options.ownerToolCallId,
          command,
          pid: 4321,
          processGroupId: 4321,
          startIdentity: "start:4321",
          startedAtMs: 123,
          logPath: options.logPath,
          outputOffset: 0,
          scope: options.scope,
          cleanupOwner: "kernel",
          ...(options.healthCommand === undefined ? {} : { healthCommand: options.healthCommand }),
          ...(options.statusCommand === undefined ? {} : { statusCommand: options.statusCommand }),
        });
      }
    }
    const session = new LeasingSession();
    const tool = createBashTool(session);

    const out = await tool.handler(
      {
        command: "python3 -m http.server 8000",
        lease: {
          kind: "service",
          scope: "until-verifier-handoff",
          logPath: "/tmp/keel-http.log",
          healthCommand: "curl -fsS http://127.0.0.1:8000/",
        },
      },
      { toolCallId: "call_http" },
    );

    expect(session.started).toEqual({
      command: "python3 -m http.server 8000",
      options: {
        kind: "service",
        scope: "until-verifier-handoff",
        logPath: "/tmp/keel-http.log",
        ownerToolCallId: "call_http",
        healthCommand: "curl -fsS http://127.0.0.1:8000/",
      },
    });
    expect(String(out)).toContain("lease registered");
    expect(String(out)).toContain("lease_01");
    expect(String(out)).toContain("pid/process group: 4321/4321");
    expect(String(out)).toContain("/tmp/keel-http.log");
    expect(String(out)).toContain(
      "health command recorded (not run): curl -fsS http://127.0.0.1:8000/",
    );
    expect(String(out)).not.toContain("ownerToolCallId");
    expect(String(out)).not.toContain("cleanupOwner");
  });

  it("passes cancellation through leased startup", async () => {
    class LeasingSession implements ShellSession {
      seen: LeaseStartOptions | undefined;
      run(): Promise<RunResult> {
        throw new Error("leased command must not use foreground run");
      }
      dispose(): Promise<void> {
        return Promise.resolve();
      }
      startLeased(_command: string, options: LeaseStartOptions): Promise<ProcessLeaseStartResult> {
        this.seen = options;
        return Promise.resolve({
          id: "lease_signal",
          kind: options.kind,
          ownerToolCallId: options.ownerToolCallId,
          command: "python3 -m http.server 8000",
          pid: 9876,
          processGroupId: 9876,
          startIdentity: "start:9876",
          startedAtMs: 789,
          logPath: options.logPath,
          outputOffset: 0,
          scope: options.scope,
          cleanupOwner: "kernel",
          ...(options.healthCommand === undefined ? {} : { healthCommand: options.healthCommand }),
          ...(options.statusCommand === undefined ? {} : { statusCommand: options.statusCommand }),
        });
      }
    }
    const ac = new AbortController();
    const session = new LeasingSession();
    const tool = createBashTool(session);

    await tool.handler(
      {
        command: "python3 -m http.server 8000",
        lease: {
          kind: "service",
          scope: "until-verifier-handoff",
          logPath: "/tmp/keel-http.log",
        },
      },
      { toolCallId: "call_http", signal: ac.signal },
    );

    expect(session.seen?.signal).toBe(ac.signal);
  });

  it("rejects lease requests that lack executor-provided owner tool-call identity", async () => {
    const tool = createBashTool(fakeSession(ok("")));

    await expect(
      tool.handler({
        command: "python3 -m http.server 8000",
        lease: {
          kind: "service",
          scope: "until-verifier-handoff",
          logPath: "/tmp/keel-http.log",
        },
      }),
    ).rejects.toThrow(/executor-provided tool call id/i);
  });

  it("rejects lease requests on sessions that do not implement the lease primitive", async () => {
    const tool = createBashTool(fakeSession(ok("")));

    await expect(
      tool.handler(
        {
          command: "python3 -m http.server 8000",
          lease: {
            kind: "service",
            scope: "until-verifier-handoff",
            logPath: "/tmp/keel-http.log",
          },
        },
        { toolCallId: "call_http" },
      ),
    ).rejects.toThrow(/does not support service\/job leases/i);
  });

  it("starts a verifier-handoff leased job with only required lease metadata", async () => {
    class LeasingSession implements ShellSession {
      started: { readonly command: string; readonly options: LeaseStartOptions } | undefined;
      run(): Promise<RunResult> {
        throw new Error("leased command must not use foreground run");
      }
      dispose(): Promise<void> {
        return Promise.resolve();
      }
      startLeased(command: string, options: LeaseStartOptions): Promise<ProcessLeaseStartResult> {
        this.started = { command, options };
        return Promise.resolve({
          id: "lease_job",
          kind: options.kind,
          ownerToolCallId: options.ownerToolCallId,
          command,
          pid: 7654,
          processGroupId: 7654,
          startIdentity: "start:7654",
          startedAtMs: 456,
          logPath: options.logPath,
          outputOffset: 0,
          scope: options.scope,
          cleanupOwner: "kernel",
        });
      }
    }
    const session = new LeasingSession();
    const tool = createBashTool(session);

    await expect(
      tool.handler(
        {
          command: "john hash.txt",
          lease: {
            kind: "job",
            scope: "until-verifier-handoff",
            logPath: "/tmp/keel-john.log",
          },
        },
        { toolCallId: "call_john" },
      ),
    ).resolves.toContain("lease_job");
    expect(session.started?.options).toEqual({
      kind: "job",
      scope: "until-verifier-handoff",
      logPath: "/tmp/keel-john.log",
      ownerToolCallId: "call_john",
    });
  });

  it("rejects unsupported lease scopes instead of advertising a stop tool that does not exist", async () => {
    const tool = createBashTool(fakeSession(ok("")));

    await expect(
      tool.handler(
        {
          command: "john hash.txt",
          lease: {
            kind: "job",
            scope: "until-explicit-stop",
            logPath: "/tmp/keel-john.log",
          },
        },
        { toolCallId: "call_john" },
      ),
    ).rejects.toThrow(ToolError);
  });

  it("ignores common provider metadata keys without making unknown args permissive", async () => {
    let seen: string | undefined;
    const tool = createBashTool(fakeSession(ok("x"), (cmd) => (seen = cmd)));
    await expect(
      tool.handler({ command: "echo x", description: "run a small probe" }),
    ).resolves.toBe("x");
    expect(seen).toBe("echo x");

    await expect(tool.handler({ command: "echo x", bogus: "nope" })).rejects.toThrow(ToolError);
  });

  it("rejects a blank command", async () => {
    const tool = createBashTool(fakeSession(ok("")));
    await expect(tool.handler({ command: "   " })).rejects.toThrow(ToolError);
  });

  it("emits a placeholder when command produces no output and exits 0", async () => {
    const tool = createBashTool(fakeSession(ok("", 0)));
    const out = await tool.handler({ command: "true" });
    expect(String(out)).toMatch(/no output/);
    expect(out).toMatch(/exit code 0/);
  });
});

describe("extractLeasableServiceCommand (eval auto-lease rewriter)", () => {
  it("extracts the foreground command from safe single backgrounded launches", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["python3 server.py &", "python3 server.py"],
      ["python3 server.py&", "python3 server.py"],
      ["nohup python3 /app/api.py &", "python3 /app/api.py"],
      [
        "nohup python3 /app/api.py > /app/api.log 2>&1 &",
        "python3 /app/api.py > /app/api.log 2>&1",
      ],
      ["setsid python3 -m http.server 8000 &", "python3 -m http.server 8000"],
      ["nohup setsid uvicorn app:app --port 5000 &", "uvicorn app:app --port 5000"],
      ["python3 server.py 2>&1 &", "python3 server.py 2>&1"],
      ["uvicorn app:app &>/app/log &", "uvicorn app:app &>/app/log"],
      ["node server.js >&2 &", "node server.js >&2"],
    ];
    for (const [input, expected] of cases) {
      expect(extractLeasableServiceCommand(input), input).toBe(expected);
    }
  });

  it("refuses to rewrite anything unsafe or non-backgrounded (returns undefined → advisory fallback)", () => {
    const unsafe = [
      "python3 server.py", // not backgrounded
      "", // empty
      "  &  ", // background of nothing
      "cd /app && python3 server.py &", // compound (&&)
      "setup || fail &", // compound (||)
      "python3 server.py; echo done &", // multi-statement (;)
      "python3 server.py | tee out.log &", // pipeline
      "python3 server.py & echo started &", // two background jobs
      "python3 -c 'import x; x.run()' &", // inline statement/parens
      "echo $(whoami) server &", // command substitution
      "python3 `which server` &", // backtick substitution
      "(python3 server.py) &", // subshell
      "python3 server.py & disown", // disown suffix
      "cd /app\nuvicorn app:app --port 5000 &", // newline statement separator (would confine `cd`)
      "export FOO=1\r\nnode server.js &", // CRLF statement separator (would confine `export`)
    ];
    for (const cmd of unsafe) {
      expect(extractLeasableServiceCommand(cmd), cmd).toBeUndefined();
    }
  });
});

describe("bash tool — eval-direct auto-lease for backgrounded services", () => {
  class DualSession implements ShellSession {
    ran: string | undefined;
    leased: { command: string; options: LeaseStartOptions } | undefined;
    run(command: string): Promise<RunResult> {
      this.ran = command;
      return Promise.resolve(ok("ran"));
    }
    dispose(): Promise<void> {
      return Promise.resolve();
    }
    startLeased(command: string, options: LeaseStartOptions): Promise<ProcessLeaseStartResult> {
      this.leased = { command, options };
      return Promise.resolve({
        id: "lease_auto",
        kind: options.kind,
        ownerToolCallId: options.ownerToolCallId,
        command,
        pid: 999,
        processGroupId: 999,
        startIdentity: "s:999",
        startedAtMs: 1,
        logPath: options.logPath,
        outputOffset: 0,
        scope: options.scope,
        cleanupOwner: "kernel",
      });
    }
  }

  it("in eval mode, auto-promotes a safe backgrounded server to a verifier-handoff lease (not a foreground run)", async () => {
    const session = new DualSession();
    const tool = createBashTool(session, { env: {}, autoLeaseBackgroundedServices: true });
    const out = String(
      await tool.handler(
        { command: "nohup uvicorn app:app --port 5000 > /app/api.log 2>&1 &" },
        { toolCallId: "call_1" },
      ),
    );
    expect(session.leased?.command).toBe("uvicorn app:app --port 5000 > /app/api.log 2>&1");
    expect(session.leased?.options.kind).toBe("service");
    expect(session.leased?.options.scope).toBe("until-verifier-handoff");
    expect(session.leased?.options.ownerToolCallId).toBe("call_1");
    expect(session.ran).toBeUndefined();
    expect(out).toContain("lease registered");
    expect(out.toLowerCase()).toContain("auto-promoted");
  });

  it("does NOT auto-lease when the flag is off (default) — normal run + advisory", async () => {
    const session = new DualSession();
    const tool = createBashTool(session, { env: {} });
    const out = String(
      await tool.handler({ command: "python3 -m http.server 8000 &" }, { toolCallId: "call_1" }),
    );
    expect(session.leased).toBeUndefined();
    expect(session.ran).toBe("python3 -m http.server 8000 &");
    expect(out.toLowerCase()).toContain("fresh verifier/handoff process");
  });

  it("in eval mode, falls back to a normal run + advisory for a command it cannot safely rewrite", async () => {
    const session = new DualSession();
    const tool = createBashTool(session, { env: {}, autoLeaseBackgroundedServices: true });
    const out = String(
      await tool.handler(
        { command: "cd /app && uvicorn app:app --port 8000 &" },
        { toolCallId: "call_1" },
      ),
    );
    expect(session.leased).toBeUndefined();
    expect(session.ran).toBe("cd /app && uvicorn app:app --port 8000 &");
    expect(out.toLowerCase()).toContain("fresh verifier/handoff process");
  });

  it("in eval mode, an explicit lease still wins (the model's command is used as-is, not auto-rewritten)", async () => {
    const session = new DualSession();
    const tool = createBashTool(session, { env: {}, autoLeaseBackgroundedServices: true });
    await tool.handler(
      {
        command: "python3 -m http.server 8000",
        lease: { kind: "service", scope: "until-verifier-handoff", logPath: "/tmp/svc.log" },
      },
      { toolCallId: "call_1" },
    );
    expect(session.leased?.command).toBe("python3 -m http.server 8000");
    expect(session.leased?.options.logPath).toBe("/tmp/svc.log");
    expect(session.ran).toBeUndefined();
  });

  it("does not auto-lease a NON-server backgrounded command even in eval mode (conservative heuristic)", async () => {
    const session = new DualSession();
    const tool = createBashTool(session, { env: {}, autoLeaseBackgroundedServices: true });
    await tool.handler({ command: "sleep 300 &" }, { toolCallId: "call_1" });
    expect(session.leased).toBeUndefined();
    expect(session.ran).toBe("sleep 300 &");
  });
});
