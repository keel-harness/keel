/**
 * Eval-only direct-executor gate — NEVER a production bypass.
 *
 * keel's production run path is governed by the warden (sandbox + policy + audit). For BENCHMARKS
 * ONLY — where the agent already runs inside a disposable, isolated container that *is* the sandbox,
 * and where the warden's `bubblewrap` sandbox cannot even create namespaces — keel can run its tools
 * through the in-process `LocalExecutor` (no warden). To make this impossible to abuse as a
 * production backdoor, it is protected by TWO independent gates that must BOTH hold:
 *
 *  1. BUILD-TIME (the real guarantee): the compile-time constant `__KEEL_EVAL_DIRECT_EXEC_BUILD__`
 *     is injected `true` ONLY by `packaging/build.ts bin-eval`. Release/CI builds (`bin`) inject
 *     `false`, so the direct branch is statically unreachable in a shipped binary — no environment
 *     variable, config, prompt, or injection can enable it.
 *  2. RUNTIME (defense in depth): even an eval build stays governed unless the operator sets
 *     `KEEL_EVAL_DIRECT_EXEC` to the exact acknowledgment string below (a bare `=1` is rejected).
 *
 * When active it is LOUD (stderr banner + the explicit deliberately-unenforced status line + a
 * session-ledger note) — honest by construction, never silent.
 */

import { realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

declare global {
  /** Injected at bundle time by `packaging/build.ts` (`bin` → false, `bin-eval` → true). Undefined
   *  when running unbundled (node/vitest) — treated as `false` (production-safe). */
  const __KEEL_EVAL_DIRECT_EXEC_BUILD__: boolean | undefined;
}

/** The env var that *requests* direct execution. Inert unless the binary is an eval build (gate 1). */
export const EVAL_DIRECT_EXEC_ENV = "KEEL_EVAL_DIRECT_EXEC";

/** The exact value `KEEL_EVAL_DIRECT_EXEC` must equal. Deliberately not a bare `1`/`true` so it can
 *  only be set by someone who has read what it does. */
export const EVAL_DIRECT_EXEC_ACK = "i-understand-this-disables-the-warden-eval-only";

/** Eval-only bash timeout ceiling. Inert unless this is an eval build AND the exact ack below is set. */
export const EVAL_BASH_TIMEOUT_ACK_ENV = "KEEL_EVAL_BASH_TIMEOUT_ACK";
export const EVAL_BASH_MAX_TIMEOUT_ENV = "KEEL_EVAL_BASH_MAX_TIMEOUT_MS";
export const EVAL_BASH_TIMEOUT_ACK = "i-understand-this-extends-bash-timeouts-eval-only";
export const PRODUCTION_BASH_MAX_TIMEOUT_MS = 600_000;
export const EVAL_BASH_MAX_TIMEOUT_LIMIT_MS = 10_800_000; // 3h, matching the TB/Pool comparison.

/** Eval-only typed-tool extra roots. Inert outside eval builds and without the exact ack. */
export const EVAL_EXTRA_ROOTS_ENV = "KEEL_EVAL_EXTRA_ROOTS";
export const EVAL_EXTRA_ROOTS_ACK_ENV = "KEEL_EVAL_EXTRA_ROOTS_ACK";
export const EVAL_EXTRA_ROOTS_ACK = "i-understand-this-expands-typed-tool-roots-eval-only";
export const EVAL_DENIED_ROOTS_ENV = "KEEL_EVAL_DENIED_ROOTS";
export const EVAL_EXTRA_ROOTS_BANNER_PREFIX =
  "⚠ KEEL EVAL EXTRA ROOTS ACTIVE — typed read/write/edit roots expanded; search remains primary-workspace-only";

export interface EvalExtraRoot {
  readonly root: string;
  readonly label: string;
  readonly source: "eval-extra-root";
  readonly allow: readonly ["read", "write"];
}

const BROAD_EVAL_ROOTS = new Set([
  "/",
  "/tmp",
  "/app",
  "/build",
  "/etc",
  "/logs",
  "/var",
  "/home",
  "/Users",
  "/root",
  "/proc",
  "/sys",
  "/dev",
  "/run",
]);

const DEFAULT_EVAL_DENIED_ROOTS = ["/proc", "/sys", "/dev", "/run", "/logs"] as const;

/** Margin the warden's per-tool RPC execute backstop sits ABOVE the bash ceiling (`maxTimeoutMs`), so a
 *  legitimately long command settles via the shell's own timer, not a premature RPC timeout. It stays
 *  BELOW the kernel infra backstop (`INFRA_TOOL_TIMEOUT_MARGIN_MS` = 60s; session-entry) so a *wedged*
 *  warden still fails closed at the warden layer first: `bash ceiling < warden RPC < kernel infra`.
 *  Production (600s ceiling) → 630s, identical to the historical hardcoded value. */
export const WARDEN_EXECUTE_TIMEOUT_MARGIN_MS = 30_000;

/** Printed to stderr (and captured in the eval transcript) whenever direct execution is active. */
export const EVAL_DIRECT_EXEC_BANNER =
  "⚠ KEEL EVAL DIRECT EXECUTOR ACTIVE — NO WARDEN · NO SANDBOX · NO POLICY · NO AUDIT. " +
  "Tools run directly in-process. Benchmarks/CI only; this cannot be enabled in a release binary.";

export type ExecutorMode = { readonly kind: "warden" | "eval-direct" };

/** True only in a binary compiled by `packaging/build.ts bin-eval`. Reads the compile-time constant;
 *  the `typeof` guard keeps it ReferenceError-safe (and `false`) when run unbundled. */
function evalDirectExecBuiltIn(): boolean {
  return (
    typeof __KEEL_EVAL_DIRECT_EXEC_BUILD__ !== "undefined" &&
    __KEEL_EVAL_DIRECT_EXEC_BUILD__ === true
  );
}

/**
 * Decide whether this run uses the governed warden executor or the eval-only direct executor.
 * Returns `"warden"` unless BOTH the build gate and the runtime acknowledgment hold. `builtIn` is
 * injectable for tests; in the real binary it defaults to the compile-time constant.
 */
export function resolveExecutorMode(
  env: NodeJS.ProcessEnv,
  builtIn: boolean = evalDirectExecBuiltIn(),
): ExecutorMode {
  // Production / release binary: the warden is the ONLY reachable executor. The env var is inert.
  if (!builtIn) return { kind: "warden" };
  // Eval build: governed by default; only the exact acknowledgment engages direct execution.
  if (env[EVAL_DIRECT_EXEC_ENV] !== EVAL_DIRECT_EXEC_ACK) return { kind: "warden" };
  return { kind: "eval-direct" };
}

/**
 * Resolve an eval-only command timeout ceiling for the bash tool.
 *
 * This is intentionally separate from the direct-executor gate: an eval binary may still use the
 * governed warden route, but benchmark parity can require a longer per-command ceiling than the
 * production default. The same compile-time constant is reused because `bin-eval` is the structural
 * "benchmark binary" gate; release/npx/unbundled runs treat it as false.
 */
export function resolveEvalBashMaxTimeoutMs(
  env: NodeJS.ProcessEnv,
  builtIn: boolean = evalDirectExecBuiltIn(),
): number | undefined {
  if (!builtIn) return undefined;
  if (env[EVAL_BASH_TIMEOUT_ACK_ENV] !== EVAL_BASH_TIMEOUT_ACK) return undefined;
  const raw = env[EVAL_BASH_MAX_TIMEOUT_ENV];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed <= PRODUCTION_BASH_MAX_TIMEOUT_MS ||
    parsed > EVAL_BASH_MAX_TIMEOUT_LIMIT_MS
  ) {
    return undefined;
  }
  return parsed;
}

function containsPath(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep));
}

function normalizeRootPath(value: string): string {
  return resolvePath(value);
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function hasTraversalSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === "..");
}

function hasGlobCharacter(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function safeRealDirectory(value: string): string | undefined {
  try {
    const stat = statSync(value);
    if (!stat.isDirectory()) return undefined;
    return realpathSync(value);
  } catch {
    return undefined;
  }
}

function safeRealRoot(value: string): string | undefined {
  try {
    return realpathSync(value);
  } catch {
    return normalizeRootPath(value);
  }
}

function splitRootList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  return raw.split(delimiter).map((entry) => entry.trim());
}

