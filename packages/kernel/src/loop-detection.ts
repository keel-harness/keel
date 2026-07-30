import type { JsonObjectT, JsonValueT } from "@keel/shared";
import { ProgressLedger, type ProgressLedgerEntry } from "./run-control/progress-ledger.js";

/**
 * Loop-detection configuration (Epic 1.1c, borrowed-technique #8). Two signals:
 * an **n-gram cycle** signal (a tool-call signature sequence of some period
 * `1..maxPeriod` repeated `maxToolRepeats` times — catches both A-A-A and
 * alternating A-B-A-B doom loops) and a **per-file edit-count** signal. The
 * per-file signal is parameterized — `editTools` names the tools that count as
 * edits and `pathArg` the args key holding the file path — so it works before
 * Epic 1.2's real tools exist and aligns with them after.
 */
export interface LoopDetectionConfig {
  /** Fire after this many repetitions of a tool-call cycle. Default 3. */
  readonly maxToolRepeats?: number;
  /** Longest cycle period to look for (1 = identical repeats, 2 = A-B-A-B, …). Default 3. */
  readonly maxPeriod?: number;
  /** Fire after this many edits to the same file path. Default 5. */
  readonly maxFileEdits?: number;
  /** Tool names that count as a file edit. Default ["edit", "write"]. */
  readonly editTools?: readonly string[];
  /** The args key holding the edited file path. Default "path". */
  readonly pathArg?: string;
  /** The shell tool whose `command` is scanned for a full-file rewrite target (Epic 1.13). A
   *  heredoc-to-file (`cat <<EOF > f`) or `tee FILE` rewrite counts toward the SAME per-file churn
   *  signal as `edit`/`write` — closing the blind spot where the model uses the shell to re-emit
   *  whole files (ER-037). Deliberately narrow (see `bashFullFileRewriteTarget`): plain `>`/`>>`/`2>`
   *  redirects are NOT counted, so legitimate appends/stderr/build-output never false-trip a halt.
   *  Default "bash"; set "" to disable. */
  readonly bashTool?: string;
  /**
   * **Over-generation guard (Epic 1.13, output side).** The per-file churn signal keys on the path, so
   * it MISSES the measured over-generation mode where the model re-emits a whole file under *churning*
   * names (`build_gates.py` → `build_gates2.py` → …; ER-037's circuit-fibsqrt: 9 full-file `cat <<EOF`
   * rewrites → 73k output). It counts large full-file rewrites **per filename family** (`build_gates.py`
   * and `build_gates2.py` normalize to the same family — a trailing version/number is stripped): when one
   * family is large-rewritten `maxLargeRewrites` times (each emission ≥ `largeRewriteBytes` — a shell
   * rewrite's command, or a `write`'s `contentArg`) an **advisory** `file-edits` signal fires (warn-ONLY:
   * the loop redirects toward small targeted edits but NEVER halts on it; the hard stop for runaway is
   * `KEEL_MAX_OUTPUT_TOKENS`/turns/budget). **Two false-positive guards:** (1) family-keying — a legitimate
   * multi-file workflow writes *distinct* names → distinct families → no family accumulates; (2) advisory
   * warn-only — even a legitimately-collapsing family (numbered series, cross-dir same-basename) is
   * **never killed**, only nudged. **Mechanism only** — like the
   * churn detector, no benefit is claimed until a scoreboard re-run measures it (the verify-interceptor
   * lesson); the defaults are first guesses to tune from matrix data. Set `maxLargeRewrites: 0` to disable.
   */
  readonly maxLargeRewrites?: number;
  /** Min size (bytes) for a full-file shell rewrite's command (the heredoc body rides in it) — or a
   *  `write` call's content (`contentArg`) — to count as a large generated payload (Epic 1.13).
   *  Default 4096. */
  readonly largeRewriteBytes?: number;
  /** The args key holding a write-like tool's full file CONTENT (Epic 1.13 output side). A `write` whose
   *  content is ≥ `largeRewriteBytes` feeds the over-generation guard (family-keyed on its `pathArg`),
   *  catching whole-file re-emission through the typed `write` tool, not just shell heredocs. Default
   *  "content"; `edit`'s targeted `oldString`/`newString` are not under it, so a targeted edit never
   *  counts. Set "" to disable the write-content source. */
  readonly contentArg?: string;
  /**
   * Outcome-stall guard: fire after this many equivalent tool outputs for the same tool, even when
   * the tool inputs vary. `0` disables. Default 8. This is a HARD signal because it keys on observed
   * non-progress, not mere iterative editing.
   */
  readonly maxOutcomeRepeats?: number;
  /**
   * Optional shorter patience for large repeated outputs. Disabled unless both this and
   * `highBurnOutputBytes` are positive; intended for replay-calibrated token-efficiency
   * slices, not blind global threshold lowering.
   */
  readonly highBurnOutcomeRepeats?: number;
  /** Output byte threshold for `highBurnOutcomeRepeats`. `0`/unset disables high-burn shortening. */
  readonly highBurnOutputBytes?: number;
  /**
   * Per-step token threshold for high-burn shortening. This catches the high-context/tiny-output loop
   * class where byte-based output checks stay blind. `0`/unset disables token-cost shortening.
   * `highBurnOutcomeStepTokens` and `highBurnToolStepTokens` may narrow this by signal type.
   */
  readonly highBurnStepTokens?: number;
  /** Per-step token threshold for high-burn generic outcome shortening. Defaults to `highBurnStepTokens`. */
  readonly highBurnOutcomeStepTokens?: number;
  /** Per-step token threshold for high-burn exact tool-cycle shortening. Defaults to `highBurnStepTokens`. */
  readonly highBurnToolStepTokens?: number;
  /**
   * Optional shorter patience for exact tool-input cycles when their average step cost crosses
   * `highBurnStepTokens`. Disabled unless both values are positive.
   */
  readonly highBurnToolRepeats?: number;
  /**
   * Objective-stall guard for recognized downstream metrics. Fire after this many non-improving
   * observations after the best value. `0` disables. Default 6.
   */
  readonly maxObjectiveStallTurns?: number;
  /**
   * Numeric-vector oscillation guard: fire when recent labeled numeric vectors stay inside a bounded
   * band while changing direction/revisiting values. `0` disables. Default 0 until replay-calibrated.
   */
  readonly maxNumericVectorStallTurns?: number;
  /** Per-dimension band width for numeric-vector oscillation. Default 5. */
  readonly numericVectorBand?: number;
  /**
   * Edit oscillation guard: fire after this many immediate inverse edit transitions on the same path.
   * `0` disables. Default 4.
   */
  readonly maxEditOscillations?: number;
  /**
   * Low-confidence poll/status/idempotent repeats have unknown process state before Slice 3. They can
   * emit an advisory nudge after this many equivalent observations, but they are not hard-halt proof by
   * themselves. Default 4; `0` disables the advisory.
   */
  readonly lowConfidenceRepeatAdvisoryRepeats?: number;
  /**
   * **Escalate the advisory loop-breaker nudge across trips (F7). Default `false` (fail-safe).** When
   * false (the default), every advisory trip injects the SAME flat L0 guidance (`KERNEL_STRINGS.
   * loopGuidance`) — the original pre-F7 behavior. When true, successive trips escalate through
   * `KERNEL_STRINGS.loopGuidanceEscalations` (reconsider → rewrite the plan → switch strategy or stop)
   * so the model is pushed to change strategy instead of being nudged with text it already ignored.
   *
   * Defaults OFF because the bounded fix-validation run fix-validation run measured the escalation net-negative: it
   * regressed `tune-mjcf` and `schemelike` (both loop-breaker-dependent wins) with no offsetting gain.
   * Kept opt-in (`KEEL_LOOP_ESCALATION`) so it can be re-ablated under a multi-seed run. This is
   * consumed by the kernel loop, not the `LoopDetector`, which ignores it. A caller-supplied `guidance`
   * override (on `input.loopDetection`) still takes precedence over both flat and escalating text.
   */
  readonly escalateGuidance?: boolean;
  /**
   * Include bounded, redacted recent failure evidence and artifact-finalization guidance in kernel
   * loop redirects. Consumed by `runAgentLoop`, ignored by `LoopDetector`.
   */
  readonly recoverWithEvidence?: boolean;
  /**
   * When a loop trip repeats strict execution-grounded success evidence, accept `model-stop` rather
   * than warning/halting a correct-but-not-stopping run. Consumed by `runAgentLoop`, ignored by
   * `LoopDetector`.
   */
  readonly stopOnRepeatedSuccessEvidence?: boolean;
  /**
   * Same success evidence repeated this many times after no intervening mutation may be accepted as a
   * done-stop before exact tool-input loop detection fires. Requires `stopOnRepeatedSuccessEvidence`.
   * `0` disables. Default 3.
   */
  readonly maxTailSuccessRepeats?: number;
}

