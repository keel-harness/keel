import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";

/**
 * Branded string: a filesystem path proven by `Workspace.resolve` to lie within the primary workspace
 * root or an explicitly declared policy root. Only `Workspace` mints one, so a function requiring a
 * `ContainedPath` cannot be handed an unchecked path by mistake — the kernel-level path-discipline
 * chokepoint (SEC-004/005 precursor) is a type-level guarantee, not a per-tool convention.
 *
 * Phase-1 honest-no-enforcement: this is path math + `fs.realpath`, NOT an OS sandbox. A TOCTOU symlink
 * swap between this check and a later fs call is not defended until the warden (Phase 2, SEC-004).
 */
declare const containedPathBrand: unique symbol;
export type ContainedPath = string & { readonly [containedPathBrand]: true };

/** Structured refusal. `guidance` is the model-facing one-liner naming the allowed root (mirrors the
 *  eventual POL-002 message shape so Phase-2 guidance stays consistent). `denied-path` = the path is
 *  inside a protected `deniedRoot` (e.g. the keel config dir, Epic 1.9) even though it is within the
 *  workspace. */
export interface ContainmentDenial {
  readonly code:
    | "outside-workspace"
    | "symlink-escape"
    | "unresolvable"
    | "denied-path"
    | "invalid-path";
  readonly guidance: string;
}

export type ResolveResult =
  | { readonly ok: true; readonly path: ContainedPath }
  | { readonly ok: false; readonly denial: ContainmentDenial };

export type WorkspaceRootSource =
  | "workspace"
  | "declared-temp"
  | "eval-extra-root"
  | "warden-approved";
export type WorkspaceOperation = "read" | "write";

export interface WorkspaceExtraRoot {
  readonly root: string;
  readonly label: string;
  readonly source: Exclude<WorkspaceRootSource, "workspace">;
  readonly allow: readonly WorkspaceOperation[];
}

export interface WorkspaceResolveOptions {
  readonly operation?: WorkspaceOperation;
}

interface WorkspaceRootPolicy {
  readonly lexicalRoot: string;
  readonly root: string;
  readonly label: string;
  readonly source: WorkspaceRootSource;
  readonly allow: ReadonlySet<WorkspaceOperation>;
}

/** Injection seam for test determinism (Epic 1.2 QC): override symlink resolution. */
export interface WorkspaceDeps {
  readonly realpath?: (p: string) => string;
  /** Protected roots refused even when inside the workspace (e.g. the keel config dir — §3.2(6),
   *  Epic 1.9). Realpath-resolved at construction; a contained path within any of them is denied. */
  readonly deniedRoots?: readonly string[];
  /** Policy-declared roots outside the primary workspace. Production callers leave this empty; eval
   *  builds may supply ack-gated roots for benchmark parity without weakening the default boundary. */
  readonly extraRoots?: readonly WorkspaceExtraRoot[];
}

/** True iff real path `p` is `base` or a descendant (relative-based; never `startsWith`, which
 *  mis-judges `/ws-secret` vs `/ws`). */
function contains(base: string, p: string): boolean {
  const rel = relative(base, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep));
}

/**
 * Resolve symlinks on the longest existing prefix of `candidate`, re-appending any non-existing tail —
 * so a not-yet-created write target is contained via its real ancestor. ENOENT (the path doesn't exist
 * yet) and ENOTDIR (a prefix component is a file, so the path can't exist as given) both walk up to the
 * real ancestor; other fs faults (e.g. EACCES) propagate. Exported for direct coverage of the fs-root
 * edge (nothing along the path exists).
 */
