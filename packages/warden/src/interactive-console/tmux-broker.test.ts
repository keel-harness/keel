import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  createConsoleLifecycleState,
  parseConsoleToolCall,
  type ConsoleBrokerOpenRequest,
  type ConsoleHandleRecord,
} from "./index.js";
import {
  SYSTEM_TMUX_CONSOLE_BROKER_KIND,
  createNodeTmuxProcessGroupController,
  createNodeTmuxCommandRunner,
  createSystemTmuxConsoleBroker as createActualSystemTmuxConsoleBroker,
  probeSystemTmuxConsoleBroker,
  type TmuxCommandRequest,
  type TmuxCommandResult,
  type TmuxCommandRunner,
} from "./tmux-broker.js";
import type { ConsoleSandboxPlan } from "./sandbox.js";
import type { ConsolePolicyTargetProfile } from "./policy.js";
import type {
  SandboxInvocation,
  SandboxProfile,
  SandboxSpawnDescriptor,
  SandboxStatus,
} from "../sandbox.js";

function createSystemTmuxConsoleBroker(
  options: Parameters<typeof createActualSystemTmuxConsoleBroker>[0],
): ReturnType<typeof createActualSystemTmuxConsoleBroker> {
  let missingChecks = 0;
  return createActualSystemTmuxConsoleBroker({
    processGroupController: {
      isAlive: () => {
        if (missingChecks === 0) return true;
        missingChecks -= 1;
        return false;
      },
      signal: (_processGroupId, signal) => {
        if (signal === "SIGKILL") missingChecks = 2;
      },
      wait: async () => {},
      nowMs: (() => {
        let now = 0;
        return () => (now += 100);
      })(),
    },
    ...options,
  });
}

const TARGET: ConsolePolicyTargetProfile = {
  targetId: "qemu-alpine",
  targetDigest: `sha256:${"a".repeat(64)}`,
  sandboxProfileId: "srt-workspace-deny-egress",
  command: "qemu-system-x86_64",
  cwd: "/workspace",
  egressDomains: [],
};

interface RecordedTmuxCommand extends TmuxCommandRequest {
  readonly argv: readonly string[];
}

function fakeRunner(
  handler: (request: TmuxCommandRequest) => TmuxCommandResult | Promise<TmuxCommandResult>,
): TmuxCommandRunner & { readonly commands: RecordedTmuxCommand[] } {
  const commands: RecordedTmuxCommand[] = [];
  return {
    commands,
    async run(request) {
      commands.push({ ...request, argv: [...request.argv] });
      return await handler(request);
    },
  };
}

function successful(stdout = ""): TmuxCommandResult {
  return { exitCode: 0, signal: null, stdout, stderr: "" };
}

function failing(stderr = "tmux missing"): TmuxCommandResult {
  return { exitCode: 127, signal: null, stdout: "", stderr };
}

function launchPreparer(options: {
  readonly descriptor: SandboxSpawnDescriptor;
  readonly revoke?: () => void | Promise<void>;
  readonly release?: () => void | Promise<void>;
  readonly cleanup: () => void | Promise<void>;
  readonly prepared: Array<{
    readonly invocation: SandboxInvocation;
    readonly profile: SandboxProfile;
  }>;
  readonly status?: SandboxStatus | (() => SandboxStatus);
}) {
  return {
    status: (): SandboxStatus =>
      typeof options.status === "function"
        ? options.status()
        : (options.status ?? {
            available: true,
            backend: "fake-srt",
            enforcementTier: "sandbox:fake",
          }),
    prepareLaunch: async (invocation: SandboxInvocation, profile: SandboxProfile) => {
      options.prepared.push({ invocation, profile });
      return {
        descriptor: options.descriptor,
        revoke: options.revoke ?? (() => {}),
        release: options.release ?? options.cleanup,
        cleanup: options.cleanup,
      };
    },
  };
}

function openRequest(
  sandbox: ConsoleSandboxPlan,
  handle = "con_tmux_test",
): ConsoleBrokerOpenRequest {
  return {
    handle,
    operation: parseConsoleToolCall({
      name: "interactive_console.open",
      args: { targetId: TARGET.targetId, rows: 24, cols: 80 },
    }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "open" }>,
    profile: TARGET,
    sandbox,
  };
}

function handleRecord(
  processIdentity: ConsoleHandleRecord["processIdentity"],
): ConsoleHandleRecord {
  return {
    handle: "con_tmux_test",
    targetId: TARGET.targetId,
    targetDigest: TARGET.targetDigest,
    sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    profile: TARGET,
    openedAt: "2026-07-09T12:00:00.000Z",
    processIdentity,
    lifecycle: createConsoleLifecycleState({ profile: TARGET, nowMs: 0, processIdentity }),
    nextSeq: 0,
  };
}

