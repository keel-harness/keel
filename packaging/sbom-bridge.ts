import { createHash } from "node:crypto";

interface SyftLocation {
  readonly path: string;
  readonly [key: string]: unknown;
}

interface SyftArtifact {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly type: string;
  readonly foundBy?: string;
  readonly locations: readonly SyftLocation[];
  readonly licenses: readonly unknown[];
  readonly language?: string;
  readonly cpes?: readonly unknown[];
  readonly purl: string;
  readonly metadataType?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

interface SyftRelationship {
  readonly parent: string;
  readonly child: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface SyftNativeDocument {
  readonly artifacts: readonly SyftArtifact[];
  readonly artifactRelationships: readonly SyftRelationship[];
  readonly files: readonly unknown[];
  readonly source: Readonly<Record<string, unknown>>;
  readonly descriptor: Readonly<Record<string, unknown>>;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

interface BundledComponent {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly source: string;
}

export interface BundledInventory {
  readonly components: readonly BundledComponent[];
  readonly [key: string]: unknown;
}

export interface SbomIdentity {
  readonly version: string;
  readonly sourceCommit: string;
  readonly sourceDateEpoch: number;
  readonly tarballSha256: string;
}

const PERMISSIVE_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
]);
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function purlName(name: string): string {
  if (!name.startsWith("@")) return encodeURIComponent(name);
  const [scope, packageName] = name.slice(1).split("/");
  if (scope === undefined || packageName === undefined || packageName.length === 0) {
    throw new Error(`invalid scoped package ${name}`);
  }
  return `%40${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}`;
}

function stableId(component: BundledComponent): string {
  return createHash("sha256")
    .update(`keel-bundled:${component.name}@${component.version}`)
    .digest("hex")
    .slice(0, 16);
}

function rewriteLockEvidencePath(value: unknown): unknown {
  if (typeof value === "string") {
    return value === "package-lock.json"
      ? "npm-shrinkwrap.json"
      : value.replaceAll("/package-lock.json", "/npm-shrinkwrap.json");
  }
  if (Array.isArray(value)) return value.map((item) => rewriteLockEvidencePath(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        rewriteLockEvidencePath(item),
      ]),
    );
  }
  return value;
}

export function mergeBundledComponentsIntoSyft(
  document: SyftNativeDocument,
  inventory: BundledInventory,
): SyftNativeDocument {
  const normalizedDocument = rewriteLockEvidencePath(document) as SyftNativeDocument;
  const root = normalizedDocument.artifacts.find(
    ({ name, version }) => name === "keel-harness" && EXACT_VERSION.test(version),
  );
  if (root === undefined) throw new Error("Syft inventory has no keel-harness root package");
  const artifacts = normalizedDocument.artifacts.map((artifact) => ({ ...artifact }));
  const relationships = normalizedDocument.artifactRelationships.map((relationship) => ({
    ...relationship,
  }));
  const known = new Set(artifacts.map(({ name, version }) => `${name}@${version}`));
  const inventoryKeys = new Set<string>();

  for (const component of inventory.components) {
    const key = `${component.name}@${component.version}`;
    if (inventoryKeys.has(key)) throw new Error(`duplicate bundled component ${key}`);
    inventoryKeys.add(key);
    if (!PERMISSIVE_LICENSES.has(component.license)) {
      throw new Error(`unsupported bundled license ${component.license} for ${key}`);
    }
    if (!EXACT_VERSION.test(component.version)) {
      throw new Error(`invalid bundled version ${key}`);
    }
    if (known.has(key)) continue;
    const id = stableId(component);
    artifacts.push({
      id,
      name: component.name,
      version: component.version,
      type: "npm",
      foundBy: "keel-bun-metafile-bridge",
      locations: [{ path: `/THIRD_PARTY_LICENSES/components.json#${key}` }],
      licenses: [
        {
          value: component.license,
          spdxExpression: component.license,
          type: "declared",
          urls: [],
          locations: [{ path: `/THIRD_PARTY_LICENSES/components.json#${key}` }],
        },
      ],
      language: "javascript",
      cpes: [],
      purl: `pkg:npm/${purlName(component.name)}@${component.version}`,
      metadataType: "javascript-npm-package-lock-entry",
      metadata: { resolved: "", integrity: "", dependencies: {} },
    });
    relationships.push({ parent: id, child: root.id, type: "dependency-of" });
    known.add(key);
  }

  artifacts.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version) ||
      left.id.localeCompare(right.id),
  );
  relationships.sort(
    (left, right) =>
      left.parent.localeCompare(right.parent) ||
      left.child.localeCompare(right.child) ||
      left.type.localeCompare(right.type),
  );
  return { ...normalizedDocument, artifacts, artifactRelationships: relationships };
}

