import { Buffer } from "node:buffer";
import { SessionId, type JsonObjectT } from "@keel/shared";
import {
  buildConsoleOpenGrantPolicyInput,
  buildConsoleSandboxPlanForTarget,
  createQemuConsoleTargetProfile,
  defaultPolicyPackRef,
  getDefaultPolicyPort,
  mintHeadlessConsoleOpenGrantEnvelope,
  prepareSystemTmuxConsoleSandboxPlan,
  type PolicyDecision,
  type QemuConsoleTargetProfileOptions,
} from "@keel/warden";

export interface TerminalBenchInteractiveConsoleConfigOptions {
  readonly tmuxPath: string;
  readonly qemuBinary: string;
  readonly workspaceRoot?: string;
  readonly home?: string;
  readonly keelHome?: string;
  readonly auditDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly tmuxPrivateRoot?: string;
  readonly maxTtlMs?: number;
  readonly maxKeyTokens?: number;
  readonly maxScreenFrames?: number;
  readonly maxScreenBytes?: number;
}

export interface TerminalBenchInteractiveConsoleGrantEnvOptions extends TerminalBenchInteractiveConsoleConfigOptions {
  readonly sessionId: string;
  readonly reviewedAt: string;
  readonly expiresAt: string;
  readonly rows?: number;
  readonly cols?: number;
  readonly principal?: JsonObjectT;
}

export interface TerminalBenchInteractiveConsoleGrantEnvBundle {
  readonly configB64: string;
  readonly grantB64: string;
  readonly sessionId: string;
  readonly home: string;
  readonly keelHome: string;
  readonly tmuxPrivateRoot: string;
  readonly eligibility: {
    readonly kind: "terminal-bench-qemu-singleton";
    readonly taskName: "qemu-startup" | "qemu-alpine-ssh";
  };
}

const QEMU_STARTUP_TASK = "qemu-startup";
const QEMU_ALPINE_SSH_TASK = "qemu-alpine-ssh";
const DEFAULT_TERMINAL_BENCH_HOME = "/logs/agent";
const DEFAULT_TERMINAL_BENCH_KEEL_HOME = "/logs/agent/keelhome";
const TERMINAL_BENCH_CONSOLE_STARTER_POLICY_REVIEW_RULES = ["POL-003", "POL-006"] as const;

function bareTaskName(taskName: string): string {
  const parts = taskName.split("/");
  return parts[parts.length - 1] ?? taskName;
}

function lifecycle(opts: TerminalBenchInteractiveConsoleConfigOptions): Record<string, number> {
  return {
    maxTtlMs: opts.maxTtlMs ?? 1_200_000,
    maxKeyTokens: opts.maxKeyTokens ?? 512,
    maxScreenFrames: opts.maxScreenFrames ?? 256,
    maxScreenBytes: opts.maxScreenBytes ?? 65_536,
  };
}

function qemuStartupTargetOptions(
  opts: TerminalBenchInteractiveConsoleConfigOptions,
): QemuConsoleTargetProfileOptions {
  const root = opts.workspaceRoot ?? "/app";
  return {
    targetId: QEMU_STARTUP_TASK,
    qemuBinary: opts.qemuBinary,
    memoryMiB: 1024,
    boot: { order: "cdrom" },
    display: { kind: "none" },
    nographic: true,
    serial: { kind: "telnet", bindHost: "127.0.0.1", port: 6665, monitor: true },
    cwd: root,
    diskImages: [
      { path: `${root}/alpine.iso`, access: "read-only", role: "cdrom" },
      {
        path: `${root}/alpine-disk.qcow2`,
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
          purpose: "ssh grading fixture",
        },
      ],
    },
    allowRelease: true,
    ...lifecycle(opts),
  };
}

function qemuAlpineSshTargetOptions(
  opts: TerminalBenchInteractiveConsoleConfigOptions,
): QemuConsoleTargetProfileOptions {
  const root = opts.workspaceRoot ?? "/app";
  return {
    targetId: QEMU_ALPINE_SSH_TASK,
    qemuBinary: opts.qemuBinary,
    memoryMiB: 512,
    boot: { order: "cdrom" },
    display: { kind: "none" },
    nographic: true,
    serial: { kind: "stdio", monitor: true },
    cwd: root,
    diskImages: [
      { path: `${root}/alpine.iso`, access: "read-only", role: "cdrom" },
      { path: `${root}/alpine-disk.qcow2`, access: "read-write", role: "hda" },
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
      guestDownloads: [{ domain: "dl-cdn.alpinelinux.org", purpose: "apk packages" }],
    },
    allowRelease: true,
    ...lifecycle(opts),
  };
}