export const PROGRESS_CONTRACT_LOOP_CONFIG = {
  highBurnOutcomeRepeats: 2,
  highBurnOutputBytes: 4096,
  highBurnToolStepTokens: 50_000,
  highBurnToolRepeats: 2,
} as const satisfies LoopDetectionConfig;

function normalizedStepTokens(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function unquote(t: string): string {
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
    ? t.slice(1, -1)
    : t;
}

/**
 * Extract the file a bash command rewrites WHOLESALE, or undefined.
 *
 * Narrowed post-QC (Epic 1.13) to the two unambiguous "emit a whole file" patterns the ER-037
 * measurement actually showed, so it cannot false-positive on the common legitimate cases a broad
 * redirect parser tripped on — `>>` appends (a log grows, it is not rewritten), `2>` stderr capture,
 * a build redirecting its stdout to an output file, or a redirect-looking token inside quotes
 * (`awk '$1>5'`). A false trip here can HALT a run (worse than the over-editing it guards), so the
 * matcher is deliberately conservative:
 *   (1) a heredoc redirected to a file — `cat <<EOF > f.py` (the measured anti-pattern); and
 *   (2) `tee FILE` — a whole-stream write (excludes `tee -a`, which appends).
 * Bounded by construction (no unbounded `\d*` → no ReDoS); ignores `/dev/*` sinks. Counts toward the
 * per-file churn signal only — it never blocks a command.
 */
export function bashFullFileRewriteTarget(command: string): string | undefined {
  // (2) `tee FILE` (not `tee -a`). Must be a command word, not a substring (`committee`, `a-tee`).
  const tee = /(?:^|[|&;]|\s)tee\b(?!\s+-a\b)\s+("[^"]*"|'[^']*'|[^\s;|&<>()]+)/.exec(command);
  if (tee) {
    const t = unquote(tee[1]!);
    if (t.length > 0 && !t.startsWith("/dev/")) return t;
  }
  // (1) heredoc-to-file: a heredoc operator AND a stdout redirect (`>`/`>|`, fd 1 — NOT `>>` append,
  // NOT `2>` stderr) on the command line. The body is on later lines and is not scanned.
  if (/<<-?\s*['"]?[A-Za-z_]/.test(command)) {
    const firstLine = command.split("\n", 1)[0] ?? command;
    const redir = /(?:^|\s)1?>(?!>)\|?\s*("[^"]*"|'[^']*'|[^\s;|&<>()]+)/.exec(firstLine);
    if (redir) {
      const t = unquote(redir[1]!);
      if (t.length > 0 && !t.startsWith("/dev/")) return t;
    }
  }
  return undefined;
}

/**
 * Normalize a path to its **filename family** for the over-generation guard (Epic 1.13): strip a
 * trailing version/number suffix from the stem so churning re-emission names collapse together —
 * `build_gates.py` / `build_gates2.py` / `build_gates_v3.py` → `build_gates.py`, while *distinct* names
 * (`server.py`, `client.py`) stay distinct. This is the load-bearing false-positive guard: distinct
 * legitimate files never share a family, so they never accumulate toward a halt. Pure; basename-only
 * (a `dir/a2.py` and `other/a.py` share a family — acceptable: the signal is "this logical file is being
 * re-emitted", and the rare cross-dir collision only ever WARNS first).
 */
export function fileFamily(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base === "") return path; // trailing-slash / directory path: never collapse distinct dirs to ""
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  const fam = stem.replace(/[_-]?v?\d+$/i, ""); // strip a trailing _N / -N / vN / N
  return (fam.length > 0 ? fam : stem) + ext; // keep the original stem if it was ALL digits/version
}

/** Which signal tripped, plus a human/audit detail (the repeated cycle's tools, or file path). */
export interface LoopSignal {
  readonly signal: "tool-repeat" | "file-edits";
  readonly detail: string;
  /** Internal-only fingerprint used to preserve a warned high-burn repeat across reset(). */
  readonly highBurnFingerprint?: string;
  /**
   * **Advisory (warn-only) signal — NEVER terminal (Epic 1.13).** A doom loop (`tool-repeat`, or
   * same-PATH churn) escalates warn → halt; but the over-generation guard is a *diagnostic rail* over a
   * heuristic family signal that can collapse legitimately-distinct same-family files (a numbered series,
   * year-stamped reports, cross-dir same-basename). To stay in the convergence-detector MUST-NOT-KILL
   * class, an advisory signal only ever WARNS+redirects — the loop never halts on it (the hard stop for
   * real runaway is `KEEL_MAX_OUTPUT_TOKENS` / turns / budget). Kernel-internal; not on the frozen
   * `loop-detected` event.
   */
  readonly advisory?: boolean;
}

export interface LoopRecordOptions {
  readonly stepTokens?: number;
  readonly resultOk?: boolean;
}

/**
 * Canonical, key-order-stable stringification of a JSON value — so reordered-but-
 * identical tool args produce the same signature (no false-negative repeats).
 */
function stableStringify(value: JsonValueT): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function parseToolFingerprint(
  fingerprint: string,
): { readonly period: number; readonly signatures: readonly string[] } | undefined {
  const first = fingerprint.indexOf(":");
  const second = fingerprint.indexOf(":", first + 1);
  if (first < 0 || second < 0 || fingerprint.slice(0, first) !== "tool") return undefined;
  const period = Number.parseInt(fingerprint.slice(first + 1, second), 10);
  const signatures = fingerprint.slice(second + 1).split("\u001f");
  if (!Number.isInteger(period) || period <= 0 || signatures.length !== period) return undefined;
  return { period, signatures };
}

/**
 * Per-tool allowlist of the arg keys whose VALUES change what the tool actually does. Everything else
 * — scratchpads (`analysis`/`plan`) and resource bounds (bash `timeoutMs`) — is inert and excluded from
 * the loop signature, so a model cannot evade cycle detection by perturbing an inert field. An allowlist
 * (not a denylist) means a future inert arg is excluded by construction rather than by enumeration. A
 * tool absent from this map signs over its full args.
 */
const SIGNATURE_KEYS: Readonly<Record<string, readonly string[]>> = {
  bash: ["command"],
};

function signatureArgs(toolName: string, args: JsonObjectT): JsonObjectT {
  const keys = SIGNATURE_KEYS[toolName];
  if (keys === undefined) return args;
  const executableArgs: JsonObjectT = {};
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined) executableArgs[key] = value;
  }
  return executableArgs;
}

