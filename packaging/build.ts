#!/usr/bin/env bun
/**
 * keel packaging build (Epic 1.10 — ADR-0009 / ADR-0040). **Runs under Bun only**; Bun is a
 * CI-only build dependency — development and testing stay on Node.js/pnpm/vitest (ADR-0009). It is
 * never imported by the app; it only produces shippable artifacts.
 *
 * Two carrier outputs, bundling our own `@keel/*` source (via the `@keel/source` export condition)
 * so there is no `workspace:*` to publish:
 *
 *   • `build/npx/`  — a self-contained npm package: our code and reviewed patched runtime exceptions
 *     bundled; other npm deps left EXTERNAL and declared in a generated `package.json` so `npm`/`npx`
 *     installs them (incl. native `@vscode/ripgrep`). This is the `npx keel-harness` mechanism.
 *   • `build/bin/`  — `bun --compile` self-contained binaries per target. These carry no
 *     `node_modules`, so one optional import is stubbed at bundle time:
 *       - `react-devtools-core` — an optional peer of ink, loaded only under `DEV=true` (never in a
 *         shipped build), but the bundler eagerly follows ink's dynamic import → stub to empty.
 *     The resolver selects **system ripgrep** only for the explicit standalone carrier; it does not
 *     import `@vscode/ripgrep` or consult npm package state on that path.
 *
 * Usage:
 *   bun packaging/build.ts npx                 # the npx package only
 *   bun packaging/build.ts bin [target…]       # binaries (all, or a subset of the keys below)
 *   bun packaging/build.ts bin-eval [target…]  # EVAL-ONLY binaries (the direct-executor gate is
 *                                              #   compiled in — NEVER for release; eval-executor-gate.ts)
 *   bun packaging/build.ts all                 # both (default; release-safe — direct executor OFF)
 * Binary target keys: darwin-arm64 · darwin-x64 · linux-x64 · linux-arm64
 */
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { KEEL_VERSION } from "../packages/kernel/src/version.ts";
import {
  npxProductionJsxBuildReasons,
  resolveNpxKernelTsxInput,
  transpileNpxProductionJsx,
} from "./production-jsx.ts";
import {
  bundleGraphIncludesPath,
  builderPathLeakReasons,
  bundledPackageManifestPaths,
  bundledThirdPartyComponentPlan,
  collectNpxExternalDependencies,
  collectOptionalDependencies,
  mergeExactDependencies,
  NPX_BUNDLED_RUNTIME_DEPENDENCIES,
  NPX_BUNDLED_RUNTIME_PACKAGES,
  NPX_BUNDLED_WORKSPACE_MANIFESTS,
  type BundledThirdPartyPackage,
  type PackageManifest,
} from "./dependencies.ts";
import { createPublicNpxManifest } from "./release-metadata.ts";

const COMPILED_ENTRY = "packaging/cli-entry.js";
const NPX_LAUNCHER = "packaging/npx-cli-entry.js";
const NPX_KERNEL_ENTRY = "packages/kernel/src/cli/bin.ts";
const NPX_WARDEN_ENTRY = "packaging/npx-warden-entry.js";
const OUT = "build";
const NPX_DIR = join(OUT, "npx");
const BIN_DIR = join(OUT, "bin");
const BIN_MANIFEST = join(BIN_DIR, "build-manifest.json");
const FORBIDDEN_SOURCE_MODE_BUNDLE_MARKERS = [
  "tsx/esm/api",
  "node_modules/.pnpm/tsx@",
  "node_modules/.pnpm/esbuild@",
];
interface InstalledPackageManifest extends PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
}

