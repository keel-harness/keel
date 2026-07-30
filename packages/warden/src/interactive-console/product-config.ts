import { Buffer } from "node:buffer";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { ConsoleBrokerPort } from "./broker.js";
import { parseHeadlessConsoleGrantEnvelope, type HeadlessConsoleGrantEnvelopeT } from "./grants.js";
import type {
  ConsoleVmDiskImage,
  ConsolePolicyTargetProfile,
  ConsoleVmGuestDownload,
  ConsoleVmHostForward,
  ConsoleVmLocalListener,
  ConsoleVmNetworkProfile,
} from "./policy.js";
import {
  createQemuConsoleTargetProfile,
  type QemuConsoleTargetProfileOptions,
  type QemuNetworkDeviceConfig,
  type QemuSerialConfig,
} from "./qemu-target.js";
import { ConsoleTargetId } from "./schema.js";
import {
  createSystemTmuxConsoleBroker,
  probeSystemTmuxConsoleBroker,
  type ConsoleSandboxLaunchPreparer,
  type ProbeSystemTmuxConsoleBrokerOptions,
  type SystemTmuxConsoleBrokerOptions,
  type SystemTmuxConsoleBrokerStatus,
} from "./tmux-broker.js";

export const INTERACTIVE_CONSOLE_CONFIG_ENV = "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG";
export const INTERACTIVE_CONSOLE_CONFIG_B64_ENV = "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64";
export const INTERACTIVE_CONSOLE_GRANT_B64_ENV = "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64";

const BROKER_ENV_ALLOWLIST = new Set([
  "HOME",
  "LANG",
  "LOGNAME",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
]);

const DiskImageConfig = z
  .object({
    path: z.string().min(1),
    access: z.enum(["read-only", "read-write"]),
    role: z.enum(["cdrom", "hda", "hdb", "hdc", "hdd", "drive"]).optional(),
    interface: z.enum(["ide", "virtio"]).optional(),
    format: z.enum(["qcow2", "raw"]).optional(),
  })
  .strict();

const QemuBootConfig = z.object({ order: z.enum(["cdrom", "disk"]) }).strict();

const QemuDisplayConfig = z.object({ kind: z.literal("none") }).strict();

const QemuSerialConfig = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stdio"), monitor: z.boolean().optional() }).strict(),
  z
    .object({
      kind: z.literal("telnet"),
      bindHost: z.string().min(1),
      port: z.number().int(),
      monitor: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);

const QemuNetworkDeviceConfig = z
  .object({
    kind: z.literal("user"),
    id: z.string().min(1).optional(),
    model: z.enum(["e1000", "virtio-net-pci"]).optional(),
  })
  .strict();

const HostForwardConfig = z
  .object({
    protocol: z.enum(["tcp", "udp"]),
    bindHost: z.string().min(1),
    hostPort: z.number().int(),
    guestPort: z.number().int(),
    purpose: z.string().optional(),
  })
  .strict();

const LocalListenerConfig = z
  .object({
    protocol: z.enum(["tcp", "udp"]),
    bindHost: z.string().min(1),
    port: z.number().int(),
    purpose: z.string().optional(),
  })
  .strict();

const GuestDownloadConfig = z
  .object({
    domain: z.string().min(1),
    purpose: z.string().optional(),
  })
  .strict();

const NetworkConfig = z
  .object({
    hostForwards: z.array(HostForwardConfig).optional(),
    localListeners: z.array(LocalListenerConfig).optional(),
    guestDownloads: z.array(GuestDownloadConfig).optional(),
  })
  .strict();

const QemuTargetConfig = z
  .object({
    kind: z.literal("qemu-local-vm"),
    targetId: z.string().min(1),
    qemuBinary: z.string().min(1),
    memoryMiB: z.number().int().optional(),
    boot: QemuBootConfig.optional(),
    display: QemuDisplayConfig.optional(),
    nographic: z.boolean().optional(),
    serial: QemuSerialConfig.optional(),
    networkDevice: QemuNetworkDeviceConfig.optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1),
    declaredTempRoots: z.array(z.string().min(1)).optional(),
    diskImages: z.array(DiskImageConfig).min(1),
    network: NetworkConfig.optional(),
    allowRelease: z.boolean().optional(),
    maxTtlMs: z.number().int().positive().optional(),
    idleTimeoutMs: z.number().int().positive().optional(),
    maxKeyTokens: z.number().int().positive().optional(),
    maxScreenFrames: z.number().int().positive().optional(),
    maxScreenBytes: z.number().int().positive().optional(),
  })
  .strict();