/**
 * Stateful detector fed one tool call at a time. `record` returns a `LoopSignal`
 * on the call that crosses a threshold, else `undefined`. The kernel loop uses
 * this two-stage: first trip → warn + `reset()` (a genuine second chance); a
 * subsequent trip → halt. Independently unit-tested; no I/O, no model coupling.
 */
export class LoopDetector {
  private readonly history: { sig: string; name: string; stepTokens: number }[] = [];
  private readonly fileEdits = new Map<string, number>();
  /** Per-FAMILY count of LARGE full-file rewrites this run (over-generation guard; Epic 1.13). Keyed on
   *  `fileFamily` so churning names collapse but distinct legitimate files never accumulate. */
  private readonly largeFamilies = new Map<string, number>();
  private readonly outcomes = new Map<string, number>();
  private readonly objectives = new Map<string, { best: number; stalled: number }>();
  private readonly numericVectors = new Map<string, number[][]>();
  private readonly progressLedger = new ProgressLedger(0);
  private readonly lastBuildOutputByAction = new Map<string, string>();
  private readonly lowConfidenceRepeats = new Map<string, number>();
  private readonly lowConfidenceAdvised = new Set<string>();
  private readonly editTransitions = new Map<
    string,
    { oldString: string; newString: string; oscillations: number }
  >();
  private readonly maxToolRepeats: number;
  private readonly maxPeriod: number;
  private readonly maxFileEdits: number;
  private readonly editTools: ReadonlySet<string>;
  private readonly pathArg: string;
  private readonly bashTool: string;
  private readonly maxLargeRewrites: number;
  private readonly largeRewriteBytes: number;
  private readonly contentArg: string;
  private readonly maxOutcomeRepeats: number;
  private readonly highBurnOutcomeRepeats: number;
  private readonly highBurnOutputBytes: number;
  private readonly highBurnOutcomeStepTokens: number;
  private readonly highBurnToolStepTokens: number;
  private readonly highBurnToolRepeats: number;
  private readonly maxObjectiveStallTurns: number;
  private readonly maxNumericVectorStallTurns: number;
  private readonly numericVectorBand: number;
  private readonly maxEditOscillations: number;
  private readonly lowConfidenceRepeatAdvisoryRepeats: number;
  private readonly windowCap: number;
  private warnedHighBurnFingerprint: string | undefined;
  private progressEpochCounter = 0;

