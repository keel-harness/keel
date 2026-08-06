import { type ChildProcess, type SpawnOptions, spawn as defaultSpawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import {
  escapeSearchGlobLiteral,
  formatSearchResultPath,
  isVisibleSearchPath,
  matchesVisibleSearchGlob,
  normalizeSearchPath,
  searchExecutionScopeFromGlob,
  type JsonObjectT,
} from "@keel/shared";
import { parseArgs } from "./args.js";
import { minimalChildEnv } from "./child-env.js";
import { ToolError } from "./errors.js";
import { staticCapability, type CoreTool } from "./registry.js";
import { truncateHeadTail, truncateHeadUtf8 } from "./truncate.js";
import { Workspace } from "./workspace.js";

const requireFromSearch = createRequire(import.meta.url);

function resolveBundledRgPath(env: NodeJS.ProcessEnv): string {
  // Resolve the native optional package from the umbrella package's dependency scope. This works
  // with strict/non-hoisted installs and, unlike importing the umbrella module, cannot throw during
  // this module's initialization when an install has been copied across platforms.
  const umbrellaEntry = requireFromSearch.resolve("@vscode/ripgrep");
  const requireFromRipgrep = createRequire(umbrellaEntry);
  const arch = env["npm_config_arch"] ?? process.arch;
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
  return requireFromRipgrep.resolve(
    `@vscode/ripgrep-${process.platform}-${arch}/bin/${binaryName}`,
  );
}

/** Hard cap on results returned to the model (head-only; refine to narrow). */
export const SEARCH_MAX_RESULTS = 200;

/** Per-match byte cap on a single result line. A wide single-line file (e.g. a 284 KB CSV row) yields a
 *  match whose `lines.text` is the *entire* row; without this, one match could blow the model's input
 *  budget (the sanitize-git-repo failure, F1). Bounds each line the way read/bash already bound output. */
export const SEARCH_MAX_LINE_BYTES = 1024;

/** Total byte cap on the joined tool result — the backstop when many medium-width lines together exceed
 *  budget. Mirrors `READ_MAX_OUTPUT_BYTES` / the shell session cap (64 KB) for a uniform bound across tools. */
export const SEARCH_MAX_OUTPUT_BYTES = 64 * 1024;

/** Raw stdout line cap before JSON parsing. Result caps alone are insufficient because rg --json can
 *  emit one very large line before `parseRgMatch` gets to truncate the match text. */
export const SEARCH_MAX_RAW_STDOUT_LINE_BYTES = 1024 * 1024;

/** Raw stderr cap before error formatting. A bad pattern/glob should not let rg fill kernel memory. */
export const SEARCH_MAX_STDERR_BYTES = 64 * 1024;

/** Wall-clock cap on a single ripgrep invocation. rg's regex engine is linear (no ReDoS), but a search
 *  over a huge tree that matches nothing has no natural bound — without this the run cannot be cancelled
 *  by time, only by the user abort. Mirrors the long-running-tool budgets elsewhere (EXEC-1). */
export const SEARCH_TIMEOUT_MS = 30_000;

const SearchText = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "search arguments may not contain a NUL byte");

export const SearchArgs = z
  .object({
    pattern: SearchText,
    kind: z.enum(["content", "filename"]).optional(),
    glob: SearchText.optional(),
    path: SearchText.optional(),
    output_mode: z.literal("content").optional(),
    maxResults: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (args.output_mode !== undefined && args.kind !== undefined && args.kind !== "content") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "search: conflicting output_mode and kind arguments",
        path: ["output_mode"],
      });
    }
    if (args.path !== undefined && args.kind === "filename") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "search: path is only supported for content searches; use glob instead",
        path: ["path"],
      });
    }
    if (args.path !== undefined && args.glob !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "search: conflicting 'path' and 'glob' arguments",
        path: ["path"],
      });
    }
    if (args.kind === "filename" && args.glob !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "glob is only supported for content searches",
        path: ["glob"],
      });
    }
  });

