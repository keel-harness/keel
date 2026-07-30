import { dirname } from "node:path";
import { estimateTokens } from "./system-prompt.js";

/**
 * Injected probes for the environment snapshot — so the pure assembly is hermetic + testable and the
 * real fs/subprocess/os access lives only in the trust-gated `ProjectReader` chokepoint (Epic 1.7),
 * which `loadProjectContext` adapts into these probes. `probeVersion` runs `<tool> --version` (or
 * returns undefined if absent); `listDir` returns immediate child names (dirs marked with "/").
 */
export interface SnapshotDeps {
  listDir(path: string): string[];
  probeVersion(tool: string): string | undefined;
  readonly cores: number;
  readonly memGB: number;
}

/** Hard cap (§7 Epic 1.6, ~600 tokens). The file listing is truncated to fit; the toolchain and
 *  package-manager lines are NEVER truncated (they are the highest-value signal). */
const TOKEN_CAP = 600;

/** Toolchains probed via `--version`, in report order. */
const TOOLS = ["node", "python3", "go", "cargo", "rustc", "java", "ruby"] as const;

/** Manifest/lock files → the package manager / ecosystem they imply (cheap, no subprocess). */
const PKG_SIGNALS: ReadonlyArray<readonly [file: string, pm: string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["package.json", "npm"],
  ["requirements.txt", "pip"],
  ["pyproject.toml", "pip"],
  ["poetry.lock", "poetry"],
  ["Cargo.toml", "cargo"],
  ["go.mod", "go"],
  ["Gemfile", "bundler"],
];

/** Universal noise excluded from the file listing — VCS/dependency/build dirs + OS cruft. They burn
 *  the budget without orienting the agent (and `package managers` already captures the lockfiles). */
const NOISE = new Set([
  ".git/",
  "node_modules/",
  ".DS_Store",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  "target/",
  ".turbo/",
  "__pycache__/",
  ".venv/",
  "venv/",
]);

const firstLine = (s: string): string => (s.indexOf("\n") === -1 ? s : s.slice(0, s.indexOf("\n")));

function toolchainLine(deps: SnapshotDeps): string {
  const found: string[] = [];
  for (const tool of TOOLS) {
    const raw = deps.probeVersion(tool);
    if (raw === undefined) continue;
    const v = firstLine(raw).trim();
    found.push(v.toLowerCase().startsWith(tool.toLowerCase()) ? v : `${tool} ${v}`);
  }
  return `toolchains: ${found.length > 0 ? found.join(" · ") : "none detected"}`;
}

function packageManagerLine(entries: readonly string[]): string {
  const set = new Set(entries);
  const pms = [...new Set(PKG_SIGNALS.filter(([f]) => set.has(f)).map(([, pm]) => pm))];
  return `package managers: ${pms.length > 0 ? pms.join(", ") : "none detected"}`;
}

/** Fit `entries` into ~`budget` tokens; append "(+K more)" for any dropped, never silently. */
function filesLine(entries: readonly string[], budget: number): string {
  const shown: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const candidate = [...shown, entries[i]!].join(" · ");
    const more = entries.length - (i + 1);
    const withMore = more > 0 ? `${candidate} · (+${more} more)` : candidate;
    if (estimateTokens(`files: ${withMore}`) > budget && shown.length > 0) {
      const dropped = entries.length - shown.length;
      return `files: ${shown.join(" · ")} · (+${dropped} more)`;
    }
    shown.push(entries[i]!);
  }
  return `files: ${shown.length > 0 ? shown.join(" · ") : "(none)"}`;
}

/**
 * A compact environment snapshot injected at session start (§7 Epic 1.6 / the Meta-Harness
 * bootstrapping lever) so the agent does not burn early turns on `ls` / `which python3`. cwd map +
 * detected toolchains/versions + package managers + system resources, within a hard ~600-token cap
 * that truncates the file listing first and the toolchain list never. Pure given `deps`.
 *
 * Trust-before-parse (Epic 1.7): this reads workspace metadata, so it runs only **post-trust** —
 * `loadProjectContext` calls it only when the `ProjectReader` is trusted and routes `deps.listDir`/
 * `deps.probeVersion` through that gated reader (SEC-012). An untrusted workspace never reaches here.
 */
export function environmentSnapshot(cwd: string, deps: SnapshotDeps): string {
  const entries = deps.listDir(cwd);
  const fixed = [
    "# Environment",
    `cwd: ${cwd} (parent: ${dirname(cwd)})`,
    toolchainLine(deps),
    packageManagerLine(entries), // package managers are inferred from the FULL listing (incl. locks)
    `system: ${String(deps.cores)} cores · ${String(deps.memGB)} GB`,
  ];
  const budget = TOKEN_CAP - estimateTokens(fixed.join("\n")) - 4; // margin for the files line + joins
  const files = filesLine(
    entries.filter((e) => !NOISE.has(e)),
    Math.max(0, budget),
  );
  // files sits under cwd, above toolchains, so the high-value lines are last (most salient)
  return [fixed[0], fixed[1], files, fixed[2], fixed[3], fixed[4]].join("\n");
}