  constructor(config: LoopDetectionConfig = {}) {
    this.maxToolRepeats = config.maxToolRepeats ?? 3;
    this.maxPeriod = config.maxPeriod ?? 3;
    this.maxFileEdits = config.maxFileEdits ?? 5;
    this.editTools = new Set(config.editTools ?? ["edit", "write"]);
    this.pathArg = config.pathArg ?? "path";
    this.bashTool = config.bashTool ?? "bash";
    this.maxLargeRewrites = config.maxLargeRewrites ?? 6;
    this.largeRewriteBytes = config.largeRewriteBytes ?? 4096;
    this.contentArg = config.contentArg ?? "content";
    this.maxOutcomeRepeats = config.maxOutcomeRepeats ?? 8;
    this.highBurnOutcomeRepeats = config.highBurnOutcomeRepeats ?? 0;
    this.highBurnOutputBytes = config.highBurnOutputBytes ?? 0;
    this.highBurnOutcomeStepTokens =
      config.highBurnOutcomeStepTokens ?? config.highBurnStepTokens ?? 0;
    this.highBurnToolStepTokens = config.highBurnToolStepTokens ?? config.highBurnStepTokens ?? 0;
    this.highBurnToolRepeats = config.highBurnToolRepeats ?? 0;
    this.maxObjectiveStallTurns = config.maxObjectiveStallTurns ?? 6;
    this.maxNumericVectorStallTurns = config.maxNumericVectorStallTurns ?? 0;
    this.numericVectorBand = config.numericVectorBand ?? 5;
    this.maxEditOscillations = config.maxEditOscillations ?? 4;
    this.lowConfidenceRepeatAdvisoryRepeats = config.lowConfidenceRepeatAdvisoryRepeats ?? 4;
    // Enough tail history to detect any period up to maxPeriod repeated at either normal or
    // high-burn patience.
    this.windowCap = Math.max(this.maxToolRepeats, this.highBurnToolRepeats) * this.maxPeriod;
  }

  /** Record one tool call; returns the tripped signal, or undefined. */
  record(
    call: { readonly name: string; readonly args: JsonObjectT },
    options: LoopRecordOptions = {},
  ): LoopSignal | undefined {
    const sig = `${JSON.stringify(call.name)}:${stableStringify(signatureArgs(call.name, call.args))}`;
    const stepTokens = normalizedStepTokens(options.stepTokens);
    this.history.push({ sig, name: call.name, stepTokens });
    if (this.history.length > this.windowCap) this.history.shift();

    const warnedToolRecurrence = this.detectWarnedToolRecurrence();
    if (warnedToolRecurrence !== undefined) return warnedToolRecurrence;

    const cycle = this.detectCycle();
    if (cycle !== undefined) return cycle;

    const editOscillation = this.recordEditOscillation(call);
    if (editOscillation !== undefined) return editOscillation;

    // per-file churn: an edit via a configured edit tool, OR a full-file rewrite via the shell
    // (Epic 1.13 — `bash` `> file`/`tee`/heredoc rewrites count toward the SAME counter, so churn
    // on one file is caught whether it goes through `edit` or the shell).
    let editedPath: string | undefined;
    // The path of a LARGE full-file emission (over-generation guard, family-keyed below), or undefined.
    let largeRewritePath: string | undefined;
    if (this.editTools.has(call.name)) {
      const path = call.args[this.pathArg];
      if (typeof path === "string") editedPath = path;
      // A write-like tool emitting a large CONTENT payload to a path = a whole-file re-emission via the
      // typed `write` tool (Epic 1.13 write side). It feeds the same family-keyed over-generation guard
      // below. `edit`'s targeted oldString/newString are NOT under `contentArg`, so a targeted edit —
      // however large the file — never counts; only a full `write` content does.
      if (typeof path === "string" && this.contentArg !== "") {
        const content = call.args[this.contentArg];
        if (typeof content === "string" && content.length >= this.largeRewriteBytes) {
          largeRewritePath = path;
        }
      }
    } else if (this.bashTool !== "" && call.name === this.bashTool) {
      const command = call.args["command"];
      if (typeof command === "string") {
        editedPath = bashFullFileRewriteTarget(command);
        // A full-file shell rewrite whose command (incl. the heredoc body) is large = a big generated
        // payload — the over-generation signature (Epic 1.13). Counted per family below.
        if (editedPath !== undefined && command.length >= this.largeRewriteBytes) {
          largeRewritePath = editedPath;
        }
      }
    }
    if (editedPath !== undefined) {
      const count = (this.fileEdits.get(editedPath) ?? 0) + 1;
      this.fileEdits.set(editedPath, count);
      if (count >= this.maxFileEdits) {
        // ADVISORY (warn-only) — Epic 1.16 / benchmark loop-detector fix. The 2026-06-19 TB-2.1 run
        // showed this per-path counter HALTING legitimate iterative refinement of one file on hard
        // tasks (adaptive-rejection-sampler 8P/1F, llm-inference-batching-scheduler 5P/1F — near-misses
        // killed at the threshold). Many *different* edits to one file is normal hard-task work, not a
        // doom loop. So this signal now only WARNS+redirects (the convergence-detector must-not-kill
        // class, matching the over-generation guard below). The hard stops for genuine runaway remain:
        // the n-gram cycle detector (identical repeats) + KEEL_MAX_GROSS_TOKENS / turns / output.
        return { signal: "file-edits", detail: editedPath, advisory: true };
      }
    }
    // Over-generation guard (Epic 1.13, output side): count large full-file rewrites PER FAMILY,
    // catching the churning-filename re-emission the per-PATH counter misses (ER-037 circuit-fibsqrt:
    // build_gates.py → build_gates2.py → …). Family-keying is the false-positive guard — distinct
    // legitimate files never share a family, so a multi-file workflow is provably never killed. Reuses
    // the `file-edits` signal (it IS excessive file rewriting) — no schema change; the detail
    // distinguishes it. Disabled when `maxLargeRewrites` is 0.
    if (largeRewritePath !== undefined && this.maxLargeRewrites > 0) {
      const family = fileFamily(largeRewritePath);
      const count = (this.largeFamilies.get(family) ?? 0) + 1;
      this.largeFamilies.set(family, count);
      if (count >= this.maxLargeRewrites) {
        // ADVISORY (warn-only): the family signal is a heuristic that can collapse legitimately-distinct
        // same-family files, so this NEVER halts — only warns/redirects (the must-not-kill class). The
        // hard stop for real runaway is KEEL_MAX_OUTPUT_TOKENS / turns / budget.
        return {
          signal: "file-edits",
          detail: `over-generation: ${String(count)} large rewrites of family ${family}`,
          advisory: true,
        };
      }
    }
    return undefined;
  }

