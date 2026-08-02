import { isIP } from "node:net";

import { GENERATED_EGRESS_ADDRESS_POLICY } from "./egress-address-policy.generated.js";

export type EgressAddressPolicyKind = "hard-deny" | "restricted" | "public";

export interface AddressPolicyEntry {
  readonly id: string;
  readonly family: 4 | 6;
  readonly network: string;
  readonly prefixLength: number;
  readonly kind: EgressAddressPolicyKind;
  readonly reason: string;
  readonly priority: number;
  readonly source: string;
}

export interface CanonicalAddress {
  readonly family: 4 | 6;
  readonly normalized: string;
  readonly value: bigint;
}

export interface EgressAddressClassification {
  readonly kind: EgressAddressPolicyKind;
  readonly reason: string;
  readonly normalizedAddress?: string;
  readonly family?: 4 | 6;
  readonly policyEntryId?: string;
  readonly mappedIpv4?: string;
}

export type EgressHostnameClassification =
  | {
      readonly kind: "hard-deny";
      readonly reason: "provider-metadata-name" | "malformed-hostname";
      readonly normalizedHostname?: string;
    }
  | {
      readonly kind: "not-hard-denied";
      readonly normalizedHostname: string;
    };

const GENERATED_ENTRIES: readonly AddressPolicyEntry[] = GENERATED_EGRESS_ADDRESS_POLICY.entries;
const IPV4_MAPPED_PREFIX = 0xffffn;
const MAX_IPV4 = (1n << 32n) - 1n;
const MAX_IPV6 = (1n << 128n) - 1n;
const HARD_DENIED_HOSTNAME_SUFFIXES = ["metadata.google.internal", "metadata.goog"];

function parseValidatedIpv4(address: string): bigint {
  // The sole caller first requires Node's authoritative isIP(address) === 4 result.
  return address.split(".").reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n);
}

function parseNormalizedIpv6(address: string): bigint | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const splitHalf = (half: string): string[] => (half === "" ? [] : half.split(":"));
  const left = splitHalf(halves[0] ?? "");
  const right = splitHalf(halves[1] ?? "");
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) {
    return undefined;
  }
  const groups = [...left, ...Array.from({ length: omitted }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return undefined;
  }
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function normalizeIpv6(address: string): string | undefined {
  try {
    const hostname = new URL(`http://[${address}]/`).hostname;
    if (!hostname.startsWith("[") || !hostname.endsWith("]")) return undefined;
    return hostname.slice(1, -1);
  } catch {
    return undefined;
  }
}

export function parseCanonicalAddress(address: string): CanonicalAddress | undefined {
  if (address.length === 0 || address !== address.trim() || address.includes("%")) {
    return undefined;
  }
  const family = isIP(address);
  if (family === 4) {
    const value = parseValidatedIpv4(address);
    return { family: 4, normalized: address, value };
  }
  if (family === 6) {
    const normalized = normalizeIpv6(address);
    if (normalized === undefined) return undefined;
    const value = parseNormalizedIpv6(normalized);
    if (value === undefined) return undefined;
    return { family: 6, normalized, value };
  }
  return undefined;
}

export function addressFromPolicyInteger(family: 4 | 6, value: bigint): string {
  const maximum = family === 4 ? MAX_IPV4 : MAX_IPV6;
  if (value < 0n || value > maximum) {
    throw new RangeError(`address value is outside IPv${family} range`);
  }
  if (family === 4) {
    return [24n, 16n, 8n, 0n]
      .map((shift) => Number((value >> shift) & 0xffn).toString(10))
      .join(".");
  }
  const expanded = Array.from({ length: 8 }, (_, index) =>
    ((value >> BigInt((7 - index) * 16)) & 0xffffn).toString(16),
  ).join(":");
  const normalized = normalizeIpv6(expanded);
  if (normalized === undefined) throw new Error("failed to format valid IPv6 integer");
  return normalized;
}

export function policyEntryContains(entry: AddressPolicyEntry, address: bigint): boolean {
  const bits = entry.family === 4 ? 32 : 128;
  if (
    address < 0n ||
    address >= 1n << BigInt(bits) ||
    entry.prefixLength < 0 ||
    entry.prefixLength > bits
  ) {
    return false;
  }
  const hostBits = BigInt(bits - entry.prefixLength);
  const network = BigInt(entry.network);
  return hostBits === 0n ? address === network : (address >> hostBits) << hostBits === network;
}

export function selectLongestPolicyEntry(
  family: 4 | 6,
  address: bigint,
  entries: readonly AddressPolicyEntry[] = GENERATED_ENTRIES,
): AddressPolicyEntry | undefined {
  let selected: AddressPolicyEntry | undefined;
  for (const entry of entries) {
    if (entry.family !== family || !policyEntryContains(entry, address)) continue;
    if (
      selected === undefined ||
      entry.prefixLength > selected.prefixLength ||
      (entry.prefixLength === selected.prefixLength && entry.priority > selected.priority) ||
      (entry.prefixLength === selected.prefixLength &&
        entry.priority === selected.priority &&
        entry.id.localeCompare(selected.id) < 0)
    ) {
      selected = entry;
    }
  }
  return selected;
}

function classifyParsedAddress(parsed: CanonicalAddress): EgressAddressClassification {
  if (parsed.family === 6 && parsed.value >> 32n === IPV4_MAPPED_PREFIX) {
    const mappedIpv4 = addressFromPolicyInteger(4, parsed.value & MAX_IPV4);
    return { ...classifyEgressAddress(mappedIpv4), mappedIpv4 };
  }

  const entry = selectLongestPolicyEntry(parsed.family, parsed.value);
  if (entry === undefined) {
    return {
      kind: "hard-deny",
      reason: "unallocated-or-reserved",
      normalizedAddress: parsed.normalized,
      family: parsed.family,
    };
  }
  return {
    kind: entry.kind,
    reason: entry.reason,
    normalizedAddress: parsed.normalized,
    family: parsed.family,
    policyEntryId: entry.id,
  };
}

export function classifyEgressAddress(address: string): EgressAddressClassification {
  const parsed = parseCanonicalAddress(address);
  if (parsed === undefined) return { kind: "hard-deny", reason: "malformed-address" };
  return classifyParsedAddress(parsed);
}

function normalizeHostname(hostname: string): string | undefined {
  if (hostname.length === 0 || hostname !== hostname.trim()) return undefined;
  const withoutRootDot = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (
    withoutRootDot.length === 0 ||
    withoutRootDot.length > 253 ||
    withoutRootDot.includes("..") ||
    !/^[a-z0-9.-]+$/i.test(withoutRootDot)
  ) {
    return undefined;
  }
  return withoutRootDot.toLowerCase();
}

export function classifyEgressHostname(hostname: string): EgressHostnameClassification {
  const normalizedHostname = normalizeHostname(hostname);
  if (normalizedHostname === undefined) {
    return { kind: "hard-deny", reason: "malformed-hostname" };
  }
  if (
    HARD_DENIED_HOSTNAME_SUFFIXES.some(
      (suffix) => normalizedHostname === suffix || normalizedHostname.endsWith(`.${suffix}`),
    )
  ) {
    return {
      kind: "hard-deny",
      reason: "provider-metadata-name",
      normalizedHostname,
    };
  }
  return { kind: "not-hard-denied", normalizedHostname };
}
