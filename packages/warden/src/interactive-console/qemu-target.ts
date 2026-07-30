import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { JsonObject, canonicalize } from "@keel/shared";
import {
  QEMU_GUEST_GOVERNANCE_BOUNDARY,
  type ConsolePolicyTargetProfile,
  type ConsoleVmDiskImage,
  type ConsoleVmGuestDownload,
  type ConsoleVmHostForward,
  type ConsoleVmLocalListener,
  type ConsoleVmNetworkProfile,
} from "./policy.js";
import type { ConsoleLifecycleProfile } from "./lifecycle.js";

export const QEMU_LOCAL_VM_SANDBOX_PROFILE_ID = "srt-qemu-local-vm-deny-default-egress";

const SIDE_EFFECT_QEMU_ARG_OPTIONS = new Set([
  "-blockdev",
  "-blockdev-add",
  "-cdrom",
  "-chardev",
  "-device",
  "-display",
  "-drive",
  "-gdb",
  "-hda",
  "-hdb",
  "-hdc",
  "-hdd",
  "-incoming",
  "-monitor",
  "-net",
  "-netdev",
  "-nic",
  "-qmp",
  "-redir",
  "-serial",
  "-spice",
  "-tftp",
  "-vnc",
]);

const SAFE_EXTRA_QEMU_ARGS = new Set(["-no-reboot", "-no-shutdown"]);
const QEMU_DISK_ROLES = new Set(["cdrom", "hda", "hdb", "hdc", "hdd", "drive"]);
const QEMU_DISK_INTERFACES = new Set(["ide", "virtio"]);
const QEMU_DISK_FORMATS = new Set(["qcow2", "raw"]);
const QEMU_BOOT_ORDERS = new Set(["cdrom", "disk"]);
const QEMU_NETWORK_DEVICE_MODELS = new Set(["e1000", "virtio-net-pci"]);
const QEMU_SAFE_ID_RE = /^[A-Za-z0-9_.:-]+$/u;

export interface QemuConsoleTargetProfileOptions extends ConsoleLifecycleProfile {
  readonly targetId: string;
  readonly qemuBinary: string;
  readonly memoryMiB?: number;
  readonly boot?: QemuBootConfig;
  readonly display?: QemuDisplayConfig;
  readonly nographic?: boolean;
  readonly serial?: QemuSerialConfig;
  readonly networkDevice?: QemuNetworkDeviceConfig;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly declaredTempRoots?: readonly string[];
  readonly diskImages: readonly ConsoleVmDiskImage[];
  readonly network?: ConsoleVmNetworkProfile;
  readonly allowRelease?: boolean;
}

export interface QemuBootConfig {
  readonly order: "cdrom" | "disk";
}

export interface QemuDisplayConfig {
  readonly kind: "none";
}

export type QemuSerialConfig =
  | {
      readonly kind: "stdio";
      readonly monitor?: boolean;
    }
  | {
      readonly kind: "telnet";
      readonly bindHost: string;
      readonly port: number;
      readonly monitor?: boolean;
    }
  | {
      readonly kind: "none";
    };

export interface QemuNetworkDeviceConfig {
  readonly kind: "user";
  readonly id?: string;
  readonly model?: "e1000" | "virtio-net-pci";
}

function sha256Json(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalize(JsonObject.parse(value)))
    .digest("hex")}`;
}

function sha256Text(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertCleanCommand(value: string): void {
  if (value.trim() === "") throw new Error("QEMU binary is empty");
  if (value.includes("\u0000") || /[\r\n]/u.test(value)) {
    throw new Error("QEMU binary must not contain control characters");
  }
  if (!isAbsolute(value) && /[/\\]/u.test(value)) {
    throw new Error(
      "QEMU binary must be a simple executable name or absolute path without shell syntax",
    );
  }
  if (/[\s"'`;|&<>$]/u.test(value)) {
    if (isAbsolute(value)) throw new Error("QEMU binary must not contain shell syntax");
    throw new Error(
      "QEMU binary must be a simple executable name or absolute path without shell syntax",
    );
  }
}

function qemuOptionName(arg: string): string {
  const [name] = arg.split("=", 1);
  return name ?? arg;
}