function qemuTargetConfig(options: QemuConsoleTargetProfileOptions): Record<string, unknown> {
  return { kind: "qemu-local-vm", ...options };
}

function deterministicTmuxPrivateRoot(
  taskName: "qemu-startup" | "qemu-alpine-ssh",
  sessionId: string,
): string {
  return `/tmp/keel-console-tmux-${taskName}-${sessionId}`;
}

function auditDirForGrant(opts: TerminalBenchInteractiveConsoleGrantEnvOptions): string {
  return opts.auditDir ?? `${keelHomeForGrant(opts)}/audit`;
}

function keelHomeForGrant(opts: TerminalBenchInteractiveConsoleGrantEnvOptions): string {
  return opts.env?.["KEEL_HOME"] ?? opts.keelHome ?? DEFAULT_TERMINAL_BENCH_KEEL_HOME;
}

function homeForGrant(opts: TerminalBenchInteractiveConsoleGrantEnvOptions): string {
  return opts.env?.["HOME"] ?? opts.home ?? DEFAULT_TERMINAL_BENCH_HOME;
}

function runtimeEnvForGrant(
  opts: TerminalBenchInteractiveConsoleGrantEnvOptions,
): NodeJS.ProcessEnv {
  return {
    HOME: homeForGrant(opts),
    KEEL_HOME: keelHomeForGrant(opts),
    USER: "terminal-bench-agent",
    ...opts.env,
  };
}

export function terminalBenchInteractiveConsoleConfigForTasks(
  taskNames: readonly string[],
  opts: TerminalBenchInteractiveConsoleConfigOptions,
): string | undefined {
  const wanted = new Set(taskNames.map(bareTaskName));
  const targets: Array<Record<string, unknown>> = [];
  if (wanted.has(QEMU_STARTUP_TASK)) targets.push(qemuTargetConfig(qemuStartupTargetOptions(opts)));
  if (wanted.has(QEMU_ALPINE_SSH_TASK)) {
    targets.push(qemuTargetConfig(qemuAlpineSshTargetOptions(opts)));
  }
  if (targets.length === 0) return undefined;
  return JSON.stringify({
    backend: {
      kind: "system-tmux",
      tmuxPath: opts.tmuxPath,
      ...(opts.tmuxPrivateRoot === undefined ? {} : { privateRoot: opts.tmuxPrivateRoot }),
    },
    targets,
  });
}

export function terminalBenchInteractiveConsoleConfigB64ForTasks(
  taskNames: readonly string[],
  opts: TerminalBenchInteractiveConsoleConfigOptions,
): string | undefined {
  const config = terminalBenchInteractiveConsoleConfigForTasks(taskNames, opts);
  return config === undefined ? undefined : Buffer.from(config, "utf8").toString("base64");
}

function parentPrincipal(options: TerminalBenchInteractiveConsoleGrantEnvOptions): JsonObjectT {
  return (
    options.principal ?? {
      osUser: "terminal-bench-parent",
      configuredId: null,
      authProvider: "benchmark-parent",
      assurance: "parent-reviewed-benchmark-env",
    }
  );
}

export async function terminalBenchInteractiveConsoleGrantEnvForTask(
  taskName: string,
  opts: TerminalBenchInteractiveConsoleGrantEnvOptions,
): Promise<TerminalBenchInteractiveConsoleGrantEnvBundle | undefined> {
  const prepared = terminalBenchInteractiveConsoleGrantMaterialForTask(taskName, opts);
  if (prepared === undefined) return undefined;
  const policy = await getDefaultPolicyPort();
  const policyDecision = await policy.evaluate(prepared.policyInput);
  return terminalBenchInteractiveConsoleGrantBundleFromMaterial(
    prepared,
    policy.packRef,
    policyDecision,
  );
}

export function terminalBenchInteractiveConsoleGrantEnvForTaskSync(
  taskName: string,
  opts: TerminalBenchInteractiveConsoleGrantEnvOptions,
): TerminalBenchInteractiveConsoleGrantEnvBundle | undefined {
  const prepared = terminalBenchInteractiveConsoleGrantMaterialForTask(taskName, opts);
  if (prepared === undefined) return undefined;
  return terminalBenchInteractiveConsoleGrantBundleFromMaterial(
    prepared,
    defaultPolicyPackRef(),
    terminalBenchConsoleStarterPolicyDecision(),
  );
}