const ProductConfig = z
  .object({
    backend: z
      .object({
        kind: z.string().min(1),
        tmuxPath: z.string().min(1).optional(),
        privateRoot: z.string().min(1).optional(),
      })
      .strict(),
    targets: z.array(z.unknown()).min(1),
  })
  .strict();

type ProductConfigT = z.infer<typeof ProductConfig>;

export interface InteractiveConsoleProductOptions {
  readonly interactiveConsoleTargets?: Readonly<Record<string, ConsolePolicyTargetProfile>>;
  readonly interactiveConsoleBroker?: ConsoleBrokerPort;
  readonly interactiveConsoleHeadlessGrants?: readonly HeadlessConsoleGrantEnvelopeT[];
}

export interface InteractiveConsoleProductOptionsDependencies {
  readonly launchPreparer?: ConsoleSandboxLaunchPreparer;
  readonly probeSystemTmuxConsoleBroker?: (
    options: ProbeSystemTmuxConsoleBrokerOptions,
  ) => Promise<SystemTmuxConsoleBrokerStatus>;
  readonly createSystemTmuxConsoleBroker?: (
    options: SystemTmuxConsoleBrokerOptions,
  ) => ConsoleBrokerPort;
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function decodeStrictBase64Env(value: string, label: string): string {
  const validBase64Shape = /^[A-Za-z0-9+/]*={0,2}$/u.test(value) && value.length % 4 !== 1;
  if (!validBase64Shape) throw new Error(`invalid ${label} encoding`);
  const decoded = Buffer.from(value, "base64");
  const input = value.replace(/=+$/u, "");
  const recoded = decoded.toString("base64").replace(/=+$/u, "");
  if (input !== recoded) throw new Error(`invalid ${label} encoding`);
  return decoded.toString("utf8");
}

function decodeConfig(env: NodeJS.ProcessEnv): string | undefined {
  const raw = nonEmptyEnv(env[INTERACTIVE_CONSOLE_CONFIG_ENV]);
  const encoded = nonEmptyEnv(env[INTERACTIVE_CONSOLE_CONFIG_B64_ENV]);
  if (raw !== undefined && encoded !== undefined) {
    throw new Error("set only one interactive console config env var");
  }
  if (raw !== undefined) return raw;
  if (encoded === undefined) return undefined;
  return decodeStrictBase64Env(encoded, "interactive console product config");
}

function parseProductConfig(env: NodeJS.ProcessEnv): ProductConfigT | undefined {
  const text = decodeConfig(env);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid interactive console product config: ${message}`);
  }
  return ProductConfig.parse(parsed);
}

function parseHeadlessGrantEnv(env: NodeJS.ProcessEnv): HeadlessConsoleGrantEnvelopeT | undefined {
  const encoded = nonEmptyEnv(env[INTERACTIVE_CONSOLE_GRANT_B64_ENV]);
  if (encoded === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeStrictBase64Env(encoded, "interactive console grant"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid interactive console grant: ${message}`);
  }
  const grant = parseHeadlessConsoleGrantEnvelope(parsed);
  if (grant.source !== "parent-reviewed-benchmark-env") {
    throw new Error("parent-env console grant source must be parent-reviewed-benchmark-env");
  }
  return grant;
}

