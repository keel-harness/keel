import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";

/**
 * The real filesystem surface a `ProjectReader` gates. Every method is fail-soft (a missing dir/file/
 * tool degrades to empty, never throws) so a hostile or broken workspace degrades the context, never
 * the run. This is the ONLY module (besides the typed-tool `Workspace`) that touches `node:fs` for
 * project-local content — keeping the trust guard structural, not a per-loader convention.
 */
export interface ProjectFs {
  /** Immediate child names of `absPath` (dirs marked with a trailing "/"); `[]` on any error. */
  listDir(absPath: string): string[];
  /** UTF-8 contents of `absPath`, or `undefined` if missing/unreadable. */
  readFile(absPath: string): string | undefined;
  /** `<tool> --version` (first line raw), or `undefined` if the tool is absent. */
  probeVersion(tool: string): string | undefined;
  /** Real (symlink-resolved) path of `absPath`, or `undefined` if it cannot be resolved. Used by
   *  loaders to keep reads contained within the workspace root even when a path is symlinked. */
  realpath(absPath: string): string | undefined;
}

/** One project-read attempt through the chokepoint. `served` = the real fs was touched (trusted);
 *  `served: false` = the read was refused because the workspace is not trusted. An SEC-012-supporting
 *  invariant surface (the security tests instrument trust via a recording `ProjectFs` spy; this log
 *  documents served-vs-refused intent and is available to a future audit consumer). */
export interface ProjectAccess {
  readonly op: "listDir" | "readFile" | "probeVersion" | "realpath";
  readonly target: string;
  readonly served: boolean;
}

/**
 * The single trust-gated chokepoint for reading project-local metadata (the environment snapshot,
 * AGENTS.md, skills, future project config). **Trust-before-parse (§3.2(4), SEC-012):** until the
 * workspace is trusted, every read returns empty and performs ZERO real fs access — the model can only
 * request through keel's loaders; this gate decides. It is an **in-process kernel-DX invariant** (like
 * read-before-edit), NOT the warden and NOT a containment boundary (Phase 1 is honest-no-enforcement);
 * the warden gates the model's typed-tool reach in Phase 2.
 *
 * Trust ≠ provenance: this is the human workspace-trust decision, distinct from the Phase-3
 * `TrustLevel` taint format (reserved in `@keel/shared`).
 */
export class ProjectReader {
  readonly #fs: ProjectFs;
  readonly #trusted: boolean;
  readonly #log: ProjectAccess[] = [];

  constructor(fs: ProjectFs, opts: { readonly trusted: boolean }) {
    this.#fs = fs;
    this.#trusted = opts.trusted;
  }

  /** The resolved workspace-trust decision this reader carries. */
  get trusted(): boolean {
    return this.#trusted;
  }

  /** Every project-read attempt routed through this reader — served (trusted) or refused (untrusted). */
  get accesses(): readonly ProjectAccess[] {
    return this.#log;
  }

  listDir(absPath: string): string[] {
    if (!this.#trusted) {
      this.#log.push({ op: "listDir", target: absPath, served: false });
      return [];
    }
    this.#log.push({ op: "listDir", target: absPath, served: true });
    return this.#fs.listDir(absPath);
  }

  readFile(absPath: string): string | undefined {
    if (!this.#trusted) {
      this.#log.push({ op: "readFile", target: absPath, served: false });
      return undefined;
    }
    this.#log.push({ op: "readFile", target: absPath, served: true });
    return this.#fs.readFile(absPath);
  }

  probeVersion(tool: string): string | undefined {
    if (!this.#trusted) {
      this.#log.push({ op: "probeVersion", target: tool, served: false });
      return undefined;
    }
    this.#log.push({ op: "probeVersion", target: tool, served: true });
    return this.#fs.probeVersion(tool);
  }

  realpath(absPath: string): string | undefined {
    if (!this.#trusted) {
      this.#log.push({ op: "realpath", target: absPath, served: false });
      return undefined;
    }
    this.#log.push({ op: "realpath", target: absPath, served: true });
    return this.#fs.realpath(absPath);
  }
}

/** Tuning for the real `ProjectFs` adapter. */
export interface DefaultProjectFsOpts {
  /** Wall-clock cap (ms) on each `<tool> --version` spawn; a spawn that exceeds it is killed and the
   *  probe degrades fail-soft to `undefined` (never throws). Default 2000. Exposed so the probe can be
   *  exercised deterministically in tests (a real subprocess spawn under heavy parallel load can exceed
   *  a tight timeout — the source of an intermittent CI flake) and so an operator could tune env-probe
   *  latency; production uses the default. */
  readonly probeTimeoutMs?: number;
}

/** Production `ProjectFs`: real fs + `<tool> --version`, every IO wrapped fail-soft (mirrors the
 *  Epic-1.6b `defaultSnapshotDeps` IO contract, now behind the trust gate). */
export function defaultProjectFs(opts: DefaultProjectFsOpts = {}): ProjectFs {
  const probeTimeoutMs = opts.probeTimeoutMs ?? 2000;
  return {
    listDir: (p) => {
      try {
        return readdirSync(p, { withFileTypes: true }).map((d) =>
          d.isDirectory() ? `${d.name}/` : d.name,
        );
      } catch {
        return [];
      }
    },
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    },
    probeVersion: (tool) => {
      try {
        return execFileSync(tool, ["--version"], {
          encoding: "utf8",
          timeout: probeTimeoutMs,
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        return undefined;
      }
    },
    realpath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return undefined;
      }
    },
  };
}