function assertSideEffectNeutralArg(args: readonly string[], index: number): void {
  const arg = args[index] ?? "";
  const optionName = qemuOptionName(arg);
  if (SIDE_EFFECT_QEMU_ARG_OPTIONS.has(optionName)) {
    throw new Error(
      `QEMU arg ${optionName} may declare disk, network, listener, or monitor side effects; use typed VM target fields instead`,
    );
  }
  if (/hostfwd|guestfwd|file=|socket|tcp:|udp:|telnet:|unix:/iu.test(arg)) {
    throw new Error(
      "QEMU args must not hide disk, network, listener, or monitor side effects in opaque argv",
    );
  }
  if (!SAFE_EXTRA_QEMU_ARGS.has(arg)) {
    throw new Error(
      `QEMU arg ${arg} is not an approved side-effect-neutral extra arg; use typed VM target fields instead`,
    );
  }
}

function normalizeArg(args: readonly string[], index: number): string {
  const arg = args[index] ?? "";
  if (arg.includes("\u0000")) throw new Error("QEMU arg must not contain NUL bytes");
  if (/[\r\n]/u.test(arg)) throw new Error("QEMU arg must not contain control characters");
  assertSideEffectNeutralArg(args, index);
  return arg;
}

function normalizeArgs(args: readonly string[] | undefined): readonly string[] {
  const values = args ?? [];
  return values.map((_arg, index) => normalizeArg(values, index));
}

function normalizeMemoryMiB(memoryMiB: number | undefined): number | undefined {
  if (memoryMiB === undefined) return undefined;
  if (!Number.isInteger(memoryMiB) || memoryMiB < 16 || memoryMiB > 262_144) {
    throw new Error("QEMU memoryMiB must be an integer from 16 to 262144");
  }
  return memoryMiB;
}

function normalizeBoot(boot: QemuBootConfig | undefined): QemuBootConfig | undefined {
  if (boot === undefined) return undefined;
  if (!QEMU_BOOT_ORDERS.has(boot.order)) {
    throw new Error("QEMU boot order is invalid");
  }
  return { order: boot.order };
}

function normalizeDisplay(display: QemuDisplayConfig | undefined): QemuDisplayConfig | undefined {
  if (display === undefined) return undefined;
  if (display.kind !== "none") throw new Error("QEMU display kind is invalid");
  return { kind: "none" };
}

function normalizeSerial(serial: QemuSerialConfig | undefined): QemuSerialConfig | undefined {
  if (serial === undefined) return undefined;
  if (serial.kind === "stdio") {
    return { kind: "stdio", ...(serial.monitor === undefined ? {} : { monitor: serial.monitor }) };
  }
  if (serial.kind === "telnet") {
    return {
      kind: "telnet",
      bindHost: normalizeLoopbackHost(serial.bindHost),
      port: normalizeSerialPort(serial.port),
      ...(serial.monitor === undefined ? {} : { monitor: serial.monitor }),
    };
  }
  if (serial.kind === "none") return { kind: "none" };
  throw new Error("QEMU serial kind is invalid");
}

function normalizeNetworkDevice(
  device: QemuNetworkDeviceConfig | undefined,
): QemuNetworkDeviceConfig | undefined {
  if (device === undefined) return undefined;
  if (device.kind !== "user") throw new Error("QEMU network device kind is invalid");
  const id = device.id ?? "keelnet0";
  if (id === "" || !QEMU_SAFE_ID_RE.test(id)) {
    throw new Error("QEMU network device id is invalid");
  }
  const model = device.model ?? "e1000";
  if (!QEMU_NETWORK_DEVICE_MODELS.has(model)) {
    throw new Error("QEMU network device model is invalid");
  }
  return { kind: "user", id, model };
}

function normalizeDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase();
  if (normalized === "" || /[\s/@:]/u.test(normalized)) {
    throw new Error(`QEMU guest download domain is invalid: ${domain}`);
  }
  return normalized;
}