  /**
   * Record one tool call and its observed result. This is the autonomous-run path: exact tool-input
   * loops still count, but semantic stalls that keep producing the same downstream outcome now count
   * too. Infra-timeout results should not be fed here; the kernel already excludes them.
   */
  recordResult(
    call: { readonly name: string; readonly args: JsonObjectT },
    output: string,
    options: LoopRecordOptions = {},
  ): LoopSignal | undefined {
    const inputSignal = this.record(call, options);
    const progressEvidence = this.progressLedger.record(call, output, {
      ...(options.resultOk !== undefined ? { ok: options.resultOk } : {}),
    });
    if (progressEvidence.successSignal !== undefined) {
      this.noteProgressEvidence();
      return inputSignal?.advisory === true ? inputSignal : undefined;
    }
    if (this.buildOutputNoveltyIndicatesProgress(progressEvidence)) {
      this.noteProgressEvidence();
      return inputSignal?.advisory === true ? inputSignal : undefined;
    }
    if (progressEvidence.benignRepeat) {
      return this.noteLowConfidenceProgress(progressEvidence, inputSignal);
    }

    const stepTokens = normalizedStepTokens(options.stepTokens);
    const objective = this.recordProgress(call, output, stepTokens);
    if (objective.signal !== undefined) return objective.signal;
    // Objective outputs contain a recognized metric; do not also collapse them through the generic
    // numeric normalizer, or legitimate monotonic improvement would look like repeated text.
    if (objective.observed) {
      this.noteProgressEvidence();
      return inputSignal?.advisory === true ? inputSignal : undefined;
    }
    // Edit tools commonly return identical acknowledgements ("wrote", "edited") while making real
    // progress. Their safety rail is the advisory file/edit family signal plus explicit oscillation
    // detection, not generic outcome repetition.
    if (this.editTools.has(call.name)) {
      if (options.resultOk !== false && editOutputIndicatesProgress(output)) {
        this.noteProgressEvidence();
      }
      return inputSignal;
    }

    if (inputSignal !== undefined) return inputSignal;

    if (this.maxOutcomeRepeats <= 0) {
      this.clearWarnedOutcomeFingerprint();
      return undefined;
    }
    const normalized = normalizeOutcomeKey(output);
    if (normalized === undefined) {
      this.clearWarnedOutcomeFingerprint();
      return undefined;
    }
    const key = `${call.name}:${normalized}`;
    const count = (this.outcomes.get(key) ?? 0) + 1;
    this.outcomes.set(key, count);
    const highBurn = this.isHighBurnOutcome(output, stepTokens);
    const threshold = highBurn
      ? Math.min(this.maxOutcomeRepeats, this.highBurnOutcomeRepeats)
      : this.maxOutcomeRepeats;
    const outcomeFingerprint = `outcome:${highBurn ? "high-burn" : "normal"}:${key}`;
    if (count === 1 && outcomeFingerprint === this.warnedHighBurnFingerprint) {
      const repeatedKind = outcomeFingerprint.startsWith("outcome:high-burn:") ? "high-burn " : "";
      return {
        signal: "tool-repeat",
        detail: `${call.name} ${repeatedKind}equivalent outcome repeated after warning: ${normalized.slice(
          0,
          120,
        )}`,
        highBurnFingerprint: outcomeFingerprint,
      };
    }
    if (this.warnedHighBurnFingerprint?.startsWith("outcome:") === true) {
      this.warnedHighBurnFingerprint = undefined;
    }
    if (count >= threshold) {
      return {
        signal: "tool-repeat",
        detail: `${call.name} ${highBurn ? "high-burn " : ""}equivalent outcome repeated ${String(
          count,
        )}x: ${normalized.slice(0, 120)}`,
        highBurnFingerprint: outcomeFingerprint,
      };
    }
    return undefined;
  }

  /**
   * Detect the smallest period `p` (1..maxPeriod) whose p-block repeats
   * `maxToolRepeats` times at the tail of the signature history.
   */
  private detectCycle(): LoopSignal | undefined {
    const highBurnRepeats =
      this.highBurnToolRepeats > 0 && this.highBurnToolStepTokens > 0
        ? Math.min(this.maxToolRepeats, this.highBurnToolRepeats)
        : 0;
    if (highBurnRepeats > 0) {
      const highBurnCycle = this.detectCycleAtRepeats(highBurnRepeats, true);
      if (highBurnCycle !== undefined) return highBurnCycle;
    }
    return this.detectCycleAtRepeats(this.maxToolRepeats, false);
  }

