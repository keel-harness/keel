import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import type ts from "typescript";
import { minimalChildEnv } from "./child-env.js";

const requireFromCodeCheck = createRequire(import.meta.url);
const COMPILED_TYPESCRIPT_LOADER = Symbol.for("keel.internal.typescript-loader.v1");
let loadedTypeScript: typeof ts | undefined;

/** Keep the exact-pinned parser off the process-start critical path. The parser is advisory and is
 * needed only when a write/edit actually targets TS or JS; loading it while the user is merely
 * opening the governed shell costs startup time and resident memory without strengthening any
 * pre-input boundary. `createRequire` keeps the existing synchronous checker contract and resolves
 * the same reviewed runtime dependency in source and packaged Node execution. */
function typeScriptRuntime(): typeof ts {
  // The packaging-owned compiled entry registers an immutable loader under this private symbol.
  // Source and packaged Node resolve the same reviewed dependency here. Project content is never
  // executed, so it cannot install or replace this process-local carrier.
  const compiledLoader =
    process.versions["bun"] === undefined
      ? undefined
      : (globalThis as unknown as Readonly<Record<symbol, (() => typeof ts) | undefined>>)[
          COMPILED_TYPESCRIPT_LOADER
        ];
  loadedTypeScript ??= compiledLoader?.() ?? (requireFromCodeCheck("typescript") as typeof ts);
  return loadedTypeScript;
}

/** One reported problem in a file (1-based line). */
export interface Diagnostic {
  readonly line: number;
  readonly message: string;
}

/** The result of a code check. `checker` names what ran ("typescript" | "python" | "none").
 *  `ok` is false ONLY when the edit introduced a NEW syntax error the checker is confident about. */
export interface CheckResult {
  readonly ok: boolean;
  readonly checker: string;
  readonly newSyntaxErrors: readonly Diagnostic[];
}

/**
 * Upper bound (in UTF-8 bytes) on content we are willing to syntax-check.
 *
 * This single cap is the unifying defense against two distinct DoS / false-negative findings:
 *  1. DoS — the python checker is a *synchronous* `spawnSync`; a 50 MB `.py` blocked the event
 *     loop for ~156 s. The TS parser is in-process and also scales with input size.
 *  2. maxBuffer false-negative — a broken `.py` whose error line exceeds spawnSync's default 1 MB
 *     `maxBuffer` gets the child killed (`status === null`), which we (correctly) treat as
 *     "unchecked, don't block" — so the broken file would be SILENTLY written.
 *
 * Refusing to check anything larger than this defuses both: an oversized file is reported as
 * `checker:"none"` (honest "too large to check"), never spawned, never parsed, never blocked.
 * 1 MB comfortably covers any realistic hand- or model-authored source file; anything larger is
 * almost certainly generated/minified/hostile, where an advisory syntax gate adds no value.
 */
export const MAX_CHECK_BYTES = 1_000_000;

/** Wall-clock budget for the python subprocess. A pathological input that survives the size cap
 *  but still hangs ast.parse is killed; spawnSync then returns with `status === null` → unchecked. */
const PYTHON_TIMEOUT_MS = 5000;

/** Explicit stdout/stderr buffer for the python subprocess, well above any plausible traceback but
 *  bounded so a hostile error cannot grow unbounded. (The size cap already keeps input ≤ 1 MB.) */
const PYTHON_MAX_BUFFER = 10_000_000;

/** Private stderr framing for the fixed Python child. Catching the syntax exception inside
 * the child avoids Python's comparatively expensive full traceback path while retaining an exact,
 * fail-open parent parser. This is an internal implementation detail, not a public protocol. */
const PYTHON_SYNTAX_RECORD_PREFIX = "KEEL_PY_SYNTAX_V1\u0000";
const PYTHON_PARSE_SCRIPT = [
  "import ast,sys",
  "try:",
  " ast.parse(sys.stdin.read())",
  "except SyntaxError as error:",
  ' sys.stderr.write("KEEL_PY_SYNTAX_V1\\0%s\\0%d\\0%s" % (type(error).__name__, error.lineno or 1, error.msg))',
  " sys.exit(1)",
].join("\n");

const TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i).toLowerCase();
}

/**
 * SYNTAX-ONLY errors for TS/JS via the exact-pinned in-process `typescript` runtime dependency (no
 * type-check and no Program). `createSourceFile` records scanner/parser errors on the source file's
 * `parseDiagnostics` (an internal field, but stable for our exact-pinned `typescript`). We filter to
 * syntactic codes (< 2000; semantic diagnostics are ≥ 2000) so an undefined symbol / type error is
 * never reported — only the model's own broken syntax.
 *
 * The parser itself can THROW on pathological input (e.g. `RangeError: Maximum call stack size
 * exceeded` on ~1000+ levels of nesting — small enough to clear the size cap). `checkCode` must
 * never let a parser fault escape, so on ANY throw we return `[]`: honest "couldn't check it" →
 * checker still reports as TS but with no new errors, so the edit is not blocked. We never fabricate
 * a diagnostic from a crash.
 */
function tsJsSyntaxErrors(path: string, content: string): Diagnostic[] {
  const ts = typeScriptRuntime();
  const ext = extOf(path);
  const kind =
    ext === ".tsx"
      ? ts.ScriptKind.TSX
      : ext === ".jsx"
        ? ts.ScriptKind.JSX
        : ext === ".ts" || ext === ".mts" || ext === ".cts"
          ? ts.ScriptKind.TS
          : ts.ScriptKind.JS;
  try {
    const sf = ts.createSourceFile(
      path,
      content,
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ false,
      kind,
    );
    const parseDiags =
      (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    return parseDiags
      .filter((d) => d.category === ts.DiagnosticCategory.Error && d.code < 2000)
      .map((d) => {
        const pos =
          d.start !== undefined
            ? sf.getLineAndCharacterOfPosition(d.start)
            : { line: 0, character: 0 };
        return { line: pos.line + 1, message: ts.flattenDiagnosticMessageText(d.messageText, " ") };
      });
  } catch {
    // The parser threw (e.g. stack overflow on deeply-nested input). We cannot honestly report
    // syntax errors, so we report none: the edit is not blocked, and we never fabricate a verdict
    // from a crash. (The DoS variant — huge files — is already short-circuited by the size cap.)
    return [];
  }
}

// ---------------------------------------------------------------------------
// Python checker (subprocess via spawnSync — synchronous, no new dependency)
// ---------------------------------------------------------------------------

/**
 * Check once whether `python3` is available on this system.
 * Memoized: the result is computed on first call and cached for the process lifetime.
 * This avoids repeated subprocess overhead while keeping availability detection honest.
 */
let _hasPython3: boolean | undefined;
function hasPython3(): boolean {
  if (_hasPython3 === undefined) {
    const r = spawnSync("python3", ["--version"]);
    _hasPython3 = r.error === undefined && r.status === 0;
  }
  return _hasPython3;
}

/** The subset of a `spawnSync` result the python checker consumes — the seam for Fix 6 (M2).
 *  Made injectable so the fail-open branches (status===null, non-syntax non-zero) are testable
 *  without depending on real OOM/signal behavior, which cannot be triggered deterministically. */
export interface PySpawnResult {
  readonly status: number | null;
  readonly stderr: string;
}
type PySpawn = (content: string) => PySpawnResult;

/** The real subprocess parses `content` on STDIN and catches syntax-family exceptions inside the
 *  fixed child, emitting one compact versioned record instead of a full traceback. It remains
 *  bounded by an explicit timeout and maxBuffer (defense-in-depth for inputs under the size cap
 *  that still misbehave). On timeout/kill, spawnSync sets `error`/`status === null` → unchecked. */
const realPySpawn: PySpawn = (content) => {
  const r = spawnSync("python3", ["-c", PYTHON_PARSE_SCRIPT], {
    input: content,
    encoding: "utf8",
    timeout: PYTHON_TIMEOUT_MS,
    maxBuffer: PYTHON_MAX_BUFFER,
    // Least privilege (EXEC-2): the syntax checker runs a fixed one-liner over stdin and must not
    // inherit the host's secrets (e.g. the resolved API key) from `process.env`.
    env: minimalChildEnv(),
  });
  return { status: r.status, stderr: typeof r.stderr === "string" ? r.stderr : "" };
};

/**
 * Syntax errors for python `content`, parameterised over the spawn implementation (Fix 6 seam).
 *
 * Honesty invariants enforced here:
 *  - NUL byte → a NUL byte is genuinely invalid python (ast.parse raises "source code string cannot
 *    contain null bytes"), but real python's traceback for it has NO `File "<unknown>"` frame
 *    (compile() raises before reaching the user filename), so the regex path would silently fall
 *    back to an UNTESTED line-1 default. We intercept it BEFORE spawn and emit a deterministic
 *    line-1 diagnostic with the canonical message — tested, not v8-ignored.
 *  - status === null (killed/signalled: timeout, maxBuffer, OOM) → NOT a syntax verdict → [].
 *  - any result other than exact status 1 plus the compact syntax record → ambiguous → [].
 *  - only a SyntaxError / IndentationError / TabError compact record produces a diagnostic.
 */
export function pythonSyntaxErrorsFor(content: string, spawn: PySpawn): Diagnostic[] {
  // A NUL byte is invalid python regardless of how it is loaded. Decide it deterministically here
  // (the traceback path has no <unknown> frame for it) rather than relying on the regex fallback.
  if (content.includes("\0")) {
    return [{ line: 1, message: "source code string cannot contain null bytes" }];
  }

  // Mirror python's file loader, which strips a single leading UTF-8 BOM before compiling. The
  // in-memory `ast.parse` does NOT strip it and would raise "invalid non-printable character
  // U+FEFF" — a false block for a BOM-prefixed source that `python3 file.py` accepts (Fix 3 / R2).
  const src = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

  const r = spawn(src);

  // The child exits 1 only after catching SyntaxError (including IndentationError and TabError).
  // A signal/timeout, success, unexpected exception, or any other status is not a syntax verdict.
  if (r.status !== 1 || !r.stderr.startsWith(PYTHON_SYNTAX_RECORD_PREFIX)) return [];

  const record = r.stderr.slice(PYTHON_SYNTAX_RECORD_PREFIX.length);
  const kindEnd = record.indexOf("\u0000");
  if (kindEnd === -1) return [];
  const lineEnd = record.indexOf("\u0000", kindEnd + 1);
  if (lineEnd === -1) return [];

  const kind = record.slice(0, kindEnd);
  if (kind !== "SyntaxError" && kind !== "IndentationError" && kind !== "TabError") return [];

  const lineText = record.slice(kindEnd + 1, lineEnd);
  if (!/^[1-9][0-9]*$/.test(lineText)) return [];
  const line = Number(lineText);
  if (!Number.isSafeInteger(line)) return [];

  const message = record.slice(lineEnd + 1).trim();
  if (message.length === 0) return [];

  return [{ line, message }];
}

/** Production python checker: the injectable core wired to the real subprocess. */
function pythonSyntaxErrors(_path: string, content: string): Diagnostic[] {
  return pythonSyntaxErrorsFor(content, realPySpawn);
}

/** A registered syntax checker: given a file's content, return its syntax errors. */
type SyntaxChecker = {
  readonly name: string;
  readonly errors: (path: string, content: string) => Diagnostic[];
};

/** Resolve the checker for a path, or null if the language is unsupported (honest fallback). */
function checkerFor(path: string): SyntaxChecker | null {
  if (TS_EXTS.has(extOf(path))) return { name: "typescript", errors: tsJsSyntaxErrors };
  if (extOf(path) === ".py" && hasPython3()) return { name: "python", errors: pythonSyntaxErrors };
  return null; // Honest fallback: unsupported or runtime absent → checker:"none"
}

/**
 * Build a message-keyed multiset (message → count) from a list of diagnostics.
 *
 * WHY a multiset keyed by message only (not by line+message):
 *   The old (line, message) key caused a common false-positive: if a model edit inserted a line
 *   ABOVE an already-broken line, the pre-existing error shifted to a new line number and no
 *   longer matched the baseline key → falsely reported as "new" → valid edit blocked (R1,
 *   SWE-agent #560 / OpenHands #3412 lesson).
 *
 *   A message-only multiset fixes this: a pre-existing error "consumed" by the baseline regardless
 *   of line number, and only a NET INCREASE in the count of a given message is flagged as new.
 *
 *   Accepted trade-off: an edit that simultaneously REMOVES one occurrence of message M and ADDS a
 *   different occurrence of the same message M elsewhere nets zero count → not flagged. This is
 *   acceptable — it is rare, it mirrors the intent of the baseline (don't block net-neutral edits),
 *   and the alternative (line-based) produces the common false-positive above.
 *
 *   Genuinely new errors retain their ACTUAL line numbers in newSyntaxErrors for model guidance —
 *   the multiset only affects which errors are suppressed, not how survivors are reported.
 */
function buildBaseline(diags: readonly Diagnostic[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of diags) {
    m.set(d.message, (m.get(d.message) ?? 0) + 1);
  }
  return m;
}

/**
 * Check a code change for NEW syntax errors. `before === undefined` ⇒ a fresh write (no baseline).
 * Returns the errors present in `after` but not in `before` (so a file that was already broken does
 * not block an unrelated edit — the SWE-agent #560 / OpenHands #3412 baseline lesson). Unsupported
 * language ⇒ ok:true, checker:"none" (never fabricate, never block).
 *
 * Content larger than `MAX_CHECK_BYTES` (in either `before` or `after`) is too large to check
 * honestly within our latency/memory budget, so it short-circuits to checker:"none" BEFORE any
 * spawn or parse — defusing both the synchronous-spawn DoS and the maxBuffer false-negative.
 *
 * Baseline diff uses a message-multiset (line-insensitive) so a pre-existing error shifted to a
 * different line by an innocent edit does not false-block. See `buildBaseline` for the rationale
 * and accepted trade-off.
 */
export function checkCode(path: string, before: string | undefined, after: string): CheckResult {
  if (
    Buffer.byteLength(after) > MAX_CHECK_BYTES ||
    (before !== undefined && Buffer.byteLength(before) > MAX_CHECK_BYTES)
  ) {
    // Too large to check honestly — never block, never imply "valid".
    return { ok: true, checker: "none", newSyntaxErrors: [] };
  }
  const checker = checkerFor(path);
  if (checker === null) return { ok: true, checker: "none", newSyntaxErrors: [] };
  const afterErrs = checker.errors(path, after);
  // Build a mutable copy of the baseline multiset; consume one count per matched after-error.
  const baseline = buildBaseline(before !== undefined ? checker.errors(path, before) : []);
  const newSyntaxErrors: Diagnostic[] = [];
  for (const d of afterErrs) {
    const remaining = baseline.get(d.message) ?? 0;
    if (remaining > 0) {
      // Pre-existing error — consume one baseline slot; do NOT report as new.
      baseline.set(d.message, remaining - 1);
    } else {
      // Net-new error (message not in baseline, or count exceeded) — report with its real line.
      newSyntaxErrors.push(d);
    }
  }
  return { ok: newSyntaxErrors.length === 0, checker: checker.name, newSyntaxErrors };
}

/** The model-facing rejection message — honest, one-line guidance + the precise errors. */
export function formatRejection(path: string, errs: readonly Diagnostic[]): string {
  const lines = errs.slice(0, 10).map((d) => `  line ${String(d.line)}: ${d.message}`);
  return (
    `[keel: edit not applied — it would introduce a syntax error in '${path}'. ` +
    `Fix the syntax and try again (this checks only NEW errors your change adds):\n${lines.join("\n")}]`
  );
}

/**
 * The env-var values that mean "opt out of the syntax check" — shared across write and edit tools
 * so both honour KEEL_NO_EDIT_CHECK with a single, tested implementation.
 */
const TRUTHY_VALUES = new Set(["1", "true", "yes"]);

/**
 * Returns true when `KEEL_NO_EDIT_CHECK` is set to a truthy value in `env`, opting the caller out
 * of the syntax-check gate. Inject a hermetic `{}` in tests to ensure the gate is always active.
 */
export function isOptedOut(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY_VALUES.has((env["KEEL_NO_EDIT_CHECK"] ?? "").toLowerCase());
}
