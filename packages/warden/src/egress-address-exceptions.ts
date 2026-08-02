import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { keelHome, parseJsonRejectingDuplicateKeys } from "@keel/shared";
import { z } from "zod";

import {
  addressFromPolicyInteger,
  classifyEgressAddress,
  classifyEgressHostname,
  parseCanonicalAddress,
} from "./egress-address-policy.js";
import { GENERATED_EGRESS_ADDRESS_POLICY } from "./egress-address-policy.generated.js";
import { normalizeEgressGrantDomain } from "./egress-review.js";
import type { RestrictedAddressContext } from "./egress-resolver.js";

export const EGRESS_ADDRESS_EXCEPTION_LIMITS = Object.freeze({
  maxFileBytes: 256 * 1024,
  maxWorkspaces: 128,
  maxExceptionsPerWorkspace: 256,
  maxTotalExceptions: 1_024,
  maxPortsPerException: 64,
});

export class EgressAddressExceptionStoreError extends Error {
  constructor(message: string) {
    super(`egress address exception store: ${message}`);
    this.name = "EgressAddressExceptionStoreError";
  }
}

export interface EgressAddressException {
  readonly host: string;
  readonly cidr: string;
  readonly ports: readonly number[];
}

export interface EgressAddressExceptionSnapshot {
  readonly revision: "none" | `sha256:${string}`;
  readonly workspaceRealpath: string;
  readonly exceptions: readonly EgressAddressException[];
  readonly allowsRestrictedAddress: (context: RestrictedAddressContext) => boolean;
}

export interface EgressAddressExceptionStoreDeps {
  readonly effectiveUid?: () => number;
  /** Deterministic race seam used only after the initial path identity is captured. */
  readonly afterInitialLstat?: () => void;
}

interface CanonicalCidr {
  readonly family: 4 | 6;
  readonly network: bigint;
  readonly last: bigint;
  readonly normalized: string;
}

interface CompiledException extends EgressAddressException {
  readonly range: CanonicalCidr;
}

const PortList = z
  .array(z.number().int().min(1).max(65_535))
  .min(1)
  .max(EGRESS_ADDRESS_EXCEPTION_LIMITS.maxPortsPerException, "port limit exceeded");

const PersistedException = z
  .object({
    host: z.string(),
    cidr: z.string(),
    ports: PortList,
  })
  .strict();

const PersistedWorkspace = z
  .object({
    realpath: z.string(),
    exceptions: z
      .array(PersistedException)
      .max(EGRESS_ADDRESS_EXCEPTION_LIMITS.maxExceptionsPerWorkspace, "exception limit exceeded"),
  })
  .strict();

const PersistedStore = z
  .object({
    version: z.literal(1),
    workspaces: z
      .array(PersistedWorkspace)
      .max(EGRESS_ADDRESS_EXCEPTION_LIMITS.maxWorkspaces, "workspace limit exceeded"),
  })
  .strict();

type PersistedStoreT = z.infer<typeof PersistedStore>;

const IPV4_MAPPED_BASE = 0xffffn << 32n;
const IPV4_SPACE_SIZE = 1n << 32n;

function fail(message: string): never {
  throw new EgressAddressExceptionStoreError(message);
}

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function effectiveUid(deps: EgressAddressExceptionStoreDeps): number {
  const uid = deps.effectiveUid?.() ?? process.geteuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    return fail("effective-user ownership is unavailable");
  }
  return uid;
}

function requireOwnerOnlyHome(home: string, uid: number): string {
  const absolute = resolve(home);
  let identity: BigIntStats;
  let physical: string;
  try {
    identity = lstatSync(absolute, { bigint: true });
    physical = realpathSync(absolute);
  } catch {
    return fail("KEEL_HOME must be a real owner-only directory");
  }
  if (
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    physical !== absolute ||
    identity.uid !== BigInt(uid) ||
    (identity.mode & 0o777n) !== 0o700n
  ) {
    return fail("KEEL_HOME must be a real owner-only mode-0700 directory");
  }
  return physical;
}

function requireWorkspaceRealpath(workspaceRoot: string): string {
  try {
    return realpathSync(resolve(workspaceRoot));
  } catch {
    return fail("trusted workspace realpath is unavailable");
  }
}