export const SPEC = {
  name: "search",
  description:
    "Search the primary workspace with ripgrep. kind 'content' (default): regex `pattern` over file " +
    "contents (optional `glob` to restrict files), returns file:line:col:match. kind 'filename': " +
    "`pattern` is a glob matched against file paths; use `kind: filename`, `pattern: packages/**` for " +
    "directory inventories. Results are capped; refine to narrow. Hidden/" +
    ".gitignored files and symlinks out of the workspace are not searched; use read for declared extra-root files.",
  // Model-facing JSON Schema — mirrors `SearchArgs` (a drift-guard test asserts the two agree).
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        minLength: 1,
        description: "Regex (content) or glob (filename) to search for.",
      },
      kind: {
        type: "string",
        enum: ["content", "filename"],
        description: "'content' (default) searches file contents; 'filename' matches paths.",
      },
      glob: {
        type: "string",
        minLength: 1,
        description:
          "Optional glob to restrict which files are searched in content mode; do not combine with path or kind:'filename'.",
      },
      path: {
        type: "string",
        minLength: 1,
        description:
          "Compatibility alias for a contained content-search scope; normalized to a literal glob. Prefer glob. Do not combine with glob or kind:'filename'.",
      },
      output_mode: {
        type: "string",
        enum: ["content"],
        description:
          "Compatibility alias for kind:'content'; prefer kind. Do not combine with kind:'filename'.",
      },
      maxResults: {
        type: "integer",
        minimum: 1,
        description: "Cap on results returned (further capped by the tool's hard limit).",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
} as const;

function toRgGlobPath(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function pathArgToGlob(workspace: Workspace, pathArg: string): string {
  const resolved = workspace.resolve(pathArg, { operation: "read" });
  if (!resolved.ok) throw new ToolError(resolved.denial.guidance);
  const rootRelative = relative(workspace.root, resolved.path);
  if (rootRelative === ".." || rootRelative.startsWith(".." + sep) || isAbsolute(rootRelative)) {
    throw new ToolError(
      "search: path must stay inside the primary workspace; use read for declared extra-root files",
    );
  }
  const rel = toRgGlobPath(relative(workspace.root, resolved.path));
  if (rel === "") return "**";
  const literal = escapeSearchGlobLiteral(rel);
  try {
    if (statSync(resolved.path).isDirectory()) return `${literal.replace(/\/+$/, "")}/**`;
  } catch {
    // If the path does not exist, let rg report no matches for the exact contained path. The
    // containment decision above is still the safety boundary.
  }
  return literal;
}

function normalizeSearchArgs(workspace: Workspace, raw: JsonObjectT): JsonObjectT {
  const normalized: JsonObjectT = { ...raw };

  if ("output_mode" in normalized) {
    if (normalized["output_mode"] !== "content") {
      throw new ToolError("search: unsupported output_mode; use kind:'content' or kind:'filename'");
    }
    if ("kind" in normalized && normalized["kind"] !== "content") {
      throw new ToolError("search: conflicting output_mode and kind arguments");
    }
    normalized["kind"] = "content";
    delete normalized["output_mode"];
  }

  if ("path" in normalized) {
    if ("kind" in normalized && normalized["kind"] !== "content") {
      throw new ToolError("search: path is only supported for content searches; use glob instead");
    }
    const pathArg = normalized["path"];
    if (typeof pathArg !== "string" || pathArg.length === 0) {
      throw new ToolError("search: path must be a non-empty string");
    }
    if ("glob" in normalized) {
      throw new ToolError("search: conflicting 'path' and 'glob' arguments");
    }
    const glob = pathArgToGlob(workspace, pathArg);
    normalized["glob"] = glob;
    delete normalized["path"];
  }
  if (normalized["kind"] === "filename" && "glob" in normalized) {
    throw new ToolError("search: glob is only supported for content searches");
  }

  return normalized;
}

/** rg --json "match" event shape (only the fields we use; strict so JSON.parse `any` never leaks). */
const RgMatch = z.object({
  type: z.literal("match"),
  data: z.object({
    path: z.object({ text: z.string() }),
    line_number: z.number(),
    lines: z.object({ text: z.string() }),
    submatches: z.array(z.object({ start: z.number() })),
  }),
});

/** rg --json "summary" event shape — only the `searches` count, to detect the "no files searched" exit-2. */
const RgSummary = z.object({
  type: z.literal("summary"),
  data: z.object({ stats: z.object({ searches: z.number() }) }),
});

/** Bound one match line to `SEARCH_MAX_LINE_BYTES`, appending a marker when truncated, so a single
 *  pathological wide line (a 284 KB CSV row) cannot dominate the model's input budget (F1). Cuts on a
 *  UTF-8 codepoint boundary (head-only — the match column is usually near the start). */
function capLine(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= SEARCH_MAX_LINE_BYTES) return text;
  return `${truncateHeadUtf8(text, SEARCH_MAX_LINE_BYTES)}… [line truncated]`;
}

