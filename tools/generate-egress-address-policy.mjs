#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const GENERATOR_VERSION = "egress-address-policy-generator/v1";
const SNAPSHOT_DATE = "2026-08-01";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotRoot = resolve(repoRoot, "docs/research/iana-snapshots", SNAPSHOT_DATE);
const outputPath = resolve(repoRoot, "packages/warden/src/egress-address-policy.generated.ts");

const sources = [
  {
    key: "ipv4Special",
    filename: "iana-ipv4-special-registry.csv",
    url: "https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv",
    sha256: "e4a1c06ecf8e934ed5ae30977a1477a78957da1a5fb602fc855e3f74bf01c8ac",
  },
  {
    key: "ipv6Special",
    filename: "iana-ipv6-special-registry.csv",
    url: "https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv",
    sha256: "8b0e181a4ef0c71fcb25403c40702f2050c2f6dc198156b6ec1a5fb746c9a73e",
  },
  {
    key: "ipv4Allocation",
    filename: "ipv4-address-space.csv",
    url: "https://www.iana.org/assignments/ipv4-address-space/ipv4-address-space.csv",
    sha256: "9e95e72c33fc9c249e180b61cf6858eb7154a85d327d8c01a11cc08a2917b45b",
  },
  {
    key: "ipv6Allocation",
    filename: "ipv6-unicast-address-assignments.csv",
    url: "https://www.iana.org/assignments/ipv6-unicast-address-assignments/ipv6-unicast-address-assignments.csv",
    sha256: "fc4447c17919feabe21bdaf17b4a929cef117ccb25814967f0c001dc0c981d49",
  },
];

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// RFC 4180 parser, including escaped quotes and newlines inside quoted fields.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("unterminated quoted CSV field");
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  const [headers, ...records] = rows;
  if (!headers) throw new Error("CSV snapshot is empty");
  return records
    .filter((record) => record.some((value) => value !== ""))
    .map((record) =>
      Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""])),
    );
}

function readSnapshots() {
  return Object.fromEntries(
    sources.map((source) => {
      const text = readFileSync(resolve(snapshotRoot, source.filename), "utf8");
      const actualDigest = sha256(text);
      if (actualDigest !== source.sha256) {
        throw new Error(
          `${source.filename}: SHA-256 mismatch; expected ${source.sha256}, got ${actualDigest}`,
        );
      }
      return [source.key, parseCsv(text)];
    }),
  );
}

function parseIpv4(address) {
  const octets = address.split(".");
  if (octets.length !== 4) throw new Error(`invalid IPv4 address: ${address}`);
  let value = 0n;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) throw new Error(`invalid IPv4 address: ${address}`);
    const numeric = Number(octet);
    if (numeric > 255) throw new Error(`invalid IPv4 address: ${address}`);
    value = (value << 8n) | BigInt(numeric);
  }
  return value;
}

