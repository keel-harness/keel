import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ConsoleBrokerPort } from "./broker.js";
import {
  createHeadlessConsoleGrantEnvelope,
  HEADLESS_CONSOLE_GRANT_VERSION,
  type HeadlessConsoleGrantEnvelopeT,
  type HeadlessConsoleGrantEnvelopePayloadT,
} from "./grants.js";
import {
  INTERACTIVE_CONSOLE_GRANT_B64_ENV,
  INTERACTIVE_CONSOLE_CONFIG_B64_ENV,
  INTERACTIVE_CONSOLE_CONFIG_ENV,
  interactiveConsoleProductOptionsFromEnv,
} from "./product-config.js";
import type {
  ConsoleSandboxLaunchPreparer,
  SystemTmuxConsoleBrokerOptions,
} from "./tmux-broker.js";
import { SYSTEM_TMUX_CONSOLE_BROKER_KIND } from "./tmux-broker.js";

const LAUNCH_PREPARER: ConsoleSandboxLaunchPreparer = {
  status: () => ({ available: true, backend: "srt:vendored", enforcementTier: "sandbox:srt" }),
  prepareLaunch: async () => ({
    descriptor: { argv: ["/usr/bin/env", "true"], env: {} },
    cleanup: () => {},
  }),
};

function broker(): ConsoleBrokerPort {
  return {
    status: () => ({
      available: true,
      backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
      tmuxPath: "/usr/bin/tmux",
      tmuxVersion: "tmux 3.4",
    }),
    open: async () => ({ processIdentity: { pid: 1001 } }),
    checkProcessIdentity: async () => ({
      live: true,
      observedProcessIdentity: { pid: 1001 },
    }),
    sendKeys: async () => ({ acceptedTokens: 1 }),
    readScreen: async () => ({
      handle: "con_product",
      targetId: "qemu-alpine",
      seq: 1,
      screen: "login:",
      capturedAt: "2026-07-09T00:00:00.000Z",
    }),
    release: async () => ({ released: true }),
    close: async () => ({ closed: true }),
  };
}

function qemuConfig() {
  return {
    backend: { kind: "system-tmux", tmuxPath: "/usr/bin/tmux" },
    targets: [
      {
        kind: "qemu-local-vm",
        targetId: "qemu-alpine",
        qemuBinary: "/usr/bin/qemu-system-x86_64",
        memoryMiB: 512,
        boot: { order: "cdrom" },
        display: { kind: "none" },
        nographic: true,
        serial: { kind: "stdio", monitor: true },
        args: ["-no-reboot"],
        cwd: "/workspace",
        declaredTempRoots: ["/tmp/keel-vm"],
        allowRelease: true,
        diskImages: [
          { path: "/workspace/alpine.iso", access: "read-only", role: "cdrom" },
          { path: "/workspace/alpine.qcow2", access: "read-write", role: "hda" },
        ],
        network: {
          hostForwards: [
            {
              protocol: "tcp",
              bindHost: "localhost",
              hostPort: 2222,
              guestPort: 22,
              purpose: "ssh grading fixture",
            },
          ],
          guestDownloads: [{ domain: "DL-CDN.AlpineLinux.org", purpose: "apk mirror" }],
        },
        maxTtlMs: 300_000,
        maxKeyTokens: 128,
      },
    ],
  };
}