function assertSbomIdentity(identity: SbomIdentity): void {
  if (!EXACT_VERSION.test(identity.version)) throw new Error("invalid SBOM version");
  if (!/^[0-9a-f]{40}$/u.test(identity.sourceCommit)) throw new Error("invalid source commit");
  if (!Number.isSafeInteger(identity.sourceDateEpoch) || identity.sourceDateEpoch < 0) {
    throw new Error("invalid source date epoch");
  }
  if (!/^[0-9a-f]{64}$/u.test(identity.tarballSha256)) {
    throw new Error("invalid tarball SHA-256");
  }
}

function stableUuid(digest: string): string {
  const chars = digest.slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeSpdx(
  document: Readonly<Record<string, unknown>>,
  identity: SbomIdentity,
): Record<string, unknown> {
  assertSbomIdentity(identity);
  const creationInfo = document["creationInfo"] as Record<string, unknown> | undefined;
  const packages = document["packages"];
  if (!Array.isArray(packages)) throw new Error("SPDX document has no packages");
  let rootFound = false;
  const normalizedPackages = packages.map((value) => {
    const pkg = value as Record<string, unknown>;
    if (pkg["name"] !== "keel-harness" || pkg["versionInfo"] !== identity.version) return pkg;
    rootFound = true;
    return {
      ...pkg,
      checksums: [{ algorithm: "SHA256", checksumValue: identity.tarballSha256 }],
    };
  });
  if (!rootFound) throw new Error("SPDX document has no exact keel-harness root package");
  return {
    ...document,
    name: `keel-harness-${identity.version}`,
    documentNamespace: `${publicSbomRoot(identity)}/spdx`,
    creationInfo: {
      ...creationInfo,
      created: new Date(identity.sourceDateEpoch * 1_000).toISOString(),
    },
    packages: normalizedPackages,
  };
}

function publicSbomRoot(identity: SbomIdentity): string {
  return `https://github.com/keel-harness/keel/sbom/${identity.sourceCommit}/${identity.tarballSha256}`;
}

export function normalizeCycloneDx(
  document: Readonly<Record<string, unknown>>,
  identity: SbomIdentity,
): Record<string, unknown> {
  assertSbomIdentity(identity);
  const metadata = document["metadata"] as Record<string, unknown> | undefined;
  const components = document["components"];
  if (!Array.isArray(components)) throw new Error("CycloneDX document has no components");
  const normalizedComponents = components.map((value) => {
    const component = value as Record<string, unknown>;
    if (component["name"] !== "keel-harness" || component["version"] !== identity.version) {
      return component;
    }
    return {
      ...component,
      hashes: [{ alg: "SHA-256", content: identity.tarballSha256 }],
    };
  });
  return {
    ...document,
    serialNumber: `urn:uuid:${stableUuid(identity.tarballSha256)}`,
    metadata: {
      ...metadata,
      timestamp: new Date(identity.sourceDateEpoch * 1_000).toISOString(),
      component: {
        type: "application",
        name: "keel-harness",
        version: identity.version,
        purl: `pkg:npm/keel-harness@${identity.version}`,
        hashes: [{ alg: "SHA-256", content: identity.tarballSha256 }],
      },
    },
    components: normalizedComponents,
  };
}