/** Parse one rg --json line into `path:line:col:text`, or null if it isn't a match event. The optional
 *  `keep(path)` predicate drops a result whose (rg-relative) path fails containment — used to exclude a
 *  protected denied root (the keel config dir, §3.2(6)) or a symlink-escaped path. Exported for direct
 *  branch coverage (non-match / blank / malformed-JSON). */
export function parseRgMatch(line: string, keep?: (path: string) => boolean): string | null {
  if (line.trim() === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const r = RgMatch.safeParse(raw);
  if (!r.success) return null;
  const d = r.data.data;
  const path = normalizeSearchPath(d.path.text);
  if (keep !== undefined && !keep(path)) return null; // drop a denied-root / escaped path
  const col = (d.submatches[0]?.start ?? 0) + 1;
  return `${formatSearchResultPath(path)}:${String(d.line_number)}:${String(col)}:${capLine(d.lines.text.replace(/\n$/, ""))}`;
}

function contentSearchArgs(pattern: string, scope: string): string[] {
  return [
    "--json",
    "--color=never",
    "--sort",
    "path",
    "--max-columns",
    String(SEARCH_MAX_LINE_BYTES),
    "--max-columns-preview",
    "--",
    pattern,
    scope,
  ];
}

function contentSearchScope(workspace: Workspace, glob: string | undefined): string | undefined {
  const scope = glob === undefined ? "." : (searchExecutionScopeFromGlob(glob) ?? ".");
  if (scope === ".") return ".";
  const resolved = workspace.resolve(scope, { operation: "read" });
  if (!resolved.ok) return undefined;
  try {
    statSync(resolved.path);
    return scope;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new ToolError(`search: cannot inspect scope '${scope}'`);
  }
}

function filenameMatchesVisibleSearchGlob(path: string, glob: string): boolean {
  return glob === "**" || matchesVisibleSearchGlob(path, glob);
}

/**
 * Resolve the ripgrep binary to run. The npx/dev install carries `@vscode/ripgrep` (a native rg
 * binary under `node_modules`); the `bun --compile` standalone binary cannot embed that native
 * binary, so it relies on **system `rg` on PATH** (which `keel doctor` checks). The npm carrier
 * fails closed when its optional platform package is unavailable: silently consulting PATH there
 * would let a workspace-controlled shim execute with Warden authority. Order: an explicit
 * `KEEL_RG_PATH` override → bare `"rg"` for the standalone carrier only → the npm-bundled binary.
 * Pure + injectable for tests (Epic 1.10 / ADR-0040).
 */
export function resolveRgPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  loadBundled: (env: NodeJS.ProcessEnv) => string = resolveBundledRgPath,
  standalone = process.versions["bun"] !== undefined,
): string | undefined {
  const override = env["KEEL_RG_PATH"];
  if (override !== undefined && override !== "") return override;
  if (standalone) return "rg";
  try {
    const bundled = loadBundled(env);
    if (exists(bundled)) return bundled; // bundled platform package (npx/dev)
  } catch {
    // An npm install copied across platforms can legitimately lack this optional package. Keep
    // recovery commands loadable, but do not widen the Warden's executable source to PATH.
  }
  return undefined;
}

/** Injection seam for tests: override the spawn call (spawn-error branch) and/or the rg binary path. */
export interface SearchToolDeps {
  readonly spawn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  /** Override the resolved ripgrep binary; `null` represents an unavailable npm carrier in tests. */
  readonly rgPath?: string | null;
  /** Override the per-search wall-clock cap (defaults to `SEARCH_TIMEOUT_MS`). */
  readonly timeoutMs?: number;
}