function headlessGrantPayload(
  source: HeadlessConsoleGrantEnvelopePayloadT["source"] = "parent-reviewed-benchmark-env",
): HeadlessConsoleGrantEnvelopePayloadT {
  return {
    version: HEADLESS_CONSOLE_GRANT_VERSION,
    source,
    sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    workspaceRoot: "/workspace",
    target: {
      targetId: "qemu-alpine",
      targetDigest: `sha256:${"a".repeat(64)}`,
      sandboxProfileId: "srt-qemu-local-vm-deny-default-egress",
    },
    operation: { kind: "open", rows: 24, cols: 80 },
    targetProfile: {
      command: "/usr/bin/qemu-system-x86_64",
      argv: ["/usr/bin/qemu-system-x86_64", "-nographic"],
      cwd: "/workspace",
    },
    policyPack: { name: "keel-default-policy", hash: `sha256:${"1".repeat(64)}` },
    sandboxPlanDigest: `sha256:${"2".repeat(64)}`,
    effectEnvelope: {
      effectKinds: ["process_exec"],
      scopes: ["workspace"],
    },
    matchedRules: ["CONSOLE-TARGET-GRANT-REQUIRED"],
    grantKey: `sha256:${"3".repeat(64)}`,
    principal: {
      osUser: "alice",
      configuredId: null,
      authProvider: "local",
      assurance: "local-os-user",
    },
    reviewedAt: "2026-07-10T18:00:00.000Z",
    expiresAt: "2026-07-10T19:00:00.000Z",
    maxUses: 1,
    reviewText: "console target qemu-alpine requires approval",
  };
}

function headlessGrant(
  source: HeadlessConsoleGrantEnvelopePayloadT["source"] = "parent-reviewed-benchmark-env",
): HeadlessConsoleGrantEnvelopeT {
  return createHeadlessConsoleGrantEnvelope(headlessGrantPayload(source));
}

function grantEnvValue(grant: HeadlessConsoleGrantEnvelopeT): string {
  return Buffer.from(JSON.stringify(grant)).toString("base64");
}