function readSecureStoreFile(
  path: string,
  uid: number,
  deps: EgressAddressExceptionStoreDeps,
): string | undefined {
  let initial: BigIntStats;
  try {
    initial = lstatSync(path, { bigint: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    return fail("exception file lstat failed");
  }
  if (!initial.isFile() || initial.isSymbolicLink()) {
    return fail("exception file must be a no-follow regular file");
  }
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    return fail("no-follow file identity is unavailable");
  }
  if (initial.size > BigInt(EGRESS_ADDRESS_EXCEPTION_LIMITS.maxFileBytes)) {
    return fail("exception file size limit exceeded");
  }

  deps.afterInitialLstat?.();
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (!sameIdentity(initial, opened) || !sameIdentity(opened, current)) {
      return fail("exception file identity changed during open");
    }
    if (!opened.isFile() || opened.uid !== BigInt(uid) || (opened.mode & 0o777n) !== 0o600n) {
      return fail("exception file must be owner-owned mode-0600 regular file");
    }
    if (opened.size > BigInt(EGRESS_ADDRESS_EXCEPTION_LIMITS.maxFileBytes)) {
      return fail("exception file size limit exceeded");
    }

    const text = readFileSync(fd, { encoding: "utf8" });
    const afterRead = fstatSync(fd, { bigint: true });
    const finalPath = lstatSync(path, { bigint: true });
    if (
      !sameIdentity(opened, afterRead) ||
      !sameIdentity(afterRead, finalPath) ||
      opened.size !== afterRead.size ||
      opened.mtimeNs !== afterRead.mtimeNs ||
      opened.ctimeNs !== afterRead.ctimeNs ||
      BigInt(Buffer.byteLength(text, "utf8")) !== opened.size
    ) {
      return fail("exception file changed during read");
    }
    return text;
  } catch (error) {
    if (error instanceof EgressAddressExceptionStoreError) throw error;
    return fail("exception file no-follow read failed");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function prefixRange(family: 4 | 6, network: bigint, prefixLength: number) {
  const bits = family === 4 ? 32 : 128;
  const hostBits = BigInt(bits - prefixLength);
  const size = 1n << hostBits;
  const canonicalNetwork = (network >> hostBits) << hostBits;
  return { network: canonicalNetwork, last: canonicalNetwork + size - 1n };
}

function addPolicyBoundaries(points: Set<bigint>, family: 4 | 6, start: bigint, end: bigint): void {
  const addRange = (entryStart: bigint, entryEnd: bigint): void => {
    if (entryEnd < start || entryStart > end) return;
    if (entryStart > start) points.add(entryStart);
    const after = entryEnd + 1n;
    if (after > start && after <= end) points.add(after);
  };

  for (const entry of GENERATED_EGRESS_ADDRESS_POLICY.entries) {
    if (entry.family !== family) continue;
    const range = prefixRange(entry.family, BigInt(entry.network), entry.prefixLength);
    addRange(range.network, range.last);
  }

  if (family === 6) {
    addRange(IPV4_MAPPED_BASE, IPV4_MAPPED_BASE + IPV4_SPACE_SIZE - 1n);
    for (const entry of GENERATED_EGRESS_ADDRESS_POLICY.entries) {
      if (entry.family !== 4) continue;
      const range = prefixRange(4, BigInt(entry.network), entry.prefixLength);
      addRange(IPV4_MAPPED_BASE + range.network, IPV4_MAPPED_BASE + range.last);
    }
  }
}

function rangeIsEntirelyRestricted(range: CanonicalCidr): boolean {
  const points = new Set<bigint>([range.network]);
  addPolicyBoundaries(points, range.family, range.network, range.last);
  for (const point of points) {
    if (
      classifyEgressAddress(addressFromPolicyInteger(range.family, point)).kind !== "restricted"
    ) {
      return false;
    }
  }
  return true;
}

function parseCanonicalRestrictedCidr(value: string): CanonicalCidr {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash !== value.lastIndexOf("/")) return fail("CIDR is malformed");
  const addressText = value.slice(0, slash);
  const prefixText = value.slice(slash + 1);
  const address = parseCanonicalAddress(addressText);
  if (address === undefined || !/^(?:0|[1-9]\d{0,2})$/u.test(prefixText)) {
    return fail("CIDR is malformed");
  }
  const prefixLength = Number(prefixText);
  const bits = address.family === 4 ? 32 : 128;
  if (prefixLength > bits) return fail("CIDR prefix is outside the address family");
  const range = prefixRange(address.family, address.value, prefixLength);
  if (range.network !== address.value) return fail("CIDR must use its canonical network address");
  const normalized = `${address.normalized}/${String(prefixLength)}`;
  if (normalized !== value) return fail("CIDR must be canonical");
  const parsed = { family: address.family, ...range, normalized };
  if (!rangeIsEntirelyRestricted(parsed)) {
    return fail("CIDR must cover restricted addresses only and no hard denial");
  }
  return parsed;
}

function canonicalHost(value: string): string {
  let normalized: string;
  try {
    normalized = normalizeEgressGrantDomain(value);
  } catch {
    return fail("host must be one canonical exact ASCII DNS name");
  }
  if (
    normalized !== value ||
    parseCanonicalAddress(value) !== undefined ||
    classifyEgressHostname(value).kind === "hard-deny"
  ) {
    return fail("host must be one canonical exact ASCII DNS name");
  }
  return normalized;
}

function canonicalWorkspaceKey(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value) {
    return fail("workspace key must be an absolute canonical realpath");
  }
  return value;
}

