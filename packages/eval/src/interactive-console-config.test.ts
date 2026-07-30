import { describe, expect, it } from "vitest";
import { createQemuConsoleTargetProfile, type QemuConsoleTargetProfileOptions } from "@keel/warden";
import {
  terminalBenchInteractiveConsoleGrantEnvForTask,
  terminalBenchInteractiveConsoleGrantEnvForTaskSync,
  terminalBenchInteractiveConsoleConfigForTasks,
  terminalBenchInteractiveConsoleConfigB64ForTasks,
} from "./interactive-console-config.js";
import { buildHarborRunArgs } from "./harbor-invoker.js";

describe("Terminal-Bench interactive console product config", () => {
  const opts = {
    tmuxPath: "/usr/bin/tmux",
    qemuBinary: "/usr/bin/qemu-system-x86_64",
  };

  function targetFor(
    targets: readonly Record<string, unknown>[],
    targetId: "qemu-startup" | "qemu-alpine-ssh",
  ): Record<string, unknown> {
    const target = targets.find((candidate) => candidate["targetId"] === targetId);
    if (target === undefined) throw new Error(`missing target ${targetId}`);
    return target;
  }

  function qemuProfile(target: Record<string, unknown>) {
    return createQemuConsoleTargetProfile(target as unknown as QemuConsoleTargetProfileOptions);
  }

  function argAfter(argv: readonly string[], flag: string): string {
    const index = argv.indexOf(flag);
    if (index < 0) throw new Error(`missing QEMU arg ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value after QEMU arg ${flag}`);
    return value;
  }

  function argvFor(target: Record<string, unknown>): readonly string[] {
    const argv = qemuProfile(target).argv;
    if (argv === undefined) throw new Error("expected QEMU profile argv");
    return argv;
  }

  it("emits no console config for non-QEMU task batches", () => {
    expect(
      terminalBenchInteractiveConsoleConfigForTasks(["terminal-bench/build-cython-ext"], opts),
    ).toBeUndefined();
  });

  it("builds reviewed task-specific QEMU targets for the two interactive-console TB tasks", () => {
    const config = terminalBenchInteractiveConsoleConfigForTasks(
      ["terminal-bench/qemu-startup", "qemu-alpine-ssh"],
      opts,
    );

    expect(config).toBeDefined();
    const parsed = JSON.parse(config ?? "") as {
      backend: { kind: string; tmuxPath: string };
      targets: Array<Record<string, unknown>>;
    };
    expect(parsed.backend).toEqual({ kind: "system-tmux", tmuxPath: "/usr/bin/tmux" });
    expect(parsed.targets.map((target) => target["targetId"]).sort()).toEqual([
      "qemu-alpine-ssh",
      "qemu-startup",
    ]);
    const startupTarget = targetFor(parsed.targets, "qemu-startup");
    const alpineSshTarget = targetFor(parsed.targets, "qemu-alpine-ssh");
    expect(startupTarget).toMatchObject({
      kind: "qemu-local-vm",
      qemuBinary: "/usr/bin/qemu-system-x86_64",
      cwd: "/app",
      memoryMiB: 1024,
      boot: { order: "cdrom" },
      allowRelease: true,
      serial: { kind: "telnet", bindHost: "127.0.0.1", port: 6665, monitor: true },
      diskImages: [
        { path: "/app/alpine.iso", access: "read-only", role: "cdrom" },
        {
          path: "/app/alpine-disk.qcow2",
          access: "read-write",
          role: "drive",
          format: "qcow2",
        },
      ],
      network: {
        hostForwards: [
          {
            protocol: "tcp",
            bindHost: "127.0.0.1",
            hostPort: 2222,
            guestPort: 22,
          },
        ],
      },
    });
    expect(alpineSshTarget).toMatchObject({
      kind: "qemu-local-vm",
      qemuBinary: "/usr/bin/qemu-system-x86_64",
      cwd: "/app",
      memoryMiB: 512,
      allowRelease: true,
      serial: { kind: "stdio", monitor: true },
      diskImages: [
        { path: "/app/alpine.iso", access: "read-only", role: "cdrom" },
        { path: "/app/alpine-disk.qcow2", access: "read-write", role: "hda" },
      ],
      network: {
        hostForwards: [
          {
            protocol: "tcp",
            bindHost: "127.0.0.1",
            hostPort: 2222,
            guestPort: 22,
          },
        ],
      },
    });
    expect(config).not.toMatch(/"-drive"|"hostfwd=/u);

    const startupProfile = qemuProfile(startupTarget);
    const startupArgv = argvFor(startupTarget);
    expect(startupArgv[0]).toBe("/usr/bin/qemu-system-x86_64");
    expect(startupArgv).toEqual(
      expect.arrayContaining([
        "-m",
        "1024",
        "-cdrom",
        "/app/alpine.iso",
        "-boot",
        "d",
        "-serial",
        "mon:telnet:127.0.0.1:6665,server,nowait",
        "-display",
        "none",
        "-nographic",
      ]),
    );
    expect(argAfter(startupArgv, "-drive").split(",")).toEqual(
      expect.arrayContaining([
        "file=/app/alpine-disk.qcow2",
        "if=virtio",
        "format=qcow2",
        "readonly=off",
      ]),
    );
    expect(argAfter(startupArgv, "-netdev").split(",")).toEqual(
      expect.arrayContaining(["user", "id=keelnet0", "hostfwd=tcp:127.0.0.1:2222-:22"]),
    );
    expect(argAfter(startupArgv, "-device")).toBe("e1000,netdev=keelnet0");
    expect(startupArgv).not.toContain("-daemonize");
    expect(startupProfile.vm?.network).toMatchObject({
      hostForwards: [
        {
          protocol: "tcp",
          bindHost: "127.0.0.1",
          hostPort: 2222,
          guestPort: 22,
        },
      ],
      localListeners: [
        {
          protocol: "tcp",
          bindHost: "127.0.0.1",
          port: 6665,
          purpose: "qemu serial telnet console",
        },
      ],
    });

    const alpineSshArgv = argvFor(alpineSshTarget);
    expect(alpineSshArgv).toEqual(
      expect.arrayContaining([
        "-hda",
        "/app/alpine-disk.qcow2",
        "-serial",
        "mon:stdio",
        "-display",
        "none",
        "-nographic",
      ]),
    );
    expect(argAfter(alpineSshArgv, "-netdev").split(",")).toEqual(
      expect.arrayContaining(["user", "id=keelnet0", "hostfwd=tcp:127.0.0.1:2222-:22"]),
    );
    expect(alpineSshArgv).not.toContain("-daemonize");
  });

  it("threads the base64 config through the Harbor argv only for QEMU task batches", () => {
    const configB64 = terminalBenchInteractiveConsoleConfigB64ForTasks(
      ["terminal-bench/qemu-startup"],
      opts,
    );
    expect(configB64).toBeDefined();
    if (configB64 === undefined) throw new Error("expected QEMU console config");

    const args = buildHarborRunArgs({
      dataset: "terminal-bench/terminal-bench-2-1",
      agentImportPath: "keel_harbor_agent.agent:KeelAgent",
      model: "anthropic/claude-sonnet-4-6",
      taskNames: ["terminal-bench/qemu-startup"],
      binaryUrl: "http://host.docker.internal:8077/keel-linux-x64",
      binarySha256: "c".repeat(64),
      maxTokens: 150_000,
      jobName: "qemu-startup",
      interactiveConsoleConfigB64: configB64,
    });

    expect(args).toEqual(expect.arrayContaining(["--ae", "KEEL_WARDEN_SANDBOX=srt"]));
    expect(args).toEqual(
      expect.arrayContaining([
        "--ae",
        `KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64=${configB64 ?? ""}`,
      ]),
    );
  });

  it("builds a deterministic parent-reviewed console grant env bundle for a singleton QEMU task", async () => {
    const bundle = await terminalBenchInteractiveConsoleGrantEnvForTask(
      "terminal-bench/qemu-startup",
      {
        ...opts,
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        reviewedAt: "2026-07-10T18:00:00.000Z",
        expiresAt: "2026-07-10T19:00:00.000Z",
      },
    );
    const repeat = await terminalBenchInteractiveConsoleGrantEnvForTask(
      "terminal-bench/qemu-startup",
      {
        ...opts,
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        reviewedAt: "2026-07-10T18:00:00.000Z",
        expiresAt: "2026-07-10T19:00:00.000Z",
      },
    );

    expect(bundle).toBeDefined();
    expect(repeat).toEqual(bundle);
    if (bundle === undefined) throw new Error("expected qemu-startup grant bundle");

    expect(bundle.sessionId).toBe("ses_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(bundle.home).toBe("/logs/agent");
    expect(bundle.keelHome).toBe("/logs/agent/keelhome");
    expect(bundle.eligibility).toEqual({
      kind: "terminal-bench-qemu-singleton",
      taskName: "qemu-startup",
    });
    expect(bundle.tmuxPrivateRoot).toBe(
      "/tmp/keel-console-tmux-qemu-startup-ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );

    const config = JSON.parse(Buffer.from(bundle.configB64, "base64").toString("utf8")) as {
      backend: { kind: string; tmuxPath: string; privateRoot?: string };
      targets: Array<Record<string, unknown>>;
    };
    expect(config.backend).toEqual({
      kind: "system-tmux",
      tmuxPath: "/usr/bin/tmux",
      privateRoot: bundle.tmuxPrivateRoot,
    });
    expect(config.targets.map((target) => target["targetId"])).toEqual(["qemu-startup"]);

    const grant = JSON.parse(Buffer.from(bundle.grantB64, "base64").toString("utf8")) as {
      source: string;
      sessionId: string;
      workspaceRoot: string;
      target: { targetId: string };
      operation: { kind: string; rows: number; cols: number };
      sandboxPlanDigest: string;
      grantKey: string;
      envelopeHash: string;
    };
    expect(grant).toMatchObject({
      source: "parent-reviewed-benchmark-env",
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      workspaceRoot: "/app",
      target: { targetId: "qemu-startup" },
      operation: { kind: "open", rows: 24, cols: 80 },
    });
    expect(grant.sandboxPlanDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(grant.grantKey).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(grant.envelopeHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("does not mint parent-reviewed console grants for non-QEMU or multi-task batches", async () => {
    await expect(
      terminalBenchInteractiveConsoleGrantEnvForTask("terminal-bench/build-cython-ext", {
        ...opts,
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        reviewedAt: "2026-07-10T18:00:00.000Z",
        expiresAt: "2026-07-10T19:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });

  it("builds qemu-alpine-ssh grants with explicit reviewed paths and operation dimensions", async () => {
    const bundle = await terminalBenchInteractiveConsoleGrantEnvForTask("qemu-alpine-ssh", {
      ...opts,
      workspaceRoot: "/work",
      home: "/agent-home",
      keelHome: "/agent-home/keelhome",
      auditDir: "/audit/explicit",
      tmuxPrivateRoot: "/tmp/keel-console-tmux-explicit",
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      reviewedAt: "2026-07-10T18:30:00.000Z",
      expiresAt: "2026-07-10T19:30:00.000Z",
      rows: 30,
      cols: 100,
      principal: {
        osUser: "reviewer",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
    });

    expect(bundle).toBeDefined();
    if (bundle === undefined) throw new Error("expected qemu-alpine-ssh grant bundle");
    expect(bundle.tmuxPrivateRoot).toBe("/tmp/keel-console-tmux-explicit");
    expect(bundle.home).toBe("/agent-home");
    expect(bundle.keelHome).toBe("/agent-home/keelhome");
    expect(bundle.eligibility).toEqual({
      kind: "terminal-bench-qemu-singleton",
      taskName: "qemu-alpine-ssh",
    });

    const config = JSON.parse(Buffer.from(bundle.configB64, "base64").toString("utf8")) as {
      backend: { privateRoot?: string };
      targets: Array<Record<string, unknown>>;
    };
    expect(config.backend.privateRoot).toBe("/tmp/keel-console-tmux-explicit");
    expect(config.targets[0]).toMatchObject({
      targetId: "qemu-alpine-ssh",
      cwd: "/work",
      diskImages: [
        { path: "/work/alpine.iso", access: "read-only", role: "cdrom" },
        { path: "/work/alpine-disk.qcow2", access: "read-write", role: "hda" },
      ],
    });

    const grant = JSON.parse(Buffer.from(bundle.grantB64, "base64").toString("utf8")) as {
      principal: { osUser?: string };
      sessionId: string;
      workspaceRoot: string;
      target: { targetId: string };
      operation: { rows: number; cols: number };
    };
    expect(grant).toMatchObject({
      principal: { osUser: "reviewer" },
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      workspaceRoot: "/work",
      target: { targetId: "qemu-alpine-ssh" },
      operation: { rows: 30, cols: 100 },
    });
  });

  it("uses env KEEL_HOME consistently for the default audit dir and emitted runtime home", () => {
    const base = {
      ...opts,
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAY",
      reviewedAt: "2026-07-10T18:00:00.000Z",
      expiresAt: "2026-07-10T19:00:00.000Z",
    };
    const viaEnv = terminalBenchInteractiveConsoleGrantEnvForTaskSync("qemu-startup", {
      ...base,
      env: { KEEL_HOME: "/logs/agent/env-keelhome" },
    });
    const explicit = terminalBenchInteractiveConsoleGrantEnvForTaskSync("qemu-startup", {
      ...base,
      keelHome: "/logs/agent/env-keelhome",
      auditDir: "/logs/agent/env-keelhome/audit",
    });

    expect(viaEnv).toEqual(explicit);
    expect(viaEnv?.keelHome).toBe("/logs/agent/env-keelhome");
  });

  it("rejects malformed session ids before minting parent-reviewed console grants", async () => {
    await expect(
      terminalBenchInteractiveConsoleGrantEnvForTask("qemu-startup", {
        ...opts,
        sessionId: "not-a-session",
        reviewedAt: "2026-07-10T18:00:00.000Z",
        expiresAt: "2026-07-10T19:00:00.000Z",
      }),
    ).rejects.toThrow(/ses_<ULID>/u);
  });

  it.each(["qemu-startup", "qemu-alpine-ssh"] as const)(
    "keeps the sync default-policy grant bundle equal to the async policy-evaluated bundle for %s",
    async (taskName) => {
      const input = {
        ...opts,
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAX",
        reviewedAt: "2026-07-10T18:00:00.000Z",
        expiresAt: "2026-07-10T19:00:00.000Z",
      };

      await expect(
        terminalBenchInteractiveConsoleGrantEnvForTask(taskName, input),
      ).resolves.toEqual(terminalBenchInteractiveConsoleGrantEnvForTaskSync(taskName, input));
    },
  );
});