function parseQemuTarget(value: unknown): QemuConsoleTargetProfileOptions {
  const object = value as Record<string, unknown>;
  if (object["kind"] !== "qemu-local-vm") {
    throw new Error("unsupported interactive console target kind");
  }
  const parsed = QemuTargetConfig.parse(value);
  const targetId = ConsoleTargetId.safeParse(parsed.targetId);
  if (!targetId.success) throw new Error("invalid interactive console targetId");
  if (!isAbsolute(parsed.qemuBinary)) {
    throw new Error("product QEMU binary must be an absolute executable path");
  }
  return {
    targetId: targetId.data,
    qemuBinary: parsed.qemuBinary,
    ...(parsed.memoryMiB === undefined ? {} : { memoryMiB: parsed.memoryMiB }),
    ...(parsed.boot === undefined ? {} : { boot: parsed.boot }),
    ...(parsed.display === undefined ? {} : { display: parsed.display }),
    ...(parsed.nographic === undefined ? {} : { nographic: parsed.nographic }),
    ...(parsed.serial === undefined ? {} : { serial: normalizeQemuSerialConfig(parsed.serial) }),
    ...(parsed.networkDevice === undefined
      ? {}
      : { networkDevice: normalizeQemuNetworkDeviceConfig(parsed.networkDevice) }),
    ...(parsed.args === undefined ? {} : { args: parsed.args }),
    cwd: parsed.cwd,
    diskImages: parsed.diskImages.map(normalizeDiskImageConfig),
    ...(parsed.declaredTempRoots === undefined
      ? {}
      : { declaredTempRoots: parsed.declaredTempRoots }),
    ...(parsed.network === undefined ? {} : { network: normalizeNetworkConfig(parsed.network) }),
    ...(parsed.allowRelease === undefined ? {} : { allowRelease: parsed.allowRelease }),
    ...(parsed.maxTtlMs === undefined ? {} : { maxTtlMs: parsed.maxTtlMs }),
    ...(parsed.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: parsed.idleTimeoutMs }),
    ...(parsed.maxKeyTokens === undefined ? {} : { maxKeyTokens: parsed.maxKeyTokens }),
    ...(parsed.maxScreenFrames === undefined ? {} : { maxScreenFrames: parsed.maxScreenFrames }),
    ...(parsed.maxScreenBytes === undefined ? {} : { maxScreenBytes: parsed.maxScreenBytes }),
  };
}

function normalizeHostForwardConfig(
  forward: z.infer<typeof HostForwardConfig>,
): ConsoleVmHostForward {
  return {
    protocol: forward.protocol,
    bindHost: forward.bindHost,
    hostPort: forward.hostPort,
    guestPort: forward.guestPort,
    ...(forward.purpose === undefined ? {} : { purpose: forward.purpose }),
  };
}

function normalizeLocalListenerConfig(
  listener: z.infer<typeof LocalListenerConfig>,
): ConsoleVmLocalListener {
  return {
    protocol: listener.protocol,
    bindHost: listener.bindHost,
    port: listener.port,
    ...(listener.purpose === undefined ? {} : { purpose: listener.purpose }),
  };
}

function normalizeGuestDownloadConfig(
  download: z.infer<typeof GuestDownloadConfig>,
): ConsoleVmGuestDownload {
  return {
    domain: download.domain,
    ...(download.purpose === undefined ? {} : { purpose: download.purpose }),
  };
}

function normalizeDiskImageConfig(disk: z.infer<typeof DiskImageConfig>): ConsoleVmDiskImage {
  return {
    path: disk.path,
    access: disk.access,
    ...(disk.role === undefined ? {} : { role: disk.role }),
    ...(disk.interface === undefined ? {} : { interface: disk.interface }),
    ...(disk.format === undefined ? {} : { format: disk.format }),
  };
}

function normalizeQemuSerialConfig(serial: z.infer<typeof QemuSerialConfig>): QemuSerialConfig {
  switch (serial.kind) {
    case "stdio":
      return {
        kind: "stdio",
        ...(serial.monitor === undefined ? {} : { monitor: serial.monitor }),
      };
    case "telnet":
      return {
        kind: "telnet",
        bindHost: serial.bindHost,
        port: serial.port,
        ...(serial.monitor === undefined ? {} : { monitor: serial.monitor }),
      };
    case "none":
      return { kind: "none" };
  }
}

function normalizeQemuNetworkDeviceConfig(
  device: z.infer<typeof QemuNetworkDeviceConfig>,
): QemuNetworkDeviceConfig {
  return {
    kind: "user",
    ...(device.id === undefined ? {} : { id: device.id }),
    ...(device.model === undefined ? {} : { model: device.model }),
  };
}

function normalizeNetworkConfig(network: z.infer<typeof NetworkConfig>): ConsoleVmNetworkProfile {
  return {
    ...(network.hostForwards === undefined
      ? {}
      : { hostForwards: network.hostForwards.map(normalizeHostForwardConfig) }),
    ...(network.localListeners === undefined
      ? {}
      : { localListeners: network.localListeners.map(normalizeLocalListenerConfig) }),
    ...(network.guestDownloads === undefined
      ? {}
      : { guestDownloads: network.guestDownloads.map(normalizeGuestDownloadConfig) }),
  };
}