function assertPort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer port from 1 to 65535`);
  }
}

function normalizeSerialPort(port: number): number {
  assertPort(port, "QEMU serial telnet port");
  return port;
}

function assertDiskAccess(access: ConsoleVmDiskImage["access"]): void {
  if (access !== "read-only" && access !== "read-write") {
    throw new Error("QEMU VM disk access is invalid");
  }
}

function normalizeDiskRole(
  role: ConsoleVmDiskImage["role"],
): NonNullable<ConsoleVmDiskImage["role"]> {
  if (role === undefined) return "drive";
  if (!QEMU_DISK_ROLES.has(role)) throw new Error("QEMU VM disk role is invalid");
  return role;
}

function normalizeDiskInterface(
  diskInterface: ConsoleVmDiskImage["interface"],
): ConsoleVmDiskImage["interface"] {
  if (diskInterface === undefined) return undefined;
  if (!QEMU_DISK_INTERFACES.has(diskInterface)) {
    throw new Error("QEMU VM disk interface is invalid");
  }
  return diskInterface;
}

function normalizeDiskFormat(format: ConsoleVmDiskImage["format"]): ConsoleVmDiskImage["format"] {
  if (format === undefined) return undefined;
  if (!QEMU_DISK_FORMATS.has(format)) throw new Error("QEMU VM disk format is invalid");
  return format;
}

function assertNetworkProtocol(protocol: ConsoleVmHostForward["protocol"]): void {
  if (protocol !== "tcp" && protocol !== "udp") {
    throw new Error("QEMU VM network protocol is invalid");
  }
}

function normalizeLoopbackHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1") {
    return normalized === "localhost" ? "127.0.0.1" : normalized;
  }
  throw new Error("QEMU VM listener/forward bind host must be loopback");
}

function normalizeDiskImage(disk: ConsoleVmDiskImage): ConsoleVmDiskImage {
  if (!isAbsolute(disk.path)) throw new Error("QEMU VM disk image path must be absolute");
  if (disk.path.includes("\u0000") || /[\r\n]/u.test(disk.path)) {
    throw new Error("QEMU VM disk image path must not contain control characters");
  }
  assertDiskAccess(disk.access);
  const role = normalizeDiskRole(disk.role);
  if (role === "cdrom" && disk.access !== "read-only") {
    throw new Error("QEMU VM cdrom disk image must be read-only");
  }
  const diskInterface = normalizeDiskInterface(disk.interface);
  const format = normalizeDiskFormat(disk.format);
  return {
    path: disk.path,
    access: disk.access,
    role,
    ...(diskInterface === undefined ? {} : { interface: diskInterface }),
    ...(format === undefined ? {} : { format }),
  };
}

function normalizeHostForward(forward: ConsoleVmHostForward): ConsoleVmHostForward {
  assertNetworkProtocol(forward.protocol);
  assertPort(forward.hostPort, "QEMU VM host forward hostPort");
  assertPort(forward.guestPort, "QEMU VM host forward guestPort");
  return {
    ...forward,
    bindHost: normalizeLoopbackHost(forward.bindHost),
  };
}

function normalizeLocalListener(listener: ConsoleVmLocalListener): ConsoleVmLocalListener {
  assertNetworkProtocol(listener.protocol);
  assertPort(listener.port, "QEMU VM local listener port");
  return {
    ...listener,
    bindHost: normalizeLoopbackHost(listener.bindHost),
  };
}

function normalizeGuestDownload(download: ConsoleVmGuestDownload): ConsoleVmGuestDownload {
  return {
    ...download,
    domain: normalizeDomain(download.domain),
  };
}

function sortByJson<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function normalizeNetwork(network: ConsoleVmNetworkProfile | undefined): ConsoleVmNetworkProfile {
  const hostForwards = sortByJson((network?.hostForwards ?? []).map(normalizeHostForward));
  const localListeners = sortByJson((network?.localListeners ?? []).map(normalizeLocalListener));
  const guestDownloads = sortByJson((network?.guestDownloads ?? []).map(normalizeGuestDownload));
  return {
    ...(hostForwards.length === 0 ? {} : { hostForwards }),
    ...(localListeners.length === 0 ? {} : { localListeners }),
    ...(guestDownloads.length === 0 ? {} : { guestDownloads }),
  };
}

function networkWithSerialListener(
  network: ConsoleVmNetworkProfile,
  serial: QemuSerialConfig | undefined,
): ConsoleVmNetworkProfile {
  if (serial?.kind !== "telnet") return network;
  const listener: ConsoleVmLocalListener = {
    protocol: "tcp",
    bindHost: serial.bindHost,
    port: serial.port,
    purpose: "qemu serial telnet console",
  };
  return normalizeNetwork({
    ...network,
    localListeners: [...(network.localListeners ?? []), listener],
  });
}

function guestDownloadDomains(network: ConsoleVmNetworkProfile): readonly string[] {
  return [...new Set((network.guestDownloads ?? []).map((download) => download.domain))].sort();
}

function bootOrderArg(order: QemuBootConfig["order"]): string {
  return order === "cdrom" ? "d" : "c";
}

function qemuDiskArgs(diskImages: readonly ConsoleVmDiskImage[]): string[] {
  const args: string[] = [];
  for (const disk of diskImages) {
    switch (disk.role) {
      case "cdrom":
        args.push("-cdrom", disk.path);
        break;
      case "hda":
      case "hdb":
      case "hdc":
      case "hdd":
        if (disk.access !== "read-write") {
          throw new Error(`QEMU VM ${disk.role} disk image must be read-write`);
        }
        args.push(`-${disk.role}`, disk.path);
        break;
      case "drive": {
        if (disk.path.includes(",")) {
          throw new Error("QEMU VM drive disk image path must not contain ','");
        }
        const drive = [
          `file=${disk.path}`,
          `if=${disk.interface ?? "virtio"}`,
          ...(disk.format === undefined ? [] : [`format=${disk.format}`]),
          `readonly=${disk.access === "read-only" ? "on" : "off"}`,
        ].join(",");
        args.push("-drive", drive);
        break;
      }
      default:
        throw new Error("QEMU VM disk role is invalid");
    }
  }
  return args;
}

function qemuSerialArg(serial: QemuSerialConfig | undefined): string[] {
  if (serial === undefined) return [];
  switch (serial.kind) {
    case "stdio":
      return ["-serial", `${serial.monitor === true ? "mon:" : ""}stdio`];
    case "telnet":
      return [
        "-serial",
        `${serial.monitor === true ? "mon:" : ""}telnet:${serial.bindHost}:${String(
          serial.port,
        )},server,nowait`,
      ];
    case "none":
      return ["-serial", "none"];
  }
}

function qemuNetworkArgs(
  network: ConsoleVmNetworkProfile,
  device: QemuNetworkDeviceConfig | undefined,
): string[] {
  const requiresUserNetwork =
    (network.hostForwards?.length ?? 0) > 0 || (network.guestDownloads?.length ?? 0) > 0;
  if (!requiresUserNetwork) return [];
  const resolvedDevice = device ?? { kind: "user", id: "keelnet0", model: "e1000" };
  const netdev = [
    "user",
    `id=${resolvedDevice.id}`,
    ...(network.hostForwards ?? []).map(
      (forward) =>
        `hostfwd=${forward.protocol}:${forward.bindHost}:${String(forward.hostPort)}-:${String(
          forward.guestPort,
        )}`,
    ),
  ].join(",");
  return ["-netdev", netdev, "-device", `${resolvedDevice.model},netdev=${resolvedDevice.id}`];
}

function qemuGeneratedArgs(options: {
  readonly memoryMiB?: number;
  readonly boot?: QemuBootConfig;
  readonly display?: QemuDisplayConfig;
  readonly nographic?: boolean;
  readonly serial?: QemuSerialConfig;
  readonly diskImages: readonly ConsoleVmDiskImage[];
  readonly network: ConsoleVmNetworkProfile;
  readonly networkDevice?: QemuNetworkDeviceConfig;
}): readonly string[] {
  return [
    ...(options.memoryMiB === undefined ? [] : ["-m", String(options.memoryMiB)]),
    ...qemuDiskArgs(options.diskImages),
    ...(options.boot === undefined ? [] : ["-boot", bootOrderArg(options.boot.order)]),
    ...qemuNetworkArgs(options.network, options.networkDevice),
    ...qemuSerialArg(options.serial),
    ...(options.display === undefined ? [] : ["-display", options.display.kind]),
    ...(options.nographic === true ? ["-nographic"] : []),
  ];
}

export function createQemuConsoleTargetProfile(
  options: QemuConsoleTargetProfileOptions,
): ConsolePolicyTargetProfile {
  assertCleanCommand(options.qemuBinary);
  if (!isAbsolute(options.cwd)) throw new Error("QEMU target cwd must be absolute");
  if (options.diskImages.length === 0) {
    throw new Error("QEMU VM target must declare at least one disk image");
  }
  const memoryMiB = normalizeMemoryMiB(options.memoryMiB);
  const boot = normalizeBoot(options.boot);
  const display = normalizeDisplay(options.display);
  const serial = normalizeSerial(options.serial);
  const networkDevice = normalizeNetworkDevice(options.networkDevice);
  const extraArgs = normalizeArgs(options.args);
  const diskImages = sortByJson(options.diskImages.map(normalizeDiskImage));
  const network = networkWithSerialListener(normalizeNetwork(options.network), serial);
  const generatedArgs = qemuGeneratedArgs({
    ...(memoryMiB === undefined ? {} : { memoryMiB }),
    ...(boot === undefined ? {} : { boot }),
    ...(display === undefined ? {} : { display }),
    ...(serial === undefined ? {} : { serial }),
    ...(networkDevice === undefined ? {} : { networkDevice }),
    nographic: options.nographic === true,
    diskImages,
    network,
  });
  const argv = [options.qemuBinary, ...generatedArgs, ...extraArgs];
  const material = {
    kind: "qemu",
    targetId: options.targetId,
    qemuBinary: options.qemuBinary,
    generatedArgs,
    extraArgs,
    ...(memoryMiB === undefined ? {} : { memoryMiB }),
    ...(boot === undefined ? {} : { boot }),
    ...(display === undefined ? {} : { display }),
    ...(serial === undefined ? {} : { serial }),
    ...(networkDevice === undefined ? {} : { networkDevice }),
    nographic: options.nographic === true,
    cwd: options.cwd,
    declaredTempRoots: [...(options.declaredTempRoots ?? [])].sort(),
    diskImages,
    network,
    allowRelease: options.allowRelease === true,
    governanceBoundary: QEMU_GUEST_GOVERNANCE_BOUNDARY,
    lifecycle: {
      ...(options.maxTtlMs === undefined ? {} : { maxTtlMs: options.maxTtlMs }),
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
      ...(options.maxKeyTokens === undefined ? {} : { maxKeyTokens: options.maxKeyTokens }),
      ...(options.maxScreenFrames === undefined
        ? {}
        : { maxScreenFrames: options.maxScreenFrames }),
      ...(options.maxScreenBytes === undefined ? {} : { maxScreenBytes: options.maxScreenBytes }),
    },
  };
  return {
    targetId: options.targetId,
    targetDigest: sha256Json(material),
    sandboxProfileId: QEMU_LOCAL_VM_SANDBOX_PROFILE_ID,
    command: options.qemuBinary,
    argv,
    cwd: options.cwd,
    ...(options.declaredTempRoots === undefined
      ? {}
      : { declaredTempRoots: [...options.declaredTempRoots].sort() }),
    filesystemScopes: ["workspace", "temp"],
    egressDomains: guestDownloadDomains(network),
    ...(options.allowRelease === true ? { allowRelease: true } : {}),
    ...(options.maxTtlMs === undefined ? {} : { maxTtlMs: options.maxTtlMs }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.maxKeyTokens === undefined ? {} : { maxKeyTokens: options.maxKeyTokens }),
    ...(options.maxScreenFrames === undefined ? {} : { maxScreenFrames: options.maxScreenFrames }),
    ...(options.maxScreenBytes === undefined ? {} : { maxScreenBytes: options.maxScreenBytes }),
    vm: {
      kind: "qemu",
      diskImages,
      ...(Object.keys(network).length === 0 ? {} : { network }),
      launch: { argvDigest: sha256Text(JSON.stringify(argv)) },
      governanceBoundary: QEMU_GUEST_GOVERNANCE_BOUNDARY,
    },
  };
}