/** Spawn rg, collect up to `cap` results (parsing each stdout line via `parse`), killing rg at the cap
 *  so a huge result set can't OOM. Resolves on close; rejects (ToolError) on rg exit 2 or spawn error.
 *  Exit-2 with `searches == 0` (no files searchable — e.g. workspace contains only symlinks) is treated
 *  as "no matches", not an error, per rg's documented behaviour. */
function runRg(
  rgBin: string,
  rgArgs: string[],
  cwd: string,
  cap: number,
  parse: (line: string) => string | null,
  spawnFn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  delimiter: "\n" | "\0" = "\n",
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    // Minimal env to the child (EXEC-2): rg needs only PATH (to exec) + locale; it must NOT inherit the
    // resolved API key or any other host secret the harness holds in `process.env`. Config-file
    // inheritance is off by omission (no `RIPGREP_CONFIG_PATH`). Mirrors the shell's own minimal env.
    const child = spawnFn(rgBin, rgArgs, {
      cwd,
      env: minimalChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const results: string[] = [];
    let buffer = "";
    let stderr = "";
    let done = false;
    let noFilesSearched = false; // set by the rg JSON summary when searches == 0

    // Single settle path (EXEC-1): clear the timer + detach the abort listener exactly once, so a
    // completed/killed search leaves no dangling timer or leaked listener on a long-lived AbortSignal.
    const settle = (action: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener("abort", abortListener);
      action();
    };
    const ok = (v: string[]): void => settle(() => resolve(v));
    const fail = (e: Error): void =>
      settle(() => {
        child.kill("SIGTERM");
        reject(e);
      });
    const abortListener = (): void => fail(new ToolError("search: cancelled"));
    const timer = setTimeout(
      () =>
        fail(
          new ToolError(
            `search: timed out after ${String(timeoutMs)}ms — narrow the pattern or glob`,
          ),
        ),
      timeoutMs,
    );
    timer.unref?.(); // don't keep the event loop alive on the timer alone
    if (signal?.aborted === true) {
      abortListener();
      return;
    }
    signal?.addEventListener("abort", abortListener, { once: true });

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (done) return;
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf(delimiter)) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + delimiter.length);
        if (Buffer.byteLength(line, "utf8") > SEARCH_MAX_RAW_STDOUT_LINE_BYTES) {
          fail(
            new ToolError(
              `search: ripgrep output line exceeded ${String(
                SEARCH_MAX_RAW_STDOUT_LINE_BYTES,
              )} bytes; narrow the pattern or glob`,
            ),
          );
          return;
        }
        // Track the summary line to detect "no files searched" exit-2.
        let jsonValue: unknown = null;
        try {
          jsonValue = JSON.parse(line);
        } catch {
          // not JSON — jsonValue stays null
        }
        if (jsonValue !== null) {
          const summaryCheck = RgSummary.safeParse(jsonValue);
          if (summaryCheck.success && summaryCheck.data.data.stats.searches === 0) {
            noFilesSearched = true;
          }
        }
        const parsed = parse(line);
        if (parsed !== null) {
          results.push(parsed);
          if (results.length >= cap) {
            ok(results); // hit the cap — settle (which detaches the timer/listener) then stop rg
            child.kill("SIGTERM");
            return;
          }
        }
      }
      if (Buffer.byteLength(buffer, "utf8") > SEARCH_MAX_RAW_STDOUT_LINE_BYTES) {
        fail(
          new ToolError(
            `search: ripgrep output line exceeded ${String(
              SEARCH_MAX_RAW_STDOUT_LINE_BYTES,
            )} bytes; narrow the pattern or glob`,
          ),
        );
      }
    });
    child.stderr!.on("data", (c: string) => {
      if (done) return;
      stderr += c;
      if (Buffer.byteLength(stderr, "utf8") > SEARCH_MAX_STDERR_BYTES) {
        fail(
          new ToolError(
            `search: ripgrep stderr exceeded ${String(
              SEARCH_MAX_STDERR_BYTES,
            )} bytes; narrow the pattern or glob`,
          ),
        );
      }
    });
    child.on("error", (err) => fail(new ToolError(`search: cannot run ripgrep: ${err.message}`)));
    child.on("close", (code, signal) => {
      if (done) return;
      if (signal !== null && signal !== undefined) {
        fail(new ToolError(`search: ripgrep terminated by ${signal}`));
        return;
      }
      if (code === 0 || code === 1) {
        ok(results); // 0 = matches, 1 = no matches
        return;
      }
      if (code === 2) {
        // "No files searched" (e.g. workspace contains only symlinks rg won't follow) is not an error;
        // treat it as no matches. Any other exit-2 (bad regex, bad glob, …) is a ToolError.
        if (noFilesSearched) {
          ok(results);
          return;
        }
        fail(new ToolError(`search: ripgrep error: ${stderr.trim() || "invalid pattern or glob"}`));
        return;
      }
      if (code === null) {
        fail(new ToolError("search: ripgrep exited without an exit code"));
        return;
      }
      fail(
        new ToolError(
          `search: ripgrep unexpected exit ${String(code)}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`,
        ),
      );
    });
  });
}

