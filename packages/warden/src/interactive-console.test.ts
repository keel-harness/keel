import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SIDE_EFFECT_TAXONOMY_VERSION, isRetryEligible, type WARDEN_METHODS } from "@keel/shared";
import {
  CONSOLE_TOOL_NAMES,
  ConsoleSandboxProfileError,
  consoleLifecycleProfileIssue,
  consoleReviewGrantKey,
  consoleTargetGrantReviewDecision,
  buildConsoleSandboxProfile,
  createConsoleRuntimeState,
  createPendingConsoleReview,
  buildConsoleOpaquePolicyInput,
  buildConsoleUnresolvedPolicyInput,
  effectiveConsoleLifecycleLimits,
  isInteractiveConsoleToolName,
  modelResultFromConsoleScreenFrame,
  parseConsoleToolCall,
  sanitizeConsoleScreenText,
  summarizeConsoleInputForAudit,
  createQemuConsoleTargetProfile,
  type ConsolePolicyTargetProfile,
} from "./interactive-console/index.js";

type ExecuteParams = ReturnType<(typeof WARDEN_METHODS)["warden.execute"]["params"]["parse"]>;

const baseParams: ExecuteParams = {
  sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  toolCall: {
    id: "tc_console",
    name: CONSOLE_TOOL_NAMES.open,
    args: { targetId: "qemu-alpine", rows: 24, cols: 80 },
  },
  provenanceContext: { inputTags: ["workspace"] },
};

const targetProfile = {
  targetId: "qemu-alpine",
  targetDigest: `sha256:${"a".repeat(64)}`,
  sandboxProfileId: "srt-workspace-deny-egress",
  command: "qemu-system-x86_64",
  cwd: "/workspace",
  filesystemScopes: ["workspace", "temp"] as const,
  egressDomains: [] as const,
};
const TEST_SANDBOX_PLAN_DIGEST = `sha256:${"9".repeat(64)}` as const;

function containsForbiddenControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (
      code !== undefined &&
      ((code <= 0x1f && code !== 0x0a) || code === 0x7f || (code >= 0x80 && code <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

describe("interactive console warden primitives", () => {
  it("parses only the four namespaced operations and rejects launch authority in model args", () => {
    expect(parseConsoleToolCall(baseParams.toolCall)).toMatchObject({
      kind: "open",
      args: { targetId: "qemu-alpine", rows: 24, cols: 80 },
    });

    expect(
      parseConsoleToolCall({
        id: "tc_console_send",
        name: CONSOLE_TOOL_NAMES.sendKeys,
        args: {
          handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          input: [
            { kind: "text", text: "root" },
            { kind: "key", key: "Enter" },
          ],
        },
      }),
    ).toMatchObject({ kind: "send_keys" });

    for (const forbidden of [
      { command: "qemu-system-x86_64" },
      { cwd: "/tmp" },
      { env: { TOKEN: "secret" } },
      { egressDomains: ["example.com"] },
    ]) {
      expect(() =>
        parseConsoleToolCall({
          id: "tc_console_bad",
          name: CONSOLE_TOOL_NAMES.open,
          args: { targetId: "qemu-alpine", ...forbidden },
        }),
      ).toThrow(/invalid interactive console/i);
    }

    expect(() =>
      parseConsoleToolCall({
        id: "tc_console_bad_key",
        name: CONSOLE_TOOL_NAMES.sendKeys,
        args: {
          handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          input: [{ kind: "text", text: "root\u001b[31m" }],
        },
      }),
    ).toThrow(/control bytes/i);

    expect(() =>
      parseConsoleToolCall({
        id: "tc_console_unknown",
        name: "interactive_console.spawn",
        args: {},
      }),
    ).toThrow(/unsupported interactive console/i);
  });

  it("parses read/release/close operations, default dimensions, and bounded key input", () => {
    expect(
      parseConsoleToolCall({
        id: "tc_console_open_defaults",
        name: CONSOLE_TOOL_NAMES.open,
        args: { targetId: "qemu-alpine" },
      }),
    ).toMatchObject({ kind: "open", args: { rows: 24, cols: 80 } });
    expect(
      parseConsoleToolCall({
        id: "tc_console_read",
        name: CONSOLE_TOOL_NAMES.readScreen,
        args: { handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      }),
    ).toMatchObject({ kind: "read_screen", args: { maxBytes: 16_384 } });
    expect(
      parseConsoleToolCall({
        id: "tc_console_close",
        name: CONSOLE_TOOL_NAMES.close,
        args: { handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "cleanup" },
      }),
    ).toMatchObject({ kind: "close", args: { reason: "cleanup" } });
    expect(
      parseConsoleToolCall({
        id: "tc_console_release",
        name: CONSOLE_TOOL_NAMES.release,
        args: { handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "external-grader" },
      }),
    ).toMatchObject({ kind: "release", args: { reason: "external-grader" } });

    for (const args of [
      { targetId: "-bad" },
      { targetId: "x".repeat(129) },
      { handle: "not-a-console-handle", input: [{ kind: "key", key: "Enter" }] },
      {
        handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        input: [{ kind: "text", text: "x".repeat(1025) }],
      },
      {
        handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        input: Array.from({ length: 5 }, () => ({ kind: "text", text: "x".repeat(900) })),
      },
    ]) {
      const name = "targetId" in args ? CONSOLE_TOOL_NAMES.open : CONSOLE_TOOL_NAMES.sendKeys;
      expect(() => parseConsoleToolCall({ id: "tc_console_bad_bounds", name, args })).toThrow(
        /invalid interactive console/i,
      );
    }

    const textOnly = summarizeConsoleInputForAudit([{ kind: "text", text: "abc" }]);
    const textOnlyAgain = summarizeConsoleInputForAudit([{ kind: "text", text: "abc" }]);
    const differentShape = summarizeConsoleInputForAudit([{ kind: "text", text: "abcd" }]);
    expect(textOnly.controlKeys).toEqual([]);
    expect(textOnly.shapeHash).toBe(textOnlyAgain.shapeHash);
    expect(textOnly.shapeHash).not.toBe(differentShape.shapeHash);
  });

  it("redacts and de-controls screen frames before building model-visible results", () => {
    const result = modelResultFromConsoleScreenFrame({
      handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      targetId: "qemu-alpine",
      seq: 7,
      screen: "\u001b[31mPassword:\u001b[0m sk-proj-12345678901234567890\u0007\n# ",
    });

    expect(result).toMatchObject({
      handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      targetId: "qemu-alpine",
      seq: 7,
    });
    expect(result.screen).toContain("Password:");
    expect(result.screen).toContain("[redacted:openai-key]");
    expect(JSON.stringify(result)).not.toContain("sk-proj-12345678901234567890");
    expect(JSON.stringify(result)).not.toContain("\u001b");
  });

  it("strips terminal escape variants, exact-redacts, caps bytes, and preserves truncation truth", () => {
    const noisy =
      "\u001b]8;;https://example.test\u0007linked\u001b]8;;\u001b\\ " +
      "\u001bPignored-private\u001b\\ " +
      "\u009b31mred " +
      "\u001bZvisible " +
      "filler ".repeat(40) +
      "short-secret";
    const sanitized = sanitizeConsoleScreenText(noisy, {
      exactRedactions: ["short-secret"],
      maxBytes: 96,
    });

    expect(sanitized).toContain("linked");
    expect(sanitized).toContain("[truncated:interactive-console-screen:");
    expect(Buffer.byteLength(sanitized, "utf8")).toBeLessThanOrEqual(96);
    expect(sanitized).not.toContain("https://example.test");
    expect(sanitized).not.toContain("ignored-private");
    expect(sanitized).not.toContain("short-secret");
    expect(sanitized).not.toContain("\u001b");

    const tiny = sanitizeConsoleScreenText(noisy, {
      exactRedactions: ["short-secret"],
      maxBytes: 20,
    });
    expect(Buffer.byteLength(tiny, "utf8")).toBeLessThanOrEqual(20);
    expect(tiny).not.toContain("\u001b");

    const result = modelResultFromConsoleScreenFrame(
      {
        handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        targetId: "qemu-alpine",
        seq: 8,
        screen: "x".repeat(50),
        truncated: true,
      },
      { maxBytes: 10 },
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.screen, "utf8")).toBeLessThanOrEqual(10);
    expect(() =>
      modelResultFromConsoleScreenFrame({
        handle: "bad-handle",
        targetId: "qemu-alpine",
        seq: 0,
        screen: "ok",
      }),
    ).toThrow();
  });

  it("builds least-privilege sandbox profiles for console targets", () => {
    const profile = buildConsoleSandboxProfile(
      { ...targetProfile, egressDomains: [] },
      {
        workspaceRoot: "/workspace",
        env: { HOME: "/home/alice", KEEL_HOME: "/keel" },
        auditDir: "/audit",
      },
    );

    expect(profile.network).toEqual({
      allowedDomains: [],
      deniedDomains: ["*"],
      strictAllowlist: true,
    });
    expect(profile.filesystem?.allowRead).toEqual(expect.arrayContaining(["/workspace"]));
    expect(profile.filesystem?.allowWrite).toEqual(expect.arrayContaining(["/workspace"]));
    expect(profile.filesystem?.denyRead).toEqual(
      expect.arrayContaining([
        "/home/alice/.ssh",
        "/home/alice/.aws",
        "/audit",
        "/keel",
        "/keel/policy",
        "/workspace/.env",
      ]),
    );
    expect(profile.filesystem?.denyWrite).toEqual(
      expect.arrayContaining(["/audit", "/keel", "/keel/policy"]),
    );

    const egressProfile = buildConsoleSandboxProfile(
      { ...targetProfile, egressDomains: ["console.example", "Example.COM"] },
      {
        workspaceRoot: "/workspace",
        env: { HOME: "/home/alice", KEEL_HOME: "/keel" },
        auditDir: "/audit",
      },
    );
    expect(egressProfile.network).toEqual({
      allowedDomains: ["console.example", "example.com"],
      deniedDomains: [],
      strictAllowlist: true,
    });

    expect(() =>
      buildConsoleSandboxProfile(
        { ...targetProfile, egressDomains: ["localhost"] },
        {
          workspaceRoot: "/workspace",
          env: { HOME: "/home/alice", KEEL_HOME: "/keel" },
          auditDir: "/audit",
        },
      ),
    ).toThrow(/localhost egress domain pattern is not allowed/u);
  });

  it("fails closed for console sandbox profiles outside workspace/temp containment", () => {
    expect(() =>
      buildConsoleSandboxProfile(
        { ...targetProfile, filesystemScopes: ["home"] },
        {
          workspaceRoot: "/workspace",
          env: { HOME: "/home/alice", KEEL_HOME: "/keel" },
          auditDir: "/audit",
        },
      ),
    ).toThrow(ConsoleSandboxProfileError);

    expect(() =>
      buildConsoleSandboxProfile(
        { ...targetProfile, cwd: "/etc" },
        {
          workspaceRoot: "/workspace",
          declaredTempRoots: ["/tmp/keel-console"],
          env: { HOME: "/home/alice", KEEL_HOME: "/keel" },
          auditDir: "/audit",
        },
      ),
    ).toThrow(/console target cwd must be inside workspace or declared temp roots/u);

    expect(
      buildConsoleSandboxProfile(
        { ...targetProfile, cwd: "/tmp/keel-console/qemu" },
        {
          workspaceRoot: "/workspace",
          declaredTempRoots: ["/tmp/keel-console"],
          env: { HOME: "/home/alice", KEEL_HOME: "/keel" },
          auditDir: "/audit",
        },
      ).filesystem?.allowRead,
    ).toEqual(expect.arrayContaining(["/tmp/keel-console"]));

    const tempOnly = buildConsoleSandboxProfile(
      { ...targetProfile, cwd: "/tmp/keel-console/qemu", filesystemScopes: ["temp"] },
      {
        workspaceRoot: "/workspace",
        declaredTempRoots: ["/tmp/keel-console"],
        env: { HOME: "/home/alice", KEEL_HOME: "/keel" },
        auditDir: "/audit",
      },
    );
    expect(tempOnly.filesystem?.allowRead).toEqual(["/tmp/keel-console"]);
    expect(tempOnly.filesystem?.allowWrite).toEqual(["/tmp/keel-console"]);

    expect(() =>
      buildConsoleSandboxProfile(
        { ...targetProfile, cwd: "relative" },
        {
          workspaceRoot: "/workspace",
          env: { HOME: "/home/alice", KEEL_HOME: "/keel" },
        },
      ),
    ).toThrow(/console target cwd must be absolute/u);

    expect(() =>
      buildConsoleSandboxProfile(
        { ...targetProfile, cwd: "/" },
        {
          workspaceRoot: "/",
          env: { HOME: "/home/alice", KEEL_HOME: "/keel" },
        },
      ),
    ).toThrow(/invalid console sandbox profile: workspace root must not be the filesystem root/u);
  });

  it("builds console sandbox profiles with default options when optional target fields are absent", () => {
    const minimalTarget: ConsolePolicyTargetProfile = {
      targetId: targetProfile.targetId,
      targetDigest: targetProfile.targetDigest,
      sandboxProfileId: targetProfile.sandboxProfileId,
      command: targetProfile.command,
      cwd: targetProfile.cwd,
    };
    const profile = buildConsoleSandboxProfile(minimalTarget, {
      workspaceRoot: "/workspace",
    });
    expect(profile.network).toEqual({
      allowedDomains: [],
      deniedDomains: ["*"],
      strictAllowlist: true,
    });
    expect(profile.filesystem?.allowRead).toEqual(expect.arrayContaining(["/workspace"]));
    expect(profile.filesystem?.allowWrite).toEqual(expect.arrayContaining(["/workspace"]));
  });

  it("builds an explicit local QEMU VM target profile without claiming guest governance", () => {
    const profile = createQemuConsoleTargetProfile({
      targetId: "qemu-alpine-ssh",
      qemuBinary: "qemu-system-x86_64",
      memoryMiB: 512,
      boot: { order: "cdrom" },
      display: { kind: "none" },
      nographic: true,
      serial: { kind: "stdio", monitor: true },
      args: ["-no-reboot"],
      cwd: "/workspace/vms",
      declaredTempRoots: ["/tmp/keel-qemu"],
      diskImages: [
        { path: "/workspace/vms/alpine.qcow2", access: "read-write", role: "hda" },
        { path: "/tmp/keel-qemu/cloud-init.iso", access: "read-only", role: "cdrom" },
      ],
      network: {
        hostForwards: [
          {
            protocol: "tcp",
            bindHost: "127.0.0.1",
            hostPort: 2222,
            guestPort: 22,
            purpose: "ssh",
          },
        ],
        localListeners: [
          {
            protocol: "tcp",
            bindHost: "127.0.0.1",
            port: 4444,
            purpose: "qemu-monitor",
          },
        ],
        guestDownloads: [
          { domain: "DL-CDN.AlpineLinux.org", purpose: "apk" },
          { domain: "example.com", purpose: "fixture" },
        ],
      },
      maxTtlMs: 60_000,
      idleTimeoutMs: 30_000,
      maxKeyTokens: 32,
      maxScreenFrames: 12,
      maxScreenBytes: 16_384,
    });

    expect(profile).toMatchObject({
      targetId: "qemu-alpine-ssh",
      sandboxProfileId: "srt-qemu-local-vm-deny-default-egress",
      command: "qemu-system-x86_64",
      argv: [
        "qemu-system-x86_64",
        "-m",
        "512",
        "-cdrom",
        "/tmp/keel-qemu/cloud-init.iso",
        "-hda",
        "/workspace/vms/alpine.qcow2",
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
      cwd: "/workspace/vms",
      declaredTempRoots: ["/tmp/keel-qemu"],
      filesystemScopes: ["workspace", "temp"],
      egressDomains: ["dl-cdn.alpinelinux.org", "example.com"],
      maxTtlMs: 60_000,
      idleTimeoutMs: 30_000,
      maxKeyTokens: 32,
      maxScreenFrames: 12,
      maxScreenBytes: 16_384,
      vm: {
        kind: "qemu",
        governanceBoundary: "host-qemu-process-governed_guest-os-ungoverned",
      },
    });
    expect(profile.targetDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(profile)).toContain("alpine.qcow2");
    expect(JSON.stringify(profile)).toContain("host-qemu-process-governed_guest-os-ungoverned");

    const same = createQemuConsoleTargetProfile({
      targetId: "qemu-alpine-ssh",
      qemuBinary: "qemu-system-x86_64",
      memoryMiB: 512,
      boot: { order: "cdrom" },
      display: { kind: "none" },
      nographic: true,
      serial: { kind: "stdio", monitor: true },
      args: ["-no-reboot"],
      cwd: "/workspace/vms",
      declaredTempRoots: ["/tmp/keel-qemu"],
      diskImages: [
        { path: "/workspace/vms/alpine.qcow2", access: "read-write", role: "hda" },
        { path: "/tmp/keel-qemu/cloud-init.iso", access: "read-only", role: "cdrom" },
      ],
      network: {
        guestDownloads: [
          { domain: "example.com", purpose: "fixture" },
          { domain: "dl-cdn.alpinelinux.org", purpose: "apk" },
        ],
        localListeners: [
          {
            protocol: "tcp",
            bindHost: "localhost",
            port: 4444,
            purpose: "qemu-monitor",
          },
        ],
        hostForwards: [
          {
            protocol: "tcp",
            bindHost: "localhost",
            hostPort: 2222,
            guestPort: 22,
            purpose: "ssh",
          },
        ],
      },
      maxTtlMs: 60_000,
      idleTimeoutMs: 30_000,
      maxKeyTokens: 32,
      maxScreenFrames: 12,
      maxScreenBytes: 16_384,
    });
    expect(same.targetDigest).toBe(profile.targetDigest);

    const differentArgv = createQemuConsoleTargetProfile({
      targetId: "qemu-alpine-ssh",
      qemuBinary: "qemu-system-x86_64",
      memoryMiB: 1024,
      cwd: "/workspace/vms",
      declaredTempRoots: ["/tmp/keel-qemu"],
      diskImages: [
        { path: "/workspace/vms/alpine.qcow2", access: "read-write", role: "hda" },
        { path: "/tmp/keel-qemu/cloud-init.iso", access: "read-only", role: "cdrom" },
      ],
      network: {
        guestDownloads: [
          { domain: "example.com", purpose: "fixture" },
          { domain: "dl-cdn.alpinelinux.org", purpose: "apk" },
        ],
        localListeners: [
          {
            protocol: "tcp",
            bindHost: "localhost",
            port: 4444,
            purpose: "qemu-monitor",
          },
        ],
        hostForwards: [
          {
            protocol: "tcp",
            bindHost: "localhost",
            hostPort: 2222,
            guestPort: 22,
            purpose: "ssh",
          },
        ],
      },
      maxTtlMs: 60_000,
      idleTimeoutMs: 30_000,
      maxKeyTokens: 32,
      maxScreenFrames: 12,
      maxScreenBytes: 16_384,
    });
    expect(differentArgv.targetDigest).not.toBe(profile.targetDigest);

    expect(() =>
      createQemuConsoleTargetProfile({
        targetId: "qemu-remote-listener",
        qemuBinary: "qemu-system-x86_64",
        cwd: "/workspace/vms",
        diskImages: [{ path: "/workspace/vms/alpine.qcow2", access: "read-write" }],
        network: {
          hostForwards: [{ protocol: "tcp", bindHost: "0.0.0.0", hostPort: 2222, guestPort: 22 }],
        },
      }),
    ).toThrow(/loopback/u);
  });

  it("generates side-effect-constrained QEMU argv for less common typed launch fields", () => {
    const profile = createQemuConsoleTargetProfile({
      targetId: "qemu-drive-roles",
      qemuBinary: "qemu-system-x86_64",
      cwd: "/workspace/vms",
      serial: { kind: "none" },
      networkDevice: { kind: "user", id: "tbnet0", model: "virtio-net-pci" },
      diskImages: [
        { path: "/workspace/vms/b.qcow2", access: "read-write", role: "hdb" },
        { path: "/workspace/vms/c.qcow2", access: "read-write", role: "hdc" },
        { path: "/workspace/vms/d.qcow2", access: "read-write", role: "hdd" },
        {
          path: "/workspace/vms/data.raw",
          access: "read-only",
          role: "drive",
          interface: "ide",
          format: "raw",
        },
      ],
      network: {
        hostForwards: [{ protocol: "udp", bindHost: "localhost", hostPort: 2200, guestPort: 22 }],
        guestDownloads: [{ domain: "Packages.Example", purpose: "fixture" }],
      },
      allowRelease: true,
    });

    expect(profile.argv).toContain("-hdb");
    expect(profile.argv).toContain("/workspace/vms/b.qcow2");
    expect(profile.argv).toContain("-hdc");
    expect(profile.argv).toContain("/workspace/vms/c.qcow2");
    expect(profile.argv).toContain("-hdd");
    expect(profile.argv).toContain("/workspace/vms/d.qcow2");
    expect(profile.argv).toContain("-drive");
    expect(profile.argv).toContain("file=/workspace/vms/data.raw,if=ide,format=raw,readonly=on");
    expect(profile.argv).toContain("user,id=tbnet0,hostfwd=udp:127.0.0.1:2200-:22");
    expect(profile.argv).toContain("virtio-net-pci,netdev=tbnet0");
    expect(profile.argv).toContain("-serial");
    expect(profile.argv).toContain("none");
    expect(profile).toMatchObject({
      allowRelease: true,
      egressDomains: ["packages.example"],
      vm: {
        network: {
          guestDownloads: [{ domain: "packages.example", purpose: "fixture" }],
        },
      },
    });

    const releaseDisabled = createQemuConsoleTargetProfile({
      targetId: "qemu-drive-roles",
      qemuBinary: "qemu-system-x86_64",
      cwd: "/workspace/vms",
      serial: { kind: "none" },
      networkDevice: { kind: "user", id: "tbnet0", model: "virtio-net-pci" },
      diskImages: [
        { path: "/workspace/vms/b.qcow2", access: "read-write", role: "hdb" },
        { path: "/workspace/vms/c.qcow2", access: "read-write", role: "hdc" },
        { path: "/workspace/vms/d.qcow2", access: "read-write", role: "hdd" },
        {
          path: "/workspace/vms/data.raw",
          access: "read-only",
          role: "drive",
          interface: "ide",
          format: "raw",
        },
      ],
      network: {
        hostForwards: [{ protocol: "udp", bindHost: "localhost", hostPort: 2200, guestPort: 22 }],
        guestDownloads: [{ domain: "Packages.Example", purpose: "fixture" }],
      },
    });
    expect(releaseDisabled.allowRelease).toBeUndefined();
    expect(releaseDisabled.targetDigest).not.toBe(profile.targetDigest);
  });

  it("generates monitored telnet serial argv and listener provenance from typed fields", () => {
    const profile = createQemuConsoleTargetProfile({
      targetId: "qemu-telnet-monitor",
      qemuBinary: "qemu-system-x86_64",
      cwd: "/workspace/vms",
      serial: { kind: "telnet", bindHost: "localhost", port: 7000, monitor: true },
      diskImages: [{ path: "/workspace/vms/monitor.qcow2", access: "read-only" }],
    });

    expect(profile.argv).toContain("mon:telnet:127.0.0.1:7000,server,nowait");
    expect(profile.vm?.network?.localListeners).toEqual([
      {
        protocol: "tcp",
        bindHost: "127.0.0.1",
        port: 7000,
        purpose: "qemu serial telnet console",
      },
    ]);
  });

  it("rejects unsafe QEMU target descriptors before policy materialization", () => {
    const validOptions: Parameters<typeof createQemuConsoleTargetProfile>[0] = {
      targetId: "qemu-invalid",
      qemuBinary: "qemu-system-x86_64",
      cwd: "/workspace/vms",
      diskImages: [{ path: "/workspace/vms/alpine.qcow2", access: "read-write" }],
    };

    const invalidCases: readonly [string, Record<string, unknown>, RegExp][] = [
      ["empty binary", { qemuBinary: "  " }, /binary is empty/u],
      ["control-byte binary", { qemuBinary: "qemu\nsystem" }, /control characters/u],
      ["shell-like binary", { qemuBinary: "qemu-system x86_64" }, /simple executable/u],
      ["relative path binary", { qemuBinary: "./qemu-system-x86_64" }, /simple executable/u],
      ["parent-relative binary", { qemuBinary: "../bin/qemu-system-x86_64" }, /simple executable/u],
      ["absolute shell-like binary", { qemuBinary: "/usr/local/bin/qemu system" }, /shell syntax/u],
      ["absolute metachar binary", { qemuBinary: "/usr/local/bin/qemu;rm" }, /shell syntax/u],
      ["arg with nul", { args: ["-no-reboot", "bad\u0000arg"] }, /arg must not contain NUL/u],
      ["arg with newline", { args: ["-no-reboot", "bad\narg"] }, /control characters/u],
      ["opaque drive arg", { args: ["-drive", "file=/workspace/other.qcow2"] }, /side effects/u],
      ["opaque netdev arg", { args: ["-netdev", "user,id=n0"] }, /side effects/u],
      ["opaque device arg", { args: ["-device", "e1000,netdev=n0"] }, /side effects/u],
      ["unsafe serial arg", { args: ["-serial", "tcp:127.0.0.1:4444"] }, /side effects/u],
      ["unsafe display arg", { args: ["-display", "vnc=:1"] }, /side effects/u],
      ["unsupported extra arg", { args: ["-m"] }, /not an approved side-effect-neutral/u],
      ["invalid memory", { memoryMiB: 0 }, /memoryMiB/u],
      ["invalid boot order", { boot: { order: "network" } }, /boot order/u],
      [
        "invalid disk role",
        {
          diskImages: [{ path: "/workspace/vms/alpine.qcow2", access: "read-write", role: "usb" }],
        },
        /disk role/u,
      ],
      [
        "invalid disk interface",
        {
          diskImages: [
            { path: "/workspace/vms/alpine.qcow2", access: "read-write", interface: "usb" },
          ],
        },
        /disk interface/u,
      ],
      [
        "invalid disk format",
        {
          diskImages: [
            { path: "/workspace/vms/alpine.qcow2", access: "read-write", format: "vhd" },
          ],
        },
        /disk format/u,
      ],
      [
        "cdrom must be read-only",
        {
          diskImages: [{ path: "/workspace/vms/alpine.iso", access: "read-write", role: "cdrom" }],
        },
        /cdrom.*read-only/u,
      ],
      [
        "hda must be read-write",
        {
          diskImages: [{ path: "/workspace/vms/alpine.qcow2", access: "read-only", role: "hda" }],
        },
        /hda.*read-write/u,
      ],
      [
        "drive path rejects commas",
        {
          diskImages: [
            { path: "/workspace/vms/alpine,fixture.qcow2", access: "read-write", role: "drive" },
          ],
        },
        /path must not contain ','/u,
      ],
      [
        "unsafe qemu net id",
        { networkDevice: { kind: "user", id: "net 0" } },
        /network device id/u,
      ],
      [
        "unsafe qemu net model",
        { networkDevice: { kind: "user", model: "rtl8139" } },
        /network device model/u,
      ],
      [
        "serial telnet must be loopback",
        { serial: { kind: "telnet", bindHost: "0.0.0.0", port: 6665 } },
        /loopback/u,
      ],
      ["relative cwd", { cwd: "vms" }, /cwd must be absolute/u],
      ["missing disk", { diskImages: [] }, /at least one disk image/u],
      [
        "relative disk",
        { diskImages: [{ path: "alpine.qcow2", access: "read-write" }] },
        /disk image path must be absolute/u,
      ],
      [
        "invalid disk access",
        { diskImages: [{ path: "/workspace/vms/alpine.qcow2", access: "write" }] },
        /disk access is invalid/u,
      ],
      [
        "invalid host forward protocol",
        {
          network: {
            hostForwards: [
              { protocol: "icmp", bindHost: "127.0.0.1", hostPort: 2222, guestPort: 22 },
            ],
          },
        },
        /protocol is invalid/u,
      ],
      [
        "invalid host forward port",
        {
          network: {
            hostForwards: [{ protocol: "tcp", bindHost: "127.0.0.1", hostPort: 0, guestPort: 22 }],
          },
        },
        /hostPort must be an integer port/u,
      ],
      [
        "invalid guest forward port",
        {
          network: {
            hostForwards: [
              { protocol: "tcp", bindHost: "127.0.0.1", hostPort: 2222, guestPort: 70_000 },
            ],
          },
        },
        /guestPort must be an integer port/u,
      ],
      [
        "invalid local listener protocol",
        {
          network: {
            localListeners: [{ protocol: "icmp", bindHost: "127.0.0.1", port: 5901 }],
          },
        },
        /protocol is invalid/u,
      ],
      [
        "invalid listener port",
        {
          network: {
            localListeners: [{ protocol: "tcp", bindHost: "127.0.0.1", port: 70_000 }],
          },
        },
        /listener port must be an integer port/u,
      ],
      [
        "invalid guest download domain",
        { network: { guestDownloads: [{ domain: "packages.example/path" }] } },
        /download domain is invalid/u,
      ],
    ];

    for (const [name, overrides, pattern] of invalidCases) {
      expect(
        () =>
          createQemuConsoleTargetProfile({
            ...validOptions,
            ...overrides,
          }),
        name,
      ).toThrow(pattern);
    }
  });

  it("keeps QEMU VM disk images explicit in policy and contained by workspace/temp sandbox roots", () => {
    const profile = createQemuConsoleTargetProfile({
      targetId: "qemu-startup",
      qemuBinary: "qemu-system-x86_64",
      cwd: "/workspace/vms",
      declaredTempRoots: ["/tmp/keel-qemu"],
      diskImages: [
        { path: "/workspace/vms/startup.qcow2", access: "read-write" },
        { path: "/tmp/keel-qemu/seed.iso", access: "read-only" },
      ],
    });

    const sandboxProfile = buildConsoleSandboxProfile(profile, {
      workspaceRoot: "/workspace",
      env: { HOME: "/home/alice", KEEL_HOME: "/keel" },
    });
    expect(sandboxProfile.filesystem?.allowRead).toEqual(
      expect.arrayContaining(["/workspace", "/tmp/keel-qemu"]),
    );
    expect(sandboxProfile.filesystem?.allowWrite).toEqual(
      expect.arrayContaining(["/workspace", "/tmp/keel-qemu"]),
    );

    const operation = parseConsoleToolCall({
      ...baseParams.toolCall,
      args: { targetId: profile.targetId },
    });
    const input = buildConsoleOpaquePolicyInput(
      {
        ...baseParams,
        toolCall: { ...baseParams.toolCall, args: { targetId: profile.targetId } },
      },
      operation,
      profile,
      { workspaceRoot: "/workspace", env: { USER: "tester" } },
    );
    expect(input.sideEffect.dynamic.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "path", normalized: "/workspace/vms/startup.qcow2" }),
        expect.objectContaining({ kind: "path", normalized: "/tmp/keel-qemu/seed.iso" }),
      ]),
    );
    expect(input.sideEffect.extensions?.["keel.interactiveConsole"]).toMatchObject({
      vm: {
        kind: "qemu",
        diskImages: [
          { path: "/tmp/keel-qemu/seed.iso", access: "read-only" },
          { path: "/workspace/vms/startup.qcow2", access: "read-write" },
        ],
        governanceBoundary: "host-qemu-process-governed_guest-os-ungoverned",
      },
    });

    const outsideProfile = createQemuConsoleTargetProfile({
      targetId: "qemu-outside-disk",
      qemuBinary: "qemu-system-x86_64",
      cwd: "/workspace/vms",
      diskImages: [{ path: "/var/lib/vm/outside.qcow2", access: "read-write" }],
    });
    expect(() =>
      buildConsoleSandboxProfile(outsideProfile, {
        workspaceRoot: "/workspace",
        env: { HOME: "/home/alice", KEEL_HOME: "/keel" },
      }),
    ).toThrow(/VM disk image .* workspace or declared temp roots/u);
  });

  it("represents QEMU host forwards, local listeners, and guest downloads as VM network semantics", () => {
    const profile = createQemuConsoleTargetProfile({
      targetId: "qemu-network",
      qemuBinary: "qemu-system-x86_64",
      cwd: "/workspace/vms",
      diskImages: [{ path: "/workspace/vms/network.qcow2", access: "read-write" }],
      network: {
        hostForwards: [{ protocol: "tcp", bindHost: "127.0.0.1", hostPort: 2222, guestPort: 22 }],
        localListeners: [{ protocol: "tcp", bindHost: "127.0.0.1", port: 5901 }],
        guestDownloads: [{ domain: "packages.example", purpose: "apk" }],
      },
    });
    const operation = parseConsoleToolCall({
      ...baseParams.toolCall,
      args: { targetId: profile.targetId },
    });
    const input = buildConsoleOpaquePolicyInput(
      {
        ...baseParams,
        toolCall: { ...baseParams.toolCall, args: { targetId: profile.targetId } },
      },
      operation,
      profile,
      { workspaceRoot: "/workspace", env: { USER: "tester" } },
    );

    expect(input.egress).toEqual({ isEgress: true, domain: "packages.example", gitRemote: null });
    expect(input.sideEffect.dynamic.effectKinds).toEqual(
      expect.arrayContaining(["network_read", "network_write"]),
    );
    expect(input.sideEffect.dynamic.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "host",
          normalized: "vm.hostForward:tcp:127.0.0.1:2222->guest:22",
        }),
        expect.objectContaining({
          kind: "host",
          normalized: "vm.localListener:tcp:127.0.0.1:5901",
        }),
        expect.objectContaining({
          kind: "host",
          normalized: "packages.example",
        }),
      ]),
    );
    expect(input.sideEffect.extensions?.["keel.interactiveConsole"]).toMatchObject({
      vm: {
        network: {
          hostForwards: [{ protocol: "tcp", bindHost: "127.0.0.1", hostPort: 2222, guestPort: 22 }],
          localListeners: [{ protocol: "tcp", bindHost: "127.0.0.1", port: 5901 }],
          guestDownloads: [{ domain: "packages.example", purpose: "apk" }],
        },
      },
    });
  });

  it("derives a telnet-ready QEMU startup argv from typed local-listener fields", () => {
    const profile = createQemuConsoleTargetProfile({
      targetId: "qemu-startup",
      qemuBinary: "qemu-system-x86_64",
      memoryMiB: 512,
      boot: { order: "cdrom" },
      display: { kind: "none" },
      nographic: true,
      serial: { kind: "telnet", bindHost: "localhost", port: 6665 },
      cwd: "/app",
      diskImages: [{ path: "/app/alpine.iso", access: "read-only", role: "cdrom" }],
      maxTtlMs: 900_000,
      maxKeyTokens: 256,
    });

    expect(profile.argv).toEqual([
      "qemu-system-x86_64",
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
    ]);
    expect(profile.vm?.network?.localListeners).toEqual([
      {
        protocol: "tcp",
        bindHost: "127.0.0.1",
        port: 6665,
        purpose: "qemu serial telnet console",
      },
    ]);

    const operation = parseConsoleToolCall({
      ...baseParams.toolCall,
      args: { targetId: profile.targetId },
    });
    const input = buildConsoleOpaquePolicyInput(
      {
        ...baseParams,
        toolCall: { ...baseParams.toolCall, args: { targetId: profile.targetId } },
      },
      operation,
      profile,
      { workspaceRoot: "/app", env: { USER: "tester" } },
    );
    expect(input.sideEffect.dynamic.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          normalized: "vm.localListener:tcp:127.0.0.1:6665",
        }),
      ]),
    );
  });

  it("fails closed on malformed QEMU VM metadata in policy inputs", () => {
    const operation = parseConsoleToolCall(baseParams.toolCall);
    const qemuArgv = [targetProfile.command];
    const validVm = {
      kind: "qemu",
      diskImages: [{ path: "/workspace/vms/alpine.qcow2", access: "read-write" }],
      launch: {
        argvDigest: `sha256:${createHash("sha256").update(JSON.stringify(qemuArgv)).digest("hex")}`,
      },
      governanceBoundary: "host-qemu-process-governed_guest-os-ungoverned",
    };
    const build = (vm: unknown) =>
      buildConsoleOpaquePolicyInput(
        baseParams,
        operation,
        { ...targetProfile, argv: qemuArgv, vm } as ConsolePolicyTargetProfile,
        { workspaceRoot: "/workspace", env: { USER: "tester" } },
      );

    const invalidCases: readonly [string, unknown, RegExp][] = [
      ["invalid kind", { ...validVm, kind: "virtualbox" }, /VM kind is invalid/u],
      ["invalid boundary", { ...validVm, governanceBoundary: "guest-governed" }, /boundary/u],
      ["missing disks", { ...validVm, diskImages: [] }, /at least one disk image/u],
      [
        "missing launch digest",
        { ...validVm, launch: undefined },
        /launch argv digest is missing/u,
      ],
      [
        "invalid launch digest",
        { ...validVm, launch: { argvDigest: "sha256:not-hex" } },
        /launch argv digest is missing or invalid/u,
      ],
      [
        "empty disk path",
        { ...validVm, diskImages: [{ path: " ", access: "read-write" }] },
        /disk image path is empty/u,
      ],
      [
        "relative disk path",
        { ...validVm, diskImages: [{ path: "vms/alpine.qcow2", access: "read-write" }] },
        /disk image path must be absolute/u,
      ],
      [
        "invalid disk access",
        { ...validVm, diskImages: [{ path: "/workspace/vms/alpine.qcow2", access: "write" }] },
        /disk access is invalid/u,
      ],
      [
        "remote host forward",
        {
          ...validVm,
          network: {
            hostForwards: [{ protocol: "tcp", bindHost: "0.0.0.0", hostPort: 2222, guestPort: 22 }],
          },
        },
        /loopback/u,
      ],
      [
        "invalid host forward protocol",
        {
          ...validVm,
          network: {
            hostForwards: [
              { protocol: "icmp", bindHost: "127.0.0.1", hostPort: 2222, guestPort: 22 },
            ],
          },
        },
        /protocol is invalid/u,
      ],
      [
        "invalid host forward port",
        {
          ...validVm,
          network: {
            hostForwards: [{ protocol: "tcp", bindHost: "127.0.0.1", hostPort: 0, guestPort: 22 }],
          },
        },
        /hostPort must be an integer port/u,
      ],
      [
        "invalid local listener protocol",
        {
          ...validVm,
          network: {
            localListeners: [{ protocol: "icmp", bindHost: "127.0.0.1", port: 5901 }],
          },
        },
        /protocol is invalid/u,
      ],
      [
        "invalid local listener port",
        {
          ...validVm,
          network: {
            localListeners: [{ protocol: "tcp", bindHost: "127.0.0.1", port: 65_536 }],
          },
        },
        /listener port must be an integer port/u,
      ],
      [
        "invalid guest download domain",
        {
          ...validVm,
          network: { guestDownloads: [{ domain: "packages.example/path" }] },
        },
        /egress domain is invalid/u,
      ],
    ];

    for (const [name, vm, pattern] of invalidCases) {
      expect(() => build(vm), name).toThrow(pattern);
    }
  });

  it("builds conservative console policy input without serializing raw keystrokes", () => {
    const operation = parseConsoleToolCall({
      id: "tc_console_send",
      name: CONSOLE_TOOL_NAMES.sendKeys,
      args: {
        handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        input: [
          { kind: "text", text: "hunter2" },
          { kind: "key", key: "Enter" },
        ],
      },
    });
    const input = buildConsoleOpaquePolicyInput(
      {
        ...baseParams,
        toolCall: {
          id: "tc_console_send",
          name: CONSOLE_TOOL_NAMES.sendKeys,
          args: { ignored: "raw args must not be trusted by the builder" },
        },
      },
      operation,
      targetProfile,
      { workspaceRoot: "/workspace", workspaceTrusted: true, env: { USER: "tester" } },
    );

    expect(input.sideEffect.taxonomyVersion).toBe(SIDE_EFFECT_TAXONOMY_VERSION);
    expect(input.sideEffect.staticCapability).toEqual({
      toolName: CONSOLE_TOOL_NAMES.sendKeys,
      effectEnvelope: ["fs_read", "fs_write", "process_exec", "unknown"],
      broad: true,
    });
    expect(input.sideEffect.dynamic.classifier).toMatchObject({
      confidence: "conservative",
    });
    expect(input.sideEffect.dynamic.classifier.reasons).toContain("interactive_console_send_keys");
    expect(input.sideEffect.dynamic.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "process",
          normalized: "console.handle:con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        }),
        expect.objectContaining({ kind: "command", value: "qemu-system-x86_64" }),
      ]),
    );
    expect(input.tool.args).toMatchObject({
      handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      inputSummary: {
        tokenCount: 2,
        textBytes: 7,
        controlKeys: ["Enter"],
      },
    });
    expect(String(input.tool.args["inputSummary"])).not.toContain("hunter2");
    expect(JSON.stringify(input)).not.toContain("hunter2");
    expect(isRetryEligible(input.sideEffect)).toBe(false);
  });

  it("fails closed when the parsed operation and resolved target disagree", () => {
    const operation = parseConsoleToolCall({
      id: "tc_console_open",
      name: CONSOLE_TOOL_NAMES.open,
      args: { targetId: "other-target" },
    });

    expect(() =>
      buildConsoleOpaquePolicyInput(baseParams, operation, targetProfile, {
        workspaceRoot: "/workspace",
        env: {},
      }),
    ).toThrow(/target mismatch/i);

    expect(() =>
      buildConsoleOpaquePolicyInput(
        {
          ...baseParams,
          toolCall: { ...baseParams.toolCall, name: CONSOLE_TOOL_NAMES.sendKeys },
        },
        operation,
        targetProfile,
        { workspaceRoot: "/workspace", env: {} },
      ),
    ).toThrow(/operation mismatch/i);
  });

  it("marks configured console egress as policy-visible host targets", () => {
    const operation = parseConsoleToolCall(baseParams.toolCall);
    const input = buildConsoleOpaquePolicyInput(
      baseParams,
      operation,
      { ...targetProfile, egressDomains: ["vm-console.example"] },
      { workspaceRoot: "/workspace", env: { USER: "tester" } },
    );

    expect(input.egress).toEqual({ isEgress: true, domain: "vm-console.example", gitRemote: null });
    expect(input.sideEffect.dynamic.effectKinds).toEqual(
      expect.arrayContaining(["network_read", "network_write"]),
    );
    expect(input.sideEffect.dynamic.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "host", normalized: "vm-console.example" }),
      ]),
    );
  });

  it("builds operation-specific policy inputs for read, release, and close", () => {
    const readOperation = parseConsoleToolCall({
      id: "tc_console_read",
      name: CONSOLE_TOOL_NAMES.readScreen,
      args: { handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV", maxBytes: 4096 },
    });
    const readInput = buildConsoleOpaquePolicyInput(
      {
        ...baseParams,
        toolCall: { id: "tc_console_read", name: CONSOLE_TOOL_NAMES.readScreen, args: {} },
      },
      readOperation,
      targetProfile,
      { workspaceRoot: "/workspace", env: {} },
    );
    expect(readInput.sideEffect.staticCapability).toEqual({
      toolName: CONSOLE_TOOL_NAMES.readScreen,
      effectEnvelope: ["unknown"],
      broad: true,
    });
    expect(readInput.sideEffect.dynamic.scopes).toEqual(["process"]);
    expect(readInput.tool.args).toEqual({
      handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      maxBytes: 4096,
    });
    expect(readInput.workspace.trusted).toBe(false);
    expect(readInput.principal.osUser).toBe("local");

    const releaseOperation = parseConsoleToolCall({
      id: "tc_console_release",
      name: CONSOLE_TOOL_NAMES.release,
      args: { handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "external-grader" },
    });
    const releaseInput = buildConsoleOpaquePolicyInput(
      {
        ...baseParams,
        toolCall: { id: "tc_console_release", name: CONSOLE_TOOL_NAMES.release, args: {} },
      },
      releaseOperation,
      { ...targetProfile, allowRelease: true },
      { workspaceRoot: "/workspace", env: { USER: "tester" } },
    );
    expect(releaseInput.sideEffect.staticCapability).toEqual({
      toolName: CONSOLE_TOOL_NAMES.release,
      effectEnvelope: ["process_exec", "unknown"],
      broad: true,
    });
    expect(releaseInput.sideEffect.dynamic.scopes).toEqual(["process", "unknown"]);
    expect(releaseInput.sideEffect.extensions?.["keel.interactiveConsole"]).toMatchObject({
      operation: "release",
      allowRelease: true,
      args: {
        handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        reason: "external-grader",
      },
    });

    const closeOperation = parseConsoleToolCall({
      id: "tc_console_close",
      name: CONSOLE_TOOL_NAMES.close,
      args: { handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "shutdown" },
    });
    const closeInput = buildConsoleOpaquePolicyInput(
      {
        ...baseParams,
        toolCall: { id: "tc_console_close", name: CONSOLE_TOOL_NAMES.close, args: {} },
      },
      closeOperation,
      targetProfile,
      { workspaceRoot: "/workspace", env: { USER: "tester" } },
    );
    expect(closeInput.sideEffect.staticCapability).toEqual({
      toolName: CONSOLE_TOOL_NAMES.close,
      effectEnvelope: ["process_exec"],
      broad: true,
    });
    expect(closeInput.sideEffect.dynamic.modifiers).toEqual([]);
    expect(closeInput.tool.args).toEqual({
      handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      reason: "shutdown",
    });
  });

  it("builds unresolved read, release, and close policy inputs without fabricating targets", () => {
    const readOperation = parseConsoleToolCall({
      id: "tc_console_read",
      name: CONSOLE_TOOL_NAMES.readScreen,
      args: { handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV", maxBytes: 2048 },
    });
    const readInput = buildConsoleUnresolvedPolicyInput(
      {
        ...baseParams,
        toolCall: { id: "tc_console_read", name: CONSOLE_TOOL_NAMES.readScreen, args: {} },
      },
      readOperation,
      { workspaceRoot: "/workspace", env: {} },
    );
    expect(readInput.sideEffect.dynamic.scopes).toEqual(["process"]);
    expect(readInput.sideEffect.dynamic.targets).toEqual([
      expect.objectContaining({
        kind: "process",
        normalized: "console.handle:con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }),
    ]);
    expect(readInput.tool.args).toEqual({
      handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      maxBytes: 2048,
    });

    const releaseOperation = parseConsoleToolCall({
      id: "tc_console_release",
      name: CONSOLE_TOOL_NAMES.release,
      args: { handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "external-grader" },
    });
    const releaseInput = buildConsoleUnresolvedPolicyInput(
      {
        ...baseParams,
        toolCall: { id: "tc_console_release", name: CONSOLE_TOOL_NAMES.release, args: {} },
      },
      releaseOperation,
      { workspaceRoot: "/workspace", env: {} },
    );
    expect(releaseInput.sideEffect.dynamic.scopes).toEqual(["process", "unknown"]);
    expect(releaseInput.tool.args).toEqual({
      handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      reason: "external-grader",
    });

    const closeOperation = parseConsoleToolCall({
      id: "tc_console_close",
      name: CONSOLE_TOOL_NAMES.close,
      args: { handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    });
    const closeInput = buildConsoleUnresolvedPolicyInput(
      {
        ...baseParams,
        toolCall: { id: "tc_console_close", name: CONSOLE_TOOL_NAMES.close, args: {} },
      },
      closeOperation,
      { workspaceRoot: "/workspace", env: {} },
    );
    expect(closeInput.sideEffect.dynamic.scopes).toEqual(["process"]);
    expect(closeInput.tool.args).toEqual({
      handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
  });

  it("fails closed when unresolved policy input sees an operation mismatch", () => {
    const operation = parseConsoleToolCall(baseParams.toolCall);

    expect(() =>
      buildConsoleUnresolvedPolicyInput(
        {
          ...baseParams,
          toolCall: { ...baseParams.toolCall, name: CONSOLE_TOOL_NAMES.close },
        },
        operation,
        { workspaceRoot: "/workspace", env: {} },
      ),
    ).toThrow(/operation mismatch/i);
  });

  it("fails closed for malformed resolved target profiles and normalizes egress domains", () => {
    const operation = parseConsoleToolCall(baseParams.toolCall);

    for (const badProfile of [
      { ...targetProfile, targetId: "" },
      { ...targetProfile, targetDigest: "sha256:not-hex" },
      { ...targetProfile, sandboxProfileId: "" },
      { ...targetProfile, command: "" },
      { ...targetProfile, cwd: "" },
      { ...targetProfile, cwd: "relative" },
      { ...targetProfile, egressDomains: [""] },
      { ...targetProfile, egressDomains: ["example.com/path"] },
    ]) {
      expect(() =>
        buildConsoleOpaquePolicyInput(baseParams, operation, badProfile, {
          workspaceRoot: "/workspace",
          env: {},
        }),
      ).toThrow(/console .* (empty|sha256|absolute|invalid)/i);
    }

    const input = buildConsoleOpaquePolicyInput(
      baseParams,
      operation,
      {
        ...targetProfile,
        egressDomains: [" B.example ", "a.example", "b.example"],
        filesystemScopes: ["home", "system"],
      },
      { workspaceRoot: "/workspace", env: {} },
    );
    expect(input.egress).toEqual({ isEgress: true, domain: null, gitRemote: null });
    expect(input.sideEffect.dynamic.scopes).toEqual(
      expect.arrayContaining(["home", "system", "network", "external_service"]),
    );
    expect(JSON.stringify(input.sideEffect.extensions)).toContain("a.example");
    expect(JSON.stringify(input.sideEffect.extensions)).toContain("b.example");
  });

  it("derives, validates, and exposes console lifecycle limits in policy input", () => {
    const defaults = effectiveConsoleLifecycleLimits({});
    expect(defaults.maxTtlMs).toBeGreaterThan(0);
    expect(defaults.idleTimeoutMs).toBeGreaterThan(0);
    expect(defaults.maxKeyTokens).toBeGreaterThan(0);
    expect(defaults.maxScreenFrames).toBeGreaterThan(0);
    expect(defaults.maxScreenBytes).toBeGreaterThan(0);
    expect(
      effectiveConsoleLifecycleLimits({
        maxTtlMs: 0,
        idleTimeoutMs: 1,
        maxKeyTokens: 2,
        maxScreenFrames: 3,
        maxScreenBytes: 4,
      }),
    ).toEqual({
      maxTtlMs: 0,
      idleTimeoutMs: 1,
      maxKeyTokens: 2,
      maxScreenFrames: 3,
      maxScreenBytes: 4,
    });
    expect(consoleLifecycleProfileIssue({ maxScreenBytes: -1 })).toMatch(/maxScreenBytes/);

    const operation = parseConsoleToolCall(baseParams.toolCall);
    const input = buildConsoleOpaquePolicyInput(
      baseParams,
      operation,
      {
        ...targetProfile,
        maxTtlMs: 10,
        idleTimeoutMs: 20,
        maxKeyTokens: 30,
        maxScreenFrames: 40,
        maxScreenBytes: 50,
      },
      { workspaceRoot: "/workspace", env: {} },
    );
    expect(input.sideEffect.extensions?.["keel.interactiveConsole"]).toMatchObject({
      lifecycleLimits: {
        maxTtlMs: 10,
        idleTimeoutMs: 20,
        maxKeyTokens: 30,
        maxScreenFrames: 40,
        maxScreenBytes: 50,
      },
    });
    expect(() =>
      buildConsoleOpaquePolicyInput(
        baseParams,
        operation,
        { ...targetProfile, maxKeyTokens: 1.5 },
        { workspaceRoot: "/workspace", env: {} },
      ),
    ).toThrow(/maxKeyTokens/);
  });

  it("recognizes only interactive console tool names", () => {
    expect(isInteractiveConsoleToolName(CONSOLE_TOOL_NAMES.open)).toBe(true);
    expect(isInteractiveConsoleToolName(CONSOLE_TOOL_NAMES.sendKeys)).toBe(true);
    expect(isInteractiveConsoleToolName(CONSOLE_TOOL_NAMES.readScreen)).toBe(true);
    expect(isInteractiveConsoleToolName(CONSOLE_TOOL_NAMES.release)).toBe(true);
    expect(isInteractiveConsoleToolName(CONSOLE_TOOL_NAMES.close)).toBe(true);
    expect(isInteractiveConsoleToolName("bash")).toBe(false);
  });

  it("mints console review grants only for exact open operations", () => {
    const openOperation = parseConsoleToolCall(baseParams.toolCall);
    const openInput = buildConsoleOpaquePolicyInput(baseParams, openOperation, targetProfile, {
      workspaceRoot: "/workspace",
      env: {},
    });
    const decision = consoleTargetGrantReviewDecision(
      { verdict: "review", matchedRules: ["ZZZ", "AAA", "AAA"], guidance: "review" },
      targetProfile.targetId,
    );

    expect(decision.matchedRules).toEqual(["AAA", "CONSOLE-TARGET-GRANT-REQUIRED", "ZZZ"]);
    const grantKey = consoleReviewGrantKey(
      {
        workspaceRoot: "/workspace",
        policyPack: { name: "test-pack", hash: `sha256:${"f".repeat(64)}` },
        sandboxPlanDigest: TEST_SANDBOX_PLAN_DIGEST,
      },
      openOperation,
      targetProfile,
      openInput,
      decision,
    );
    expect(grantKey).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const sendOperation = parseConsoleToolCall({
      id: "tc_console_send",
      name: CONSOLE_TOOL_NAMES.sendKeys,
      args: {
        handle: "con_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        input: [{ kind: "key", key: "Enter" }],
      },
    });
    const sendInput = buildConsoleOpaquePolicyInput(
      {
        ...baseParams,
        toolCall: { id: "tc_console_send", name: CONSOLE_TOOL_NAMES.sendKeys, args: {} },
      },
      sendOperation,
      targetProfile,
      { workspaceRoot: "/workspace", env: {} },
    );
    expect(() =>
      consoleReviewGrantKey(
        {
          workspaceRoot: "/workspace",
          policyPack: { name: "test-pack", hash: `sha256:${"f".repeat(64)}` },
          sandboxPlanDigest: TEST_SANDBOX_PLAN_DIGEST,
        },
        sendOperation,
        targetProfile,
        sendInput,
        decision,
      ),
    ).toThrow(/only be minted for open/i);
  });

  it("binds console review grants to open geometry and the resolved target profile", () => {
    const decision = consoleTargetGrantReviewDecision(
      { verdict: "review", matchedRules: ["CONSOLE"], guidance: "review" },
      targetProfile.targetId,
    );
    const context = {
      workspaceRoot: "/workspace",
      policyPack: { name: "test-pack", hash: `sha256:${"f".repeat(64)}` },
      sandboxPlanDigest: TEST_SANDBOX_PLAN_DIGEST,
    };
    const keyFor = (
      params: ExecuteParams,
      profile: ConsolePolicyTargetProfile,
    ): `sha256:${string}` => {
      const operation = parseConsoleToolCall(params.toolCall);
      const input = buildConsoleOpaquePolicyInput(params, operation, profile, {
        workspaceRoot: "/workspace",
        env: {},
      });
      return consoleReviewGrantKey(context, operation, profile, input, decision);
    };

    const baseline = keyFor(baseParams, targetProfile);
    const differentRows = keyFor(
      {
        ...baseParams,
        toolCall: {
          ...baseParams.toolCall,
          args: { targetId: "qemu-alpine", rows: 30, cols: 80 },
        },
      },
      targetProfile,
    );
    const egressProfile = {
      ...targetProfile,
      egressDomains: [" B.example ", "a.example"] as const,
    };
    const equivalentEgressProfile = {
      ...targetProfile,
      egressDomains: ["a.example", "b.example"] as const,
    };
    const broaderFilesystemProfile = {
      ...targetProfile,
      filesystemScopes: ["workspace", "temp", "home"] as const,
    };
    const differentCommandProfile = {
      ...targetProfile,
      command: "qemu-system-aarch64",
    };
    const differentBudgetProfile = {
      ...targetProfile,
      maxKeyTokens: 16,
    };

    expect(differentRows).not.toBe(baseline);
    expect(keyFor(baseParams, egressProfile)).not.toBe(baseline);
    expect(keyFor(baseParams, equivalentEgressProfile)).toBe(keyFor(baseParams, egressProfile));
    expect(keyFor(baseParams, broaderFilesystemProfile)).not.toBe(baseline);
    expect(keyFor(baseParams, differentCommandProfile)).not.toBe(baseline);
    expect(keyFor(baseParams, differentBudgetProfile)).not.toBe(baseline);
    expect(
      consoleReviewGrantKey(
        {
          ...context,
          sandboxPlanDigest: `sha256:${"8".repeat(64)}`,
        },
        parseConsoleToolCall(baseParams.toolCall),
        targetProfile,
        buildConsoleOpaquePolicyInput(
          baseParams,
          parseConsoleToolCall(baseParams.toolCall),
          targetProfile,
          {
            workspaceRoot: "/workspace",
            env: {},
          },
        ),
        decision,
      ),
    ).not.toBe(baseline);
  });

  it("mints stable console review grants when optional target profile fields are absent", () => {
    const operation = parseConsoleToolCall(baseParams.toolCall);
    const profileWithoutOptionals: ConsolePolicyTargetProfile = {
      targetId: "qemu-alpine",
      targetDigest: `sha256:${"a".repeat(64)}`,
      sandboxProfileId: "srt-workspace-deny-egress",
      command: "qemu-system-x86_64",
      cwd: "/workspace",
    };
    const input = buildConsoleOpaquePolicyInput(baseParams, operation, profileWithoutOptionals, {
      workspaceRoot: "/workspace",
      env: {},
    });
    const sparseTargetInput = {
      ...input,
      sideEffect: {
        ...input.sideEffect,
        dynamic: {
          ...input.sideEffect.dynamic,
          targets: [{ kind: "unknown" as const, value: "console.target:qemu-alpine" }],
        },
      },
    };
    const decision = consoleTargetGrantReviewDecision(
      { verdict: "review", matchedRules: ["CONSOLE"], guidance: "review" },
      profileWithoutOptionals.targetId,
    );

    expect(
      consoleReviewGrantKey(
        {
          workspaceRoot: "/workspace",
          policyPack: { name: "test-pack", hash: `sha256:${"f".repeat(64)}` },
          sandboxPlanDigest: TEST_SANDBOX_PLAN_DIGEST,
        },
        operation,
        profileWithoutOptionals,
        sparseTargetInput,
        decision,
      ),
    ).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("sanitizes pending console review text before it becomes human-visible approval state", () => {
    const state = createConsoleRuntimeState();
    const noisyTarget = `qemu\nalpine\u0000${"x".repeat(220)}`;
    const review = createPendingConsoleReview(state, {
      targetId: noisyTarget,
      targetDigest: `sha256:${"a".repeat(64)}`,
      grantKey: `sha256:${"b".repeat(64)}`,
      executeParams: baseParams,
    });

    expect(review.reviewId).toBe("console_review_1");
    expect(state.nextReviewSeq).toBe(2);
    expect(state.pendingReviews.get("console_review_1")).toBe(review);
    expect(review.summary).not.toContain("\n");
    expect(review.allowCommand).not.toContain("\u0000");
    expect(review.allowCommand).toContain("...");
    expect(review.allowCommand).toContain("--scope once");
  });

  it("keeps sanitized screen output JSON-safe under arbitrary terminal bytes", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const sanitized = sanitizeConsoleScreenText(raw, { maxBytes: 512 });
        expect(containsForbiddenControl(sanitized)).toBe(false);
        expect(sanitized).not.toContain("\u001b");
        const encoded = JSON.stringify({ sanitized });
        expect(() => {
          JSON.parse(encoded);
        }).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });
});