function targetProfiles(
  config: ProductConfigT,
): Readonly<Record<string, ConsolePolicyTargetProfile>> {
  const profiles: Record<string, ConsolePolicyTargetProfile> = {};
  for (const rawTarget of config.targets) {
    const profile = createQemuConsoleTargetProfile(parseQemuTarget(rawTarget));
    if (profiles[profile.targetId] !== undefined) {
      throw new Error(`duplicate interactive console target id: ${profile.targetId}`);
    }
    profiles[profile.targetId] = profile;
  }
  return profiles;
}

function brokerEnvFrom(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const brokerEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (name === "TMUX") continue;
    if (BROKER_ENV_ALLOWLIST.has(name) || name.startsWith("LC_")) {
      brokerEnv[name] = value;
    }
  }
  brokerEnv["TERM"] = brokerEnv["TERM"] ?? "xterm-256color";
  return brokerEnv;
}

function assertSystemTmuxPrivateRoot(privateRoot: string | undefined): string | undefined {
  if (privateRoot === undefined) return undefined;
  const normalized = resolve(privateRoot);
  const hasControlCharacter = [...privateRoot].some((char) => {
    const code = char.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
  if (
    !isAbsolute(privateRoot) ||
    normalized !== privateRoot ||
    hasControlCharacter ||
    !privateRoot.startsWith("/tmp/keel-console-tmux-") ||
    privateRoot === "/tmp/keel-console-tmux-"
  ) {
    throw new Error(
      "tmux privateRoot must be a normalized /tmp/keel-console-tmux-* path without control characters",
    );
  }
  return privateRoot;
}

function assertSystemTmuxBackend(config: ProductConfigT): {
  readonly tmuxPath: string;
  readonly privateRoot?: string;
} {
  if (config.backend.kind !== "system-tmux") {
    throw new Error(`unsupported interactive console backend: ${config.backend.kind}`);
  }
  const tmuxPath = config.backend.tmuxPath;
  if (
    tmuxPath === undefined ||
    !isAbsolute(tmuxPath) ||
    tmuxPath.includes("\u0000") ||
    /[\r\n\s"'`;|&<>$]/u.test(tmuxPath)
  ) {
    throw new Error("tmuxPath must be an absolute executable path without shell syntax");
  }
  const privateRoot = assertSystemTmuxPrivateRoot(config.backend.privateRoot);
  return privateRoot === undefined ? { tmuxPath } : { tmuxPath, privateRoot };
}

export async function interactiveConsoleProductOptionsFromEnv(
  env: NodeJS.ProcessEnv,
  dependencies: InteractiveConsoleProductOptionsDependencies = {},
): Promise<InteractiveConsoleProductOptions> {
  const config = parseProductConfig(env);
  const headlessGrant = parseHeadlessGrantEnv(env);
  const headlessGrantOptions =
    headlessGrant === undefined ? {} : { interactiveConsoleHeadlessGrants: [headlessGrant] };
  if (config === undefined) {
    if (headlessGrant !== undefined) {
      throw new Error("parent-env console grant requires interactive console product config");
    }
    return {};
  }
  if (dependencies.launchPreparer === undefined) {
    throw new Error("interactive console product config requires an enforcing SRT launch preparer");
  }
  const backend = assertSystemTmuxBackend(config);
  const targets = targetProfiles(config);
  const brokerEnv = brokerEnvFrom(env);
  const probe = dependencies.probeSystemTmuxConsoleBroker ?? probeSystemTmuxConsoleBroker;
  const tmuxStatus = await probe({ tmuxPath: backend.tmuxPath, env: brokerEnv });
  const createBroker = dependencies.createSystemTmuxConsoleBroker ?? createSystemTmuxConsoleBroker;
  const broker = createBroker({
    tmuxPath: tmuxStatus.tmuxPath ?? backend.tmuxPath,
    tmuxVersion: tmuxStatus.tmuxVersion ?? (tmuxStatus.available ? "unknown" : "unavailable"),
    tmuxStatus,
    launchPreparer: dependencies.launchPreparer,
    env: brokerEnv,
    ...(backend.privateRoot === undefined ? {} : { privateRoot: backend.privateRoot }),
  });
  return {
    interactiveConsoleTargets: targets,
    interactiveConsoleBroker: broker,
    ...headlessGrantOptions,
  };
}