  private detectCycleAtRepeats(repeats: number, requireHighBurn: boolean): LoopSignal | undefined {
    const h = this.history;
    for (let p = 1; p <= this.maxPeriod; p++) {
      const need = repeats * p;
      if (h.length < need) continue;
      let periodic = true;
      for (let i = h.length - need + p; i < h.length; i++) {
        if (h[i]!.sig !== h[i - p]!.sig) {
          periodic = false;
          break;
        }
      }
      if (periodic) {
        const period = h.slice(h.length - p);
        const repeated = h.slice(h.length - need);
        const averageStepTokens =
          repeated.reduce((sum, entry) => sum + entry.stepTokens, 0) / repeated.length;
        if (requireHighBurn && averageStepTokens < this.highBurnToolStepTokens) continue;
        const detail = period.map((e) => e.name).join(",");
        const highBurnFingerprint = `tool:${p}:${period.map((e) => e.sig).join("\u001f")}`;
        if (!requireHighBurn) return { signal: "tool-repeat", detail, highBurnFingerprint };
        return {
          signal: "tool-repeat",
          detail: `${detail} high-burn exact input repeated ${String(repeats)}x`,
          highBurnFingerprint,
        };
      }
    }
    return undefined;
  }

  private detectWarnedToolRecurrence(): LoopSignal | undefined {
    const fingerprint = this.warnedHighBurnFingerprint;
    if (fingerprint?.startsWith("tool:") !== true) return undefined;
    const parsed = parseToolFingerprint(fingerprint);
    if (parsed === undefined) {
      this.warnedHighBurnFingerprint = undefined;
      return undefined;
    }
    const recent = this.history.slice(-Math.min(this.history.length, parsed.period));
    const expected = parsed.signatures.slice(0, recent.length);
    const stillMatches = recent.every((entry, index) => entry.sig === expected[index]);
    if (!stillMatches) {
      this.warnedHighBurnFingerprint = undefined;
      return undefined;
    }
    const detail = recent.map((entry) => entry.name).join(",");
    return {
      signal: "tool-repeat",
      detail:
        parsed.period === 1
          ? `${detail} exact input repeated after warning`
          : `${detail} repeated from warned ${String(parsed.period)}-step cycle after warning`,
      highBurnFingerprint: fingerprint,
    };
  }

  /** Monotonic counter for high-confidence progress boundaries observed by `recordResult()`. */
  progressEpoch(): number {
    return this.progressEpochCounter;
  }

  /** Clear all state — used after a warning to give the model a genuine second chance. */
  reset(signal?: LoopSignal): void {
    const preservedHighBurnFingerprint = signal?.highBurnFingerprint;
    this.history.length = 0;
    this.fileEdits.clear();
    this.largeFamilies.clear();
    this.outcomes.clear();
    this.objectives.clear();
    this.numericVectors.clear();
    this.lastBuildOutputByAction.clear();
    this.lowConfidenceRepeats.clear();
    this.lowConfidenceAdvised.clear();
    this.editTransitions.clear();
    this.warnedHighBurnFingerprint = preservedHighBurnFingerprint;
  }

  /** Clear advisory-only counters while preserving hard loop/stall evidence. */
  resetAdvisory(): void {
    this.fileEdits.clear();
    this.largeFamilies.clear();
  }

  private isHighBurnOutcome(output: string, stepTokens: number): boolean {
    if (this.highBurnOutcomeRepeats <= 0) return false;
    const outputHighBurn =
      this.highBurnOutputBytes > 0 && Buffer.byteLength(output, "utf8") >= this.highBurnOutputBytes;
    const tokenHighBurn =
      this.highBurnOutcomeStepTokens > 0 && stepTokens >= this.highBurnOutcomeStepTokens;
    return outputHighBurn || tokenHighBurn;
  }

  private clearWarnedOutcomeFingerprint(): void {
    if (this.warnedHighBurnFingerprint?.startsWith("outcome:") === true) {
      this.warnedHighBurnFingerprint = undefined;
    }
  }

  private noteProgressEvidence(): void {
    this.progressEpochCounter += 1;
    this.outcomes.clear();
    this.lowConfidenceRepeats.clear();
    this.lowConfidenceAdvised.clear();
    this.warnedHighBurnFingerprint = undefined;
  }

  private buildOutputNoveltyIndicatesProgress(progressEvidence: ProgressLedgerEntry): boolean {
    if (progressEvidence.commandClass !== "build") return false;
    const prior = this.lastBuildOutputByAction.get(progressEvidence.actionSignature);
    this.lastBuildOutputByAction.set(progressEvidence.actionSignature, progressEvidence.stdoutHash);
    return prior !== undefined && prior !== progressEvidence.stdoutHash;
  }

  private noteLowConfidenceProgress(
    progressEvidence: ProgressLedgerEntry,
    inputSignal: LoopSignal | undefined,
  ): LoopSignal | undefined {
    const key = `${progressEvidence.commandClass}:${progressEvidence.actionSignature}`;
    const count = (this.lowConfidenceRepeats.get(key) ?? 0) + 1;
    this.lowConfidenceRepeats.set(key, count);
    if (inputSignal?.advisory === true) return inputSignal;
    if (
      this.lowConfidenceRepeatAdvisoryRepeats > 0 &&
      count >= this.lowConfidenceRepeatAdvisoryRepeats &&
      !this.lowConfidenceAdvised.has(key)
    ) {
      this.lowConfidenceAdvised.add(key);
      return {
        signal: "tool-repeat",
        detail: `${progressEvidence.commandClass} output repeated ${String(
          count,
        )}x with unknown process/job progress`,
        advisory: true,
      };
    }
    return undefined;
  }