describe("interactive console product config", () => {
  it("keeps product console disabled when no parent-controlled config is present", async () => {
    await expect(interactiveConsoleProductOptionsFromEnv({})).resolves.toEqual({});
    await expect(
      interactiveConsoleProductOptionsFromEnv({
        [INTERACTIVE_CONSOLE_CONFIG_ENV]: "   ",
        [INTERACTIVE_CONSOLE_CONFIG_B64_ENV]: "\t",
      }),
    ).resolves.toEqual({});
  });

  it("fails closed when a parent-reviewed headless grant env is supplied without product config", async () => {
    const grant = headlessGrant();

    await expect(
      interactiveConsoleProductOptionsFromEnv({
        [INTERACTIVE_CONSOLE_GRANT_B64_ENV]: grantEnvValue(grant),
      }),
    ).rejects.toThrow("parent-env console grant requires interactive console product config");
  });

  it("fails closed when the parent-reviewed grant env is malformed, tampered, or from the wrong source", async () => {
    await expect(
      interactiveConsoleProductOptionsFromEnv({
        [INTERACTIVE_CONSOLE_GRANT_B64_ENV]: Buffer.from("{not-json").toString("base64"),
      }),
    ).rejects.toThrow("invalid interactive console grant");

    await expect(
      interactiveConsoleProductOptionsFromEnv({
        [INTERACTIVE_CONSOLE_GRANT_B64_ENV]: `${grantEnvValue(headlessGrant())}!`,
      }),
    ).rejects.toThrow("invalid interactive console grant encoding");

    await expect(
      interactiveConsoleProductOptionsFromEnv({
        [INTERACTIVE_CONSOLE_GRANT_B64_ENV]: grantEnvValue({
          ...headlessGrant(),
          envelopeHash: `sha256:${"f".repeat(64)}`,
        }),
      }),
    ).rejects.toThrow("headless console grant envelope hash mismatch");

    await expect(
      interactiveConsoleProductOptionsFromEnv({
        [INTERACTIVE_CONSOLE_GRANT_B64_ENV]: grantEnvValue(
          headlessGrant("local-console-grant-file"),
        ),
      }),
    ).rejects.toThrow("parent-env console grant source must be parent-reviewed-benchmark-env");
  });

  it("loads a parent-reviewed headless console grant alongside reviewed product config", async () => {
    const grant = headlessGrant();

    const options = await interactiveConsoleProductOptionsFromEnv(
      {
        [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify(qemuConfig()),
        [INTERACTIVE_CONSOLE_GRANT_B64_ENV]: grantEnvValue(grant),
      },
      {
        launchPreparer: LAUNCH_PREPARER,
        probeSystemTmuxConsoleBroker: async () => ({
          available: true,
          backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
          tmuxPath: "/usr/bin/tmux",
          tmuxVersion: "tmux 3.4",
        }),
        createSystemTmuxConsoleBroker: () => broker(),
      },
    );

    expect(options.interactiveConsoleTargets?.["qemu-alpine"]).toBeDefined();
    expect(options.interactiveConsoleBroker).toBeDefined();
    expect(options.interactiveConsoleHeadlessGrants).toEqual([grant]);
  });

  it("fails closed when explicit product config is not valid JSON", async () => {
    await expect(
      interactiveConsoleProductOptionsFromEnv({
        [INTERACTIVE_CONSOLE_CONFIG_ENV]: "{not-json",
      }),
    ).rejects.toThrow("invalid interactive console product config");
  });

  it("fails closed when raw and base64 configs are both present", async () => {
    await expect(
      interactiveConsoleProductOptionsFromEnv({
        [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify(qemuConfig()),
        [INTERACTIVE_CONSOLE_CONFIG_B64_ENV]: Buffer.from(JSON.stringify(qemuConfig())).toString(
          "base64",
        ),
      }),
    ).rejects.toThrow("set only one interactive console config env var");
  });

  it("fails closed when explicit console config is present without an SRT launch preparer", async () => {
    await expect(
      interactiveConsoleProductOptionsFromEnv({
        [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify(qemuConfig()),
      }),
    ).rejects.toThrow(
      "interactive console product config requires an enforcing SRT launch preparer",
    );
  });

  it("builds normalized QEMU targets and a probed system-tmux broker from parent env", async () => {
    let capturedBrokerOptions: SystemTmuxConsoleBrokerOptions | undefined;
    const createSystemTmuxConsoleBroker = vi.fn((options: SystemTmuxConsoleBrokerOptions) => {
      capturedBrokerOptions = options;
      return broker();
    });

    const options = await interactiveConsoleProductOptionsFromEnv(
      {
        [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify(qemuConfig()),
        PATH: "/usr/bin",
        TMUX: "/tmp/user-tmux",
      },
      {
        launchPreparer: LAUNCH_PREPARER,
        probeSystemTmuxConsoleBroker: async () => ({
          available: true,
          backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
          tmuxPath: "/usr/bin/tmux",
          tmuxVersion: "tmux 3.4",
        }),
        createSystemTmuxConsoleBroker,
      },
    );

    expect(Object.keys(options.interactiveConsoleTargets ?? {})).toEqual(["qemu-alpine"]);
    expect(options.interactiveConsoleTargets?.["qemu-alpine"]).toMatchObject({
      targetId: "qemu-alpine",
      command: "/usr/bin/qemu-system-x86_64",
      argv: [
        "/usr/bin/qemu-system-x86_64",
        "-m",
        "512",
        "-cdrom",
        "/workspace/alpine.iso",
        "-hda",
        "/workspace/alpine.qcow2",
        "-boot",
        "d",
        "-netdev",
        "user,id=keelnet0,hostfwd=tcp:127.0.0.1:2222-:22",
        "-device",
        "e1000,netdev=keelnet0",
        "-serial",
        "mon:stdio",
        "-display",
        "none",
        "-nographic",
        "-no-reboot",
      ],
      cwd: "/workspace",
      declaredTempRoots: ["/tmp/keel-vm"],
      allowRelease: true,
      egressDomains: ["dl-cdn.alpinelinux.org"],
      vm: {
        kind: "qemu",
        diskImages: [
          { path: "/workspace/alpine.iso", access: "read-only", role: "cdrom" },
          { path: "/workspace/alpine.qcow2", access: "read-write", role: "hda" },
        ],
        network: {
          hostForwards: [
            {
              protocol: "tcp",
              bindHost: "127.0.0.1",
              hostPort: 2222,
              guestPort: 22,
              purpose: "ssh grading fixture",
            },
          ],
          guestDownloads: [{ domain: "dl-cdn.alpinelinux.org", purpose: "apk mirror" }],
        },
      },
    });
    expect(options.interactiveConsoleBroker).toBeDefined();
    expect(createSystemTmuxConsoleBroker).toHaveBeenCalledOnce();
    expect(capturedBrokerOptions).toMatchObject({
      tmuxPath: "/usr/bin/tmux",
      tmuxVersion: "tmux 3.4",
      launchPreparer: LAUNCH_PREPARER,
    });
    expect(capturedBrokerOptions?.env?.["TMUX"]).toBeUndefined();
  });

  it("passes a parent-reviewed system-tmux private root through to the broker", async () => {
    let capturedBrokerOptions: SystemTmuxConsoleBrokerOptions | undefined;
    const createSystemTmuxConsoleBroker = vi.fn((options: SystemTmuxConsoleBrokerOptions) => {
      capturedBrokerOptions = options;
      return broker();
    });
    const config = {
      ...qemuConfig(),
      backend: {
        kind: "system-tmux",
        tmuxPath: "/usr/bin/tmux",
        privateRoot: "/tmp/keel-console-tmux-qemu-startup-fixed",
      },
    };

    await interactiveConsoleProductOptionsFromEnv(
      {
        [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify(config),
      },
      {
        launchPreparer: LAUNCH_PREPARER,
        probeSystemTmuxConsoleBroker: async () => ({
          available: true,
          backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
          tmuxPath: "/usr/bin/tmux",
          tmuxVersion: "tmux 3.4",
        }),
        createSystemTmuxConsoleBroker,
      },
    );

    expect(capturedBrokerOptions?.privateRoot).toBe("/tmp/keel-console-tmux-qemu-startup-fixed");
  });

  it("keeps the broker unavailable-honest when the system tmux probe fails", async () => {
    let capturedBrokerOptions: SystemTmuxConsoleBrokerOptions | undefined;

    const options = await interactiveConsoleProductOptionsFromEnv(
      {
        [INTERACTIVE_CONSOLE_CONFIG_B64_ENV]: Buffer.from(JSON.stringify(qemuConfig())).toString(
          "base64",
        ),
      },
      {
        launchPreparer: LAUNCH_PREPARER,
        probeSystemTmuxConsoleBroker: async () => ({
          available: false,
          backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
          tmuxPath: "/usr/bin/tmux",
          reason: "spawn tmux ENOENT",
          fixCommand: "keel doctor",
        }),
        createSystemTmuxConsoleBroker: (options) => {
          capturedBrokerOptions = options;
          return broker();
        },
      },
    );

    expect(options.interactiveConsoleTargets?.["qemu-alpine"]).toBeDefined();
    expect(capturedBrokerOptions?.tmuxStatus).toEqual({
      available: false,
      backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
      tmuxPath: "/usr/bin/tmux",
      reason: "spawn tmux ENOENT",
      fixCommand: "keel doctor",
    });
    expect(capturedBrokerOptions?.tmuxVersion).toBe("unavailable");
  });

  it("normalizes local listeners and uses unknown tmux version only for available unversioned probes", async () => {
    let capturedBrokerOptions: SystemTmuxConsoleBrokerOptions | undefined;
    const config = {
      backend: { kind: "system-tmux", tmuxPath: "/usr/local/bin/tmux" },
      targets: [
        {
          kind: "qemu-local-vm",
          targetId: "qemu-listener",
          qemuBinary: "/usr/bin/qemu-system-x86_64",
          cwd: "/workspace",
          diskImages: [{ path: "/workspace/listener.qcow2", access: "read-only" }],
          network: {
            localListeners: [
              { protocol: "udp", bindHost: "::1", port: 5901, purpose: "vnc fixture" },
            ],
          },
          idleTimeoutMs: 10_000,
          maxScreenFrames: 12,
          maxScreenBytes: 4096,
        },
      ],
    };

    const options = await interactiveConsoleProductOptionsFromEnv(
      {
        [INTERACTIVE_CONSOLE_CONFIG_B64_ENV]: Buffer.from(JSON.stringify(config)).toString(
          "base64",
        ),
        LC_ALL: "C",
        PATH: "/workspace/bin",
      },
      {
        launchPreparer: LAUNCH_PREPARER,
        probeSystemTmuxConsoleBroker: async () => ({
          available: true,
          backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
          tmuxPath: "/usr/local/bin/tmux",
        }),
        createSystemTmuxConsoleBroker: (options) => {
          capturedBrokerOptions = options;
          return broker();
        },
      },
    );

    expect(options.interactiveConsoleTargets?.["qemu-listener"]).toMatchObject({
      targetId: "qemu-listener",
      command: "/usr/bin/qemu-system-x86_64",
      egressDomains: [],
      idleTimeoutMs: 10_000,
      maxScreenFrames: 12,
      maxScreenBytes: 4096,
      vm: {
        network: {
          localListeners: [
            { protocol: "udp", bindHost: "::1", port: 5901, purpose: "vnc fixture" },
          ],
        },
      },
    });
    expect(capturedBrokerOptions?.tmuxVersion).toBe("unknown");
    expect(capturedBrokerOptions?.env?.["TERM"]).toBe("xterm-256color");
    expect(capturedBrokerOptions?.env?.["LC_ALL"]).toBe("C");
    expect(capturedBrokerOptions?.env?.["PATH"]).toBeUndefined();
  });

  it("omits optional QEMU fields and undefined broker env values", async () => {
    let capturedBrokerOptions: SystemTmuxConsoleBrokerOptions | undefined;
    const config = {
      backend: { kind: "system-tmux", tmuxPath: "/usr/bin/tmux" },
      targets: [
        {
          kind: "qemu-local-vm",
          targetId: "qemu-minimal",
          qemuBinary: "/usr/bin/qemu-system-x86_64",
          cwd: "/workspace",
          diskImages: [{ path: "/workspace/minimal.qcow2", access: "read-only" }],
          network: {
            hostForwards: [
              { protocol: "tcp", bindHost: "127.0.0.1", hostPort: 2022, guestPort: 22 },
            ],
            localListeners: [{ protocol: "tcp", bindHost: "127.0.0.1", port: 5901 }],
            guestDownloads: [{ domain: "example.invalid" }],
          },
        },
      ],
    };

    const options = await interactiveConsoleProductOptionsFromEnv(
      {
        [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify(config),
        HOME: undefined,
        LANG: "C.UTF-8",
      },
      {
        launchPreparer: LAUNCH_PREPARER,
        probeSystemTmuxConsoleBroker: async () => ({
          available: true,
          backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
          tmuxPath: "/usr/bin/tmux",
          tmuxVersion: "tmux 3.4",
        }),
        createSystemTmuxConsoleBroker: (options) => {
          capturedBrokerOptions = options;
          return broker();
        },
      },
    );

    const profile = options.interactiveConsoleTargets?.["qemu-minimal"];
    expect(profile).toMatchObject({
      targetId: "qemu-minimal",
      egressDomains: ["example.invalid"],
      vm: {
        network: {
          hostForwards: [{ protocol: "tcp", bindHost: "127.0.0.1", hostPort: 2022, guestPort: 22 }],
          localListeners: [{ protocol: "tcp", bindHost: "127.0.0.1", port: 5901 }],
          guestDownloads: [{ domain: "example.invalid" }],
        },
      },
    });
    expect(profile?.declaredTempRoots).toBeUndefined();
    expect(capturedBrokerOptions?.env?.["HOME"]).toBeUndefined();
    expect(capturedBrokerOptions?.env?.["LANG"]).toBe("C.UTF-8");
  });

  it("builds a target with no network declaration", async () => {
    const config = {
      backend: { kind: "system-tmux", tmuxPath: "/usr/bin/tmux" },
      targets: [
        {
          kind: "qemu-local-vm",
          targetId: "qemu-no-network",
          qemuBinary: "/usr/bin/qemu-system-x86_64",
          cwd: "/workspace",
          diskImages: [{ path: "/workspace/no-network.qcow2", access: "read-only" }],
        },
      ],
    };

    const options = await interactiveConsoleProductOptionsFromEnv(
      { [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify(config) },
      {
        launchPreparer: LAUNCH_PREPARER,
        probeSystemTmuxConsoleBroker: async () => ({
          available: true,
          backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
          tmuxPath: "/usr/bin/tmux",
          tmuxVersion: "tmux 3.4",
        }),
        createSystemTmuxConsoleBroker: () => broker(),
      },
    );

    const profile = options.interactiveConsoleTargets?.["qemu-no-network"];
    expect(profile).toMatchObject({
      targetId: "qemu-no-network",
      egressDomains: [],
      vm: { kind: "qemu" },
    });
    expect(profile?.vm?.network).toBeUndefined();
  });

  it("parses task-shaped typed QEMU launch fields without opaque side-effect args", async () => {
    const config = {
      backend: { kind: "system-tmux", tmuxPath: "/usr/bin/tmux" },
      targets: [
        {
          kind: "qemu-local-vm",
          targetId: "qemu-startup",
          qemuBinary: "/usr/bin/qemu-system-x86_64",
          memoryMiB: 512,
          boot: { order: "cdrom" },
          display: { kind: "none" },
          nographic: true,
          serial: { kind: "telnet", bindHost: "localhost", port: 6665 },
          cwd: "/app",
          diskImages: [{ path: "/app/alpine.iso", access: "read-only", role: "cdrom" }],
        },
      ],
    };

    const options = await interactiveConsoleProductOptionsFromEnv(
      { [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify(config) },
      {
        launchPreparer: LAUNCH_PREPARER,
        probeSystemTmuxConsoleBroker: async () => ({
          available: true,
          backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
          tmuxPath: "/usr/bin/tmux",
          tmuxVersion: "tmux 3.4",
        }),
        createSystemTmuxConsoleBroker: () => broker(),
      },
    );

    expect(options.interactiveConsoleTargets?.["qemu-startup"]).toMatchObject({
      argv: [
        "/usr/bin/qemu-system-x86_64",
        "-m",
        "512",
        "-cdrom",
        "/app/alpine.iso",
        "-boot",
        "d",
        "-serial",
        "telnet:127.0.0.1:6665,server,nowait",
        "-display",
        "none",
        "-nographic",
      ],
      vm: {
        network: {
          localListeners: [
            {
              protocol: "tcp",
              bindHost: "127.0.0.1",
              port: 6665,
              purpose: "qemu serial telnet console",
            },
          ],
        },
      },
    });
  });

  it("normalizes broader typed QEMU launch fields from product config", async () => {
    const config = {
      backend: { kind: "system-tmux", tmuxPath: "/usr/bin/tmux" },
      targets: [
        {
          kind: "qemu-local-vm",
          targetId: "qemu-drive-none",
          qemuBinary: "/usr/bin/qemu-system-x86_64",
          cwd: "/workspace",
          serial: { kind: "none" },
          networkDevice: { kind: "user", id: "tbnet0", model: "virtio-net-pci" },
          diskImages: [
            {
              path: "/workspace/data.qcow2",
              access: "read-only",
              role: "drive",
              interface: "ide",
              format: "qcow2",
            },
          ],
          network: {
            hostForwards: [
              { protocol: "udp", bindHost: "localhost", hostPort: 2223, guestPort: 23 },
            ],
          },
        },
        {
          kind: "qemu-local-vm",
          targetId: "qemu-telnet-monitor",
          qemuBinary: "/usr/bin/qemu-system-x86_64",
          cwd: "/workspace",
          serial: { kind: "telnet", bindHost: "localhost", port: 7000, monitor: true },
          diskImages: [{ path: "/workspace/monitor.iso", access: "read-only", role: "cdrom" }],
        },
      ],
    };

    const options = await interactiveConsoleProductOptionsFromEnv(
      { [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify(config) },
      {
        launchPreparer: LAUNCH_PREPARER,
        probeSystemTmuxConsoleBroker: async () => ({
          available: true,
          backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
          tmuxPath: "/usr/bin/tmux",
          tmuxVersion: "tmux 3.4",
        }),
        createSystemTmuxConsoleBroker: () => broker(),
      },
    );

    expect(options.interactiveConsoleTargets?.["qemu-drive-none"]).toMatchObject({
      argv: [
        "/usr/bin/qemu-system-x86_64",
        "-drive",
        "file=/workspace/data.qcow2,if=ide,format=qcow2,readonly=on",
        "-netdev",
        "user,id=tbnet0,hostfwd=udp:127.0.0.1:2223-:23",
        "-device",
        "virtio-net-pci,netdev=tbnet0",
        "-serial",
        "none",
      ],
      vm: {
        diskImages: [
          {
            path: "/workspace/data.qcow2",
            access: "read-only",
            role: "drive",
            interface: "ide",
            format: "qcow2",
          },
        ],
        network: {
          hostForwards: [{ protocol: "udp", bindHost: "127.0.0.1", hostPort: 2223, guestPort: 23 }],
        },
      },
    });
    expect(options.interactiveConsoleTargets?.["qemu-telnet-monitor"]).toMatchObject({
      argv: [
        "/usr/bin/qemu-system-x86_64",
        "-cdrom",
        "/workspace/monitor.iso",
        "-serial",
        "mon:telnet:127.0.0.1:7000,server,nowait",
      ],
      vm: {
        network: {
          localListeners: [
            {
              protocol: "tcp",
              bindHost: "127.0.0.1",
              port: 7000,
              purpose: "qemu serial telnet console",
            },
          ],
        },
      },
    });
  });

  it("fails closed for unsupported backends and unsafe QEMU executable paths", async () => {
    await expect(
      interactiveConsoleProductOptionsFromEnv(
        {
          [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify({
            ...qemuConfig(),
            backend: { kind: "node-pty" },
          }),
        },
        { launchPreparer: LAUNCH_PREPARER },
      ),
    ).rejects.toThrow("unsupported interactive console backend");

    await expect(
      interactiveConsoleProductOptionsFromEnv(
        {
          [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify({
            ...qemuConfig(),
            targets: [{ ...qemuConfig().targets[0], qemuBinary: "./qemu-system-x86_64" }],
          }),
        },
        { launchPreparer: LAUNCH_PREPARER },
      ),
    ).rejects.toThrow("product QEMU binary must be an absolute executable path");

    await expect(
      interactiveConsoleProductOptionsFromEnv(
        {
          [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify({
            ...qemuConfig(),
            targets: [{ ...qemuConfig().targets[0], qemuBinary: "qemu-system-x86_64" }],
          }),
        },
        { launchPreparer: LAUNCH_PREPARER },
      ),
    ).rejects.toThrow("product QEMU binary must be an absolute executable path");

    await expect(
      interactiveConsoleProductOptionsFromEnv(
        {
          [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify({
            ...qemuConfig(),
            targets: [{ ...qemuConfig().targets[0], args: ["-no-reboot", "stdio\nnext"] }],
          }),
        },
        { launchPreparer: LAUNCH_PREPARER },
      ),
    ).rejects.toThrow("QEMU arg must not contain control characters");

    for (const args of [
      ["-drive", "file=/workspace/other.qcow2,if=virtio"],
      ["-netdev", "user,id=n0,hostfwd=tcp:127.0.0.1:2222-:22"],
      ["-device", "e1000,netdev=n0"],
      ["-serial", "tcp:127.0.0.1:4444,server=on"],
      ["-display", "vnc=:1"],
    ]) {
      await expect(
        interactiveConsoleProductOptionsFromEnv(
          {
            [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify({
              ...qemuConfig(),
              targets: [{ ...qemuConfig().targets[0], args }],
            }),
          },
          { launchPreparer: LAUNCH_PREPARER },
        ),
      ).rejects.toThrow(/side effects|opaque argv/u);
    }
  });

  it("fails closed for non-absolute or shell-shaped tmux paths", async () => {
    for (const tmuxPath of [
      "tmux",
      "./tmux",
      "/usr/bin/tmux -S x",
      "/usr/bin/tmux\nnext",
      "/usr/bin/tmux\u0000",
    ]) {
      await expect(
        interactiveConsoleProductOptionsFromEnv(
          {
            [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify({
              ...qemuConfig(),
              backend: { kind: "system-tmux", tmuxPath },
            }),
          },
          { launchPreparer: LAUNCH_PREPARER },
        ),
      ).rejects.toThrow("tmuxPath must be an absolute executable path without shell syntax");
    }
  });

  it("fails closed for non-absolute or control-shaped system-tmux private roots", async () => {
    for (const privateRoot of [
      "keel-console-tmux-fixed",
      "./keel-console-tmux-fixed",
      "/",
      "/workspace/keel-console-tmux-fixed",
      "/tmp/../tmp/keel-console-tmux-fixed",
      "/tmp/keel-console-tmux-",
      "/tmp/keel-console-tmux-fixed\nnext",
      "/tmp/keel-console-tmux-fixed\u0000",
    ]) {
      await expect(
        interactiveConsoleProductOptionsFromEnv(
          {
            [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify({
              ...qemuConfig(),
              backend: { kind: "system-tmux", tmuxPath: "/usr/bin/tmux", privateRoot },
            }),
          },
          { launchPreparer: LAUNCH_PREPARER },
        ),
      ).rejects.toThrow("tmux privateRoot must be a normalized /tmp/keel-console-tmux-* path");
    }
  });

  it("fails closed instead of resolving tmux through PATH that could prefer a workspace binary", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "keel-console-shadow-workspace-"));
    const shadowDir = join(workspace, "bin");
    mkdirSync(shadowDir);
    writeFileSync(join(shadowDir, "tmux"), "#!/bin/sh\nexit 99\n");

    await expect(
      interactiveConsoleProductOptionsFromEnv(
        {
          [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify({
            ...qemuConfig(),
            backend: { kind: "system-tmux" },
          }),
          KEEL_WARDEN_WORKSPACE_ROOT: workspace,
          PATH: shadowDir,
        },
        { launchPreparer: LAUNCH_PREPARER },
      ),
    ).rejects.toThrow("tmuxPath must be an absolute executable path without shell syntax");
  });

  it("fails closed for target ids the model-facing schema cannot open", async () => {
    await expect(
      interactiveConsoleProductOptionsFromEnv(
        {
          [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify({
            ...qemuConfig(),
            targets: [{ ...qemuConfig().targets[0], targetId: "bad target id" }],
          }),
        },
        { launchPreparer: LAUNCH_PREPARER },
      ),
    ).rejects.toThrow("invalid interactive console targetId");
  });

  it("fails closed for unsupported or duplicate product targets", async () => {
    await expect(
      interactiveConsoleProductOptionsFromEnv(
        {
          [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify({
            ...qemuConfig(),
            targets: [{ kind: "ssh-remote", targetId: "remote-1" }],
          }),
        },
        { launchPreparer: LAUNCH_PREPARER },
      ),
    ).rejects.toThrow("unsupported interactive console target kind");

    await expect(
      interactiveConsoleProductOptionsFromEnv(
        {
          [INTERACTIVE_CONSOLE_CONFIG_ENV]: JSON.stringify({
            ...qemuConfig(),
            targets: [qemuConfig().targets[0], qemuConfig().targets[0]],
          }),
        },
        { launchPreparer: LAUNCH_PREPARER },
      ),
    ).rejects.toThrow("duplicate interactive console target id");
  });
});
