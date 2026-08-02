import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  addressFromPolicyInteger,
  classifyEgressAddress,
  classifyEgressHostname,
  parseCanonicalAddress,
  policyEntryContains,
  selectLongestPolicyEntry,
  type AddressPolicyEntry,
} from "./egress-address-policy.js";
import { GENERATED_EGRESS_ADDRESS_POLICY } from "./egress-address-policy.generated.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("generated egress address-policy provenance", () => {
  it("pins all four reviewed IANA sources and their exact digests", () => {
    expect(GENERATED_EGRESS_ADDRESS_POLICY).toMatchObject({
      generatorVersion: "egress-address-policy-generator/v1",
      snapshotDate: "2026-08-01",
      sources: [
        {
          url: "https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv",
          sha256: "e4a1c06ecf8e934ed5ae30977a1477a78957da1a5fb602fc855e3f74bf01c8ac",
        },
        {
          url: "https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv",
          sha256: "8b0e181a4ef0c71fcb25403c40702f2050c2f6dc198156b6ec1a5fb746c9a73e",
        },
        {
          url: "https://www.iana.org/assignments/ipv4-address-space/ipv4-address-space.csv",
          sha256: "9e95e72c33fc9c249e180b61cf6858eb7154a85d327d8c01a11cc08a2917b45b",
        },
        {
          url: "https://www.iana.org/assignments/ipv6-unicast-address-assignments/ipv6-unicast-address-assignments.csv",
          sha256: "fc4447c17919feabe21bdaf17b4a929cef117ccb25814967f0c001dc0c981d49",
        },
      ],
    });
  });

  it("regenerates byte-for-byte from the pinned local snapshots", () => {
    expect(() =>
      execFileSync(process.execPath, ["tools/generate-egress-address-policy.mjs", "--check"], {
        cwd: repoRoot,
        encoding: "utf8",
      }),
    ).not.toThrow();
  });
});

