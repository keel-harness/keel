import { releasePacklistProblems } from "./release-candidate.js";

interface PackFile {
  readonly path?: unknown;
}

interface PackResult {
  readonly filename?: unknown;
  readonly files?: unknown;
}

export function parseNpmPackOutput(
  stdout: string,
  version: string,
): { readonly filename: string; readonly members: readonly string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("npm pack did not return JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("expected exactly one npm pack result");
  }
  const result = parsed[0] as PackResult;
  const expectedFilename = `keel-harness-${version}.tgz`;
  if (result.filename !== expectedFilename) {
    throw new Error(`expected npm pack filename ${expectedFilename}`);
  }
  if (!Array.isArray(result.files)) throw new Error("npm pack result has no file inventory");
  const members = result.files.map((value) => {
    const file = value as PackFile;
    if (typeof file.path !== "string" || file.path.length === 0) {
      throw new Error("npm pack result contains an invalid path");
    }
    return `package/${file.path}`;
  });
  const problems = releasePacklistProblems(members);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return { filename: expectedFilename, members };
}

export interface PackageIdentity {
  readonly name: string;
  readonly version: string;
}

interface ShrinkwrapEntry {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly dev?: unknown;
}

function packageName(path: string, entry: ShrinkwrapEntry): string | undefined {
  if (typeof entry.name === "string" && entry.name.length > 0) return entry.name;
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  return index < 0 ? undefined : path.slice(index + marker.length);
}

export function shrinkwrapPackageIdentities(
  shrinkwrap: Readonly<Record<string, unknown>>,
): PackageIdentity[] {
  const packages = shrinkwrap["packages"];
  if (packages === null || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error("npm shrinkwrap has no packages map");
  }
  const identities = new Map<string, PackageIdentity>();
  for (const [path, value] of Object.entries(packages as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as ShrinkwrapEntry;
    if (entry.dev === true || typeof entry.version !== "string") continue;
    const name = packageName(path, entry);
    if (name === undefined) throw new Error(`npm shrinkwrap package ${path} has no name`);
    const key = `${name}@${entry.version}`;
    identities.set(key, { name, version: entry.version });
  }
  return [...identities.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  );
}

function hasPrivatePath(document: unknown): boolean {
  const text = JSON.stringify(document);
  const absoluteBuilderPath = /(?:\/Users\/|\/home\/runner\/|[A-Za-z]:\\Users\\)/u.test(text);
  const noncanonicalKeelRepository =
    /github\.com(?:\/|:)(?!keel-harness\/keel(?:\.git)?(?:[/?#"]|$))[^/"\s]+\/keel(?:\.git)?/u.test(
      text,
    );
  return absoluteBuilderPath || noncanonicalKeelRepository;
}

function spdxIdentities(document: Readonly<Record<string, unknown>>): Map<string, number> {
  const packages = document["packages"];
  const identities = new Map<string, number>();
  if (!Array.isArray(packages)) return identities;
  for (const value of packages) {
    const pkg = value as Record<string, unknown>;
    if (
      pkg["primaryPackagePurpose"] === "FILE" ||
      typeof pkg["name"] !== "string" ||
      typeof pkg["versionInfo"] !== "string"
    ) {
      continue;
    }
    const key = `${pkg["name"]}@${pkg["versionInfo"]}`;
    identities.set(key, (identities.get(key) ?? 0) + 1);
  }
  return identities;
}

function cycloneIdentities(document: Readonly<Record<string, unknown>>): Map<string, number> {
  const components = document["components"];
  const identities = new Map<string, number>();
  if (!Array.isArray(components)) return identities;
  for (const value of components) {
    const component = value as Record<string, unknown>;
    if (typeof component["name"] !== "string" || typeof component["version"] !== "string") {
      continue;
    }
    const key = `${component["name"]}@${component["version"]}`;
    identities.set(key, (identities.get(key) ?? 0) + 1);
  }
  return identities;
}

export function sbomCompletenessProblems(
  spdx: Readonly<Record<string, unknown>>,
  cycloneDx: Readonly<Record<string, unknown>>,
  expected: readonly PackageIdentity[],
  tarballSha256: string,
): string[] {
  const problems: string[] = [];
  const spdxPackages = spdxIdentities(spdx);
  const cycloneComponents = cycloneIdentities(cycloneDx);
  const expectedKeys = new Set(expected.map(({ name, version }) => `${name}@${version}`));
  for (const identity of expected) {
    const key = `${identity.name}@${identity.version}`;
    if ((spdxPackages.get(key) ?? 0) === 0) problems.push(`SPDX missing ${key}`);
    if ((cycloneComponents.get(key) ?? 0) === 0) problems.push(`CycloneDX missing ${key}`);
  }
  for (const [key, count] of spdxPackages) {
    if (!expectedKeys.has(key)) problems.push(`SPDX unexpected ${key}`);
    if (count > 1) problems.push(`SPDX duplicate ${key}`);
  }
  for (const [key, count] of cycloneComponents) {
    if (!expectedKeys.has(key)) problems.push(`CycloneDX unexpected ${key}`);
    if (count > 1) problems.push(`CycloneDX duplicate ${key}`);
  }

  const rootSpdx = Array.isArray(spdx["packages"])
    ? (spdx["packages"] as unknown[]).find((value) => {
        const pkg = value as Record<string, unknown>;
        return pkg["name"] === "keel-harness";
      })
    : undefined;
  const rootChecksums = (rootSpdx as Record<string, unknown> | undefined)?.["checksums"];
  if (
    !Array.isArray(rootChecksums) ||
    !rootChecksums.some((value) => {
      const checksum = value as Record<string, unknown>;
      return checksum["algorithm"] === "SHA256" && checksum["checksumValue"] === tarballSha256;
    })
  ) {
    problems.push("SPDX root is not bound to the tarball SHA-256");
  }

  const metadata = cycloneDx["metadata"] as Record<string, unknown> | undefined;
  const rootCyclone = metadata?.["component"] as Record<string, unknown> | undefined;
  const rootHashes = rootCyclone?.["hashes"];
  if (
    !Array.isArray(rootHashes) ||
    !rootHashes.some((value) => {
      const hash = value as Record<string, unknown>;
      return hash["alg"] === "SHA-256" && hash["content"] === tarballSha256;
    })
  ) {
    problems.push("CycloneDX root is not bound to the tarball SHA-256");
  }
  if (hasPrivatePath(spdx)) problems.push("SPDX contains a private or absolute builder path");
  if (hasPrivatePath(cycloneDx)) {
    problems.push("CycloneDX contains a private or absolute builder path");
  }
  return problems;
}
