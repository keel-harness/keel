import { isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  PolicyInput,
  SIDE_EFFECT_TAXONOMY_VERSION,
  aggregateSegments,
  type EffectKindT,
  type EffectScopeT,
  type PolicyInputT,
  type RiskModifierT,
  type SideEffectSegmentT,
  type SideEffectTargetT,
  type WARDEN_METHODS,
} from "@keel/shared";
import { isInside } from "../path-util.js";
import type { PolicyInputBuildOptions } from "../policy.js";
import {
  consoleLifecycleProfileIssue,
  effectiveConsoleLifecycleLimits,
  type ConsoleLifecycleProfile,
} from "./lifecycle.js";
import {
  CONSOLE_TOOL_NAMES,
  summarizeConsoleInputForAudit,
  type ConsoleOperation,
  type ConsoleSpecialKeyT,
  type ConsoleToolName,
} from "./schema.js";

type ExecuteParams = ReturnType<(typeof WARDEN_METHODS)["warden.execute"]["params"]["parse"]>;

const HASH_RE = /^sha256:[0-9a-f]{64}$/u;
const BASE_TARGET_EFFECTS: readonly EffectKindT[] = [
  "fs_read",
  "fs_write",
  "process_exec",
  "unknown",
];
const NETWORK_EFFECTS: readonly EffectKindT[] = ["network_read", "network_write"];

export interface ConsolePolicyTargetProfile extends ConsoleLifecycleProfile {
  readonly targetId: string;
  readonly targetDigest: string;
  readonly sandboxProfileId: string;
  readonly command: string;
  readonly argv?: readonly string[];
  readonly cwd: string;
  readonly declaredTempRoots?: readonly string[];
  readonly filesystemScopes?: readonly Extract<
    EffectScopeT,
    "workspace" | "temp" | "home" | "system"
  >[];
  readonly egressDomains?: readonly string[];
  readonly allowRelease?: boolean;
  readonly vm?: ConsoleVmTargetProfile;
}

export const QEMU_GUEST_GOVERNANCE_BOUNDARY =
  "host-qemu-process-governed_guest-os-ungoverned" as const;

export interface ConsoleVmDiskImage {
  readonly path: string;
  readonly access: "read-only" | "read-write";
  readonly role?: "cdrom" | "hda" | "hdb" | "hdc" | "hdd" | "drive";
  readonly interface?: "ide" | "virtio";
  readonly format?: "qcow2" | "raw";
}

export interface ConsoleVmHostForward {
  readonly protocol: "tcp" | "udp";
  readonly bindHost: string;
  readonly hostPort: number;
  readonly guestPort: number;
  readonly purpose?: string;
}

export interface ConsoleVmLocalListener {
  readonly protocol: "tcp" | "udp";
  readonly bindHost: string;
  readonly port: number;
  readonly purpose?: string;
}

export interface ConsoleVmGuestDownload {
  readonly domain: string;
  readonly purpose?: string;
}

export interface ConsoleVmNetworkProfile {
  readonly hostForwards?: readonly ConsoleVmHostForward[];
  readonly localListeners?: readonly ConsoleVmLocalListener[];
  readonly guestDownloads?: readonly ConsoleVmGuestDownload[];
}

export interface ConsoleVmTargetProfile {
  readonly kind: "qemu";
  readonly diskImages: readonly ConsoleVmDiskImage[];
  readonly network?: ConsoleVmNetworkProfile;
  readonly launch?: {
    readonly argvDigest: string;
  };
  readonly governanceBoundary: typeof QEMU_GUEST_GOVERNANCE_BOUNDARY;
}

export class ConsolePolicyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsolePolicyInputError";
  }
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function normalizeEgressDomains(profile: ConsolePolicyTargetProfile): readonly string[] {
  const domains = (profile.egressDomains ?? []).map((domain) => {
    const normalized = domain.trim().toLowerCase();
    if (normalized === "" || /[\s/@:]/u.test(normalized)) {
      throw new ConsolePolicyInputError(`console egress domain is invalid: ${domain}`);
    }
    return normalized;
  });
  return sortedUnique(domains);
}

