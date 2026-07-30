export interface PackageManifest {
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

export const NPX_BUNDLED_WORKSPACE_MANIFESTS = [
  "packages/kernel/package.json",
  "packages/shared/package.json",
  "packages/warden/package.json",
] as const;

/** Runtime packages whose reviewed installed bytes must ship inside the npx bundle. Keep React
 * external so application code and the bundled Ink reconciler share one runtime instance. */
export const NPX_BUNDLED_RUNTIME_PACKAGES = [
  { name: "ink", version: "7.0.5", license: "MIT", licenseFile: "license" },
  { name: "cli-truncate", version: "6.0.0", license: "MIT", licenseFile: "license" },
  { name: "slice-ansi", version: "9.0.0", license: "MIT", licenseFile: "license" },
  { name: "cli-boxes", version: "4.0.1", license: "MIT", licenseFile: "license" },
] as const;

export const NPX_BUNDLED_RUNTIME_DEPENDENCIES = NPX_BUNDLED_RUNTIME_PACKAGES.map(
  ({ name }) => name,
);

const PERMISSIVE_BUNDLED_LICENSES = new Set(["Apache-2.0", "BSD-3-Clause", "ISC", "MIT"]);

/**
 * Reduce Bun's exact module graph to the installed package manifests that contributed bytes.
 * The last `node_modules/` segment is intentional: pnpm paths contain both its virtual-store
 * segment and the package's real segment. Keeping manifest paths (rather than names) preserves
 * simultaneous versions such as string-width@5 and string-width@8.
 */
export function bundledPackageManifestPaths(inputs: readonly string[]): readonly string[] {
  const manifests = new Set<string>();
  for (const input of inputs) {
    const marker = "node_modules/";
    const markerIndex = input.lastIndexOf(marker);
    if (markerIndex < 0) continue;
    const packageRoot = input.slice(markerIndex + marker.length).split("/");
    const first = packageRoot[0];
    if (first === undefined || first.length === 0 || first === ".pnpm") continue;
    const nameParts = first.startsWith("@") ? packageRoot.slice(0, 2) : packageRoot.slice(0, 1);
    if (nameParts.length === 0 || nameParts.some((part) => part.length === 0)) continue;
    manifests.add(
      `${input.slice(0, markerIndex + marker.length)}${nameParts.join("/")}/package.json`,
    );
  }
  return [...manifests].sort((a, b) => a.localeCompare(b));
}

/** True only when Bun's exact input graph contains a file at or below the requested path. */
export function bundleGraphIncludesPath(inputs: readonly string[], requestedPath: string): boolean {
  const prefix = requestedPath.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (prefix.length === 0) throw new Error("bundle graph path must not be empty");
  return inputs.some((input) => {
    const normalized = input.replaceAll("\\", "/").replace(/^\.\//u, "");
    return (
      normalized === prefix ||
      normalized.startsWith(`${prefix}/`) ||
      normalized.includes(`/${prefix}/`)
    );
  });
}

/** Reject checkout-local absolute paths in generated carrier bytes. They disclose builder metadata
 * and make byte-for-byte reproduction depend on where the source tree happened to live. */
export function builderPathLeakReasons(
  contents: string,
  builderPaths: readonly string[],
): readonly string[] {
  const normalizedContents = contents.replace(/\\+/gu, "/");
  const reasons = new Set<string>();
  for (const builderPath of builderPaths) {
    const normalized = builderPath.replace(/\\+/gu, "/").replace(/\/+$/u, "");
    if (normalized.length === 0) throw new Error("builder path must not be empty");
    let occurrence = normalizedContents.indexOf(normalized);
    while (occurrence >= 0) {
      const next = normalizedContents[occurrence + normalized.length];
      if (next === undefined || next === "/" || !/[0-9A-Za-z._~/-]/u.test(next)) {
        reasons.add(`bundle embeds absolute builder path ${builderPath}`);
        break;
      }
      occurrence = normalizedContents.indexOf(normalized, occurrence + normalized.length);
    }
  }
  return [...reasons];
}

/** Select the exact permissive license Keel redistributes for bundled bytes. */
export function bundledLicenseSelection(name: string, declaredLicense: string): string {
  if (name === "node-forge" && declaredLicense === "(BSD-3-Clause OR GPL-2.0)") {
    return "BSD-3-Clause";
  }
  if (PERMISSIVE_BUNDLED_LICENSES.has(declaredLicense)) return declaredLicense;
  throw new Error(`unsupported bundled license for ${name}: ${declaredLicense}`);
}

/** Flat, collision-free artifact name for scoped packages and simultaneous package versions. */
export function bundledThirdPartyArtifactStem(name: string, version: string): string {
  const flatName = name
    .replace(/^@/u, "")
    .replaceAll("/", "--")
    .replace(/[^0-9A-Za-z._-]/gu, "-");
  const flatVersion = version.replace(/[^0-9A-Za-z._-]/gu, "-");
  return `${flatName}-${flatVersion}`;
}

export interface BundledThirdPartyPackage {
  readonly manifestPath: string;
  readonly name: string;
  readonly version: string;
  readonly declaredLicense: string;
  readonly licenseFiles: readonly string[];
  readonly noticeFiles: readonly string[];
  readonly source: "npm" | "vendored";
}

export interface BundledThirdPartyArtifact {
  readonly source: string;
  readonly artifact: string;
}

export interface BundledThirdPartyComponent {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly source: "npm" | "vendored";
  readonly manifestPath: string;
  readonly licenseFiles: readonly BundledThirdPartyArtifact[];
  readonly noticeFiles: readonly BundledThirdPartyArtifact[];
}

function safeThirdPartyBasename(name: string): string {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new Error(`unsafe bundled third-party artifact source: ${name}`);
  }
  return name;
}

function licenseArtifactBasename(source: string): string {
  const safe = safeThirdPartyBasename(source);
  const match = /^licen[cs]e(?<suffix>\..+)?$/iu.exec(safe);
  return match === null ? safe : `LICENSE${match.groups?.["suffix"] ?? ""}`;
}

/**
 * Convert the exact packages that contributed bundle bytes into a complete redistribution plan.
 * Versions are part of every artifact name so simultaneous package versions cannot silently
 * overwrite one another. Any missing/unsupported license or duplicate component fails closed.
 */
export function bundledThirdPartyComponentPlan(
  packages: readonly BundledThirdPartyPackage[],
): readonly BundledThirdPartyComponent[] {
  const componentIds = new Set<string>();
  const artifacts = new Set<string>();
  const components = packages.map((pkg) => {
    if (pkg.name.length === 0 || pkg.version.length === 0) {
      throw new Error(`bundled component at ${pkg.manifestPath} is missing name or version`);
    }
    const componentId = `${pkg.name}@${pkg.version}`;
    if (componentIds.has(componentId)) {
      throw new Error(`duplicate bundled component ${componentId}`);
    }
    componentIds.add(componentId);
    if (pkg.licenseFiles.length === 0) {
      throw new Error(`bundled component ${componentId} has no redistributable license file`);
    }
    const stem = bundledThirdPartyArtifactStem(pkg.name, pkg.version);
    const planFiles = (
      files: readonly string[],
      kind: "license" | "notice",
    ): readonly BundledThirdPartyArtifact[] =>
      [...files]
        .sort((a, b) => a.localeCompare(b))
        .map((source) => {
          const basename =
            kind === "license" ? licenseArtifactBasename(source) : safeThirdPartyBasename(source);
          const artifact = `THIRD_PARTY_LICENSES/${stem}-${basename}`;
          if (artifacts.has(artifact)) {
            throw new Error(`bundled third-party artifact collision: ${artifact}`);
          }
          artifacts.add(artifact);
          return { source, artifact };
        });
    return {
      name: pkg.name,
      version: pkg.version,
      license: bundledLicenseSelection(pkg.name, pkg.declaredLicense),
      source: pkg.source,
      manifestPath: pkg.manifestPath,
      licenseFiles: planFiles(pkg.licenseFiles, "license"),
      noticeFiles: planFiles(pkg.noticeFiles, "notice"),
    };
  });
  return components.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    return byName === 0 ? a.version.localeCompare(b.version) : byName;
  });
}