function gitOutput(args: readonly string[]): string | undefined {
  const result = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

const sourceCommit = gitOutput(["rev-parse", "HEAD"]) ?? "unknown";
const sourceDirty =
  (gitOutput(["status", "--porcelain", "--untracked-files=normal"]) ?? "unknown") !== "";

const bundledWorkspaceManifests = await Promise.all(
  NPX_BUNDLED_WORKSPACE_MANIFESTS.map(
    async (path) => JSON.parse(await readFile(path, "utf8")) as PackageManifest,
  ),
);
// Bundle Ink's reviewed patched source. Ink 7 and two of its direct formatting dependencies declare
// Node >=22, and cli-boxes narrows Node 20 to >=20.10, while Keel's npx carrier promises Node >=20.
// Those exact reviewed bytes remain in the bundle. Externalize the complete direct boundary of that
// small bundled set: npm then installs every other package normally (with its own manifest/license).
const bundledRuntimeNames = new Set<string>(NPX_BUNDLED_RUNTIME_DEPENDENCIES);
const inkManifestPath = await realpath("packages/kernel/node_modules/ink/package.json");
const bundledRuntimeResolutionRoot = dirname(dirname(inkManifestPath));
const bundledRuntimePackages = await Promise.all(
  NPX_BUNDLED_RUNTIME_PACKAGES.map(async (reviewed) => {
    const { name } = reviewed;
    const manifestPath = await realpath(join(bundledRuntimeResolutionRoot, name, "package.json"));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as InstalledPackageManifest;
    if (manifest.version !== reviewed.version || manifest.license !== reviewed.license) {
      throw new Error(
        `reviewed runtime ${name} expected ${reviewed.version}/${reviewed.license}, received ${manifest.version ?? "missing"}/${manifest.license ?? "missing"}`,
      );
    }
    return {
      ...reviewed,
      directory: dirname(manifestPath),
      manifest,
    };
  }),
);
const inkPatchSha256 = createHash("sha256")
  .update(await readFile("patches/ink@7.0.5.patch"))
  .digest("hex");
const reviewedTuiComponentManifest = {
  version: 1,
  components: bundledRuntimePackages.map(({ name, manifest, license, licenseFile }) => ({
    name,
    version: manifest.version!,
    license,
    licenseFile: `THIRD_PARTY_LICENSES/${name}-LICENSE`,
    source: "npm",
    ...(name === "ink" ? { patchSha256: inkPatchSha256 } : {}),
  })),
};
const bundledRuntimeExternalDeps = mergeExactDependencies(
  ...(await Promise.all(
    bundledRuntimePackages.map(async ({ directory, manifest }) =>
      Object.fromEntries(
        await Promise.all(
          Object.keys(manifest.dependencies ?? {})
            .filter((name) => !bundledRuntimeNames.has(name))
            .map(async (name) => {
              const dependencyManifestPath = await realpath(
                join(dirname(directory), name, "package.json"),
              );
              const dependencyManifest = JSON.parse(
                await readFile(dependencyManifestPath, "utf8"),
              ) as InstalledPackageManifest;
              if (
                dependencyManifest.version === undefined ||
                dependencyManifest.version.length === 0
              ) {
                throw new Error(
                  `installed bundled runtime dependency ${name} has no exact version`,
                );
              }
              return [name, dependencyManifest.version] as const;
            }),
        ),
      ),
    ),
  )),
);
// External runtime deps for the npx bundle = runtime deps from every workspace package bundled from
// source, minus Ink itself, plus Ink's exact direct dependency boundary. React, react-reconciler,
// and scheduler deliberately remain external, so production renderer selection is an npx-launcher
// runtime responsibility (ADR-0083); a bundle-time NODE_ENV define cannot select their CJS builds.
const externalDeps = mergeExactDependencies(
  collectNpxExternalDependencies(bundledWorkspaceManifests),
  bundledRuntimeExternalDeps,
);
const optionalDeps = collectOptionalDependencies(bundledWorkspaceManifests);
const externals = Object.keys(externalDeps);

const KERNEL_SOURCE_ROOT = resolve("packages/kernel/src");
const transformedNpxKernelTsx = new Set<string>();

/**
 * Npx-Kernel-only compatibility transform for ADR-0083. React still selects its external production
 * CJS build at user runtime through the launcher. This plugin only makes our pre-bundled JSX call
 * sites compatible with that runtime; it must never be applied to the standalone binary or Warden.
 */
const npxProductionJsxPlugin: Bun.Plugin = {
  name: "keel-npx-production-jsx",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/u, namespace: "file" }, async ({ path }) => {
      const absolutePath = await resolveNpxKernelTsxInput(path, KERNEL_SOURCE_ROOT);
      const source = await readFile(absolutePath, "utf8");
      const contents = transpileNpxProductionJsx(source, absolutePath);
      transformedNpxKernelTsx.add(absolutePath);
      return {
        contents,
        loader: "js",
      };
    });
  },
};