function assertAbsoluteVmPath(path: string, label: string): void {
  if (path.trim() === "") throw new ConsolePolicyInputError(`${label} is empty`);
  if (!isAbsolute(path)) throw new ConsolePolicyInputError(`${label} must be absolute`);
}

function validatePort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConsolePolicyInputError(`${label} must be an integer port from 1 to 65535`);
  }
}

function validateDiskAccess(access: ConsoleVmDiskImage["access"]): void {
  if (access !== "read-only" && access !== "read-write") {
    throw new ConsolePolicyInputError("QEMU VM disk access is invalid");
  }
}

function validateDiskLaunchMetadata(disk: ConsoleVmDiskImage): void {
  if (
    disk.role !== undefined &&
    disk.role !== "cdrom" &&
    disk.role !== "hda" &&
    disk.role !== "hdb" &&
    disk.role !== "hdc" &&
    disk.role !== "hdd" &&
    disk.role !== "drive"
  ) {
    throw new ConsolePolicyInputError("QEMU VM disk role is invalid");
  }
  if (disk.interface !== undefined && disk.interface !== "ide" && disk.interface !== "virtio") {
    throw new ConsolePolicyInputError("QEMU VM disk interface is invalid");
  }
  if (disk.format !== undefined && disk.format !== "qcow2" && disk.format !== "raw") {
    throw new ConsolePolicyInputError("QEMU VM disk format is invalid");
  }
  if (disk.role === "cdrom" && disk.access !== "read-only") {
    throw new ConsolePolicyInputError("QEMU VM cdrom disk image must be read-only");
  }
}

function validateNetworkProtocol(protocol: ConsoleVmHostForward["protocol"]): void {
  if (protocol !== "tcp" && protocol !== "udp") {
    throw new ConsolePolicyInputError("QEMU VM network protocol is invalid");
  }
}

function normalizeLoopbackHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1") {
    return normalized === "localhost" ? "127.0.0.1" : normalized;
  }
  throw new ConsolePolicyInputError("QEMU VM listener/forward bind host must be loopback");
}