const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function collectManifestDeps(
  manifests: readonly PackageManifest[],
  key: "dependencies" | "optionalDependencies",
): Record<string, string> {
  const deps = new Map<string, string>();
  for (const manifest of manifests) {
    for (const [name, version] of Object.entries(manifest[key] ?? {})) {
      if (name.startsWith("@keel/")) continue;
      const existing = deps.get(name);
      if (existing !== undefined && existing !== version) {
        throw new Error(
          `conflicting ${key} version for ${name}: ${existing} vs ${version}; align workspace manifests before packaging`,
        );
      }
      deps.set(name, version);
    }
  }
  return Object.fromEntries([...deps.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function collectExternalDependencies(
  manifests: readonly PackageManifest[],
): Record<string, string> {
  return collectManifestDeps(manifests, "dependencies");
}

export function collectNpxExternalDependencies(
  manifests: readonly PackageManifest[],
): Record<string, string> {
  const bundled = new Set<string>(NPX_BUNDLED_RUNTIME_DEPENDENCIES);
  return Object.fromEntries(
    Object.entries(collectExternalDependencies(manifests)).filter(([name]) => !bundled.has(name)),
  );
}

/** Merge dependency maps only when every version is already an exact, identical runtime pin. */
export function mergeExactDependencies(
  ...dependencySets: readonly Record<string, string>[]
): Record<string, string> {
  const dependencies = new Map<string, string>();
  for (const dependencySet of dependencySets) {
    for (const [name, version] of Object.entries(dependencySet)) {
      if (!EXACT_SEMVER.test(version)) {
        throw new Error(
          `dependency ${name} must use an exact semantic version, received ${version}`,
        );
      }
      const existing = dependencies.get(name);
      if (existing !== undefined && existing !== version) {
        throw new Error(
          `conflicting exact dependency version for ${name}: ${existing} vs ${version}`,
        );
      }
      dependencies.set(name, version);
    }
  }
  return Object.fromEntries([...dependencies.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function collectOptionalDependencies(
  manifests: readonly PackageManifest[],
): Record<string, string> {
  return collectManifestDeps(manifests, "optionalDependencies");
}