  private recordProgress(
    call: { readonly name: string; readonly args: JsonObjectT },
    output: string,
    stepTokens: number,
  ): { observed: boolean; signal?: LoopSignal } {
    const context = objectiveContext(call);
    const highBurn = this.isHighBurnOutcome(output, stepTokens);
    const latex = latexOverfullEvidence(output);
    if (latex !== undefined) {
      return this.recordMinimizingScalar(
        contextObjectiveKey(latex.key, context),
        latex.value,
        latex.detail,
        highBurn,
      );
    }

    const scalar = labeledMinimizingScalar(output);
    if (scalar !== undefined) {
      return this.recordMinimizingScalar(
        contextObjectiveKey(scalar.key, context),
        scalar.value,
        scalar.detail,
        highBurn,
      );
    }

    const vector = labeledNumericVector(output);
    if (vector !== undefined) {
      return this.recordNumericVector(vector.key, vector.values, vector.detail);
    }

    return { observed: false };
  }

  private recordMinimizingScalar(
    key: string,
    value: number,
    detail: string,
    highBurn: boolean,
  ): { observed: boolean; signal?: LoopSignal } {
    if (this.maxObjectiveStallTurns <= 0) return { observed: false };
    const recoveryFingerprint = `objective:${key}:${value.toFixed(6)}`;
    if (this.warnedHighBurnFingerprint === recoveryFingerprint) {
      return {
        observed: true,
        signal: {
          signal: "tool-repeat",
          detail: `${detail} repeated after warning at ${String(value)}`,
          highBurnFingerprint: recoveryFingerprint,
        },
      };
    }
    const prior = this.objectives.get(key);
    if (prior === undefined || value < prior.best - 0.001) {
      this.objectives.set(key, { best: value, stalled: 0 });
      return { observed: true };
    }
    const stalled = prior.stalled + 1;
    this.objectives.set(key, { best: prior.best, stalled });
    const threshold = highBurn
      ? Math.min(this.maxObjectiveStallTurns, this.highBurnOutcomeRepeats)
      : this.maxObjectiveStallTurns;
    if (stalled >= threshold) {
      return {
        observed: true,
        signal: {
          signal: "tool-repeat",
          detail: `${detail} ${highBurn ? "high-burn " : ""}stalled at ${String(value)}; best ${String(
            prior.best,
          )}`,
          highBurnFingerprint: recoveryFingerprint,
        },
      };
    }
    return { observed: true };
  }

  private recordNumericVector(
    key: string,
    values: readonly number[],
    detail: string,
  ): { observed: boolean; signal?: LoopSignal } {
    if (this.maxNumericVectorStallTurns <= 0) return { observed: false };
    const recoveryFingerprint = `numeric-vector:${key}:${values.join(",")}`;
    if (this.warnedHighBurnFingerprint === recoveryFingerprint) {
      return {
        observed: true,
        signal: {
          signal: "tool-repeat",
          detail: `numeric-vector repeated after warning: ${detail}`,
          highBurnFingerprint: recoveryFingerprint,
        },
      };
    }
    const prior = this.numericVectors.get(key) ?? [];
    const next = [...prior, [...values]].slice(-this.maxNumericVectorStallTurns);
    this.numericVectors.set(key, next);
    if (
      next.length >= this.maxNumericVectorStallTurns &&
      (isStableVector(next) || isBoundedOscillation(next, this.numericVectorBand))
    ) {
      const kind = isStableVector(next) ? "stalled" : "oscillation";
      return {
        observed: true,
        signal: {
          signal: "tool-repeat",
          detail: `numeric-vector ${kind}: ${detail}`,
          highBurnFingerprint: recoveryFingerprint,
        },
      };
    }
    return { observed: true };
  }

  private recordEditOscillation(call: {
    readonly name: string;
    readonly args: JsonObjectT;
  }): LoopSignal | undefined {
    if (this.maxEditOscillations <= 0 || !this.editTools.has(call.name)) return undefined;
    const path = call.args[this.pathArg];
    const oldString = call.args["oldString"];
    const newString = call.args["newString"];
    if (
      typeof path !== "string" ||
      typeof oldString !== "string" ||
      typeof newString !== "string"
    ) {
      return undefined;
    }
    const prior = this.editTransitions.get(path);
    const oscillations =
      prior !== undefined && prior.oldString === newString && prior.newString === oldString
        ? prior.oscillations + 1
        : 0;
    this.editTransitions.set(path, { oldString, newString, oscillations });
    if (oscillations >= this.maxEditOscillations) {
      return {
        signal: "tool-repeat",
        detail: `oscillating edit: ${path}`,
      };
    }
    return undefined;
  }
}

const ANSI_PATTERN = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function editOutputIndicatesProgress(output: string): boolean {
  const text = stripAnsi(output).toLowerCase();
  if (
    /\b(no changes?|unchanged|not found|failed|failure|error|denied|ambiguous|stale)\b/.test(text)
  ) {
    return false;
  }
  return /\b(edited|updated|applied|wrote|written|created|replaced|patched)\b/.test(text);
}

function normalizeOutcome(output: string): string | undefined {
  const normalized = stripAnsi(output)
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length < 8) return undefined;
  return normalized.slice(0, 500);
}

function normalizeOutcomeKey(output: string): string | undefined {
  const normalized = normalizeOutcome(output);
  if (normalized === undefined) return undefined;
  const numbers = numericFingerprint(output);
  return numbers === undefined ? normalized : `${normalized} nums:${numbers}`;
}

function numericFingerprint(output: string): string | undefined {
  const numbers = stripAnsi(output).match(/-?\d+(?:\.\d+)?/g);
  if (numbers === null || numbers.length === 0) return undefined;
  return numbers.slice(0, 12).join(",");
}

interface ScalarEvidence {
  readonly key: string;
  readonly value: number;
  readonly detail: string;
}