function isStructurallyInvalidRoot(root: string): boolean {
  return (
    root.length === 0 ||
    !isAbsolute(root) ||
    hasControlCharacter(root) ||
    hasTraversalSegment(root) ||
    hasGlobCharacter(root)
  );
}

function evalRootGateActive(env: NodeJS.ProcessEnv, builtIn: boolean): boolean {
  return builtIn && env[EVAL_EXTRA_ROOTS_ACK_ENV] === EVAL_EXTRA_ROOTS_ACK;
}

export function resolveEvalDeniedRoots(
  env: NodeJS.ProcessEnv,
  builtIn: boolean = evalDirectExecBuiltIn(),
): readonly string[] {
  if (!evalRootGateActive(env, builtIn)) return [];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const entry of [
    ...DEFAULT_EVAL_DENIED_ROOTS,
    ...splitRootList(env[EVAL_DENIED_ROOTS_ENV]),
  ]) {
    const normalized = normalizeRootPath(entry);
    if (isStructurallyInvalidRoot(entry) || normalized === "/") continue;
    const real = safeRealRoot(normalized);
    if (real === undefined || seen.has(real)) continue;
    seen.add(real);
    roots.push(real);
  }
  return roots;
}

export function resolveEvalExtraRoots(
  env: NodeJS.ProcessEnv,
  builtIn: boolean = evalDirectExecBuiltIn(),
): readonly EvalExtraRoot[] {
  if (!evalRootGateActive(env, builtIn)) return [];
  const deniedRoots = resolveEvalDeniedRoots(env, builtIn);
  const candidates: Array<EvalExtraRoot & { readonly index: number; readonly real: string }> = [];
  const seenReal = new Set<string>();
  for (const [index, entry] of splitRootList(env[EVAL_EXTRA_ROOTS_ENV]).entries()) {
    const normalized = normalizeRootPath(entry);
    if (isStructurallyInvalidRoot(entry) || BROAD_EVAL_ROOTS.has(normalized)) continue;
    const real = safeRealDirectory(normalized);
    if (real === undefined || BROAD_EVAL_ROOTS.has(real) || seenReal.has(real)) continue;
    if (deniedRoots.some((denied) => containsPath(denied, real))) continue;
    seenReal.add(real);
    candidates.push({
      index,
      real,
      root: normalized,
      label: `eval-extra-root:${normalized}`,
      source: "eval-extra-root",
      allow: ["read", "write"],
    });
  }
  return candidates
    .filter(
      (candidate) =>
        !candidates.some(
          (other) => other !== candidate && containsPath(candidate.real, other.real),
        ),
    )
    .sort((a, b) => a.index - b.index)
    .map(({ index: _index, real: _real, ...root }) => root);
}

/**
 * Resolve the warden's per-tool RPC execute backstop (the kernel-side deadline the `WardenExecutor`
 * waits for a `warden.execute` reply). It tracks the bash ceiling so a warden-mode command is bounded
 * by the shell's own timer, not clipped early by the RPC deadline:
 *
 *   - Production / release / unbundled (no eval bash ceiling): `600s + 30s = 630s` — byte-identical to
 *     the historical hardcoded default, so this is NOT a production timeout relaxation.
 *   - Eval build + exact ack + a valid `KEEL_EVAL_BASH_MAX_TIMEOUT_MS`: `<ceiling> + 30s` (e.g. the 3h
 *     TB/Pool ceiling → `10_830_000`).
 *
 * The 30s margin keeps the invariant `bash ceiling < warden RPC < kernel infra backstop` (the infra
 * margin is 60s; session-entry), so a *wedged* warden still fails closed at the warden layer first.
 * `builtIn` is injectable for tests; in the real binary it defaults to the compile-time constant.
 */
export function resolveWardenExecuteTimeoutMs(
  env: NodeJS.ProcessEnv,
  builtIn: boolean = evalDirectExecBuiltIn(),
): number {
  const bashCeilingMs = resolveEvalBashMaxTimeoutMs(env, builtIn) ?? PRODUCTION_BASH_MAX_TIMEOUT_MS;
  return bashCeilingMs + WARDEN_EXECUTE_TIMEOUT_MARGIN_MS;
}