function parseIpv6(address) {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) throw new Error(`invalid IPv6 address: ${address}`);
  const parseHalf = (half) => (half === "" ? [] : half.split(":"));
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) {
    throw new Error(`invalid IPv6 address: ${address}`);
  }
  const groups = [...left, ...Array.from({ length: omitted }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    throw new Error(`invalid IPv6 address: ${address}`);
  }
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function parseCidr(cidr, familyHint) {
  const cleaned = cidr.replace(/\s*\[\d+\]\s*/g, "").trim();
  const [address, rawPrefixLength, ...remainder] = cleaned.split("/");
  if (!address || !rawPrefixLength || remainder.length > 0) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const family = familyHint ?? (address.includes(":") ? 6 : 4);
  const bits = family === 4 ? 32 : 128;
  const prefixLength = Number(rawPrefixLength);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > bits) {
    throw new Error(`invalid CIDR prefix length: ${cidr}`);
  }
  const value = family === 4 ? parseIpv4(address) : parseIpv6(address);
  const hostBits = BigInt(bits - prefixLength);
  const network = hostBits === 0n ? value : (value >> hostBits) << hostBits;
  return { family, network: network.toString(), prefixLength };
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function makeEntry({ cidr, id, kind, reason, priority, source, family }) {
  return { id, ...parseCidr(cidr, family), kind, reason, priority, source };
}

function allocationEntries(rows, family) {
  return rows.map((row, index) => {
    let cidr = row.Prefix;
    if (family === 4) {
      const firstOctet = Number(cidr.split("/")[0]);
      cidr = `${firstOctet}.0.0.0/8`;
    }
    const status = (row.Status ?? row["Status [1]"] ?? "").trim();
    const allocated = status === "ALLOCATED" || status === "LEGACY";
    return makeEntry({
      cidr,
      family,
      id: `iana-v${family}-allocation-${index}-${slug(cidr)}`,
      kind: allocated ? "public" : "hard-deny",
      reason: allocated ? "allocated-global-unicast" : "unallocated-or-reserved",
      priority: 1,
      source: family === 4 ? "iana-ipv4-address-space" : "iana-ipv6-unicast-assignments",
    });
  });
}

function specialEntries(rows, family) {
  return rows.flatMap((row, rowIndex) => {
    const blocks = row["Address Block"]
      .split(",")
      .map((block) => block.trim())
      .filter(Boolean);
    return blocks.map((cidr, blockIndex) => {
      const globallyReachable = row["Globally Reachable"].trim() === "True";
      const reservedByProtocol = row["Reserved-by-Protocol"].trim() === "True";
      return makeEntry({
        cidr,
        family,
        id: `iana-v${family}-special-${rowIndex}-${blockIndex}-${slug(row.Name)}`,
        kind: reservedByProtocol ? "hard-deny" : globallyReachable ? "public" : "restricted",
        reason: reservedByProtocol
          ? "reserved-by-protocol"
          : globallyReachable
            ? "iana-special-globally-reachable"
            : "iana-special-non-global",
        priority: 2,
        source: family === 4 ? "iana-ipv4-special-registry" : "iana-ipv6-special-registry",
      });
    });
  });
}

const hardDenyOverlays = [
  ["0.0.0.0/8", "unspecified-or-this-network"],
  ["0.0.0.0/32", "unspecified-or-this-network"],
  ["127.0.0.0/8", "loopback"],
  ["169.254.0.0/16", "link-local-or-metadata"],
  ["224.0.0.0/4", "multicast"],
  ...Array.from({ length: 16 }, (_, index) => [`${224 + index}.0.0.0/8`, "multicast"]),
  ["240.0.0.0/4", "reserved-by-protocol"],
  ...Array.from({ length: 16 }, (_, index) => [`${240 + index}.0.0.0/8`, "reserved-by-protocol"]),
  ["255.255.255.255/32", "limited-broadcast"],
  ["168.63.129.16/32", "provider-metadata"],
  ["100.100.100.200/32", "provider-metadata"],
  ["192.88.99.0/24", "transition-mechanism"],
  ["::/128", "unspecified"],
  ["::1/128", "loopback"],
  ["::/96", "transition-mechanism"],
  ["64:ff9b::/96", "transition-mechanism"],
  ["64:ff9b:1::/48", "transition-mechanism"],
  ["2001::/32", "transition-mechanism"],
  ["2002::/16", "transition-mechanism"],
  ["fec0::/10", "deprecated-site-local"],
  ["fe80::/10", "link-local"],
  ["ff00::/8", "multicast"],
  ["fd00:ec2::254/128", "provider-metadata"],
  ["fd20:ce::254/128", "provider-metadata"],
];

function overlayEntries() {
  return hardDenyOverlays.map(([cidr, reason], index) =>
    makeEntry({
      cidr,
      id: `keel-hard-deny-${index}-${slug(reason)}`,
      kind: "hard-deny",
      reason,
      priority: 3,
      source: "keel-adr-0086-hard-deny-overlay",
    }),
  );
}

function compareEntries(left, right) {
  return (
    left.family - right.family ||
    right.prefixLength - left.prefixLength ||
    right.priority - left.priority ||
    (BigInt(left.network) < BigInt(right.network)
      ? -1
      : BigInt(left.network) > BigInt(right.network)
        ? 1
        : 0) ||
    left.id.localeCompare(right.id)
  );
}

function generate() {
  const snapshots = readSnapshots();
  const entries = [
    ...allocationEntries(snapshots.ipv4Allocation, 4),
    ...allocationEntries(snapshots.ipv6Allocation, 6),
    ...specialEntries(snapshots.ipv4Special, 4),
    ...specialEntries(snapshots.ipv6Special, 6),
    ...overlayEntries(),
  ].sort(compareEntries);

  const artifact = {
    generatorVersion: GENERATOR_VERSION,
    snapshotDate: SNAPSHOT_DATE,
    sources: sources.map(({ url, sha256: digest }) => ({ url, sha256: digest })),
    entries,
  };
  return [
    "// Generated by tools/generate-egress-address-policy.mjs. Do not edit by hand.",
    `export const GENERATED_EGRESS_ADDRESS_POLICY = ${JSON.stringify(artifact, null, 2)} as const;`,
    "",
  ].join("\n");
}

const generated = await format(generate(), {
  parser: "typescript",
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  printWidth: 100,
});
if (process.argv.includes("--check")) {
  const current = readFileSync(outputPath, "utf8");
  if (current !== generated) {
    throw new Error(
      "generated egress address policy is stale; run node tools/generate-egress-address-policy.mjs",
    );
  }
} else {
  writeFileSync(outputPath, generated);
}