function latexOverfullEvidence(output: string): ScalarEvidence | undefined {
  const value = maxLatexOverfullPt(output);
  if (value === undefined) return undefined;
  const context = /\bin\s+([^\s]+\.tex)\b/i.exec(output)?.[1];
  const key = context === undefined ? "latex-overfull" : `latex-overfull:${context}`;
  const detail = context === undefined ? "latex-overfull" : `latex-overfull ${context}`;
  return { key, value, detail };
}

function labeledMinimizingScalar(output: string): ScalarEvidence | undefined {
  const text = stripAnsi(output).toLowerCase();
  const afterLabel =
    /\b(validation\s+loss|loss|error|rmse|mse|fail(?:ed|ures?)?|remaining|distance)\b(?:\s*(?::|=)\s*|\s+)(-?\d+(?:\.\d+)?)/i.exec(
      text,
    );
  if (afterLabel !== null) {
    const label = metricLabel(afterLabel[1]!);
    const value = Number(afterLabel[2]);
    if (Number.isFinite(value)) {
      return { key: `metric:${label}`, value, detail: `metric ${label}` };
    }
  }

  const beforeLabel = /\b(-?\d+(?:\.\d+)?)\s+(failed|failures?|errors?|remaining)\b/i.exec(text);
  if (beforeLabel !== null) {
    const label = metricLabel(beforeLabel[2]!);
    const value = Number(beforeLabel[1]);
    if (Number.isFinite(value)) {
      return { key: `metric:${label}`, value, detail: `metric ${label}` };
    }
  }

  return undefined;
}

function metricLabel(label: string): string {
  const normalized = label.toLowerCase().replace(/\s+/g, "-");
  if (normalized.startsWith("fail")) return "failure";
  if (normalized === "error" || normalized === "errors") return "error";
  return normalized;
}

function objectiveContext(call: { readonly name: string; readonly args: JsonObjectT }): string {
  if (call.name === "bash" && typeof call.args["command"] === "string") {
    return `bash:${normalizeContextText(call.args["command"])}`;
  }
  return `${call.name}:${normalizeContextText(stableStringify(signatureArgs(call.name, call.args)))}`;
}

function normalizeContextText(value: string): string {
  return stripAnsi(value)
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function contextObjectiveKey(key: string, context: string): string {
  return `${key}:${context}`;
}

interface VectorEvidence {
  readonly key: string;
  readonly values: readonly number[];
  readonly detail: string;
}

function labeledNumericVector(output: string): VectorEvidence | undefined {
  const text = stripAnsi(output);
  const pairs: { label: string; value: number }[] = [];
  const re = /\b([A-Za-z][A-Za-z_-]{1,31})\s*[:=]\s*(-?\d+(?:\.\d+)?)\b/g;
  for (;;) {
    const match = re.exec(text);
    if (match === null) break;
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    pairs.push({ label: match[1]!.toLowerCase(), value });
    if (pairs.length > 6) return undefined;
  }
  if (pairs.length < 2) return undefined;
  return recognizedNumericVector(pairs);
}

const NUMERIC_VECTOR_GROUPS: readonly {
  readonly key: string;
  readonly labels: readonly string[];
}[] = [
  // Keep production hard halts on vetted semantic vector families. Generic `Label: number`
  // pairs are too broad: compiler diagnostics (`line: 12 column: 5`) and timing logs
  // (`time=12 duration=5`) are ordinary tool output, not objective-vector evidence.
  { key: "takeoff-landing", labels: ["takeoff", "landing"] },
];

function recognizedNumericVector(
  pairs: readonly { readonly label: string; readonly value: number }[],
): VectorEvidence | undefined {
  const byLabel = new Map<string, number>();
  for (const pair of pairs) byLabel.set(pair.label, pair.value);
  for (const group of NUMERIC_VECTOR_GROUPS) {
    if (!group.labels.every((label) => byLabel.has(label))) continue;
    const values = group.labels.map((label) => byLabel.get(label)!);
    return {
      key: `numeric-vector:${group.key}`,
      values,
      detail: group.labels.map((label, i) => `${label}=${String(values[i])}`).join(","),
    };
  }
  return undefined;
}

function isBoundedOscillation(vectors: readonly (readonly number[])[], band: number): boolean {
  if (vectors.length < 3) return false;
  const dimensions = vectors[0]?.length ?? 0;
  if (dimensions < 2) return false;
  if (vectors.some((v) => v.length !== dimensions)) return false;

  for (let dim = 0; dim < dimensions; dim++) {
    const values = vectors.map((v) => v[dim]!);
    const range = Math.max(...values) - Math.min(...values);
    if (range > band) return false;
  }

  const distinct = new Set(vectors.map((v) => v.map((n) => n.toFixed(3)).join(",")));
  if (distinct.size < 3) return false;

  let changes = 0;
  for (let dim = 0; dim < dimensions; dim++) {
    let prevSign = 0;
    for (let i = 1; i < vectors.length; i++) {
      const delta = vectors[i]![dim]! - vectors[i - 1]![dim]!;
      const sign = Math.sign(delta);
      if (sign !== 0 && prevSign !== 0 && sign !== prevSign) changes += 1;
      if (sign !== 0) prevSign = sign;
    }
  }
  return changes >= 2;
}

function isStableVector(vectors: readonly (readonly number[])[]): boolean {
  const first = vectors[0];
  if (first === undefined) return false;
  return vectors.every(
    (v) => v.length === first.length && v.every((value, i) => Math.abs(value - first[i]!) <= 0.001),
  );
}

function maxLatexOverfullPt(output: string): number | undefined {
  let max: number | undefined;
  const re = /Overfull \\hbox \((\d+(?:\.\d+)?)pt too wide\)/g;
  for (;;) {
    const match = re.exec(output);
    if (match === null) break;
    const value = Number(match[1]);
    if (Number.isFinite(value)) max = max === undefined ? value : Math.max(max, value);
  }
  return max;
}