function compileStore(raw: unknown): {
  readonly store: PersistedStoreT;
  readonly compiled: ReadonlyMap<string, readonly CompiledException[]>;
} {
  const parsed = PersistedStore.safeParse(raw);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "strict schema validation failed");
  }
  const total = parsed.data.workspaces.reduce(
    (count, workspace) => count + workspace.exceptions.length,
    0,
  );
  if (total > EGRESS_ADDRESS_EXCEPTION_LIMITS.maxTotalExceptions) {
    return fail("total exception limit exceeded");
  }

  const compiled = new Map<string, readonly CompiledException[]>();
  for (const workspace of parsed.data.workspaces) {
    const workspaceRealpath = canonicalWorkspaceKey(workspace.realpath);
    if (compiled.has(workspaceRealpath)) return fail("duplicate workspace realpath");
    const seen = new Set<string>();
    const entries = workspace.exceptions.map((entry) => {
      const host = canonicalHost(entry.host);
      const range = parseCanonicalRestrictedCidr(entry.cidr);
      const ports = [...entry.ports];
      if (new Set(ports).size !== ports.length) return fail("ports must be duplicate-free");
      const key = `${host}\0${range.normalized}\0${ports.join(",")}`;
      if (seen.has(key)) return fail("duplicate exception entry");
      seen.add(key);
      return { host, cidr: range.normalized, ports, range };
    });
    compiled.set(workspaceRealpath, entries);
  }
  return { store: parsed.data, compiled };
}

function publicEntries(entries: readonly CompiledException[]): readonly EgressAddressException[] {
  return Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        host: entry.host,
        cidr: entry.cidr,
        ports: Object.freeze([...entry.ports]),
      }),
    ),
  );
}

export function egressAddressExceptionFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(keelHome(env), "egress-address-exceptions.v1.json");
}

export function loadEgressAddressExceptionSnapshot(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: EgressAddressExceptionStoreDeps = {},
): EgressAddressExceptionSnapshot {
  const uid = effectiveUid(deps);
  const home = requireOwnerOnlyHome(keelHome(env), uid);
  const workspaceRealpath = requireWorkspaceRealpath(workspaceRoot);
  const text = readSecureStoreFile(join(home, "egress-address-exceptions.v1.json"), uid, deps);

  let revision: EgressAddressExceptionSnapshot["revision"] = "none";
  let selected: readonly CompiledException[] = [];
  if (text !== undefined) {
    let raw: unknown;
    try {
      raw = parseJsonRejectingDuplicateKeys(text);
    } catch (error) {
      return fail(error instanceof Error ? error.message : "JSON parse failed");
    }
    const compiled = compileStore(raw).compiled;
    selected = compiled.get(workspaceRealpath) ?? [];
    revision = `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
  }

  const exposed = publicEntries(selected);
  const allowsRestrictedAddress = (context: RestrictedAddressContext): boolean => {
    if (context.classification.kind !== "restricted") return false;
    const address = parseCanonicalAddress(context.address);
    if (address === undefined || address.family !== context.family) return false;
    return selected.some(
      (entry) =>
        entry.host === context.hostname &&
        entry.ports.includes(context.port) &&
        entry.range.family === address.family &&
        address.value >= entry.range.network &&
        address.value <= entry.range.last,
    );
  };

  return Object.freeze({
    revision,
    workspaceRealpath,
    exceptions: exposed,
    allowsRestrictedAddress,
  });
}
