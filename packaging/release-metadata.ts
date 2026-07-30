export const PUBLIC_PACKAGE_NAME = "keel-harness";
export const PUBLIC_REPOSITORY = "keel-harness/keel";
export const PUBLIC_REPOSITORY_URL = `https://github.com/${PUBLIC_REPOSITORY}`;

export interface PublicManifestInput {
  readonly version: string;
  readonly sourceCommit: string;
  readonly sourceDirty: boolean;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly bundledComponents: readonly unknown[];
}

export interface PublicNpxManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly type: "module";
  readonly bin: Readonly<Record<"keel", string>>;
  readonly engines: Readonly<Record<"node", string>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly keelBundledComponents: readonly unknown[];
  readonly keelSource: {
    readonly repository: string;
    readonly commit: string;
    readonly dirty: boolean;
  };
  readonly license: "Apache-2.0";
  readonly homepage: string;
  readonly repository: { readonly type: "git"; readonly url: string };
  readonly bugs: { readonly url: string };
  readonly publishConfig: { readonly access: "public" };
}

export function createPublicNpxManifest(input: PublicManifestInput): PublicNpxManifest {
  return {
    name: PUBLIC_PACKAGE_NAME,
    version: input.version,
    description:
      "keel — a pre-alpha, local-first governed agent harness: high autonomy inside structurally enforced boundaries.",
    type: "module",
    bin: { keel: "./bin/keel.mjs" },
    engines: { node: ">=20" },
    dependencies: input.dependencies,
    ...(Object.keys(input.optionalDependencies).length > 0
      ? { optionalDependencies: input.optionalDependencies }
      : {}),
    keelBundledComponents: input.bundledComponents,
    keelSource: {
      repository: PUBLIC_REPOSITORY_URL,
      commit: input.sourceCommit,
      dirty: input.sourceDirty,
    },
    license: "Apache-2.0",
    homepage: "https://github.com/keel-harness/keel#readme",
    repository: {
      type: "git",
      url: `git+${PUBLIC_REPOSITORY_URL}.git`,
    },
    bugs: { url: `${PUBLIC_REPOSITORY_URL}/issues` },
    publishConfig: { access: "public" },
  };
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export function publicManifestProblems(manifest: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (manifest["name"] !== PUBLIC_PACKAGE_NAME) {
    problems.push(`expected package name ${PUBLIC_PACKAGE_NAME}`);
  }
  if (manifest["private"] === true) problems.push("must not be private");
  const repository = manifest["repository"] as { url?: unknown } | undefined;
  if (repository?.url !== `git+${PUBLIC_REPOSITORY_URL}.git`) {
    problems.push("public repository");
  }
  if (manifest["homepage"] !== "https://github.com/keel-harness/keel#readme") {
    problems.push("expected public homepage");
  }
  const bugs = manifest["bugs"] as { url?: unknown } | undefined;
  if (bugs?.url !== `${PUBLIC_REPOSITORY_URL}/issues`) problems.push("expected public bugs URL");
  const publishConfig = manifest["publishConfig"] as { access?: unknown } | undefined;
  if (publishConfig?.access !== "public") problems.push("expected public access");

  for (const field of ["dependencies", "optionalDependencies"] as const) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      problems.push(`invalid ${field}`);
      continue;
    }
    for (const [name, version] of Object.entries(dependencies as Record<string, unknown>)) {
      if (typeof version !== "string") {
        problems.push(`non-string dependency ${name}`);
      } else if (version.startsWith("workspace:")) {
        problems.push("workspace protocol");
      } else if (!EXACT_VERSION.test(version)) {
        problems.push("exact dependency");
      }
    }
  }
  return [...new Set(problems)];
}