describe("egress address classifier", () => {
  it.each([
    ["8.8.8.8", "public", "allocated-global-unicast"],
    ["1.1.1.1", "public", "allocated-global-unicast"],
    ["192.0.0.9", "public", "iana-special-globally-reachable"],
    ["192.0.0.10", "public", "iana-special-globally-reachable"],
    ["2001:4860:4860::8888", "public", "allocated-global-unicast"],
    ["2606:4700:4700::1111", "public", "allocated-global-unicast"],
    ["2001:1::1", "public", "iana-special-globally-reachable"],
  ])("classifies %s as affirmatively %s", (address, kind, reason) => {
    expect(classifyEgressAddress(address)).toMatchObject({ kind, reason });
  });

  it.each([
    ["10.0.0.1", "iana-special-non-global"],
    ["100.64.0.1", "iana-special-non-global"],
    ["100.127.255.254", "iana-special-non-global"],
    ["172.16.0.1", "iana-special-non-global"],
    ["192.168.1.1", "iana-special-non-global"],
    ["192.0.2.1", "iana-special-non-global"],
    ["198.18.0.1", "iana-special-non-global"],
    ["198.51.100.1", "iana-special-non-global"],
    ["203.0.113.1", "iana-special-non-global"],
    ["100::1", "iana-special-non-global"],
    ["2001:2::1", "iana-special-non-global"],
    ["2001:db8::1", "iana-special-non-global"],
    ["3fff::1", "iana-special-non-global"],
    ["5f00::1", "iana-special-non-global"],
    ["fc00::1", "iana-special-non-global"],
    ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "iana-special-non-global"],
  ])("classifies %s as restricted exception-capable space", (address, reason) => {
    expect(classifyEgressAddress(address)).toMatchObject({ kind: "restricted", reason });
  });

  it.each([
    ["0.0.0.0", "unspecified-or-this-network"],
    ["0.255.255.255", "unspecified-or-this-network"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.1.1", "link-local-or-metadata"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.255", "multicast"],
    ["240.0.0.1", "reserved-by-protocol"],
    ["255.255.255.255", "limited-broadcast"],
    ["168.63.129.16", "provider-metadata"],
    ["100.100.100.200", "provider-metadata"],
    ["192.0.0.170", "reserved-by-protocol"],
    ["192.0.0.171", "reserved-by-protocol"],
    ["192.88.99.1", "transition-mechanism"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["::192.0.2.1", "transition-mechanism"],
    ["64:ff9b::c000:201", "transition-mechanism"],
    ["64:ff9b:1::1", "transition-mechanism"],
    ["2001::1", "transition-mechanism"],
    ["2002:c000:0201::", "transition-mechanism"],
    ["fec0::1", "deprecated-site-local"],
    ["fe80::1", "link-local"],
    ["ff02::1", "multicast"],
    ["fd00:ec2::254", "provider-metadata"],
    ["fd20:ce::254", "provider-metadata"],
  ])("hard-denies %s as %s", (address, reason) => {
    expect(classifyEgressAddress(address)).toMatchObject({ kind: "hard-deny", reason });
  });

  it("decodes IPv4-mapped IPv6 and recursively applies IPv4 policy", () => {
    expect(classifyEgressAddress("::ffff:8.8.8.8")).toMatchObject({
      kind: "public",
      reason: "allocated-global-unicast",
      mappedIpv4: "8.8.8.8",
    });
    expect(classifyEgressAddress("::ffff:192.168.1.1")).toMatchObject({
      kind: "restricted",
      mappedIpv4: "192.168.1.1",
    });
    expect(classifyEgressAddress("::ffff:127.0.0.1")).toMatchObject({
      kind: "hard-deny",
      reason: "loopback",
      mappedIpv4: "127.0.0.1",
    });
  });

  it.each([
    "127.1",
    "2130706433",
    "0177.0.0.1",
    "0x7f.0.0.1",
    "fe80::1%lo0",
    "[::1]",
    "::ffff:999.1.1.1",
    "not-an-address",
    "",
  ])("fails closed on malformed or ambiguous form %j", (address) => {
    expect(classifyEgressAddress(address)).toMatchObject({
      kind: "hard-deny",
      reason: "malformed-address",
    });
  });

  it("normalizes canonical IPv4 and IPv6 without losing family or value", () => {
    expect(parseCanonicalAddress("192.0.2.1")).toEqual({
      family: 4,
      normalized: "192.0.2.1",
      value: 3221225985n,
    });
    expect(parseCanonicalAddress("2001:0DB8:0:0:0:0:0:1")).toEqual({
      family: 6,
      normalized: "2001:db8::1",
      value: 0x20010db8000000000000000000000001n,
    });
  });

  it("denies metadata names exactly and beneath their normalized suffixes", () => {
    for (const hostname of [
      "metadata.google.internal",
      "service.metadata.google.internal.",
      "METADATA.GOOG",
      "v1.metadata.goog",
    ]) {
      expect(classifyEgressHostname(hostname)).toMatchObject({
        kind: "hard-deny",
        reason: "provider-metadata-name",
      });
    }
    expect(classifyEgressHostname("notmetadata.goog")).toEqual({
      kind: "not-hard-denied",
      normalizedHostname: "notmetadata.goog",
    });
  });

  it("uses the most-specific matching policy entry independent of input order", () => {
    const broad: AddressPolicyEntry = {
      id: "broad",
      family: 4,
      network: "3221225472",
      prefixLength: 24,
      kind: "restricted",
      reason: "broad",
      priority: 1,
      source: "test",
    };
    const exact: AddressPolicyEntry = {
      id: "exact",
      family: 4,
      network: "3221225481",
      prefixLength: 32,
      kind: "public",
      reason: "exact",
      priority: 1,
      source: "test",
    };
    for (const entries of [
      [broad, exact],
      [exact, broad],
    ]) {
      expect(selectLongestPolicyEntry(4, 3221225481n, entries)?.id).toBe("exact");
      expect(selectLongestPolicyEntry(4, 3221225480n, entries)?.id).toBe("broad");
    }
  });

  it("covers both sides of every generated prefix boundary", () => {
    for (const entry of GENERATED_EGRESS_ADDRESS_POLICY.entries) {
      const bits = entry.family === 4 ? 32n : 128n;
      const network = BigInt(entry.network);
      const size = 1n << (bits - BigInt(entry.prefixLength));
      const last = network + size - 1n;
      expect(policyEntryContains(entry, network), `${entry.id} first`).toBe(true);
      expect(policyEntryContains(entry, last), `${entry.id} last`).toBe(true);
      if (network > 0n) {
        expect(policyEntryContains(entry, network - 1n), `${entry.id} before`).toBe(false);
      }
      const max = (1n << bits) - 1n;
      if (last < max) {
        expect(policyEntryContains(entry, last + 1n), `${entry.id} after`).toBe(false);
      }
      expect(parseCanonicalAddress(addressFromPolicyInteger(entry.family, network))).toMatchObject({
        family: entry.family,
        value: network,
      });
      expect(parseCanonicalAddress(addressFromPolicyInteger(entry.family, last))).toMatchObject({
        family: entry.family,
        value: last,
      });
    }
  });

  it("property: canonicalization round-trips and every valid address has one total class", () => {
    fc.assert(
      fc.property(fc.oneof(fc.ipV4(), fc.ipV6()), (address) => {
        const parsed = parseCanonicalAddress(address);
        expect(parsed).toBeDefined();
        const reparsed = parseCanonicalAddress(parsed!.normalized);
        expect(reparsed).toEqual(parsed);
        const classification = classifyEgressAddress(address);
        expect(["hard-deny", "restricted", "public"]).toContain(classification.kind);
      }),
      { numRuns: 500 },
    );
  });

  it("property: most-specific selection always wins", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: 0, max: 24 }),
        fc.integer({ min: 1, max: 8 }),
        (rawAddress, broadLength, extraBits) => {
          const exactLength = Math.min(32, broadLength + extraBits);
          const address = BigInt(rawAddress >>> 0);
          const mask = (length: number) =>
            length === 0 ? 0n : ((1n << BigInt(length)) - 1n) << BigInt(32 - length);
          const broad: AddressPolicyEntry = {
            id: "property-broad",
            family: 4,
            network: (address & mask(broadLength)).toString(),
            prefixLength: broadLength,
            kind: "restricted",
            reason: "broad",
            priority: 1,
            source: "test",
          };
          const exact: AddressPolicyEntry = {
            id: "property-exact",
            family: 4,
            network: (address & mask(exactLength)).toString(),
            prefixLength: exactLength,
            kind: "public",
            reason: "exact",
            priority: 1,
            source: "test",
          };
          expect(selectLongestPolicyEntry(4, address, [broad, exact])?.id).toBe(
            "property-exact",
          );
        },
      ),
      { numRuns: 500 },
    );
  });
});