export function createSearchTool(workspace: Workspace, deps: SearchToolDeps = {}): CoreTool {
  const spawnFn = deps.spawn ?? defaultSpawn;
  const rgBin = deps.rgPath === null ? undefined : (deps.rgPath ?? resolveRgPath());
  const timeoutMs = deps.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const handler = async (raw: JsonObjectT, opts?: { signal?: AbortSignal }): Promise<string> => {
    const args = parseArgs("search", SearchArgs, normalizeSearchArgs(workspace, raw));
    if (rgBin === undefined) {
      throw new ToolError(
        "search: bundled ripgrep is unavailable — run `keel doctor` for one repair action",
      );
    }
    const cap = Math.min(args.maxResults ?? SEARCH_MAX_RESULTS, SEARCH_MAX_RESULTS);
    const root = workspace.root;
    // Reuse the Workspace containment guard so `search` honours the same protections as read/write/edit
    // — esp. the denied keel config dir (§3.2(6), Epic 1.9) and any symlink-escaped path. rg emits
    // root-relative paths, which `resolve` re-checks; a denied/escaped result is dropped.
    const keep = (p: string): boolean =>
      isVisibleSearchPath(p) && workspace.resolve(p, { operation: "read" }).ok;

    let results: string[];
    if (args.kind === "filename") {
      results = await runRg(
        rgBin,
        ["--files", "--null", "--sort", "path"],
        root,
        cap + 1,
        (l) => {
          const path = l;
          return path === "" || !keep(path) || !filenameMatchesVisibleSearchGlob(path, args.pattern)
            ? null
            : formatSearchResultPath(path);
        },
        spawnFn,
        opts?.signal,
        timeoutMs,
        "\0",
      );
    } else {
      const contentKeep = (path: string): boolean =>
        keep(path) && (args.glob === undefined || matchesVisibleSearchGlob(path, args.glob));
      const scope = contentSearchScope(workspace, args.glob);
      if (scope === undefined) {
        results = [];
      } else {
        results = await runRg(
          rgBin,
          contentSearchArgs(args.pattern, scope),
          root,
          cap + 1,
          (l) => parseRgMatch(l, contentKeep),
          spawnFn,
          opts?.signal,
          timeoutMs,
        );
      }
    }

    if (results.length === 0) return "search: no matches.";
    const shown = results.slice(0, cap);
    const more =
      results.length > cap
        ? `\n… ${String(results.length - cap)}+ more matches; refine the pattern or glob.`
        : "";
    // Total-output backstop: even within the 200-result and per-line caps, many medium-width lines can
    // exceed budget — bound the joined result the way read/bash already are (head+tail, marks the elision).
    return truncateHeadTail(shown.join("\n") + more, SEARCH_MAX_OUTPUT_BYTES).text;
  };
  return { spec: SPEC, handler, staticCapability: staticCapability(SPEC.name, ["fs_read"]) };
}