/** Ink's optional development bridge is unreachable in shipped operation, but Bun follows the
 * dynamic import while bundling the reviewed Ink bytes. Keep the npx artifact install-free. */
const stubInkDevtools: Bun.Plugin = {
  name: "keel-ink-devtools-stub",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, (a) => ({
      path: a.path,
      namespace: "stub-ink-devtools",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub-ink-devtools" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

/** Bundle-time optional-peer stub for the standalone binary (no node_modules at runtime). */
const stubInkDevtoolsForBinary: Bun.Plugin = {
  name: "keel-binary-ink-devtools-stub",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, (a) => ({
      path: a.path,
      namespace: "stub-empty",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub-empty" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

function fail(label: string, logs: readonly unknown[]): never {
  console.error(`✗ ${label} failed:`);
  for (const l of logs) console.error(String(l));
  process.exit(1);
}

function assertNoSourceModeLoaderDeps(label: string, contents: Buffer | string): void {
  for (const marker of FORBIDDEN_SOURCE_MODE_BUNDLE_MARKERS) {
    const found =
      typeof contents === "string"
        ? contents.includes(marker)
        : contents.includes(Buffer.from(marker, "utf8"));
    if (found) {
      fail(label, [
        `source-mode loader dependency marker ${JSON.stringify(marker)} was bundled; release artifacts must use the bundled SRT helper path`,
      ]);
    }
  }
}

const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:\..+)?$/iu;
const NOTICE_FILE = /^(?:notice|thirdpartynoticetext)(?:\..+)?$/iu;
const VENDORED_SRT_ROOT = "vendor/sandbox-runtime";

async function bundledThirdPartyPackage(
  manifestPath: string,
  source: BundledThirdPartyPackage["source"],
): Promise<BundledThirdPartyPackage> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as InstalledPackageManifest;
  if (
    manifest.name === undefined ||
    manifest.name.length === 0 ||
    manifest.version === undefined ||
    manifest.version.length === 0 ||
    manifest.license === undefined ||
    manifest.license.length === 0
  ) {
    throw new Error(`bundled manifest ${manifestPath} is missing name, version, or license`);
  }
  const files = (await readdir(dirname(manifestPath), { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  return {
    manifestPath,
    name: manifest.name,
    version: manifest.version,
    declaredLicense: manifest.license,
    licenseFiles: files.filter((name) => LICENSE_FILE.test(name)),
    noticeFiles: files.filter((name) => NOTICE_FILE.test(name)),
    source,
  };
}

async function bundledThirdPartyInventory(graphInputs: readonly string[]) {
  const packages = await Promise.all(
    bundledPackageManifestPaths(graphInputs).map((manifestPath) =>
      bundledThirdPartyPackage(manifestPath, "npm"),
    ),
  );
  if (bundleGraphIncludesPath(graphInputs, VENDORED_SRT_ROOT)) {
    packages.push(
      await bundledThirdPartyPackage(join(VENDORED_SRT_ROOT, "package.json"), "vendored"),
    );
  }
  const planned = bundledThirdPartyComponentPlan(packages);
  const packageById = new Map(packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]));
  for (const reviewed of NPX_BUNDLED_RUNTIME_PACKAGES) {
    const component = planned.find(
      ({ name, version }) => name === reviewed.name && version === reviewed.version,
    );
    if (component === undefined || component.license !== reviewed.license) {
      throw new Error(
        `reviewed runtime ${reviewed.name}@${reviewed.version} is absent from the exact npx bundle graph`,
      );
    }
  }
  const components = planned.map((component) => ({
    ...component,
    ...(component.name === "ink" ? { patchSha256: inkPatchSha256 } : {}),
  }));
  return { components, packageById };
}

/** Build the self-contained npm package under build/npx (our code bundled, npm deps external). */
async function buildNpx(): Promise<void> {
  await rm(NPX_DIR, { recursive: true, force: true });
  await mkdir(join(NPX_DIR, "bin"), { recursive: true });
  const buildEntry = async (
    label: string,
    entrypoint: string,
    naming: string,
    plugins: readonly Bun.Plugin[],
  ) => {
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: "node",
      conditions: ["@keel/source"],
      external: externals,
      plugins: [...plugins],
      outdir: join(NPX_DIR, "bin"),
      naming,
      metafile: true,
    });
    if (!result.success) fail(label, result.logs);
    if (result.metafile === undefined) {
      fail(label, ["Bun did not return the requested metafile"]);
    }
    return Object.keys(result.metafile.inputs).sort((a, b) => a.localeCompare(b));
  };
  const kernelGraphInputs = await buildEntry(
    "npx kernel bundle",
    NPX_KERNEL_ENTRY,
    "keel-kernel.mjs",
    [stubInkDevtools, npxProductionJsxPlugin],
  );
  const wardenGraphInputs = await buildEntry(
    "npx warden bundle",
    NPX_WARDEN_ENTRY,
    "keel-warden.mjs",
    [stubInkDevtools],
  );
  const graphInputs = [...new Set([...kernelGraphInputs, ...wardenGraphInputs])].sort((a, b) =>
    a.localeCompare(b),
  );
  const inventory = await bundledThirdPartyInventory(graphInputs);
  const graphSha256 = createHash("sha256").update(graphInputs.join("\n")).digest("hex");
  const bundledComponentManifest = {
    version: 2,
    generatedFrom: "bun-metafile",
    graphInputCount: graphInputs.length,
    graphSha256,
    components: inventory.components,
  };
  await copyFile(NPX_LAUNCHER, join(NPX_DIR, "bin", "keel.mjs"));
  const launcher = await readFile(join(NPX_DIR, "bin", "keel.mjs"), "utf8");
  const kernelBundle = await readFile(join(NPX_DIR, "bin", "keel-kernel.mjs"), "utf8");
  const wardenBundle = await readFile(join(NPX_DIR, "bin", "keel-warden.mjs"), "utf8");
  const productionJsxReasons = npxProductionJsxBuildReasons(
    kernelBundle,
    transformedNpxKernelTsx.size,
  );
  if (productionJsxReasons.length > 0) fail("npx kernel bundle", productionJsxReasons);
  const shebangs = launcher.split("\n").filter((line) => line.startsWith("#!")).length;
  if (!launcher.startsWith("#!/usr/bin/env node") || shebangs !== 1) {
    fail("npx launcher", [`expected exactly one node shebang on line 1, found ${shebangs}`]);
  }
  if (Buffer.byteLength(launcher, "utf8") > 4_096) {
    fail("npx launcher", ["paint-first public launcher exceeds 4096 bytes"]);
  }
  for (const [label, contents] of [
    ["npx launcher", launcher],
    ["npx kernel bundle", kernelBundle],
    ["npx warden bundle", wardenBundle],
  ] as const) {
    assertNoSourceModeLoaderDeps(label, contents);
    const builderPathReasons = builderPathLeakReasons(contents, [
      process.cwd(),
      await realpath("."),
    ]);
    if (builderPathReasons.length > 0) fail(label, builderPathReasons);
  }
  for (const dependency of NPX_BUNDLED_RUNTIME_DEPENDENCIES) {
    if (Object.hasOwn(externalDeps, dependency)) {
      fail("npx bundle", [`reviewed runtime dependency ${dependency} remained external`]);
    }
  }
  for (const dependency of Object.keys(bundledRuntimeExternalDeps)) {
    if (!Object.hasOwn(externalDeps, dependency)) {
      fail("npx bundle", [`Ink runtime dependency ${dependency} was not externalized`]);
    }
  }
  if (!kernelBundle.includes("resizeQuietPeriodMs")) {
    fail("npx kernel bundle", ["reviewed Ink resize patch marker is absent"]);
  }
  for (const marker of ["keel-warden failed to start", "importBundledVendoredSrtRuntime"]) {
    if (kernelBundle.includes(marker)) {
      fail("npx kernel bundle", [`Warden host marker ${JSON.stringify(marker)} crossed boundary`]);
    }
  }
  if (bundleGraphIncludesPath(kernelGraphInputs, VENDORED_SRT_ROOT)) {
    fail("npx kernel bundle", ["vendored SRT graph crossed the Kernel process boundary"]);
  }
  if (!bundleGraphIncludesPath(wardenGraphInputs, VENDORED_SRT_ROOT)) {
    fail("npx warden bundle", ["vendored SRT graph is absent from the Warden process boundary"]);
  }
  for (const marker of ["keel · starting", "resizeQuietPeriodMs"]) {
    if (wardenBundle.includes(marker)) {
      fail("npx warden bundle", [
        `Kernel/renderer marker ${JSON.stringify(marker)} crossed boundary`,
      ]);
    }
  }
  if (!wardenBundle.includes("keel-warden failed to start")) {
    fail("npx warden bundle", ["Warden host startup marker is absent"]);
  }
  await chmod(join(NPX_DIR, "bin", "keel.mjs"), 0o755);
  await mkdir(join(NPX_DIR, "THIRD_PARTY_LICENSES"), { recursive: true });
  await Promise.all([
    copyFile("LICENSE", join(NPX_DIR, "LICENSE")),
    copyFile("NOTICE", join(NPX_DIR, "NOTICE")),
    copyFile("packaging/npm-readme.md", join(NPX_DIR, "README.md")),
    ...inventory.components.flatMap((component) => {
      const sourcePackage = inventory.packageById.get(`${component.name}@${component.version}`);
      if (sourcePackage === undefined) {
        throw new Error(
          `missing bundled source package for ${component.name}@${component.version}`,
        );
      }
      return [...component.licenseFiles, ...component.noticeFiles].map((file) =>
        copyFile(
          join(dirname(sourcePackage.manifestPath), file.source),
          join(NPX_DIR, file.artifact),
        ),
      );
    }),
    writeFile(
      join(NPX_DIR, "THIRD_PARTY_LICENSES", "components.json"),
      JSON.stringify(bundledComponentManifest, null, 2) + "\n",
    ),
  ]);

  const publishPkg = createPublicNpxManifest({
    version: KEEL_VERSION,
    dependencies: externalDeps,
    optionalDependencies: optionalDeps,
    bundledComponents: bundledComponentManifest.components,
    sourceCommit,
    sourceDirty,
  });
  await writeFile(join(NPX_DIR, "package.json"), JSON.stringify(publishPkg, null, 2) + "\n");
  console.log(`✓ npx package → ${NPX_DIR} (v${KEEL_VERSION}, ${externals.length} external deps)`);
}

const BINARY_TARGETS: Readonly<Record<string, string>> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
};

/** Build one or more `bun --compile` binaries under build/bin. Eval-only behavior is gated at COMPILE
 *  time by the `__KEEL_EVAL_DIRECT_EXEC_BUILD__` constant (eval-executor-gate.ts): release builds inject
 *  `false` so eval-only branches are structurally absent from shipped binaries; only an explicit
 *  `bin-eval` build injects `true`. */
async function buildBinaries(
  keys: readonly string[],
  opts: { evalDirectExec?: boolean } = {},
): Promise<void> {
  await mkdir(BIN_DIR, { recursive: true });
  await mkdir(join(BIN_DIR, "THIRD_PARTY_LICENSES"), { recursive: true });
  await Promise.all([
    copyFile("LICENSE", join(BIN_DIR, "LICENSE")),
    copyFile("NOTICE", join(BIN_DIR, "NOTICE")),
    ...bundledRuntimePackages.map(({ name, directory, licenseFile }) =>
      copyFile(
        join(directory, licenseFile),
        join(BIN_DIR, "THIRD_PARTY_LICENSES", `${name}-LICENSE`),
      ),
    ),
    writeFile(
      join(BIN_DIR, "THIRD_PARTY_LICENSES", "tui-runtime-components.json"),
      JSON.stringify(reviewedTuiComponentManifest, null, 2) + "\n",
    ),
  ]);
  const evalDirectExecBuild = opts.evalDirectExec === true;
  const binaries: Record<string, { readonly sha256: string }> = {};
  for (const key of keys) {
    const target = BINARY_TARGETS[key];
    if (target === undefined) fail(`binary build`, [`unknown target "${key}"`]);
    const outfile = join(BIN_DIR, `keel-${key}`);
    // `define` is a real Bun.build option (compile-time identifier replacement), but the bundled
    // @types/bun lags and omits it from the build config type — widen locally rather than cast away.
    const buildConfig: Parameters<typeof Bun.build>[0] & { define?: Record<string, string> } = {
      entrypoints: [COMPILED_ENTRY],
      conditions: ["@keel/source"],
      // `autoloadDotenv`/`autoloadBunfig: false` (Bun v1.3.3+) stop the compiled binary from reading a
      // cwd `.env`/`.env.local`/`bunfig.toml` into `process.env` at process init. Bun does this BEFORE
      // any keel code runs and before workspace trust — so a project-local file would otherwise supply
      // keel's provider key and every `KEEL_*` control var (SEC-012 / ADR-0038 trust-before-parse
      // violation + arbitrary env injection into keel, its children, and the warden). Disabling it makes
      // the shipped binary match the Node/tsx dev path, which never autoloads `.env`. Proven by the
      // `packaging/smoke-dotenv-isolation.mjs` compiled-binary probe (a unit test can't — Node doesn't
      // autoload). @types/bun lags on these fields; they're declared in packaging/bun-build.d.ts.
      compile: { target, outfile, autoloadDotenv: false, autoloadBunfig: false },
      plugins: [stubInkDevtoolsForBinary],
      metafile: true,
      define: { __KEEL_EVAL_DIRECT_EXEC_BUILD__: evalDirectExecBuild ? "true" : "false" },
    };
    const r = await Bun.build(buildConfig);
    if (!r.success) fail(`binary ${key}`, r.logs);
    if (r.metafile === undefined) {
      fail(`binary ${key}`, ["Bun did not return the requested metafile"]);
    }
    const binaryPackageManifests = bundledPackageManifestPaths(Object.keys(r.metafile.inputs));
    if (
      !binaryPackageManifests.some((path) => /node_modules\/typescript\/package\.json$/u.test(path))
    ) {
      fail(`binary ${key}`, [
        "the self-contained binary graph lost the on-demand TypeScript syntax checker",
      ]);
    }
    const artifact = await readFile(outfile);
    assertNoSourceModeLoaderDeps(`binary ${key}`, artifact);
    if (!artifact.includes(Buffer.from("resizeQuietPeriodMs", "utf8"))) {
      fail(`binary ${key}`, ["reviewed Ink resize patch marker is absent"]);
    }
    const digest = createHash("sha256").update(artifact).digest("hex");
    binaries[`keel-${key}`] = { sha256: digest };
    console.log(
      `✓ binary → ${outfile} (${target})` +
        (evalDirectExecBuild
          ? "  ⚠ EVAL build — direct executor available behind KEEL_EVAL_DIRECT_EXEC (NEVER for release)"
          : ""),
    );
  }
  await writeFile(
    BIN_MANIFEST,
    JSON.stringify(
      {
        version: 1,
        sourceCommit,
        sourceDirty,
        evalDirectExec: evalDirectExecBuild,
        inkPatchSha256,
        bundledRuntimeComponents: reviewedTuiComponentManifest.components,
        binaries,
      },
      null,
      2,
    ) + "\n",
  );
}

const [mode, ...rest] = process.argv.slice(2);
const binKeys = (): string[] =>
  rest.length === 0 || rest[0] === "all" ? Object.keys(BINARY_TARGETS) : rest;

switch (mode ?? "all") {
  case "npx":
    await buildNpx();
    break;
  case "bin":
    await buildBinaries(binKeys());
    break;
  case "bin-eval":
    await buildBinaries(binKeys(), { evalDirectExec: true });
    break;
  case "all":
    await buildNpx();
    await buildBinaries(Object.keys(BINARY_TARGETS));
    break;
  default:
    fail("build", [`unknown mode "${mode}" — use npx | bin | bin-eval | all`]);
}