function terminalBenchConsoleStarterPolicyDecision(): PolicyDecision {
  return {
    verdict: "review",
    matchedRules: TERMINAL_BENCH_CONSOLE_STARTER_POLICY_REVIEW_RULES,
  };
}

function terminalBenchInteractiveConsoleGrantMaterialForTask(
  taskName: string,
  opts: TerminalBenchInteractiveConsoleGrantEnvOptions,
):
  | {
      readonly bare: "qemu-startup" | "qemu-alpine-ssh";
      readonly opts: TerminalBenchInteractiveConsoleGrantEnvOptions;
      readonly sessionId: string;
      readonly workspaceRoot: string;
      readonly home: string;
      readonly keelHome: string;
      readonly tmuxPrivateRoot: string;
      readonly profile: ReturnType<typeof createQemuConsoleTargetProfile>;
      readonly rows: number;
      readonly cols: number;
      readonly runtimeEnv: NodeJS.ProcessEnv;
      readonly sandboxPlan: ReturnType<typeof prepareSystemTmuxConsoleSandboxPlan>;
      readonly policyInput: ReturnType<typeof buildConsoleOpenGrantPolicyInput>;
    }
  | undefined {
  const bare = bareTaskName(taskName);
  if (bare !== QEMU_STARTUP_TASK && bare !== QEMU_ALPINE_SSH_TASK) return undefined;
  const sessionId = SessionId.parse(opts.sessionId);
  const tmuxPrivateRoot = opts.tmuxPrivateRoot ?? deterministicTmuxPrivateRoot(bare, sessionId);
  const targetOptions =
    bare === QEMU_STARTUP_TASK
      ? qemuStartupTargetOptions({ ...opts, tmuxPrivateRoot })
      : qemuAlpineSshTargetOptions({ ...opts, tmuxPrivateRoot });
  const workspaceRoot = opts.workspaceRoot ?? "/app";
  const home = homeForGrant(opts);
  const keelHome = keelHomeForGrant(opts);
  const runtimeEnv = runtimeEnvForGrant(opts);
  const profile = createQemuConsoleTargetProfile(targetOptions);
  const rows = opts.rows ?? 24;
  const cols = opts.cols ?? 80;
  const sandboxPlan = prepareSystemTmuxConsoleSandboxPlan(
    buildConsoleSandboxPlanForTarget(profile, {
      workspaceRoot,
      env: runtimeEnv,
      auditDir: auditDirForGrant(opts),
    }),
    tmuxPrivateRoot,
  );
  const policyInput = buildConsoleOpenGrantPolicyInput({
    sessionId,
    workspaceRoot,
    profile,
    rows,
    cols,
    env: runtimeEnv,
    workspaceTrusted: true,
  });
  return {
    bare,
    opts,
    sessionId,
    workspaceRoot,
    home,
    keelHome,
    tmuxPrivateRoot,
    profile,
    rows,
    cols,
    runtimeEnv,
    sandboxPlan,
    policyInput,
  };
}

function terminalBenchInteractiveConsoleGrantBundleFromMaterial(
  prepared: Exclude<
    ReturnType<typeof terminalBenchInteractiveConsoleGrantMaterialForTask>,
    undefined
  >,
  policyPack: ReturnType<typeof defaultPolicyPackRef>,
  policyDecision: PolicyDecision,
): TerminalBenchInteractiveConsoleGrantEnvBundle {
  const grant = mintHeadlessConsoleOpenGrantEnvelope({
    source: "parent-reviewed-benchmark-env",
    sessionId: prepared.sessionId,
    workspaceRoot: prepared.workspaceRoot,
    profile: prepared.profile,
    rows: prepared.rows,
    cols: prepared.cols,
    env: prepared.runtimeEnv,
    workspaceTrusted: true,
    policyPack,
    policyDecision,
    sandboxPlan: prepared.sandboxPlan,
    principal: parentPrincipal(prepared.opts),
    reviewedAt: prepared.opts.reviewedAt,
    expiresAt: prepared.opts.expiresAt,
  });
  const configB64 = terminalBenchInteractiveConsoleConfigB64ForTasks([prepared.bare], {
    ...prepared.opts,
    tmuxPrivateRoot: prepared.tmuxPrivateRoot,
  })!;
  return {
    configB64,
    grantB64: Buffer.from(JSON.stringify(grant), "utf8").toString("base64"),
    sessionId: prepared.sessionId,
    home: prepared.home,
    keelHome: prepared.keelHome,
    tmuxPrivateRoot: prepared.tmuxPrivateRoot,
    eligibility: {
      kind: "terminal-bench-qemu-singleton",
      taskName: prepared.bare,
    },
  };
}