describe("system tmux console broker", () => {
  it("SMOKE: probes local system tmux or records NOT_RUN when the binary is unavailable", async () => {
    const status = await probeSystemTmuxConsoleBroker();
    if (!status.available) {
      console.log(
        `[system-tmux-console-smoke] NOT_RUN: ${status.reason ?? "tmux unavailable"} (${status.fixCommand ?? "keel doctor"})`,
      );
      expect(status.fixCommand).toBe("keel doctor");
      return;
    }

    expect(status.tmuxVersion).toMatch(/^tmux\s+\S+/u);
    expect(status.tmuxPath).toBe("tmux");
  });

  it("REAL: reaps a HUP/TERM-resistant pane group before returning close success", async () => {
    if (process.env["KEEL_RUN_REAL_TMUX_REAP_TEST"] !== "1") {
      console.log("[system-tmux-process-reap] NOT_RUN: set KEEL_RUN_REAL_TMUX_REAP_TEST=1");
      return;
    }
    const status = await probeSystemTmuxConsoleBroker();
    if (!status.available || status.tmuxPath === undefined || status.tmuxVersion === undefined) {
      console.log(`[system-tmux-process-reap] NOT_RUN: ${status.reason ?? "tmux unavailable"}`);
      return;
    }
    const tmuxPath = [
      ...(status.tmuxPath.includes("/") ? [status.tmuxPath] : []),
      "/opt/homebrew/bin/tmux",
      "/usr/local/bin/tmux",
      "/usr/bin/tmux",
    ].find((candidate) => existsSync(candidate));
    if (tmuxPath === undefined) {
      console.log("[system-tmux-process-reap] NOT_RUN: absolute tmux path unavailable");
      return;
    }
    const root = join("/tmp", `keel-tmux-real-process-group-${String(process.pid)}`);
    const privateRoot = join(root, "broker");
    const readyMarker = join(root, "pane-ready");
    const resistantScript = join(root, "term-resistant-pane.cjs");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(
      resistantScript,
      "const fs=require('node:fs'); const ready=process.argv[2]; " +
        "process.on('SIGHUP',()=>{}); process.on('SIGTERM',()=>{}); " +
        "fs.writeFileSync(ready,'ready'); setTimeout(() => process.exit(0), 60_000);",
      { mode: 0o600 },
    );
    let panePid: number | undefined;
    const broker = createActualSystemTmuxConsoleBroker({
      tmuxPath,
      tmuxVersion: status.tmuxVersion,
      privateRoot,
      launchPreparer: launchPreparer({
        prepared: [],
        cleanup: () => {},
        descriptor: {
          argv: [process.execPath, resistantScript, readyMarker],
          cwd: tmpdir(),
          env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        },
      }),
    });
    const sandbox = broker.prepareSandboxPlan({
      invocation: { command: TARGET.command, cwd: tmpdir() },
      profile: { filesystem: { allowRead: [tmpdir()], allowWrite: [tmpdir()] } },
    });
    try {
      const opened = await broker.open(openRequest(sandbox, "con_tmux_real_reap"));
      panePid = Number(opened.processIdentity["panePid"]);
      const handle = { ...handleRecord(opened.processIdentity), handle: "con_tmux_real_reap" };

      const readyDeadline = Date.now() + 2_000;
      while (!existsSync(readyMarker) && Date.now() < readyDeadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(readyMarker)).toBe(true);

      const closeStartedAt = Date.now();
      await expect(
        broker.close({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.close",
            args: { handle: handle.handle },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "close" }>,
          profile: TARGET,
        }),
      ).resolves.toEqual({ closed: true });
      expect(Date.now() - closeStartedAt).toBeGreaterThanOrEqual(100);
      let paneGroupAbsent = false;
      try {
        process.kill(-panePid, 0);
      } catch (error) {
        paneGroupAbsent = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      expect(paneGroupAbsent).toBe(true);
    } finally {
      if (panePid !== undefined) {
        try {
          process.kill(-panePid, "SIGKILL");
        } catch {
          // Expected after the broker proves the isolated test group is absent.
        }
      }
      await Promise.resolve(broker.dispose()).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs tmux commands through the node runner with argv-only execution, stdin, and timeout handling", async () => {
    const runner = createNodeTmuxCommandRunner();

    await expect(runner.run({ argv: [], env: {} })).rejects.toThrow(/argv must not be empty/u);

    const ok = await runner.run({
      argv: [
        process.execPath,
        "-e",
        [
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (chunk) => process.stdout.write(chunk));",
          "process.stdin.on('end', () => process.stderr.write('done'));",
        ].join(""),
      ],
      env: { PATH: process.env["PATH"] ?? "" },
      stdin: "hello",
      timeoutMs: 5_000,
    });
    expect(ok).toMatchObject({ exitCode: 0, signal: null, stdout: "hello", stderr: "done" });

    const timedOut = await runner.run({
      argv: [process.execPath, "-e", "setTimeout(() => undefined, 1000);"],
      env: { PATH: process.env["PATH"] ?? "" },
      timeoutMs: 1,
    });
    expect(timedOut.stderr).toContain("tmux command timed out");

    const stubbornStart = Date.now();
    const stubborn = await runner.run({
      argv: ["/bin/sh", "-c", "trap '' TERM; while :; do :; done"],
      env: { PATH: process.env["PATH"] ?? "" },
      timeoutMs: 250,
    });
    expect(stubborn.signal).toBe("SIGKILL");
    expect(Date.now() - stubbornStart).toBeLessThan(700);
    expect(stubborn.stderr).toContain("tmux command timed out");

    const abort = new AbortController();
    const aborted = runner.run({
      argv: [process.execPath, "-e", "setTimeout(() => undefined, 1000);"],
      env: { PATH: process.env["PATH"] ?? "" },
      signal: abort.signal,
      timeoutMs: 5_000,
    });
    abort.abort();
    await expect(aborted).resolves.toMatchObject({ signal: "SIGTERM" });

    const large = await runner.run({
      argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(1049000));"],
      env: { PATH: process.env["PATH"] ?? "" },
      timeoutMs: 5_000,
    });
    expect(large.stdout.length).toBeLessThanOrEqual(1_048_576);
  });

  it("treats only ESRCH as host process-group absence", async () => {
    const calls: Array<{ readonly pid: number; readonly signal: NodeJS.Signals | 0 }> = [];
    let mode: "alive" | "absent" | "refused" = "alive";
    let waited = 0;
    const controller = createNodeTmuxProcessGroupController({
      killProcess: (pid, signal) => {
        calls.push({ pid, signal });
        if (mode === "absent") {
          throw Object.assign(new Error("process group absent"), { code: "ESRCH" });
        }
        if (mode === "refused") {
          throw Object.assign(new Error("process group probe refused"), { code: "EPERM" });
        }
      },
      wait: async (milliseconds) => {
        waited += milliseconds;
      },
      nowMs: () => 42,
    });

    expect(controller.isAlive(4321)).toBe(true);
    controller.signal(4321, "SIGTERM");
    mode = "absent";
    expect(controller.isAlive(4321)).toBe(false);
    expect(() => controller.signal(4321, "SIGKILL")).not.toThrow();
    mode = "refused";
    expect(() => controller.isAlive(4321)).toThrow("process group probe refused");
    expect(() => controller.signal(4321, "SIGKILL")).toThrow("process group probe refused");
    await controller.wait(25);
    expect(waited).toBe(25);
    expect(controller.nowMs()).toBe(42);
    expect(calls).toContainEqual({ pid: -4321, signal: "SIGTERM" });
  });

  it.skipIf(process.platform === "win32")(
    "uses bounded host defaults without mistaking an absent process group for failure",
    async () => {
      const absentProcessGroup = 2_147_483_646;
      const hostSignals = createNodeTmuxProcessGroupController({
        wait: async () => {},
        nowMs: () => 0,
      });
      expect(hostSignals.isAlive(absentProcessGroup)).toBe(false);

      const hostClock = createNodeTmuxProcessGroupController({ killProcess: () => {} });
      const before = Date.now();
      await hostClock.wait(0);
      expect(hostClock.nowMs()).toBeGreaterThanOrEqual(before);
    },
  );

  it("reports tmux availability without hiding install/doctor diagnostics", async () => {
    const unavailable = await probeSystemTmuxConsoleBroker({
      tmuxPath: "/missing/tmux",
      runner: fakeRunner(() => failing("not found")),
    });

    expect(unavailable).toMatchObject({
      available: false,
      backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
      fixCommand: "keel doctor",
    });
    expect(unavailable.reason).toContain("not found");

    const available = await probeSystemTmuxConsoleBroker({
      tmuxPath: "/usr/local/bin/tmux",
      runner: fakeRunner(() => successful("tmux 3.5a\n")),
    });

    expect(available).toEqual({
      available: true,
      backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
      tmuxPath: "/usr/local/bin/tmux",
      tmuxVersion: "tmux 3.5a",
    });

    const stderrVersion = await probeSystemTmuxConsoleBroker({
      tmuxPath: "/usr/local/bin/tmux",
      runner: fakeRunner(() => ({ exitCode: 0, signal: null, stdout: "", stderr: "tmux 3.4\n" })),
    });
    expect(stderrVersion).toMatchObject({ available: true, tmuxVersion: "tmux 3.4" });

    const silentFailure = await probeSystemTmuxConsoleBroker({
      tmuxPath: "/usr/local/bin/tmux",
      runner: fakeRunner(() => ({ exitCode: 70, signal: null, stdout: "", stderr: "" })),
    });
    expect(silentFailure).toMatchObject({
      available: false,
      reason: "tmux version probe failed",
      fixCommand: "keel doctor",
    });
  });

  it("reports adapter status from tmux probe material and the sandbox launch preparer", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-status-test");
    const unavailableRoot = join(root, "unavailable");
    const staleRoot = join(root, "stale");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const prepared: Array<{ invocation: SandboxInvocation; profile: SandboxProfile }> = [];
    let cleanupCount = 0;
    try {
      const unavailableBroker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot: unavailableRoot,
        runner: fakeRunner(() => successful()),
        launchPreparer: launchPreparer({
          prepared,
          cleanup: () => {
            cleanupCount += 1;
          },
          status: {
            available: false,
            backend: "fake-srt",
            enforcementTier: "none",
            reason: "sandbox runtime missing",
            fixCommand: "keel doctor",
          },
          descriptor: {
            argv: ["/srt-wrap", "--"],
            cwd: "/workspace",
            env: { PATH: "/bin" },
          },
        }),
      });
      const unavailableStatus = unavailableBroker.status?.();
      expect(unavailableStatus).toMatchObject({
        available: false,
        backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        fixCommand: "keel doctor",
      });
      expect(unavailableStatus?.reason).toContain("sandbox runtime missing");
      const sandbox = unavailableBroker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      });
      await expect(unavailableBroker.open(openRequest(sandbox))).rejects.toThrow(
        /broker unavailable/u,
      );
      expect(prepared).toEqual([]);

      const staleBroker = createSystemTmuxConsoleBroker({
        tmuxPath: "/missing/tmux",
        tmuxVersion: "tmux missing",
        privateRoot: staleRoot,
        runner: fakeRunner(() => successful()),
        tmuxStatus: {
          available: false,
          backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
          tmuxPath: "/missing/tmux",
          reason: "spawn /missing/tmux ENOENT",
          fixCommand: "keel doctor",
        },
        launchPreparer: launchPreparer({
          prepared,
          cleanup: () => {
            cleanupCount += 1;
          },
          descriptor: {
            argv: ["/srt-wrap", "--"],
            cwd: "/workspace",
            env: { PATH: "/bin" },
          },
        }),
      });
      expect(staleBroker.status?.()).toMatchObject({
        available: false,
        backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
        tmuxPath: "/missing/tmux",
        reason: "spawn /missing/tmux ENOENT",
        fixCommand: "keel doctor",
      });
      await expect(
        staleBroker.open(openRequest(staleBroker.prepareSandboxPlan(sandbox))),
      ).rejects.toThrow(/broker unavailable/u);
      expect(cleanupCount).toBe(0);

      const noReasonBroker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot: join(root, "no-reason"),
        runner: fakeRunner(() => successful()),
        launchPreparer: launchPreparer({
          prepared,
          cleanup: () => {
            cleanupCount += 1;
          },
          status: {
            available: false,
            backend: "fake-srt",
            enforcementTier: "none",
          },
          descriptor: {
            argv: ["/srt-wrap", "--"],
            cwd: "/workspace",
            env: { PATH: "/bin" },
          },
        }),
      });
      expect(noReasonBroker.status?.().reason).toContain("fake-srt reported none launch tier");

      const throwingStatusBroker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot: join(root, "status-throws"),
        runner: fakeRunner(() => successful()),
        launchPreparer: launchPreparer({
          prepared,
          cleanup: () => {
            cleanupCount += 1;
          },
          status: () => {
            throw new Error("status boom");
          },
          descriptor: {
            argv: ["/srt-wrap", "--"],
            cwd: "/workspace",
            env: { PATH: "/bin" },
          },
        }),
      });
      expect(throwingStatusBroker.status?.()).toMatchObject({
        available: false,
        reason: "sandbox launch preparer status failed: status boom",
        fixCommand: "keel doctor",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("threads the warden abort signal into sandbox launch preparation and tmux commands", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-signal-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const abort = new AbortController();
    let launchSignal: AbortSignal | undefined;
    let paneGroupAlive = false;
    const runner = fakeRunner((request) => {
      if (request.argv.includes("new-session")) {
        paneGroupAlive = true;
        if (request.argv.includes("-e")) return failing("tmux: unknown option -- e");
        return successful("$7|%9|1234|0\n");
      }
      return successful();
    });
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        runner,
        processGroupController: {
          isAlive: () => paneGroupAlive,
          signal: (_processGroupId, signal) => {
            if (signal === "SIGKILL") paneGroupAlive = false;
          },
          wait: async () => {},
          nowMs: (() => {
            let now = 0;
            return () => (now += 100);
          })(),
        },
        launchPreparer: {
          status: () => ({
            available: true,
            backend: "fake-srt",
            enforcementTier: "sandbox:fake",
          }),
          prepareLaunch: async (
            invocation: SandboxInvocation,
            profile: SandboxProfile,
            options?: { readonly signal?: AbortSignal },
          ) => {
            expect(invocation).toEqual({ command: TARGET.command, cwd: TARGET.cwd });
            expect(profile.filesystem?.allowRead).toEqual(["/workspace"]);
            launchSignal = options?.signal;
            return {
              descriptor: {
                argv: ["/srt-wrap", "--", "qemu-system-x86_64"],
                cwd: "/workspace",
                env: { PATH: "/bin" },
              },
              revoke: () => undefined,
              release: () => undefined,
              cleanup: () => undefined,
            };
          },
        },
      });
      const sandbox = broker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      });

      await broker.open({
        ...openRequest(sandbox),
        signal: abort.signal,
      });

      expect(launchSignal).toBe(abort.signal);
      const openCommand = runner.commands.find((command) => command.argv.includes("new-session"));
      expect(openCommand?.signal).toBe(abort.signal);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows only one outstanding Warden-controlled system-tmux session", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-single-session-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const runner = fakeRunner((request) => {
      if (request.argv.includes("new-session")) return successful("$7|%9|1234|0\n");
      if (request.argv.includes("display-message")) return successful("$7|%9|1234|0\n");
      return successful();
    });
    const broker = createSystemTmuxConsoleBroker({
      tmuxPath: "/usr/local/bin/tmux",
      tmuxVersion: "tmux 3.5a",
      privateRoot,
      runner,
      launchPreparer: launchPreparer({
        prepared: [],
        cleanup: () => undefined,
        descriptor: {
          argv: ["/srt-wrap", "--", "qemu-system-x86_64"],
          cwd: "/workspace",
          env: { PATH: "/bin" },
        },
      }),
    });
    try {
      const sandbox = broker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      });
      const opened = await broker.open(openRequest(sandbox, "con_tmux_first"));
      const first = { ...handleRecord(opened.processIdentity), handle: "con_tmux_first" };
      await broker.checkProcessIdentity({
        handle: first,
        operation: parseConsoleToolCall({
          name: "interactive_console.close",
          args: { handle: "con_tmux_first", reason: "shutdown" },
        }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "close" }>,
        profile: TARGET,
      });
      const identityProbe = [...runner.commands]
        .reverse()
        .find((command) => command.argv.includes("display-message"));
      expect(identityProbe?.timeoutMs).toBe(2_000);

      await expect(broker.open(openRequest(sandbox, "con_tmux_second"))).rejects.toThrow(
        /one outstanding Warden-controlled session/,
      );

      await broker.close({
        handle: first,
        operation: parseConsoleToolCall({
          name: "interactive_console.close",
          args: { handle: "con_tmux_first" },
        }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "close" }>,
        profile: TARGET,
      });
      await expect(
        broker.open(openRequest(sandbox, "con_tmux_after_close")),
      ).resolves.toMatchObject({ processIdentity: { kind: "tmux-pane" } });
      await broker.dispose();
      const serverStop = [...runner.commands]
        .reverse()
        .find((command) => command.argv.includes("kill-server"));
      expect(serverStop?.timeoutMs).toBe(2_000);
    } finally {
      try {
        await broker.dispose();
      } catch {
        // Cleanup debt is asserted in the test body when expected.
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reserves the single system-tmux session slot while launch preparation is pending", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-opening-slot-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    let releasePreparation = (): void => {};
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let markPreparationEntered = (): void => {};
    const preparationEntered = new Promise<void>((resolve) => {
      markPreparationEntered = resolve;
    });
    const runner = fakeRunner((request) =>
      request.argv.includes("new-session") ? successful("$7|%9|1234|0\n") : successful(),
    );
    const broker = createSystemTmuxConsoleBroker({
      tmuxPath: "/usr/local/bin/tmux",
      tmuxVersion: "tmux 3.5a",
      privateRoot,
      runner,
      launchPreparer: {
        status: () => ({
          available: true,
          backend: "fake-srt",
          enforcementTier: "sandbox:fake",
        }),
        prepareLaunch: async () => {
          markPreparationEntered();
          await preparationGate;
          return {
            descriptor: {
              argv: ["/srt-wrap", "--", "qemu-system-x86_64"],
              cwd: "/workspace",
              env: { PATH: "/bin" },
            },
            revoke: () => undefined,
            release: () => undefined,
            cleanup: () => undefined,
          };
        },
      },
    });
    const sandbox = broker.prepareSandboxPlan({
      invocation: { command: TARGET.command, cwd: TARGET.cwd },
      profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
    });
    const firstOpen = broker.open(openRequest(sandbox, "con_tmux_opening"));
    await preparationEntered;
    try {
      await expect(broker.open(openRequest(sandbox, "con_tmux_racing"))).rejects.toThrow(
        /one outstanding Warden-controlled session/,
      );
    } finally {
      releasePreparation();
    }
    try {
      await expect(firstOpen).resolves.toMatchObject({ processIdentity: { kind: "tmux-pane" } });
    } finally {
      try {
        await broker.dispose();
      } catch {
        // Cleanup debt is asserted in the test body when expected.
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("opens, drives, reads, and closes through a private-socket sandbox-wrapped tmux session", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const prepared: Array<{ invocation: SandboxInvocation; profile: SandboxProfile }> = [];
    let cleanupCount = 0;
    const runner = fakeRunner((request) => {
      if (request.argv.includes("new-session")) {
        return successful("$7|%9|1234|0\n");
      }
      if (request.argv.includes("display-message")) {
        return successful("$7|%9|1234|0\n");
      }
      if (request.argv.includes("capture-pane")) {
        return successful("Password: sk-proj-12345678901234567890\n# ");
      }
      return successful();
    });
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        env: {
          HOME: "/Users/tester",
          LANG: "C.UTF-8",
          PATH: "/usr/bin",
          SECRET_TOKEN: "outer-secret",
          TMUX: "outer-tmux",
        },
        runner,
        launchPreparer: launchPreparer({
          prepared,
          cleanup: () => {
            cleanupCount += 1;
          },
          descriptor: {
            argv: ["/srt-wrap", "--", "qemu-system-x86_64"],
            cwd: "/workspace",
            env: {
              BAD_VALUE: undefined,
              HOME: "/sandbox-home",
              LANG: "C.UTF-8",
              "NOT-A-NAME": "dropped",
              PATH: "/bin",
              SANDBOX_RUNTIME: "fake-srt",
              SECRET_TOKEN: "target-secret",
              TMPDIR: "/sandbox-tmp",
              TMUX: "target-tmux",
              USER: "has\u0000nul",
            },
          },
        }),
      });
      const sandbox = broker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: {
          filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] },
          network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true },
        },
      });
      expect(sandbox.profile.filesystem?.denyRead).toContain(privateRoot);
      expect(sandbox.profile.filesystem?.denyWrite).toContain(privateRoot);
      expect(
        broker.prepareSandboxPlan({
          invocation: { command: TARGET.command, cwd: TARGET.cwd },
          profile: { filesystem: { denyRead: [privateRoot], denyWrite: [privateRoot] } },
        }).profile.filesystem,
      ).toEqual({ denyRead: [privateRoot], denyWrite: [privateRoot] });

      const opened = await broker.open(openRequest(sandbox));
      expect(opened.processIdentity).toMatchObject({
        kind: "tmux-pane",
        backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
        tmuxVersion: "tmux 3.5a",
        sessionId: "$7",
        paneId: "%9",
        panePid: 1234,
      });
      expect(JSON.stringify(opened.processIdentity)).not.toContain(root);
      expect(prepared).toEqual([
        {
          invocation: { command: TARGET.command, cwd: TARGET.cwd },
          profile: sandbox.profile,
        },
      ]);

      const openCommand = runner.commands.find((command) => command.argv.includes("new-session"));
      expect(openCommand?.argv).not.toContain("-e");
      const formatIndex = openCommand?.argv.indexOf("-F");
      expect(formatIndex).not.toBe(-1);
      expect(openCommand?.argv[(formatIndex ?? -1) + 1]).toBe(
        "#{session_id}|#{pane_id}|#{pane_pid}|#{pane_dead}",
      );
      const targetArgvStart = openCommand?.argv.indexOf("-E");
      expect(targetArgvStart).not.toBe(-1);
      expect(openCommand?.argv.slice((targetArgvStart ?? -1) + 1)).toEqual([
        "/usr/bin/env",
        "-i",
        "HOME=/sandbox-home",
        "LANG=C.UTF-8",
        "PATH=/bin",
        "SANDBOX_RUNTIME=fake-srt",
        "TMPDIR=/sandbox-tmp",
        "/srt-wrap",
        "--",
        "qemu-system-x86_64",
      ]);
      expect(openCommand?.argv).not.toEqual(expect.arrayContaining(["SECRET_TOKEN=target-secret"]));
      expect(openCommand?.argv).not.toEqual(expect.arrayContaining(["TMUX=target-tmux"]));
      expect(openCommand?.argv).not.toEqual(expect.arrayContaining(["NOT-A-NAME=dropped"]));
      expect(openCommand?.argv).not.toEqual(expect.arrayContaining(["USER=has\u0000nul"]));
      expect(openCommand?.env["TMUX"]).toBeUndefined();
      expect(JSON.stringify(openCommand)).not.toContain("outer-secret");
      expect(dirname(openCommand?.argv[2] ?? "")).toBe(privateRoot);

      const handle = handleRecord(opened.processIdentity);
      await expect(
        broker.checkProcessIdentity({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.read_screen",
            args: { handle: handle.handle },
          }) as Exclude<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "open" }>,
          profile: TARGET,
        }),
      ).resolves.toEqual({
        live: true,
        observedProcessIdentity: opened.processIdentity,
      });

      await expect(
        broker.sendKeys({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.send_keys",
            args: {
              handle: handle.handle,
              input: [
                { kind: "text", text: "root -n" },
                { kind: "key", key: "Backspace" },
                { kind: "key", key: "Enter" },
              ],
            },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "send_keys" }>,
          profile: TARGET,
        }),
      ).resolves.toEqual({ acceptedTokens: 3 });
      expect(
        runner.commands.some((command) =>
          command.argv
            .join("\u0000")
            .includes("send-keys\u0000-t\u0000%9\u0000-l\u0000--\u0000root -n"),
        ),
      ).toBe(true);
      expect(
        runner.commands.some((command) =>
          command.argv.join("\u0000").includes("send-keys\u0000-t\u0000%9\u0000BSpace"),
        ),
      ).toBe(true);

      const frame = await broker.readScreen({
        handle,
        operation: parseConsoleToolCall({
          name: "interactive_console.read_screen",
          args: { handle: handle.handle, maxBytes: 4096 },
        }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "read_screen" }>,
        profile: TARGET,
      });
      expect(frame).toEqual({
        handle: handle.handle,
        targetId: TARGET.targetId,
        seq: 0,
        screen: "Password: sk-proj-12345678901234567890\n# ",
      });

      await expect(
        broker.close({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.close",
            args: { handle: handle.handle, reason: "cleanup" },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "close" }>,
          profile: TARGET,
        }),
      ).resolves.toEqual({ closed: true });
      const sessionName = opened.processIdentity["sessionName"];
      if (typeof sessionName !== "string") throw new Error("expected tmux session name");
      expect(cleanupCount).toBe(1);
      expect(
        runner.commands.some(
          (command) =>
            command.argv.includes("kill-session") && command.argv.includes(`=${sessionName}`),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a private launcher file when the sandbox descriptor is too large for tmux argv", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-long-descriptor-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const hugeArg = `sandbox-profile-${"x".repeat(70_000)}`;
    const runner = fakeRunner((request) => {
      if (request.argv.includes("new-session")) {
        return successful("$7|%9|1234|0\n");
      }
      return successful();
    });
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        runner,
        launchPreparer: launchPreparer({
          prepared: [],
          cleanup: () => undefined,
          descriptor: {
            argv: ["/srt-wrap", "--", "", "quote'probe", hugeArg],
            cwd: "/workspace",
            env: { PATH: "/bin" },
          },
        }),
      });
      const sandbox = broker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      });

      await broker.open(openRequest(sandbox));

      const openCommand = runner.commands.find((command) => command.argv.includes("new-session"));
      expect(openCommand?.argv).not.toContain(hugeArg);
      expect(openCommand?.argv).toEqual(expect.arrayContaining(["/bin/sh"]));
      const launcherPath = openCommand?.argv.find(
        (arg) => arg.startsWith(privateRoot) && arg.endsWith(".sh"),
      );
      expect(launcherPath).toBeDefined();
      if (launcherPath === undefined) throw new Error("expected launcher path");
      expect(statSync(launcherPath).mode & 0o777).toBe(0o700);
      const launcher = readFileSync(launcherPath, "utf8");
      expect(launcher).toContain(
        "exec '/usr/bin/env' '-i' 'PATH=/bin' '/srt-wrap' '--' '' 'quote'\\''probe'",
      );
      expect(launcher).toContain("'sandbox-profile-");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports accepted token count when a later tmux send-keys command fails", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-partial-send-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    let sendCalls = 0;
    const runner = fakeRunner((request) => {
      if (request.argv.includes("new-session")) return successful("$7|%9|1234|0\n");
      if (request.argv.includes("display-message")) return successful("$7|%9|1234|0\n");
      if (request.argv.includes("send-keys")) {
        sendCalls += 1;
        return sendCalls === 1 ? successful() : failing("pane refused second key");
      }
      return successful();
    });
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        runner,
        launchPreparer: launchPreparer({
          prepared: [],
          cleanup: () => undefined,
          descriptor: {
            argv: ["/srt-wrap", "--", "qemu-system-x86_64"],
            cwd: "/workspace",
            env: { PATH: "/bin" },
          },
        }),
      });
      const sandbox = broker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      });
      const opened = await broker.open(openRequest(sandbox));
      const handle = handleRecord(opened.processIdentity);

      await expect(
        broker.sendKeys({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.send_keys",
            args: {
              handle: handle.handle,
              input: [
                { kind: "key", key: "Enter" },
                { kind: "key", key: "Tab" },
              ],
            },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "send_keys" }>,
          profile: TARGET,
        }),
      ).rejects.toMatchObject({ acceptedTokens: 1 });
      expect(sendCalls).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("confirms pane process-group death before releasing launch filesystem state", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-process-group-settlement-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const events: string[] = [];
    let live = true;
    const runner = fakeRunner((request) => {
      if (request.argv.includes("new-session")) return successful("$7|%9|4321|0\n");
      if (request.argv.includes("kill-session")) {
        events.push("kill-session");
        return successful();
      }
      return successful();
    });
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        runner,
        processGroupController: {
          isAlive: () => live,
          signal: (_processGroupId: number, signal: NodeJS.Signals) => {
            events.push(signal);
            if (signal === "SIGKILL") live = false;
          },
          wait: async () => {},
          nowMs: (() => {
            let now = 0;
            return () => (now += 100);
          })(),
        },
        launchPreparer: launchPreparer({
          prepared: [],
          revoke: () => {
            events.push("revoke");
          },
          cleanup: () => {
            events.push("cleanup");
          },
          descriptor: {
            argv: ["/srt-wrap", "--", "qemu-system-x86_64"],
            cwd: "/workspace",
            env: { PATH: "/bin" },
          },
        }),
      });
      const sandbox = broker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      });
      const opened = await broker.open(openRequest(sandbox));

      await expect(
        broker.close({
          handle: handleRecord(opened.processIdentity),
          operation: parseConsoleToolCall({
            name: "interactive_console.close",
            args: { handle: handleRecord(opened.processIdentity).handle },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "close" }>,
          profile: TARGET,
        }),
      ).resolves.toEqual({ closed: true });

      expect(events).toEqual(["revoke", "SIGTERM", "kill-session", "SIGKILL", "cleanup"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains launch cleanup debt when pane process-group signaling is refused", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-process-group-signal-failure-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    let cleanupCalls = 0;
    const runner = fakeRunner((request) =>
      request.argv.includes("new-session") ? successful("$7|%9|4321|0\n") : successful(),
    );
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        runner,
        processGroupController: {
          isAlive: () => true,
          signal: () => {
            throw Object.assign(new Error("process group signal refused"), { code: "EPERM" });
          },
          wait: async () => {},
          nowMs: () => 0,
        },
        launchPreparer: launchPreparer({
          prepared: [],
          cleanup: () => {
            cleanupCalls += 1;
          },
          descriptor: { argv: ["/srt-wrap", "--"], env: { PATH: "/bin" } },
        }),
      });
      const sandbox = broker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      });
      const opened = await broker.open(openRequest(sandbox));
      const handle = handleRecord(opened.processIdentity);

      await expect(
        broker.close({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.close",
            args: { handle: handle.handle },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "close" }>,
          profile: TARGET,
        }),
      ).rejects.toThrow("process group signal refused");
      expect(cleanupCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects single-argument launch descriptors so tmux cannot fall back to shell command parsing", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-single-argv-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    let cleanupCount = 0;
    const runner = fakeRunner(() => successful("$7|%9|1234|0\n"));
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        runner,
        launchPreparer: launchPreparer({
          prepared: [],
          cleanup: () => {
            cleanupCount += 1;
          },
          descriptor: {
            argv: ["/srt-wrap"],
            cwd: "/workspace",
            env: { PATH: "/bin" },
          },
        }),
      });
      const sandbox = broker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      });

      await expect(broker.open(openRequest(sandbox))).rejects.toThrow(/direct-exec/u);
      expect(cleanupCount).toBe(1);
      expect(runner.commands.some((command) => command.argv.includes("new-session"))).toBe(false);

      const nulBroker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot: join(root, "nul-broker"),
        runner,
        launchPreparer: launchPreparer({
          prepared: [],
          cleanup: () => {
            cleanupCount += 1;
          },
          descriptor: {
            argv: ["/srt-wrap", "bad\u0000arg"],
            cwd: "/workspace",
            env: { PATH: "/bin" },
          },
        }),
      });
      await expect(
        nulBroker.open(openRequest(nulBroker.prepareSandboxPlan(sandbox))),
      ).rejects.toThrow(/NUL/u);
      expect(cleanupCount).toBe(2);

      const ambiguousExecutables = ["-wrapped-srt", "PATH=/wrapped-srt"];
      for (const [index, executable] of ambiguousExecutables.entries()) {
        const startCount = runner.commands.filter((command) =>
          command.argv.includes("new-session"),
        ).length;
        const ambiguousBroker = createSystemTmuxConsoleBroker({
          tmuxPath: "/usr/local/bin/tmux",
          tmuxVersion: "tmux 3.5a",
          privateRoot: join(root, `ambiguous-broker-${String(index)}`),
          runner,
          launchPreparer: launchPreparer({
            prepared: [],
            cleanup: () => {
              cleanupCount += 1;
            },
            descriptor: {
              argv: [executable, "qemu-system-x86_64"],
              cwd: "/workspace",
              env: { PATH: "/bin" },
            },
          }),
        });
        await expect(
          ambiguousBroker.open(openRequest(ambiguousBroker.prepareSandboxPlan(sandbox))),
        ).rejects.toThrow(/executable/u);
        expect(cleanupCount).toBe(index + 3);
        expect(
          runner.commands.filter((command) => command.argv.includes("new-session")).length,
        ).toBe(startCount);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for broker sandbox, open rollback, identity, handle, and close edge cases", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-failure-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const prepared: Array<{ invocation: SandboxInvocation; profile: SandboxProfile }> = [];
    let cleanupCount = 0;
    let paneGroupAlive = false;
    let mode:
      | "open-ok"
      | "open-dead"
      | "open-invalid"
      | "display-missing"
      | "display-dead"
      | "send-fail"
      | "kill-fail"
      | "rollback-kill-fail"
      | "rollback-kill-throw"
      | "dispose-fail"
      | "dispose-throw" = "open-ok";
    const runner = fakeRunner((request) => {
      if (request.argv.includes("new-session")) {
        paneGroupAlive = true;
        if (mode === "open-dead") return successful("$7|%9|1234|1\n");
        if (
          mode === "open-invalid" ||
          mode === "rollback-kill-fail" ||
          mode === "rollback-kill-throw"
        ) {
          return successful("not-a-pane\n");
        }
        return successful("$7|%9|1234|0\n");
      }
      if (request.argv.includes("display-message")) {
        if (mode === "display-missing") return failing("pane not found");
        if (mode === "display-dead") return successful("$7|%9|1234|1\n");
        return successful("$7|%9|1234|0\n");
      }
      if (request.argv.includes("kill-session")) {
        if (mode === "rollback-kill-throw") throw new Error("rollback kill threw");
        return mode === "kill-fail" || mode === "rollback-kill-fail"
          ? failing("kill failed")
          : successful();
      }
      if (request.argv.includes("kill-server")) {
        if (mode === "dispose-throw") throw new Error("server throw");
        return mode === "dispose-fail" ? failing("server gone") : successful();
      }
      if (request.argv.includes("send-keys")) {
        return mode === "send-fail"
          ? failing(`send failed through ${join(privateRoot, "tmux.sock")}`)
          : successful();
      }
      if (request.argv.includes("capture-pane")) return successful("screen");
      return successful();
    });
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        runner,
        processGroupController: {
          isAlive: () => paneGroupAlive,
          signal: (_processGroupId, signal) => {
            if (
              mode === "kill-fail" ||
              mode === "rollback-kill-fail" ||
              mode === "rollback-kill-throw"
            ) {
              throw new Error(
                mode === "rollback-kill-throw" ? "rollback kill threw" : "kill failed",
              );
            }
            if (signal === "SIGKILL") paneGroupAlive = false;
          },
          wait: async () => {},
          nowMs: (() => {
            let now = 0;
            return () => (now += 100);
          })(),
        },
        launchPreparer: launchPreparer({
          prepared,
          cleanup: () => {
            cleanupCount += 1;
          },
          descriptor: {
            argv: ["/srt-wrap", "--"],
            env: { PATH: "/bin" },
          },
        }),
      });
      const basePlan: ConsoleSandboxPlan = {
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      };
      await expect(broker.open(openRequest(basePlan))).rejects.toThrow(/deny broker private root/u);
      expect(prepared).toEqual([]);

      const sandbox = broker.prepareSandboxPlan(basePlan);
      mode = "open-invalid";
      await expect(broker.open(openRequest(sandbox))).rejects.toThrow(/valid session\/pane/u);
      expect(cleanupCount).toBe(1);
      expect(runner.commands.some((command) => command.argv.includes("kill-session"))).toBe(true);

      for (const rollbackMode of ["rollback-kill-fail", "rollback-kill-throw"] as const) {
        mode = rollbackMode;
        let rollbackCleanupCount = 0;
        const rollbackBroker = createSystemTmuxConsoleBroker({
          tmuxPath: "/usr/local/bin/tmux",
          tmuxVersion: "tmux 3.5a",
          privateRoot: join(root, `${rollbackMode}-broker`),
          runner,
          processGroupController: {
            isAlive: () => paneGroupAlive,
            signal: (_processGroupId, signal) => {
              if (mode === "rollback-kill-fail" || mode === "rollback-kill-throw") {
                throw new Error(
                  rollbackMode === "rollback-kill-throw" ? "rollback kill threw" : "kill failed",
                );
              }
              if (signal === "SIGKILL") paneGroupAlive = false;
            },
            wait: async () => {},
            nowMs: (() => {
              let now = 0;
              return () => (now += 100);
            })(),
          },
          launchPreparer: launchPreparer({
            prepared,
            cleanup: () => {
              rollbackCleanupCount += 1;
            },
            descriptor: { argv: ["/srt-wrap", "--"], env: { PATH: "/bin" } },
          }),
        });
        await expect(
          rollbackBroker.open(
            openRequest(
              rollbackBroker.prepareSandboxPlan(basePlan),
              `con_tmux_${rollbackMode.replaceAll("-", "_")}`,
            ),
          ),
        ).rejects.toThrow(/valid session\/pane/u);
        expect(rollbackCleanupCount).toBe(0);
        mode = "open-ok";
        await expect(rollbackBroker.dispose()).resolves.toBeUndefined();
        expect(rollbackCleanupCount).toBe(1);
      }

      mode = "open-dead";
      await expect(broker.open(openRequest(sandbox))).rejects.toThrow(/pane exited/u);
      expect(cleanupCount).toBe(2);

      mode = "open-ok";
      const opened = await broker.open(openRequest(sandbox));
      const handle = handleRecord(opened.processIdentity);

      await expect(
        broker.checkProcessIdentity({
          handle: { ...handle, processIdentity: { kind: "not-tmux" } },
          operation: parseConsoleToolCall({
            name: "interactive_console.read_screen",
            args: { handle: handle.handle },
          }) as Exclude<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "open" }>,
          profile: TARGET,
        }),
      ).resolves.toMatchObject({
        live: true,
        observedProcessIdentity: opened.processIdentity,
      });

      mode = "display-missing";
      await expect(
        broker.checkProcessIdentity({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.read_screen",
            args: { handle: handle.handle },
          }) as Exclude<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "open" }>,
          profile: TARGET,
        }),
      ).resolves.toMatchObject({
        live: false,
        observedProcessIdentity: { kind: "tmux-pane-missing", paneId: "%9" },
      });

      mode = "display-dead";
      await expect(
        broker.checkProcessIdentity({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.read_screen",
            args: { handle: handle.handle },
          }) as Exclude<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "open" }>,
          profile: TARGET,
        }),
      ).resolves.toMatchObject({ live: false });

      const unknownHandle = {
        ...handleRecord({ kind: "not-tmux" }),
        handle: "con_tmux_missing",
      };
      await expect(
        broker.checkProcessIdentity({
          handle: unknownHandle,
          operation: parseConsoleToolCall({
            name: "interactive_console.read_screen",
            args: { handle: unknownHandle.handle },
          }) as Exclude<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "open" }>,
          profile: TARGET,
        }),
      ).resolves.toMatchObject({
        live: false,
        observedProcessIdentity: { kind: "tmux-pane-missing" },
      });
      mode = "display-missing";
      await expect(
        broker.checkProcessIdentity({
          handle: {
            ...unknownHandle,
            processIdentity: { kind: "tmux-pane", sessionName: "keel_other", paneId: "%other" },
          },
          operation: parseConsoleToolCall({
            name: "interactive_console.read_screen",
            args: { handle: unknownHandle.handle },
          }) as Exclude<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "open" }>,
          profile: TARGET,
        }),
      ).resolves.toMatchObject({
        live: false,
        observedProcessIdentity: { kind: "tmux-pane-missing", paneId: "%other" },
      });
      await expect(
        broker.sendKeys({
          handle: unknownHandle,
          operation: parseConsoleToolCall({
            name: "interactive_console.send_keys",
            args: { handle: unknownHandle.handle, input: [{ kind: "key", key: "Enter" }] },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "send_keys" }>,
          profile: TARGET,
        }),
      ).rejects.toThrow(/handle is not open/u);
      await expect(
        broker.readScreen({
          handle: unknownHandle,
          operation: parseConsoleToolCall({
            name: "interactive_console.read_screen",
            args: { handle: unknownHandle.handle },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "read_screen" }>,
          profile: TARGET,
        }),
      ).rejects.toThrow(/handle is not open/u);
      await expect(
        broker.close({
          handle: unknownHandle,
          operation: parseConsoleToolCall({
            name: "interactive_console.close",
            args: { handle: unknownHandle.handle },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "close" }>,
          profile: TARGET,
        }),
      ).resolves.toEqual({ closed: false });

      mode = "send-fail";
      await expect(
        broker.sendKeys({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.send_keys",
            args: { handle: handle.handle, input: [{ kind: "text", text: "root" }] },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "send_keys" }>,
          profile: TARGET,
        }),
      ).rejects.toThrow(/tmux command failed/u);
      const sendFailure = await broker
        .sendKeys({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.send_keys",
            args: { handle: handle.handle, input: [{ kind: "text", text: "root" }] },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "send_keys" }>,
          profile: TARGET,
        })
        .catch((error: unknown) => error);
      expect(sendFailure).toBeInstanceOf(Error);
      expect((sendFailure as Error).message).not.toContain(privateRoot);

      mode = "kill-fail";
      await expect(
        broker.close({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.close",
            args: { handle: handle.handle },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "close" }>,
          profile: TARGET,
        }),
      ).rejects.toThrow(/kill failed/u);
      expect(cleanupCount).toBe(2);

      mode = "open-ok";
      await expect(
        broker.readScreen({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.read_screen",
            args: { handle: handle.handle },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "read_screen" }>,
          profile: TARGET,
        }),
      ).resolves.toMatchObject({ screen: "screen" });
      await expect(
        broker.close({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.close",
            args: { handle: handle.handle },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "close" }>,
          profile: TARGET,
        }),
      ).resolves.toEqual({ closed: true });
      expect(cleanupCount).toBe(3);

      const openedForDispose = await broker.open(openRequest(sandbox));
      expect(openedForDispose.processIdentity).toMatchObject({ paneId: "%9" });
      mode = "kill-fail";
      await expect(broker.dispose()).rejects.toThrow(/process settlement was not confirmed/u);
      expect(cleanupCount).toBe(3);
      mode = "open-ok";
      await expect(broker.dispose()).resolves.toBeUndefined();
      expect(cleanupCount).toBe(4);

      const brokerForThrowingDispose = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot: join(root, "dispose-throw"),
        runner,
        launchPreparer: launchPreparer({
          prepared,
          cleanup: () => {
            cleanupCount += 1;
          },
          descriptor: {
            argv: ["/srt-wrap", "--"],
            env: { PATH: "/bin" },
          },
        }),
      });
      mode = "open-ok";
      await expect(
        brokerForThrowingDispose.open(
          openRequest(brokerForThrowingDispose.prepareSandboxPlan(basePlan)),
        ),
      ).resolves.toMatchObject({ processIdentity: { paneId: "%9" } });
      mode = "dispose-throw";
      await expect(brokerForThrowingDispose.dispose()).rejects.toThrow(
        /process settlement was not confirmed/u,
      );
      expect(cleanupCount).toBe(5);
      expect(existsSync(join(root, "dispose-throw"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("revokes and drains launch authority before releasing an external session", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-release-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const prepared: Array<{ invocation: SandboxInvocation; profile: SandboxProfile }> = [];
    let cleanupCount = 0;
    const runner = fakeRunner((request) => {
      if (request.argv.includes("new-session")) return successful("$7|%9|1234|0\n");
      if (request.argv.includes("display-message")) return successful("$7|%9|1234|0\n");
      if (request.argv.includes("kill-server")) return successful();
      if (request.argv.includes("kill-session")) return successful();
      return successful();
    });
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        runner,
        launchPreparer: launchPreparer({
          prepared,
          cleanup: () => {
            cleanupCount += 1;
          },
          descriptor: {
            argv: ["/srt-wrap", "--"],
            env: { PATH: "/bin" },
          },
        }),
      });
      const sandbox = broker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      });
      const opened = await broker.open(openRequest(sandbox));
      const handle = handleRecord(opened.processIdentity);

      await expect(
        broker.release({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.release",
            args: { handle: handle.handle, reason: "external-grader" },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "release" }>,
          profile: TARGET,
        }),
      ).resolves.toEqual({ released: true });

      expect(cleanupCount).toBe(1);
      await expect(
        broker.close({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.close",
            args: { handle: handle.handle },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "close" }>,
          profile: TARGET,
        }),
      ).resolves.toEqual({ closed: false });

      await broker.dispose();
      expect(cleanupCount).toBe(1);
      expect(runner.commands.some((command) => command.argv.includes("kill-server"))).toBe(false);
      expect(runner.commands.some((command) => command.argv.includes("kill-session"))).toBe(false);
      await expect(broker.open(openRequest(sandbox))).rejects.toThrow(
        "interactive console broker is disposed",
      );
      expect(cleanupCount).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies release and retains control when authority drain cannot be confirmed", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-release-failure-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    let cleanupCalls = 0;
    const events: string[] = [];
    const runner = fakeRunner((request) => {
      if (request.argv.includes("new-session")) return successful("$7|%9|1234|0\n");
      if (request.argv.includes("kill-session")) events.push("kill-session");
      return successful();
    });
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        runner,
        launchPreparer: launchPreparer({
          prepared: [],
          release: async () => {
            cleanupCalls += 1;
            events.push(`cleanup-${String(cleanupCalls)}`);
            if (cleanupCalls === 1) throw new Error("drain not confirmed");
          },
          cleanup: async () => {
            cleanupCalls += 1;
            events.push(`cleanup-${String(cleanupCalls)}`);
          },
          descriptor: { argv: ["/srt-wrap", "--"], env: { PATH: "/bin" } },
        }),
      });
      const sandbox = broker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      });
      const opened = await broker.open(openRequest(sandbox));
      const handle = handleRecord(opened.processIdentity);

      await expect(
        broker.release({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.release",
            args: { handle: handle.handle, reason: "external-grader" },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "release" }>,
          profile: TARGET,
        }),
      ).rejects.toThrow("drain not confirmed");

      await expect(
        broker.close({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.close",
            args: { handle: handle.handle },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "close" }>,
          profile: TARGET,
        }),
      ).resolves.toEqual({ closed: true });
      expect(cleanupCalls).toBe(2);
      expect(events).toEqual(["cleanup-1", "kill-session", "cleanup-2"]);
      expect(runner.commands.some((command) => command.argv.includes("kill-session"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("withholds filesystem cleanup when failed-open pane identity cannot be recovered", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-open-cleanup-failure-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    let cleanupCalls = 0;
    const runner = fakeRunner((request) => {
      if (request.argv.includes("new-session")) return successful("invalid identity\n");
      return successful();
    });
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        runner,
        launchPreparer: launchPreparer({
          prepared: [],
          cleanup: async () => {
            cleanupCalls += 1;
            throw new Error("rollback drain failed");
          },
          descriptor: { argv: ["/srt-wrap", "--"], env: { PATH: "/bin" } },
        }),
      });
      const sandbox = broker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      });

      await expect(broker.open(openRequest(sandbox))).rejects.toThrow(
        /process-group settlement was not confirmed/u,
      );
      expect(runner.commands.some((command) => command.argv.includes("kill-session"))).toBe(true);
      expect(cleanupCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("kills on close drain failure and reports unconfirmed disposal settlement", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-close-cleanup-failure-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const events: string[] = [];
    let killCalls = 0;
    const runner = fakeRunner((request) => {
      if (request.argv.includes("new-session")) return successful("$7|%9|1234|0\n");
      if (request.argv.includes("kill-session")) {
        killCalls += 1;
        events.push(`kill-${String(killCalls)}`);
        if (killCalls === 2) throw new Error("already unavailable");
      }
      if (request.argv.includes("kill-server")) throw new Error("server kill unavailable");
      return successful();
    });
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        runner,
        launchPreparer: launchPreparer({
          prepared: [],
          cleanup: async () => {
            events.push("cleanup");
            throw new Error("drain not confirmed");
          },
          descriptor: { argv: ["/srt-wrap", "--"], env: { PATH: "/bin" } },
        }),
      });
      const sandbox = broker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      });
      const opened = await broker.open(openRequest(sandbox));
      const handle = handleRecord(opened.processIdentity);

      await expect(
        broker.close({
          handle,
          operation: parseConsoleToolCall({
            name: "interactive_console.close",
            args: { handle: handle.handle },
          }) as Extract<ReturnType<typeof parseConsoleToolCall>, { readonly kind: "close" }>,
          profile: TARGET,
        }),
      ).rejects.toThrow("drain not confirmed");
      expect(events).toEqual(["kill-1", "cleanup"]);

      await expect(broker.dispose()).rejects.toThrow(/settlement was not confirmed/u);
      expect(events).toEqual(["kill-1", "cleanup", "cleanup"]);
      expect(existsSync(privateRoot)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not treat private tmux-server shutdown as process-group settlement", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-server-fallback-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const events: string[] = [];
    const runner = fakeRunner((request) => {
      if (request.argv.includes("new-session")) return successful("$7|%9|1234|0\n");
      if (request.argv.includes("kill-session")) {
        events.push("kill-session");
        return { ...successful(), exitCode: 1, stderr: "session remained" };
      }
      if (request.argv.includes("kill-server")) events.push("kill-server");
      return successful();
    });
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        runner,
        processGroupController: {
          isAlive: () => true,
          signal: () => {},
          wait: async () => {},
          nowMs: (() => {
            let now = 0;
            return () => (now += 1_000);
          })(),
        },
        launchPreparer: launchPreparer({
          prepared: [],
          cleanup: () => {},
          descriptor: { argv: ["/srt-wrap", "--"], env: { PATH: "/bin" } },
        }),
      });
      const sandbox = broker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      });
      await broker.open(openRequest(sandbox));

      await expect(broker.dispose()).rejects.toThrow(/process settlement was not confirmed/u);
      expect(events).toEqual(["kill-session"]);
      expect(existsSync(privateRoot)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries session settlement and authority cleanup independently", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-server-retry-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    let cleanupCalls = 0;
    let killServerCalls = 0;
    let killSessionCalls = 0;
    let killSignals = 0;
    const runner = fakeRunner((request) => {
      if (request.argv.includes("new-session")) return successful("$7|%9|1234|0\n");
      if (request.argv.includes("kill-session")) {
        killSessionCalls += 1;
        return killSessionCalls === 1 ? failing("session remained") : successful();
      }
      if (request.argv.includes("kill-server")) {
        killServerCalls += 1;
        return killServerCalls === 1 ? successful() : failing("server already settled");
      }
      return successful();
    });
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        runner,
        processGroupController: {
          isAlive: () => killSignals < 2,
          signal: (_processGroupId, signal) => {
            if (signal === "SIGKILL") killSignals += 1;
          },
          wait: async () => {},
          nowMs: (() => {
            let now = 0;
            return () => (now += 1_000);
          })(),
        },
        launchPreparer: launchPreparer({
          prepared: [],
          cleanup: () => {
            cleanupCalls += 1;
            if (cleanupCalls === 1) throw new Error("drain retry required");
          },
          descriptor: { argv: ["/srt-wrap", "--"], env: { PATH: "/bin" } },
        }),
      });
      const sandbox = broker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      });
      await broker.open(openRequest(sandbox));

      await expect(broker.dispose()).rejects.toThrow(/process settlement/u);
      expect(existsSync(privateRoot)).toBe(true);
      await expect(broker.dispose()).rejects.toThrow(/authority cleanup/u);
      await expect(broker.dispose()).resolves.toBeUndefined();
      expect(cleanupCalls).toBe(2);
      expect(killServerCalls).toBe(1);
      expect(existsSync(privateRoot)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies reuse after failed open settlement and drains the pending session on disposal", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-pending-settlement-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    let cleanupCalls = 0;
    let killSessionCalls = 0;
    let displayCalls = 0;
    const runner = fakeRunner((request) => {
      if (request.argv.includes("new-session")) return successful("invalid identity\n");
      if (request.argv.includes("display-message")) {
        displayCalls += 1;
        return displayCalls === 1 ? successful() : successful("$7|%9|1234|0\n");
      }
      if (request.argv.includes("kill-session")) {
        killSessionCalls += 1;
        if (killSessionCalls === 1) return failing("session remained");
        return successful();
      }
      return successful();
    });
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        runner,
        launchPreparer: launchPreparer({
          prepared: [],
          cleanup: () => {
            cleanupCalls += 1;
            if (cleanupCalls === 1) throw new Error("initial drain failed");
          },
          descriptor: { argv: ["/srt-wrap", "--"], env: { PATH: "/bin" } },
        }),
      });
      const sandbox = broker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      });

      await expect(broker.open(openRequest(sandbox))).rejects.toThrow(
        /settlement was not confirmed/u,
      );
      await expect(broker.open(openRequest(sandbox))).rejects.toThrow(
        /previous tmux session cleanup settlement was not confirmed/u,
      );
      expect(cleanupCalls).toBe(0);
      expect(killSessionCalls).toBe(1);

      await expect(broker.dispose()).rejects.toThrow(/authority cleanup/u);
      expect(cleanupCalls).toBe(1);
      await expect(broker.dispose()).resolves.toBeUndefined();
      expect(cleanupCalls).toBe(2);
      expect(killSessionCalls).toBe(2);
      expect(runner.commands.some((command) => command.argv.includes("kill-server"))).toBe(true);
      expect(existsSync(privateRoot)).toBe(false);
      await expect(broker.open(openRequest(sandbox, "con_tmux_after_dispose"))).rejects.toThrow(
        /broker is disposed/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains broker state when private-server settlement fails and permits a safe retry", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-server-settlement-failure-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    let killServerCalls = 0;
    const runner = fakeRunner((request) => {
      if (request.argv.includes("kill-server")) {
        killServerCalls += 1;
        return killServerCalls === 1 ? failing("server remained") : successful();
      }
      return successful();
    });
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        runner,
        launchPreparer: launchPreparer({
          prepared: [],
          cleanup: () => {},
          descriptor: { argv: ["/srt-wrap", "--"], env: { PATH: "/bin" } },
        }),
      });
      writeFileSync(join(privateRoot, "tmux.sock"), "live-server-marker");

      await expect(broker.dispose()).rejects.toThrow(/process settlement was not confirmed/u);
      expect(existsSync(privateRoot)).toBe(true);
      rmSync(join(privateRoot, "tmux.sock"), { force: true });
      await expect(broker.dispose()).resolves.toBeUndefined();
      expect(killServerCalls).toBe(2);
      expect(existsSync(privateRoot)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds failed-open pane PID recovery before retaining cleanup debt", async () => {
    vi.useFakeTimers();
    const root = join(tmpdir(), "keel-tmux-broker-pid-recovery-deadline-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    let recoveryAborted = false;
    const runner = fakeRunner((request) => {
      if (request.argv.includes("new-session")) return successful("invalid identity\n");
      if (request.argv.includes("display-message")) {
        return new Promise<TmuxCommandResult>((resolve) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              recoveryAborted = true;
              resolve(failing("display-message aborted"));
            },
            { once: true },
          );
        });
      }
      return successful();
    });
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        runner,
        launchPreparer: launchPreparer({
          prepared: [],
          cleanup: () => {
            throw new Error("cleanup must remain withheld");
          },
          descriptor: { argv: ["/srt-wrap", "--"], env: { PATH: "/bin" } },
        }),
      });
      const sandbox = broker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      });
      const opening = broker.open(openRequest(sandbox));
      let settled = false;
      void opening.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(opening).rejects.toThrow(/settlement was not confirmed/u);
      expect(recoveryAborted).toBe(true);
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("revokes and drains every controlled launch before broker disposal kills tmux", async () => {
    const root = join(tmpdir(), "keel-tmux-broker-dispose-order-test");
    const privateRoot = join(root, "broker");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const events: string[] = [];
    const runner = fakeRunner((request) => {
      if (request.argv.includes("new-session")) return successful("$7|%9|1234|0\n");
      if (request.argv.includes("kill-session")) events.push("kill-session");
      return successful();
    });
    try {
      const broker = createSystemTmuxConsoleBroker({
        tmuxPath: "/usr/local/bin/tmux",
        tmuxVersion: "tmux 3.5a",
        privateRoot,
        runner,
        launchPreparer: launchPreparer({
          prepared: [],
          revoke: () => {
            events.push("revoke");
          },
          cleanup: () => {
            events.push("cleanup");
          },
          descriptor: { argv: ["/srt-wrap", "--"], env: { PATH: "/bin" } },
        }),
      });
      const sandbox = broker.prepareSandboxPlan({
        invocation: { command: TARGET.command, cwd: TARGET.cwd },
        profile: { filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"] } },
      });
      await broker.open(openRequest(sandbox));

      await broker.dispose();
      expect(events).toEqual(["revoke", "kill-session", "cleanup"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