export function resolveRealPath(candidate: string, realpath: (p: string) => string): string {
  const tail: string[] = [];
  let cur = candidate;
  for (;;) {
    try {
      const real = realpath(cur);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = dirname(cur);
      if (parent === cur) return candidate; // nothing along the path exists up to the fs root
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

export class Workspace {
  /** Realpath-resolved absolute workspace root; all containment compares real-to-real. */
  readonly root: string;
  readonly #realpath: (p: string) => string;
  readonly #roots: readonly WorkspaceRootPolicy[];
  /** Realpath-resolved protected roots refused even when inside the workspace (Epic 1.9). */
  readonly #denied: readonly string[];

  constructor(root: string, deps: WorkspaceDeps = {}) {
    this.#realpath = deps.realpath ?? ((p) => realpathSync(p));
    this.root = this.#realpath(resolvePath(root));
    const roots: WorkspaceRootPolicy[] = [
      {
        lexicalRoot: this.root,
        root: this.root,
        label: "workspace",
        source: "workspace",
        allow: new Set<WorkspaceOperation>(["read", "write"]),
      },
    ];
    for (const extra of deps.extraRoots ?? []) {
      const lexical = resolvePath(extra.root);
      const real = resolveRealPath(lexical, this.#realpath);
      if (real === this.root || roots.some((r) => r.root === real)) continue;
      roots.push({
        lexicalRoot: lexical,
        root: real,
        label: extra.label,
        source: extra.source,
        allow: new Set(extra.allow),
      });
    }
    this.#roots = roots.sort((a, b) => b.root.length - a.root.length);
    // Drop only a denied root that is the workspace root itself or an ANCESTOR of it — those would deny
    // the whole workspace (a degenerate config, e.g. a test setting KEEL_HOME=cwd). KEEP descendants
    // AND roots that sit outside the workspace: an outside root (the default `~/.config/keel`) is
    // unreachable on the normal `resolve` path (containment rejects it first), but on the
    // `--followSymlink` path a repo symlink can target it, so the realpath denied-check in
    // `resolveLexical` needs it present to refuse the bypass (SEC-5, Epic 1.9 QC).
    this.#denied = (deps.deniedRoots ?? [])
      .map((d) => resolveRealPath(resolvePath(d), this.#realpath))
      .filter((d) => !contains(d, this.root));
  }

  /**
   * Resolve a model-supplied path arg and prove it is contained: (1) lexical containment rejects `../`
   * traversal; (2) symlink containment rejects a path whose real target escapes the root. Returns a
   * branded `ContainedPath` or a structured denial.
   */
  resolve(input: string, options: WorkspaceResolveOptions = {}): ResolveResult {
    const invalid = this.#invalidPath(input);
    if (invalid !== undefined) return { ok: false, denial: invalid };
    const lexical = resolvePath(this.root, input);
    const operation = options.operation ?? "read";
    const lexicalRoot = this.#lexicalRootFor(lexical, operation);
    if (lexicalRoot === undefined) {
      return {
        ok: false,
        denial: { code: "outside-workspace", guidance: this.#guidance(input, operation) },
      };
    }
    let real: string;
    try {
      real = resolveRealPath(lexical, this.#realpath);
    } catch {
      // A genuine fs fault (e.g. EACCES/EIO on an existing ancestor) — we cannot verify containment.
      // Fail closed: refuse rather than risk operating on an unverified path (charter: fail closed).
      return {
        ok: false,
        denial: {
          code: "unresolvable",
          guidance: `blocked: cannot resolve path '${input}' to verify it is inside the workspace`,
        },
      };
    }
    const realRoot = this.#realRootFor(real, operation);
    if (realRoot === undefined || realRoot !== lexicalRoot) {
      return {
        ok: false,
        denial: { code: "symlink-escape", guidance: this.#guidance(input, operation) },
      };
    }
    const denied = this.#deniedDenial(input, real);
    if (denied !== undefined) return { ok: false, denial: denied };
    return { ok: true, path: lexical as ContainedPath };
  }

  /**
   * Lexical-only resolution: rejects `../` escape but SKIPS the symlink-containment check. For
   * `read --followSymlink` only (design spec §5/§8), which explicitly opts out of symlink containment.
   * Returns a PLAIN path (not a `ContainedPath`) because the followed target may lie outside the root —
   * an honest, model-reachable escape with no Phase-1 gate (the warden gates it in Phase 2, POL-001).
   */
  resolveLexical(
    input: string,
    options: WorkspaceResolveOptions = {},
  ): { ok: true; path: string } | { ok: false; denial: ContainmentDenial } {
    const invalid = this.#invalidPath(input);
    if (invalid !== undefined) return { ok: false, denial: invalid };
    const lexical = resolvePath(this.root, input);
    const operation = options.operation ?? "read";
    const lexicalRoot = this.#lexicalRootFor(lexical, operation);
    if (lexicalRoot === undefined) {
      return {
        ok: false,
        denial: { code: "outside-workspace", guidance: this.#guidance(input, operation) },
      };
    }
    if (lexicalRoot.root !== this.root) {
      return {
        ok: false,
        denial: {
          code: "symlink-escape",
          guidance:
            `blocked: followSymlink is available only inside the primary workspace; '${input}' ` +
            `resolves under declared root ${lexicalRoot.label}`,
        },
      };
    }
    // The denied-roots (config-dir) guard must hold even on the symlink-following path: a `read
    // --followSymlink` whose REAL target lands in the config dir must still be refused (§3.2(6)).
    // Workspace containment is deliberately skipped here (that is what `--followSymlink` opts out of),
    // but the config dir stays off-limits — so resolve the real target for the denied check ONLY, and
    // fail closed if it cannot be resolved. A purely lexical check let an in-workspace symlink to the
    // config dir slip through (SEC-5, Epic 1.9 QC). Skipped entirely when no denied roots are set.
    if (this.#denied.length > 0) {
      let real: string;
      try {
        real = resolveRealPath(lexical, this.#realpath);
      } catch {
        return {
          ok: false,
          denial: {
            code: "unresolvable",
            guidance: `blocked: cannot resolve path '${input}' to verify it is outside the protected config dir`,
          },
        };
      }
      const denied = this.#deniedDenial(input, real);
      if (denied !== undefined) return { ok: false, denial: denied };
    }
    return { ok: true, path: lexical };
  }

  #lexicalRootFor(p: string, operation: WorkspaceOperation): WorkspaceRootPolicy | undefined {
    return this.#roots.find((root) => root.allow.has(operation) && contains(root.lexicalRoot, p));
  }

  #realRootFor(p: string, operation: WorkspaceOperation): WorkspaceRootPolicy | undefined {
    return this.#roots.find((root) => root.allow.has(operation) && contains(root.root, p));
  }

  /** Reject a structurally-invalid path up front so the fail-closed refusal rests on an explicit check
   *  rather than incidentally on a downstream `realpath` error code (FS-6). Currently: an embedded NUL
   *  byte, which truncates the path at the syscall layer. The raw input is NEVER echoed back into the
   *  guidance (it carries the NUL). Shared by `resolve` and `resolveLexical`. */
  #invalidPath(input: string): ContainmentDenial | undefined {
    if (input.includes("\0")) {
      return { code: "invalid-path", guidance: "blocked: path may not contain a NUL byte" };
    }
    return undefined;
  }

  /** A `denied-path` denial if `p` is inside a protected `deniedRoot` (the keel config dir), else
   *  undefined. Shared by `resolve` (realpath'd) and `resolveLexical` (lexical). */
  #deniedDenial(input: string, p: string): ContainmentDenial | undefined {
    if (this.#denied.some((d) => contains(d, p))) {
      return {
        code: "denied-path",
        guidance: `blocked: '${input}' is inside a protected directory (the keel config dir is off-limits)`,
      };
    }
    return undefined;
  }

  // The typed tools are intentionally tighter than Phase-1 bash. The denial should teach the safe
  // self-correction without implying that bash is an acceptable substitute for files the typed tools
  // must later read/edit. Required artifacts/configuration belong in an allowed policy root; bash is
  // only the scratch escape hatch until the Phase-2 warden mediates richer root approvals.
  #guidance(input: string, operation: WorkspaceOperation): string {
    const allowedRoots = this.#roots.filter((root) => root.allow.has(operation));
    const roots =
      allowedRoots.length === 1
        ? (allowedRoots[0]?.root ?? this.root)
        : allowedRoots
            .slice()
            .sort((a, b) => (a.root === this.root ? -1 : b.root === this.root ? 1 : 0))
            .map((root) =>
              root.source === "workspace" ? root.root : `${root.root} (${root.source})`,
            )
            .join(", ");
    return (
      `blocked: path '${input}' is outside the workspace or declared ${operation} roots; ` +
      `allowed ${operation} root: ${roots}. Use a workspace-relative path for required artifacts ` +
      `or configuration, or ask for a declared/approved extra root. Use bash only for transient ` +
      `scratch elsewhere (e.g. /tmp), not for files the typed tools must read or edit.`
    );
  }
}
