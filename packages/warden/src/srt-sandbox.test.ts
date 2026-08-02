import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  createNodeSandboxProcessRunner,
  createSrtSandboxLaunchPreparer,
  createSrtSandboxPort,
  type SrtRuntimeAdapter,
} from "./srt-sandbox.js";
import type { SandboxProfile, SandboxProcessRunner } from "./sandbox.js";

function profile(writeRoot: string): SandboxProfile {
  return {
    filesystem: {
      allowRead: ["/workspace"],
      allowWrite: [writeRoot],
      denyRead: ["/home/user/.ssh"],
      denyWrite: ["/workspace/.git/hooks"],
    },
    network: {
      allowedDomains: ["example.com"],
      deniedDomains: ["*"],
      strictAllowlist: true,
    },
  };
}

describe("SrtSandboxPort", () => {
  it("reports an honest configured status without claiming policy or audit enforcement", () => {
    const port = createSrtSandboxPort({
      runtime: {
        wrapWithSandboxArgv: async () => ({ argv: ["/bin/true"], env: {} }),
      },
      runner: {
        run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
      status: {
        available: true,
        backend: "srt:fake",
        enforcementTier: "sandbox:srt",
      },
    });

    expect(port.status()).toEqual({
      available: true,
      backend: "srt:fake",
      enforcementTier: "sandbox:srt",
    });
  });

  it("prepares a long-lived sandbox descriptor without running it and defers cleanup", async () => {
    const updateCalls: unknown[] = [];
    const wrappedCalls: unknown[] = [];
    let initializeCalls = 0;
    let cleanupCalls = 0;
    const preparer = createSrtSandboxLaunchPreparer({
      runtime: {
        initialize: async () => {
          initializeCalls += 1;
        },
        updateConfig: (config) => {
          updateCalls.push(config);
        },
        cleanupAfterCommand: () => {
          cleanupCalls += 1;
        },
        wrapWithSandboxArgv: async (command, binShell, config, signal) => {
          wrappedCalls.push({ command, binShell, config, signal });
          return {
            argv: ["/usr/bin/env", "qemu-system-x86_64"],
            env: {
              PATH: "/usr/bin",
              TERM: "xterm-256color",
              AWS_SECRET_ACCESS_KEY: "secret",
            },
          };
        },
      },
      status: {
        available: true,
        backend: "srt:fake",
        enforcementTier: "sandbox:srt",
      },
      binShell: "/bin/sh",
    });
    const abortController = new AbortController();

    const prepared = await preparer.prepareLaunch(
      { command: "qemu-system-x86_64", cwd: "/workspace" },
      profile("/workspace"),
      { signal: abortController.signal },
    );

    expect(initializeCalls).toBe(1);
    expect(updateCalls).toHaveLength(1);
    expect(wrappedCalls).toEqual([
      expect.objectContaining({
        command: "qemu-system-x86_64",
        binShell: "/bin/sh",
        config: updateCalls[0],
        signal: abortController.signal,
      }),
    ]);
    expect(prepared.descriptor).toEqual({
      argv: ["/usr/bin/env", "qemu-system-x86_64"],
      cwd: "/workspace",
      env: { PATH: "/usr/bin", TERM: "xterm-256color" },
    });
    expect(cleanupCalls).toBe(0);
    prepared.cleanup();
    prepared.cleanup();
    expect(cleanupCalls).toBe(1);
  });

  it("prepares argv-bearing invocations as a shell-quoted command for the srt runtime", async () => {
    const wrappedCalls: unknown[] = [];
    const preparer = createSrtSandboxLaunchPreparer({
      runtime: {
        wrapWithSandboxArgv: async (command) => {
          wrappedCalls.push(command);
          return {
            argv: ["/usr/bin/env", "qemu-system-x86_64"],
            env: { PATH: "/usr/bin" },
          };
        },
      },
      status: {
        available: true,
        backend: "srt:fake",
        enforcementTier: "sandbox:srt",
      },
    });

    await expect(
      preparer.prepareLaunch(
        {
          command: "/usr/bin/qemu-system-x86_64",
          argv: [
            "/usr/bin/qemu-system-x86_64",
            "-drive",
            "file=/workspace/disk one.qcow2,if=virtio",
            "literal;not-shell",
            "quote'probe",
          ],
          cwd: "/workspace",
        },
        profile("/workspace"),
      ),
    ).resolves.toMatchObject({
      descriptor: {
        argv: ["/usr/bin/env", "qemu-system-x86_64"],
        cwd: "/workspace",
        env: { PATH: "/usr/bin" },
      },
    });

    expect(wrappedCalls).toEqual([
      "'/usr/bin/qemu-system-x86_64' '-drive' 'file=/workspace/disk one.qcow2,if=virtio' 'literal;not-shell' 'quote'\\''probe'",
    ]);
  });

  it("fails closed for malformed argv-bearing invocations before calling srt", async () => {
    const wrappedCalls: unknown[] = [];
    const preparer = createSrtSandboxLaunchPreparer({
      runtime: {
        wrapWithSandboxArgv: async (command) => {
          wrappedCalls.push(command);
          return { argv: ["/bin/true"], env: {} };
        },
      },
      status: {
        available: true,
        backend: "srt:fake",
        enforcementTier: "sandbox:srt",
      },
    });

    await expect(
      preparer.prepareLaunch(
        { command: "/usr/bin/qemu-system-x86_64", argv: [], cwd: "/workspace" },
        profile("/workspace"),
      ),
    ).rejects.toThrow(/argv must not be empty/u);

    await expect(
      preparer.prepareLaunch(
        {
          command: "/usr/bin/qemu-system-x86_64",
          argv: ["/usr/bin/other-qemu"],
          cwd: "/workspace",
        },
        profile("/workspace"),
      ),
    ).rejects.toThrow(/argv executable must match command/u);

    await expect(
      preparer.prepareLaunch(
        {
          command: "/usr/bin/qemu-system-x86_64",
          argv: ["/usr/bin/qemu-system-x86_64", "bad\u0000arg"],
          cwd: "/workspace",
        },
        profile("/workspace"),
      ),
    ).rejects.toThrow(/NUL/u);

    expect(wrappedCalls).toEqual([]);
  });

  it("fails closed before preparing a long-lived descriptor when srt is unavailable", async () => {
    const preparer = createSrtSandboxLaunchPreparer({
      runtime: {
        wrapWithSandboxArgv: async () => ({ argv: ["/bin/true"], env: {} }),
      },
      status: {
        available: false,
        backend: "srt:fake",
        enforcementTier: "none",
        reason: "bubblewrap missing",
      },
    });

    await expect(
      preparer.prepareLaunch({ command: "true" }, profile("/workspace")),
    ).rejects.toThrow("bubblewrap missing");
  });

  it("passes the sandbox profile as a per-call plain-data srt config", async () => {
    const updateCalls: unknown[] = [];
    const wrappedCalls: unknown[] = [];
    const runtime: SrtRuntimeAdapter = {
      updateConfig: (config) => {
        updateCalls.push(config);
      },
      wrapWithSandboxArgv: async (_command, _shell, config) => {
        wrappedCalls.push(config);
        return { argv: ["/usr/bin/env", "true"], env: { KEEL_TEST: "1" } };
      },
    };
    const runner: SandboxProcessRunner = {
      run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    };
    const port = createSrtSandboxPort({
      runtime,
      runner,
      status: {
        available: true,
        backend: "srt:fake",
        enforcementTier: "sandbox:srt",
      },
    });

    await expect(
      port.execute({ command: "printf ok", cwd: "/workspace" }, profile("/workspace/a")),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "ok" });
    await port.execute({ command: "printf ok", cwd: "/workspace" }, profile("/workspace/b"));

    expect(updateCalls).toEqual(wrappedCalls);
    expect(wrappedCalls).toEqual([
      {
        filesystem: {
          allowRead: ["/workspace"],
          allowWrite: ["/workspace/a"],
          denyRead: ["/home/user/.ssh"],
          denyWrite: ["/workspace/.git/hooks"],
        },
        network: {
          allowedDomains: ["example.com"],
          deniedDomains: ["*"],
          strictAllowlist: true,
        },
      },
      {
        filesystem: {
          allowRead: ["/workspace"],
          allowWrite: ["/workspace/b"],
          denyRead: ["/home/user/.ssh"],
          denyWrite: ["/workspace/.git/hooks"],
        },
        network: {
          allowedDomains: ["example.com"],
          deniedDomains: ["*"],
          strictAllowlist: true,
        },
      },
    ]);
  });

  it("spawns the argv descriptor returned by srt instead of a host-shell command string", async () => {
    const descriptors: unknown[] = [];
    const runner: SandboxProcessRunner = {
      run: async (descriptor) => {
        descriptors.push(descriptor);
        return { exitCode: 0, stdout: "ran", stderr: "" };
      },
    };
    const port = createSrtSandboxPort({
      runtime: {
        wrapWithSandboxArgv: async () => ({
          argv: ["/usr/bin/env", "node", "--version"],
          env: {
            PATH: "/usr/bin",
            ANTHROPIC_API_KEY: "secret",
            GH_TOKEN: "secret",
            AWS_SECRET_ACCESS_KEY: "secret",
          },
        }),
      },
      runner,
      status: {
        available: true,
        backend: "srt:fake",
        enforcementTier: "sandbox:srt",
      },
    });

    const result = await port.execute(
      { command: "node --version", cwd: "/workspace" },
      profile("/workspace"),
    );

    expect(result.stdout).toBe("ran");
    expect(descriptors).toEqual([
      {
        argv: ["/usr/bin/env", "node", "--version"],
        cwd: "/workspace",
        env: { PATH: "/usr/bin" },
      },
    ]);
  });

  it("strips exception-admin authority and KEEL_HOME from governed child environments", async () => {
    const descriptors: unknown[] = [];
    const port = createSrtSandboxPort({
      runtime: {
        wrapWithSandboxArgv: async () => ({
          argv: ["/usr/bin/env"],
          env: {
            PATH: "/usr/bin",
            KEEL_HOME: "/owner/keel-home",
            KEEL_INTERNAL_EGRESS_EXCEPTION_ADMIN: "1",
            KEEL_INTERNAL_EGRESS_EXCEPTION_ADMIN_REQUEST_B64: "model-controlled",
          },
        }),
      },
      runner: {
        run: async (descriptor) => {
          descriptors.push(descriptor);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      status: {
        available: true,
        backend: "srt:fake",
        enforcementTier: "sandbox:srt",
      },
    });

    await port.execute({ command: "/usr/bin/env", cwd: "/workspace" }, profile("/workspace"));

    expect(descriptors).toEqual([
      { argv: ["/usr/bin/env"], cwd: "/workspace", env: { PATH: "/usr/bin" } },
    ]);
  });

  it("passes credential proxy secrets only through the host-side srt config", async () => {
    const secret = "keel-real-token-sec027-srt-adapter";
    const placeholder = "keelcred_test_srt_adapter";
    const updateCalls: unknown[] = [];
    const wrappedCalls: unknown[] = [];
    const descriptors: unknown[] = [];
    const runnerOptions: unknown[] = [];
    const port = createSrtSandboxPort({
      runtime: {
        updateConfig: (config) => {
          updateCalls.push(config);
        },
        wrapWithSandboxArgv: async (_command, _shell, config) => {
          wrappedCalls.push(config);
          return {
            argv: ["/usr/bin/env", "true"],
            env: {
              PATH: "/usr/bin",
              KEEL_FIXTURE_TOKEN: secret,
              SANDBOX_RUNTIME: "1",
            },
          };
        },
      },
      runner: {
        run: async (descriptor, options) => {
          descriptors.push(descriptor);
          runnerOptions.push(options);
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
      },
      status: {
        available: true,
        backend: "srt:fake",
        enforcementTier: "sandbox:srt",
      },
    });

    await port.execute(
      { command: "curl http://api.example.com", cwd: "/workspace" },
      profile("/workspace"),
      {
        credentialProxy: {
          authorizationHeaders: [{ host: "api.example.com", scheme: "Bearer", secret }],
          authorizationPlaceholders: [
            { host: "placeholder.example.com", scheme: "Bearer", placeholder, secret },
          ],
          sandboxEnv: { KEEL_PLACEHOLDER_AUTH: placeholder },
          allowPlaintextInject: true,
        },
      },
    );

    expect(updateCalls).toEqual(wrappedCalls);
    expect(JSON.stringify(updateCalls)).toContain(secret);
    expect(updateCalls).toEqual([
      expect.objectContaining({
        credentials: {
          authorizationHeaders: [{ host: "api.example.com", scheme: "Bearer", value: secret }],
          authorizationPlaceholders: [
            { host: "placeholder.example.com", scheme: "Bearer", placeholder, value: secret },
          ],
          allowPlaintextInject: true,
        },
      }),
    ]);
    expect(JSON.stringify(descriptors)).not.toContain(secret);
    expect(descriptors).toEqual([
      {
        argv: ["/usr/bin/env", "true"],
        cwd: "/workspace",
        env: {
          PATH: "/usr/bin",
          SANDBOX_RUNTIME: "1",
          KEEL_PLACEHOLDER_AUTH: placeholder,
        },
      },
    ]);
    expect(JSON.stringify(runnerOptions)).not.toContain(secret);
  });

  it("refuses execution while the sandbox backend is unavailable", async () => {
    let wrapCalls = 0;
    const port = createSrtSandboxPort({
      runtime: {
        initialize: async () => {
          throw new Error("initialize must not run");
        },
        wrapWithSandboxArgv: async () => {
          wrapCalls += 1;
          return { argv: ["/bin/true"], env: {} };
        },
      },
      runner: {
        run: async () => {
          throw new Error("runner must not run");
        },
      },
      status: () => ({
        available: false,
        backend: "srt:fake",
        enforcementTier: "none",
        reason: "bubblewrap missing",
      }),
    });

    await expect(port.execute({ command: "true" }, {})).rejects.toThrow("bubblewrap missing");
    expect(wrapCalls).toBe(0);
  });

  it("initializes the runtime lazily once, cleans up per execution, and preserves per-call options", async () => {
    const abortController = new AbortController();
    let initializeCalls = 0;
    let cleanupCalls = 0;
    const wrappedCalls: unknown[] = [];
    const descriptors: unknown[] = [];
    const runnerOptions: unknown[] = [];
    const port = createSrtSandboxPort({
      runtime: {
        initialize: async () => {
          initializeCalls += 1;
        },
        wrapWithSandboxArgv: async (command, binShell, config, signal) => {
          wrappedCalls.push({ command, binShell, config, signal });
          return {
            argv: ["/usr/bin/env", "true"],
            env: { PATH: "/usr/bin", KEEL_TEST_SECRET: "secret" },
          };
        },
        cleanupAfterCommand: () => {
          cleanupCalls += 1;
        },
      },
      runner: {
        run: async (descriptor, options) => {
          descriptors.push(descriptor);
          runnerOptions.push(options);
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
      },
      status: {
        available: true,
        backend: "srt:fake",
        enforcementTier: "sandbox:srt",
      },
      binShell: "/bin/zsh",
    });

    await port.execute({ command: "true" }, {}, { signal: abortController.signal });
    await port.execute({ command: "true" }, {});

    expect(initializeCalls).toBe(1);
    expect(wrappedCalls).toEqual([
      {
        command: "true",
        binShell: "/bin/zsh",
        config: {},
        signal: abortController.signal,
      },
      {
        command: "true",
        binShell: "/bin/zsh",
        config: {},
        signal: undefined,
      },
    ]);
    expect(descriptors).toEqual([
      {
        argv: ["/usr/bin/env", "true"],
        env: { PATH: "/usr/bin" },
      },
      {
        argv: ["/usr/bin/env", "true"],
        env: { PATH: "/usr/bin" },
      },
    ]);
    expect(runnerOptions).toEqual([{ signal: abortController.signal }, undefined]);
    expect(cleanupCalls).toBe(2);
  });

  it("runs cleanup when the sandbox runner rejects", async () => {
    let cleanupCalls = 0;
    const port = createSrtSandboxPort({
      runtime: {
        wrapWithSandboxArgv: async () => ({
          argv: ["/usr/bin/env", "true"],
          env: { PATH: "/usr/bin" },
        }),
        cleanupAfterCommand: () => {
          cleanupCalls += 1;
        },
      },
      runner: {
        run: async () => {
          throw new Error("runner failed");
        },
      },
      status: {
        available: true,
        backend: "srt:fake",
        enforcementTier: "sandbox:srt",
      },
    });

    await expect(port.execute({ command: "true" }, {})).rejects.toThrow("runner failed");
    expect(cleanupCalls).toBe(1);
  });

  it("runs cleanup when srt wrapping rejects after config update", async () => {
    let cleanupCalls = 0;
    const port = createSrtSandboxPort({
      runtime: {
        updateConfig: () => {},
        wrapWithSandboxArgv: async () => {
          throw new Error("wrap failed");
        },
        cleanupAfterCommand: () => {
          cleanupCalls += 1;
        },
      },
      runner: {
        run: async () => {
          throw new Error("runner must not run");
        },
      },
      status: {
        available: true,
        backend: "srt:fake",
        enforcementTier: "sandbox:srt",
      },
    });

    await expect(port.execute({ command: "true" }, {})).rejects.toThrow("wrap failed");
    expect(cleanupCalls).toBe(1);
  });
});

describe("createNodeSandboxProcessRunner", () => {
  function fileSize(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  async function waitForFileGrowth(path: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (fileSize(path) > 0) return;
      await sleep(25);
    }
    throw new Error(`timed out waiting for marker growth: ${path}`);
  }

  it("runs argv directly, captures output, and honors cwd without a shell", async () => {
    const runner = createNodeSandboxProcessRunner();

    const result = await runner.run(
      {
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(process.cwd()); process.stderr.write('stderr-ok')",
        ],
        cwd: process.cwd(),
        env: process.env,
      },
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      stdout: process.cwd(),
      stderr: "stderr-ok",
    });
  });

  it("caps runaway stdout/stderr so a flooding command cannot OOM the warden (QC §5)", async () => {
    // The warden buffers the child's whole output into a JS string (and into the audit payload). A
    // command that streams unbounded output (`yes`, `cat /dev/zero`) would grow that string without
    // limit and OOM the control plane — the sandbox ulimit bounds the CHILD, not the warden's buffer.
    const runner = createNodeSandboxProcessRunner({ maxOutputBytes: 1024 });
    const result = await runner.run(
      {
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write('x'.repeat(1_000_000)); process.stderr.write('y'.repeat(1_000_000))",
        ],
        cwd: process.cwd(),
        env: process.env,
      },
      { signal: new AbortController().signal },
    );

    // Each stream is bounded near the cap (a runaway 1 MB child yields a small, capped buffer)...
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(1024 + 4096);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThan(1024 + 4096);
    // ...and the truncation is marked so the model/audit sees it was cut, not silently dropped.
    expect(result.stdout).toContain("truncated");
    expect(result.stderr).toContain("truncated");
  });

  it("does not add a truncation marker to output within the cap", async () => {
    const runner = createNodeSandboxProcessRunner({ maxOutputBytes: 1024 });
    const result = await runner.run(
      {
        argv: [process.execPath, "-e", "process.stdout.write('small output')"],
        cwd: process.cwd(),
        env: process.env,
      },
      { signal: new AbortController().signal },
    );
    expect(result.stdout).toBe("small output");
    expect(result.stdout).not.toContain("truncated");
  });

  it("rejects an empty argv descriptor before spawning", async () => {
    const runner = createNodeSandboxProcessRunner();

    await expect(runner.run({ argv: [], env: {} })).rejects.toThrow(
      "sandbox spawn descriptor argv must not be empty",
    );
  });

  it("reports process spawn failures to the caller", async () => {
    const runner = createNodeSandboxProcessRunner();

    await expect(
      runner.run({
        argv: ["/definitely/not/a/keel/sandbox/runtime"],
        env: {},
      }),
    ).rejects.toThrow(/ENOENT|spawn/);
  });

  it("kills the child process when the execution signal aborts", async () => {
    const runner = createNodeSandboxProcessRunner();
    const abortController = new AbortController();

    const result = runner.run(
      {
        argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
        env: process.env,
      },
      { signal: abortController.signal },
    );
    abortController.abort();

    await expect(result).resolves.toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
    });
  });

  it("honors a signal already aborted before spawn listeners are registered", async () => {
    const runner = createNodeSandboxProcessRunner({ killGraceMs: 0 });
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      runner.run(
        {
          argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
          env: process.env,
        },
        { signal: abortController.signal },
      ),
    ).resolves.toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
    });
  });

  it.skipIf(process.platform === "win32")(
    "falls back to direct-child signaling when process-group signaling fails",
    async () => {
      const abortController = new AbortController();
      let groupKillAttempts = 0;
      const runner = createNodeSandboxProcessRunner({
        killGraceMs: 0,
        killProcess: () => {
          groupKillAttempts += 1;
          throw new Error("group unavailable");
        },
      });

      const result = runner.run(
        {
          argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
          env: process.env,
        },
        { signal: abortController.signal },
      );
      abortController.abort();

      await expect(result).resolves.toMatchObject({
        exitCode: null,
        signal: "SIGTERM",
      });
      expect(groupKillAttempts).toBe(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "escalates to SIGKILL when an aborted process ignores SIGTERM",
    async () => {
      const runner = createNodeSandboxProcessRunner({ killGraceMs: 25 });
      const abortController = new AbortController();
      const dir = mkdtempSync(join(tmpdir(), "keel-sandbox-runner-sigkill-"));
      const readyMarker = join(dir, "sigterm-handler-ready");

      const result = runner.run(
        {
          argv: [
            process.execPath,
            "-e",
            "const fs = require('node:fs'); " +
              "const ready = process.argv[1]; " +
              "process.on('SIGTERM', () => {}); " +
              "fs.writeFileSync(ready, 'ready'); " +
              "setInterval(() => {}, 10_000)",
            readyMarker,
          ],
          env: process.env,
        },
        { signal: abortController.signal },
      );

      try {
        await waitForFileGrowth(readyMarker);
        abortController.abort();

        await expect(result).resolves.toMatchObject({
          exitCode: null,
          signal: "SIGKILL",
        });
      } finally {
        abortController.abort();
        await result.catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "kills the spawned process group on abort so descendants do not survive",
    async () => {
      const runner = createNodeSandboxProcessRunner();
      const abortController = new AbortController();
      const dir = mkdtempSync(join(tmpdir(), "keel-sandbox-runner-abort-"));
      const marker = join(dir, "grandchild-heartbeat");
      const grandchildScript =
        "const fs=require('node:fs'); const marker=process.argv[1]; " +
        "setInterval(() => fs.appendFileSync(marker, 'x'), 25);";
      const parentScript =
        "const { spawn } = require('node:child_process'); " +
        "const marker = process.argv[1]; " +
        "const child = spawn(process.execPath, ['-e', process.argv[2], marker], { stdio: 'ignore' }); " +
        "child.unref(); " +
        "setInterval(() => {}, 10_000);";

      try {
        const result = runner.run(
          {
            argv: [process.execPath, "-e", parentScript, marker, grandchildScript],
            env: process.env,
          },
          { signal: abortController.signal },
        );

        await waitForFileGrowth(marker);
        abortController.abort();
        await expect(result).resolves.toMatchObject({ exitCode: null });

        const sizeAfterAbort = fileSize(marker);
        await sleep(200);
        expect(fileSize(marker)).toBe(sizeAfterAbort);
      } finally {
        abortController.abort();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