function validateVmProfile(profile: ConsolePolicyTargetProfile): void {
  const vm = profile.vm;
  if (vm === undefined) return;
  if (vm.kind !== "qemu") throw new ConsolePolicyInputError("console VM kind is invalid");
  if (vm.governanceBoundary !== QEMU_GUEST_GOVERNANCE_BOUNDARY) {
    throw new ConsolePolicyInputError("console VM governance boundary is invalid");
  }
  if (vm.diskImages.length === 0) {
    throw new ConsolePolicyInputError("QEMU VM target must declare at least one disk image");
  }
  for (const disk of vm.diskImages) {
    assertAbsoluteVmPath(disk.path, "QEMU VM disk image path");
    validateDiskAccess(disk.access);
    validateDiskLaunchMetadata(disk);
  }
  for (const forward of vm.network?.hostForwards ?? []) {
    validateNetworkProtocol(forward.protocol);
    normalizeLoopbackHost(forward.bindHost);
    validatePort(forward.hostPort, "QEMU VM host forward hostPort");
    validatePort(forward.guestPort, "QEMU VM host forward guestPort");
  }
  for (const listener of vm.network?.localListeners ?? []) {
    validateNetworkProtocol(listener.protocol);
    normalizeLoopbackHost(listener.bindHost);
    validatePort(listener.port, "QEMU VM local listener port");
  }
  for (const download of vm.network?.guestDownloads ?? []) {
    normalizeEgressDomain(download.domain);
  }
  if (profile.argv === undefined) {
    throw new ConsolePolicyInputError("QEMU VM profile must declare generated argv");
  }
  if (vm.launch === undefined || !HASH_RE.test(vm.launch.argvDigest)) {
    throw new ConsolePolicyInputError("QEMU VM launch argv digest is missing or invalid");
  }
  const observedArgvDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify([...profile.argv]))
    .digest("hex")}`;
  if (vm.launch.argvDigest !== observedArgvDigest) {
    throw new ConsolePolicyInputError("QEMU VM launch argv digest does not match profile argv");
  }
}

function normalizeEgressDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase();
  if (normalized === "" || /[\s/@:]/u.test(normalized)) {
    throw new ConsolePolicyInputError(`console egress domain is invalid: ${domain}`);
  }
  return normalized;
}

function validateTargetProfile(profile: ConsolePolicyTargetProfile): void {
  if (profile.targetId.trim() === "")
    throw new ConsolePolicyInputError("console targetId is empty");
  if (!HASH_RE.test(profile.targetDigest)) {
    throw new ConsolePolicyInputError("console targetDigest must be sha256:<64 hex>");
  }
  if (profile.sandboxProfileId.trim() === "") {
    throw new ConsolePolicyInputError("console sandboxProfileId is empty");
  }
  if (profile.command.trim() === "") throw new ConsolePolicyInputError("console command is empty");
  if (profile.argv !== undefined) {
    if (profile.argv.length === 0) throw new ConsolePolicyInputError("console argv is empty");
    if (profile.argv[0] !== profile.command) {
      throw new ConsolePolicyInputError("console argv executable must match command");
    }
    for (const arg of profile.argv) {
      if (arg.includes("\u0000")) {
        throw new ConsolePolicyInputError("console argv must not contain NUL bytes");
      }
    }
  }
  if (profile.cwd.trim() === "") throw new ConsolePolicyInputError("console cwd is empty");
  if (!isAbsolute(profile.cwd)) throw new ConsolePolicyInputError("console cwd must be absolute");
  validateVmProfile(profile);
  const lifecycleIssue = consoleLifecycleProfileIssue(profile);
  if (lifecycleIssue !== undefined) throw new ConsolePolicyInputError(lifecycleIssue);
}

function assertOperationMatchesTarget(
  params: ExecuteParams,
  operation: ConsoleOperation,
  profile: ConsolePolicyTargetProfile,
): void {
  if (params.toolCall.name !== operation.toolName) {
    throw new ConsolePolicyInputError(
      "console operation mismatch between params and parsed tool call",
    );
  }
  if (operation.kind === "open" && operation.args.targetId !== profile.targetId) {
    throw new ConsolePolicyInputError(
      `console target mismatch: requested ${operation.args.targetId}, resolved ${profile.targetId}`,
    );
  }
}

function pathTarget(rawPath: string, workspaceRoot: string): SideEffectTargetT {
  const normalized = resolve(rawPath);
  return {
    kind: "path",
    value: rawPath,
    normalized,
    withinWorkspace: isInside(workspaceRoot, normalized),
    sensitivity: "internal",
  };
}

function vmDiskImageTargets(
  profile: ConsolePolicyTargetProfile,
  workspaceRoot: string,
): SideEffectTargetT[] {
  return (profile.vm?.diskImages ?? []).map((disk) => pathTarget(disk.path, workspaceRoot));
}

function normalizedHostForward(forward: ConsoleVmHostForward): ConsoleVmHostForward {
  return {
    ...forward,
    bindHost: normalizeLoopbackHost(forward.bindHost),
  };
}

function normalizedLocalListener(listener: ConsoleVmLocalListener): ConsoleVmLocalListener {
  return {
    ...listener,
    bindHost: normalizeLoopbackHost(listener.bindHost),
  };
}

function normalizedGuestDownload(download: ConsoleVmGuestDownload): ConsoleVmGuestDownload {
  return {
    ...download,
    domain: normalizeEgressDomain(download.domain),
  };
}

function normalizedVmNetwork(
  profile: ConsolePolicyTargetProfile,
): ConsoleVmNetworkProfile | undefined {
  const network = profile.vm?.network;
  if (network === undefined) return undefined;
  const hostForwards = (network.hostForwards ?? []).map(normalizedHostForward);
  const localListeners = (network.localListeners ?? []).map(normalizedLocalListener);
  const guestDownloads = (network.guestDownloads ?? []).map(normalizedGuestDownload);
  return {
    ...(hostForwards.length === 0 ? {} : { hostForwards }),
    ...(localListeners.length === 0 ? {} : { localListeners }),
    ...(guestDownloads.length === 0 ? {} : { guestDownloads }),
  };
}

function vmNetworkTargets(profile: ConsolePolicyTargetProfile): SideEffectTargetT[] {
  const network = normalizedVmNetwork(profile);
  const targets: SideEffectTargetT[] = [];
  for (const forward of network?.hostForwards ?? []) {
    targets.push({
      kind: "host",
      value: `QEMU host forward ${forward.protocol} ${forward.bindHost}:${String(forward.hostPort)} -> guest:${String(forward.guestPort)}`,
      normalized: `vm.hostForward:${forward.protocol}:${forward.bindHost}:${String(forward.hostPort)}->guest:${String(forward.guestPort)}`,
      sensitivity: "internal",
    });
  }
  for (const listener of network?.localListeners ?? []) {
    targets.push({
      kind: "host",
      value: `QEMU local listener ${listener.protocol} ${listener.bindHost}:${String(listener.port)}`,
      normalized: `vm.localListener:${listener.protocol}:${listener.bindHost}:${String(listener.port)}`,
      sensitivity: "internal",
    });
  }
  return targets;
}

function hasVmNetworkSemantics(profile: ConsolePolicyTargetProfile): boolean {
  const network = normalizedVmNetwork(profile);
  return (
    (network?.hostForwards?.length ?? 0) > 0 ||
    (network?.localListeners?.length ?? 0) > 0 ||
    (network?.guestDownloads?.length ?? 0) > 0
  );
}

function targetIdentityTargets(
  profile: ConsolePolicyTargetProfile,
  workspaceRoot: string,
  domains: readonly string[],
): SideEffectTargetT[] {
  return [
    {
      kind: "unknown",
      value: `console.target:${profile.targetId}`,
      normalized: `console.target:${profile.targetDigest}`,
    },
    {
      kind: "unknown",
      value: `console.sandbox:${profile.sandboxProfileId}`,
      normalized: `console.sandbox:${profile.sandboxProfileId}`,
    },
    { kind: "command", value: profile.command, normalized: profile.command },
    pathTarget(profile.cwd, workspaceRoot),
    ...vmDiskImageTargets(profile, workspaceRoot),
    ...vmNetworkTargets(profile),
    ...domains.map(
      (domain): SideEffectTargetT => ({ kind: "host", value: domain, normalized: domain }),
    ),
  ];
}

function handleTarget(handle: string): SideEffectTargetT {
  return {
    kind: "process",
    value: handle,
    normalized: `console.handle:${handle}`,
  };
}

function keyShapeTarget(shapeHash: string): SideEffectTargetT {
  return {
    kind: "unknown",
    value: `console.key-shape:${shapeHash}`,
    normalized: `console.key-shape:${shapeHash}`,
  };
}

function effectKindsFor(
  operation: ConsoleOperation,
  domains: readonly string[],
  networkSemantics = domains.length > 0,
): readonly EffectKindT[] {
  if (operation.kind === "read_screen") return ["unknown"];
  if (operation.kind === "close") return ["process_exec"];
  if (operation.kind === "release") return ["process_exec", "unknown"];
  return networkSemantics ? [...BASE_TARGET_EFFECTS, ...NETWORK_EFFECTS] : BASE_TARGET_EFFECTS;
}

function scopesFor(
  operation: ConsoleOperation,
  profile: ConsolePolicyTargetProfile,
  domains: readonly string[],
): readonly EffectScopeT[] {
  if (operation.kind === "read_screen" || operation.kind === "close") return ["process"];
  if (operation.kind === "release") return ["process", "unknown"];
  const fsScopes = profile.filesystemScopes ?? ["workspace", "temp"];
  return domains.length === 0 && !hasVmNetworkSemantics(profile)
    ? [...fsScopes, "process", "unknown"]
    : [...fsScopes, "network", "external_service", "process", "unknown"];
}

function modifiersFor(operation: ConsoleOperation): readonly RiskModifierT[] {
  return operation.kind === "close" ? [] : ["unknown"];
}

function operationTargets(
  operation: ConsoleOperation,
  profile: ConsolePolicyTargetProfile,
  workspaceRoot: string,
  domains: readonly string[],
): readonly SideEffectTargetT[] {
  const base = targetIdentityTargets(profile, workspaceRoot, domains);
  switch (operation.kind) {
    case "open":
      return base;
    case "send_keys": {
      const summary = summarizeConsoleInputForAudit(operation.args.input);
      return [...base, handleTarget(operation.args.handle), keyShapeTarget(summary.shapeHash)];
    }
    case "read_screen":
    case "release":
    case "close":
      return [...base, handleTarget(operation.args.handle)];
  }
}

function policyArgsFor(operation: ConsoleOperation): Record<string, unknown> {
  switch (operation.kind) {
    case "open":
      return {
        targetId: operation.args.targetId,
        rows: operation.args.rows,
        cols: operation.args.cols,
      };
    case "send_keys": {
      const summary = summarizeConsoleInputForAudit(operation.args.input);
      return {
        handle: operation.args.handle,
        inputSummary: {
          tokenCount: summary.tokenCount,
          textBytes: summary.textBytes,
          controlKeys: [...summary.controlKeys] satisfies ConsoleSpecialKeyT[],
          shapeHash: summary.shapeHash,
        },
      };
    }
    case "read_screen":
      return { handle: operation.args.handle, maxBytes: operation.args.maxBytes };
    case "release":
      return {
        handle: operation.args.handle,
        reason: operation.args.reason,
      };
    case "close":
      return {
        handle: operation.args.handle,
        ...(operation.args.reason === undefined ? {} : { reason: operation.args.reason }),
      };
  }
}

function extensionFor(
  operation: ConsoleOperation,
  profile: ConsolePolicyTargetProfile,
  domains: readonly string[],
): Record<string, unknown> {
  return {
    operation: operation.kind,
    targetId: profile.targetId,
    targetDigest: profile.targetDigest,
    sandboxProfileId: profile.sandboxProfileId,
    ...(profile.argv === undefined
      ? {}
      : {
          argv: {
            count: profile.argv.length,
            digest: `sha256:${createHash("sha256")
              .update(JSON.stringify([...profile.argv]))
              .digest("hex")}`,
          },
        }),
    egressDomains: [...domains],
    declaredTempRoots: [...(profile.declaredTempRoots ?? [])],
    allowRelease: profile.allowRelease === true,
    lifecycleLimits: effectiveConsoleLifecycleLimits(profile),
    ...(profile.vm === undefined
      ? {}
      : {
          vm: {
            ...profile.vm,
            ...(normalizedVmNetwork(profile) === undefined
              ? {}
              : { network: normalizedVmNetwork(profile) }),
          },
        }),
    args: policyArgsFor(operation),
  };
}

function unresolvedTargets(operation: ConsoleOperation): readonly SideEffectTargetT[] {
  switch (operation.kind) {
    case "open":
      return [
        {
          kind: "unknown",
          value: `console.target:${operation.args.targetId}`,
          normalized: `console.target:unresolved:${operation.args.targetId}`,
        },
      ];
    case "send_keys": {
      const summary = summarizeConsoleInputForAudit(operation.args.input);
      return [handleTarget(operation.args.handle), keyShapeTarget(summary.shapeHash)];
    }
    case "read_screen":
    case "release":
    case "close":
      return [handleTarget(operation.args.handle)];
  }
}

function unresolvedExtensionFor(operation: ConsoleOperation): Record<string, unknown> {
  return {
    operation: operation.kind,
    unresolved: true,
    args: policyArgsFor(operation),
  };
}

export function buildConsoleUnresolvedPolicyInput(
  params: ExecuteParams,
  operation: ConsoleOperation,
  options: PolicyInputBuildOptions,
): PolicyInputT {
  if (params.toolCall.name !== operation.toolName) {
    throw new ConsolePolicyInputError(
      "console operation mismatch between params and parsed tool call",
    );
  }
  const env = options.env ?? process.env;
  const effectKinds = effectKindsFor(operation, []);
  const scopes: EffectScopeT[] =
    operation.kind === "open" || operation.kind === "send_keys" || operation.kind === "release"
      ? ["process", "unknown"]
      : ["process"];
  const segments: SideEffectSegmentT[] = [
    {
      effectKinds: [...effectKinds],
      scopes,
      targets: [...unresolvedTargets(operation)],
      modifiers: [...modifiersFor(operation)],
    },
  ];
  const aggregate = aggregateSegments(segments);

  return PolicyInput.parse({
    tool: { name: operation.toolName, args: policyArgsFor(operation) },
    normalized: { argv: [], decodedLayers: [] },
    sideEffect: {
      taxonomyVersion: SIDE_EFFECT_TAXONOMY_VERSION,
      staticCapability: {
        toolName: operation.toolName,
        effectEnvelope: [...effectKinds],
        broad: true,
      },
      dynamic: {
        ...aggregate,
        composition: { kind: "atomic", segments, edges: [] },
        classifier: {
          name: "interactive-console-opaque-classifier",
          version: "1",
          confidence: "conservative",
          reasons: [
            "interactive_console_opaque",
            "interactive_console_unresolved",
            `interactive_console_${operation.kind}`,
            "interactive_console_slice_2",
          ],
        },
      },
      extensions: {
        "keel.interactiveConsole": unresolvedExtensionFor(operation),
      },
    },
    workspace: { path: options.workspaceRoot, trusted: options.workspaceTrusted ?? false },
    provenance: params.provenanceContext,
    egress: { isEgress: false, domain: null, gitRemote: null },
    session: {
      id: params.sessionId,
      mode: "enforced",
      promptCountThisSession: 0,
    },
    principal: { osUser: env["USER"] ?? "local" },
  });
}

export function buildConsoleOpaquePolicyInput(
  params: ExecuteParams,
  operation: ConsoleOperation,
  profile: ConsolePolicyTargetProfile,
  options: PolicyInputBuildOptions,
): PolicyInputT {
  validateTargetProfile(profile);
  assertOperationMatchesTarget(params, operation, profile);

  const env = options.env ?? process.env;
  const domains = normalizeEgressDomains(profile);
  const effectKinds = effectKindsFor(
    operation,
    domains,
    domains.length > 0 || hasVmNetworkSemantics(profile),
  );
  const scopes = scopesFor(operation, profile, domains);
  const targets = operationTargets(operation, profile, options.workspaceRoot, domains);
  const segments: SideEffectSegmentT[] = [
    {
      effectKinds: [...effectKinds],
      scopes: [...scopes],
      targets: [...targets],
      modifiers: [...modifiersFor(operation)],
    },
  ];
  const aggregate = aggregateSegments(segments);

  return PolicyInput.parse({
    tool: { name: operation.toolName, args: policyArgsFor(operation) },
    normalized: { argv: [], decodedLayers: [] },
    sideEffect: {
      taxonomyVersion: SIDE_EFFECT_TAXONOMY_VERSION,
      staticCapability: {
        toolName: operation.toolName,
        effectEnvelope: [...effectKinds],
        broad: true,
      },
      dynamic: {
        ...aggregate,
        composition: { kind: "atomic", segments, edges: [] },
        classifier: {
          name: "interactive-console-opaque-classifier",
          version: "1",
          confidence: "conservative",
          reasons: [
            "interactive_console_opaque",
            `interactive_console_${operation.kind}`,
            "interactive_console_slice_1",
          ],
        },
      },
      extensions: {
        "keel.interactiveConsole": extensionFor(operation, profile, domains),
      },
    },
    workspace: { path: options.workspaceRoot, trusted: options.workspaceTrusted ?? false },
    provenance: params.provenanceContext,
    egress: {
      isEgress: domains.length > 0,
      domain: domains.length === 1 ? domains[0] : null,
      gitRemote: null,
    },
    session: {
      id: params.sessionId,
      mode: "enforced",
      promptCountThisSession: 0,
    },
    principal: { osUser: env["USER"] ?? "local" },
  });
}

export function isInteractiveConsoleToolName(toolName: string): toolName is ConsoleToolName {
  return (
    toolName === CONSOLE_TOOL_NAMES.open ||
    toolName === CONSOLE_TOOL_NAMES.sendKeys ||
    toolName === CONSOLE_TOOL_NAMES.readScreen ||
    toolName === CONSOLE_TOOL_NAMES.release ||
    toolName === CONSOLE_TOOL_NAMES.close
  );
}

export { CONSOLE_TOOL_NAMES } from "./schema.js";
