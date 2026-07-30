import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SessionId, StopReason, type StopReasonT } from "@keel/shared";
import type { RunUsage } from "./cost-cap.js";
import type { HarborInvoker, HarborRunOutcome, HarborTaskOutcome } from "./runner.js";

/**
 * The REAL `HarborInvoker` for the guarded benchmark runner (`runner.ts`): build the `harbor run` argv,
 * spawn it (the venv harbor), and read the resulting job dir back into `HarborTaskOutcome[]`.
 *
 * Split the way `commands.py` is split, for the same reason: the bug-prone, security-relevant parts —
 * the exact argv and the result parsing — are PURE and unit-tested (against a captured job-directory
 * fixture derived from the initial bounded Harbor probe) at zero spend; only the actual subprocess
 * `spawn` is the inherently un-unit-testable edge,
 * validated by the bounded live Harbor validation run.
 */

/** Raised when a harbor job dir cannot be parsed into outcomes (missing result/reward/ledger). Fail
 *  closed: an unparseable trial must never become a silent $0/resolved=false outcome that under-counts
 *  spend or mis-scores the run. */
export class HarborParseError extends Error {
  constructor(message: string) {
    super(`harbor job parse: ${message}`);
    this.name = "HarborParseError";
  }
}

/** Options for one `harbor run` invocation. `jobName` makes the output dir deterministic (no stdout
 *  scraping); `jobsDir` should be ABSOLUTE for a real run so the parser finds it regardless of cwd. */
export interface HarborRunOpts {
  readonly dataset: string;
  readonly agentImportPath: string;
  readonly model: string;
  readonly taskNames: readonly string[];
  readonly binaryUrl: string;
  /** SHA-256 recorded by the owner for the exact locally served evaluation binary. The adapter
   *  authenticates the download before installation or execution. */
  readonly binarySha256: string;
  /** KEEL_MAX_TOKENS — the effective-cost cap. OPTIONAL: a gross-only run (matrix variant A, the raw
   *  control) omits it and sets only `maxGrossTokens`. At least one of `maxTokens`/`maxGrossTokens`
   *  MUST be set — `buildHarborRunArgs` refuses an uncapped paid run (fail-closed money-safety). */
  readonly maxTokens?: number;
  /** KEEL_MAX_GROSS_TOKENS — raw-token cap. The ONLY cap for variant A (a true pre-ADR-0044 raw cap);
   *  a high backstop for B/C to bound wall time without cutting cost-cheap progress. */
  readonly maxGrossTokens?: number;
  /** KEEL_MAX_OUTPUT_TOKENS — output over-generation guard (matrix variant C sets it). */
  readonly maxOutputTokens?: number;
  /** KEEL_MAX_TURNS — explicit turn cap (ER-038). Raises the in-container loop's default so the BUDGET,
   *  not the turn cap, bounds a cost-aware variant's runway. Held identical across the matrix variants
   *  (the token caps are the only difference). NOT a money cap — the uncapped-run refusal above still
   *  requires a token cap. Unset → the in-container kernel default applies. */
  readonly maxTurns?: number;
  /** KEEL_COMPACTION — enable in-loop context compaction (Epic 1.6c). The compaction-ablation ARM
   *  toggle: `true` → the compaction-ON arm; omitted/false → the compaction-OFF arm (byte-identical to
   *  the prior argv). Isolate this as the single lever between the two arms (run-plan §Config). */
  readonly compaction?: boolean;
  /** KEEL_CONTEXT_WINDOW — the context window (tokens) compaction targets. Only emitted when
   *  `compaction` is on; omitted → the in-container default. */
  readonly contextWindow?: number;
  /** KEEL_COMPACTION_RECENT — recent turns kept verbatim. Only emitted when `compaction` is on. */
  readonly compactionRecent?: number;
  /** KEEL_PRESTOP_CHECK_CMD — opt-in clean-subprocess completion check (Epic 2.23). Emitting this also
   *  emits `KEEL_VERIFY=1` plus `KEEL_VERIFY_MODE=prestop`, because the kernel intentionally ignores
   *  pre-stop checks unless the verification gate is explicitly enabled, and the eval path must never
   *  silently fall back to the prompt-only gate when the command is missing/miswired. */
  readonly preStopCheckCommand?: string;
  readonly preStopCheckTimeoutMs?: number;
  readonly preStopCheckMaxOutputBytes?: number;
  /** Reviewed interactive-console product config for installed-adapter runs that need a warden-owned
   *  console backend. Mutually exclusive with `interactiveConsoleConfigB64`; either form automatically
   *  enables `KEEL_WARDEN_SANDBOX=srt` so product config cannot silently run without SRT. */
  readonly interactiveConsoleConfig?: string;
  readonly interactiveConsoleConfigB64?: string;
  /** Parent-reviewed, one-use console grant envelope for installed-adapter runs. This is not authority
   *  by itself: it may only be emitted alongside reviewed interactive-console product config, and the
   *  warden still revalidates it against live target/session/sandbox/policy material before use. */
  readonly interactiveConsoleGrantB64?: string;
  readonly interactiveConsoleSessionId?: string;
  readonly interactiveConsoleHome?: string;
  /** Extra guardrail for grant env emission. v1 supports only the two Terminal-Bench QEMU tasks as
   *  singleton, one-attempt batches; broader grant use needs a new typed eligibility path. */
  readonly interactiveConsoleGrantEligibility?: InteractiveConsoleGrantEligibility;
  /** Eval-only direct execution acknowledgment. In release binaries this env is inert; bin-eval also
   *  requires this runtime acknowledgment before ordinary eval tools bypass the warden. */
  readonly evalDirectExec?: boolean;
  readonly jobName: string;
  readonly jobsDir?: string;
  /** KEEL_HOME inside the container. Defaults to a path UNDER `/logs/agent`, which Harbor syncs back to
   *  the host — so keel's session ledger (the exact token usage) reaches the parser. */
  readonly keelHome?: string;
  readonly nConcurrent?: number;
  readonly nAttempts?: number;
}

const DEFAULT_KEEL_HOME = "/logs/agent/keelhome";
const TERMINAL_BENCH_QEMU_CONSOLE_GRANT_TASKS = new Set(["qemu-startup", "qemu-alpine-ssh"]);
export const EVAL_DIRECT_EXEC_ENV = "KEEL_EVAL_DIRECT_EXEC";
export const EVAL_DIRECT_EXEC_ACK = "i-understand-this-disables-the-warden-eval-only";

export interface InteractiveConsoleGrantEligibility {
  readonly kind: "terminal-bench-qemu-singleton";
  readonly taskName: "qemu-startup" | "qemu-alpine-ssh";
}

function bareTaskName(taskName: string): string {
  return taskName.includes("/") ? taskName.slice(taskName.lastIndexOf("/") + 1) : taskName;
}

function assertInteractiveConsoleGrantEligibility(
  opts: HarborRunOpts,
  hasInteractiveConsoleConfig: boolean,
): void {
  if (opts.interactiveConsoleGrantB64 === undefined) return;
  if (!hasInteractiveConsoleConfig) {
    throw new Error(
      "buildHarborRunArgs: interactive console grant requires interactive console config",
    );
  }
  const eligibility = opts.interactiveConsoleGrantEligibility;
  if (eligibility === undefined) {
    throw new Error(
      "buildHarborRunArgs: interactive console grant requires terminal-bench QEMU singleton eligibility",
    );
  }
  if (opts.taskNames.length !== 1) {
    throw new Error(
      "buildHarborRunArgs: interactive console grant requires a singleton QEMU task batch",
    );
  }
  const taskName = bareTaskName(opts.taskNames[0]!);
  if (taskName !== eligibility.taskName || !TERMINAL_BENCH_QEMU_CONSOLE_GRANT_TASKS.has(taskName)) {
    throw new Error(
      "buildHarborRunArgs: interactive console grant eligibility does not match task",
    );
  }
  if ((opts.nAttempts ?? 1) !== 1) {
    throw new Error("buildHarborRunArgs: interactive console grant requires exactly one attempt");
  }
  if ((opts.nConcurrent ?? 1) !== 1) {
    throw new Error("buildHarborRunArgs: interactive console grant requires exactly one worker");
  }
  if (opts.interactiveConsoleSessionId === undefined) {
    throw new Error("buildHarborRunArgs: interactive console grant requires KEEL_RUN_SESSION_ID");
  }
  if (!SessionId.safeParse(opts.interactiveConsoleSessionId).success) {
    throw new Error("buildHarborRunArgs: interactive console session id must be ses_<ULID>");
  }
}

/** Build the `harbor run` argv (pure). Mirrors the invocation proven by initial bounded Harbor probe. Refuses an UNCAPPED paid
 *  run (neither `maxTokens` nor `maxGrossTokens` set) — an unbounded benchmark spend is a money footgun. */
export function buildHarborRunArgs(opts: HarborRunOpts): string[] {
  if (!/^[0-9a-f]{64}$/u.test(opts.binarySha256)) {
    throw new Error(
      "buildHarborRunArgs: binary SHA-256 must be 64 lowercase hexadecimal characters",
    );
  }
  if (opts.maxTokens === undefined && opts.maxGrossTokens === undefined) {
    throw new Error(
      "buildHarborRunArgs: refusing an uncapped run — set maxTokens (KEEL_MAX_TOKENS, effective cap) " +
        "and/or maxGrossTokens (KEEL_MAX_GROSS_TOKENS, raw cap). A paid benchmark run must be bounded.",
    );
  }
  if (
    opts.interactiveConsoleConfig !== undefined &&
    opts.interactiveConsoleConfigB64 !== undefined
  ) {
    throw new Error("buildHarborRunArgs: set only one interactive console config");
  }
  const hasInteractiveConsoleConfig =
    opts.interactiveConsoleConfig !== undefined || opts.interactiveConsoleConfigB64 !== undefined;
  assertInteractiveConsoleGrantEligibility(opts, hasInteractiveConsoleConfig);
  const args = [
    "run",
    "--env",
    "docker",
    "--dataset",
    opts.dataset,
    "--agent-import-path",
    opts.agentImportPath,
    "-m",
    opts.model,
    "-k",
    String(opts.nAttempts ?? 1),
    "-n",
    String(opts.nConcurrent ?? 1),
    "-y",
    "--job-name",
    opts.jobName,
    "--jobs-dir",
    opts.jobsDir ?? "jobs",
    "--ae",
    `KEEL_BINARY_URL=${opts.binaryUrl}`,
    "--ae",
    `KEEL_BINARY_SHA256=${opts.binarySha256}`,
    "--ae",
    `KEEL_HOME=${opts.keelHome ?? DEFAULT_KEEL_HOME}`,
  ];
  // KEEL_MAX_TOKENS is the in-container EFFECTIVE-cost cap (ADR-0044): the binary discounts cached input
  // by the provider's cacheReadWeight (anthropic 0.1×) from KEEL_PROVIDER. Emitted ONLY when set — a
  // gross-only run (variant A, the raw control) omits it so it is NOT given the cache discount.
  if (opts.maxTokens !== undefined) {
    args.push("--ae", `KEEL_MAX_TOKENS=${String(opts.maxTokens)}`);
  }
  // The A/B/C matrix (ER-038) adds the gross backstop + output guard for variants B/C — only when set,
  // so variant A (single raw cap) and a plain run emit exactly the prior argv (no behavior change).
  if (opts.maxGrossTokens !== undefined) {
    args.push("--ae", `KEEL_MAX_GROSS_TOKENS=${String(opts.maxGrossTokens)}`);
  }
  if (opts.maxOutputTokens !== undefined) {
    args.push("--ae", `KEEL_MAX_OUTPUT_TOKENS=${String(opts.maxOutputTokens)}`);
  }
  // KEEL_MAX_TURNS (ER-038) — emitted only when set, so a plain run / variant A without an explicit turn
  // cap is byte-identical to before (the in-container DEFAULT_MAX_TURNS applies). A turn cap alone does
  // NOT satisfy the uncapped-run guard above (it bounds loop depth, not spend).
  if (opts.maxTurns !== undefined) {
    args.push("--ae", `KEEL_MAX_TURNS=${String(opts.maxTurns)}`);
  }
  if (hasInteractiveConsoleConfig) {
    args.push("--ae", "KEEL_WARDEN_SANDBOX=srt");
    args.push("--ae", `${EVAL_DIRECT_EXEC_ENV}=${EVAL_DIRECT_EXEC_ACK}`);
    if (opts.interactiveConsoleConfig !== undefined) {
      args.push("--ae", `KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG=${opts.interactiveConsoleConfig}`);
    }
    if (opts.interactiveConsoleConfigB64 !== undefined) {
      args.push(
        "--ae",
        `KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64=${opts.interactiveConsoleConfigB64}`,
      );
    }
    if (opts.interactiveConsoleGrantB64 !== undefined) {
      args.push("--ae", `HOME=${opts.interactiveConsoleHome ?? "/logs/agent"}`);
      args.push(
        "--ae",
        `KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64=${opts.interactiveConsoleGrantB64}`,
      );
      args.push("--ae", `KEEL_RUN_SESSION_ID=${opts.interactiveConsoleSessionId ?? ""}`);
    }
  } else if (opts.evalDirectExec === true) {
    args.push("--ae", `${EVAL_DIRECT_EXEC_ENV}=${EVAL_DIRECT_EXEC_ACK}`);
  }
  // The Epic 1.6c compaction-ablation arm: KEEL_COMPACTION is the single lever between the on/off arms.
  // Emitted only when `compaction` is true, so the off arm (and every prior caller) is byte-identical.
  if (opts.compaction === true) {
    args.push("--ae", "KEEL_COMPACTION=1");
    if (opts.contextWindow !== undefined) {
      args.push("--ae", `KEEL_CONTEXT_WINDOW=${String(opts.contextWindow)}`);
    }
    if (opts.compactionRecent !== undefined) {
      args.push("--ae", `KEEL_COMPACTION_RECENT=${String(opts.compactionRecent)}`);
    }
  }
  const preStopCommand = opts.preStopCheckCommand?.trim();
  if (preStopCommand !== undefined && preStopCommand.length > 0) {
    args.push(
      "--ae",
      "KEEL_VERIFY=1",
      "--ae",
      "KEEL_VERIFY_MODE=prestop",
      "--ae",
      `KEEL_PRESTOP_CHECK_CMD=${preStopCommand}`,
    );
    if (opts.preStopCheckTimeoutMs !== undefined) {
      args.push("--ae", `KEEL_PRESTOP_CHECK_TIMEOUT_MS=${String(opts.preStopCheckTimeoutMs)}`);
    }
    if (opts.preStopCheckMaxOutputBytes !== undefined) {
      args.push(
        "--ae",
        `KEEL_PRESTOP_CHECK_MAX_OUTPUT_BYTES=${String(opts.preStopCheckMaxOutputBytes)}`,
      );
    }
  }
  for (const t of opts.taskNames) args.push("-i", t);
  return args;
}

const TrialResult = z
  .object({
    task_id: z.object({ name: z.string().min(1) }).passthrough(),
    trial_name: z.string().min(1),
  })
  .passthrough();

const RunStatusUsage = z.object({
  inputTokens: z.number().nonnegative().finite(),
  outputTokens: z.number().nonnegative().finite(),
  // The cache-read subset (ADR-0044) — the substrate for effective-cost reconstruction. Optional, so an
  // older ledger / non-caching provider (no field) still parses; absent → treated as 0 downstream.
  cachedInputTokens: z.number().nonnegative().finite().optional(),
  // The cache-WRITE subset (ADR-0047) — for exact real-cost accounting. Optional (older ledgers omit it).
  cacheCreationInputTokens: z.number().nonnegative().finite().optional(),
});
type RunStatusUsageT = z.infer<typeof RunStatusUsage>;

/** Parse a trial's synced keel session ledger (`agent/keelhome/sessions/*.jsonl`) into the event array,
 *  tolerating a torn trailing line. Files are read in name order (deterministic). Returns [] if absent. */
async function readTrialSessionEvents(trialDir: string): Promise<Array<Record<string, unknown>>> {
  const sessionsDir = join(trialDir, "agent", "keelhome", "sessions");
  let files: string[];
  try {
    files = (await readdir(sessionsDir)).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const events: Array<Record<string, unknown>> = [];
  for (const f of files) {
    const raw = await readFile(join(sessionsDir, f), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const ev: unknown = JSON.parse(trimmed);
        if (typeof ev === "object" && ev !== null) events.push(ev as Record<string, unknown>);
      } catch {
        continue; // tolerate a torn line
      }
    }
  }
  return events;
}

function addRunStatusUsage(total: RunStatusUsageT | null, next: RunStatusUsageT): RunStatusUsageT {
  if (total === null) return next;
  const cachedInputTokens =
    total.cachedInputTokens !== undefined || next.cachedInputTokens !== undefined
      ? (total.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0)
      : undefined;
  const cacheCreationInputTokens =
    total.cacheCreationInputTokens !== undefined || next.cacheCreationInputTokens !== undefined
      ? (total.cacheCreationInputTokens ?? 0) + (next.cacheCreationInputTokens ?? 0)
      : undefined;
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
  };
}

/** Sum every `run_status.usage` delta from a trial's session ledger. Throws if no ledger / no usage —
 *  fail closed (unknown cost must never become a silent $0). Used by the spend path. */
async function readTrialUsage(trialDir: string): Promise<RunUsage> {
  const events = await readTrialSessionEvents(trialDir);
  let usage: RunStatusUsageT | null = null;
  for (const ev of events) {
    if (ev["type"] === "run_status") {
      const parsed = RunStatusUsage.safeParse(ev["usage"]);
      if (parsed.success) usage = addRunStatusUsage(usage, parsed.data);
    }
  }
  if (usage === null) {
    throw new HarborParseError(
      `no run_status usage in ${join(trialDir, "agent", "keelhome", "sessions")} — keel's session ` +
        `ledger did not sync (set KEEL_HOME under /logs/agent so Harbor syncs it back); refusing to ` +
        `record an unknown cost as $0`,
    );
  }
  return usage;
}

/** Per-trial instrumentation for the Epic 1.11 A/B/C matrix (ER-038): summed per-run usage (incl. the
 *  cache-read subset), the kernel stop `reason` (for end-kind reconstruction), and trajectory-shape
 *  counters. NEVER throws — a trial whose ledger did not sync returns zero/`null` so the runner can
 *  classify it as `timeout`/`error` rather than crashing the whole matrix. (Distinct from the spend
 *  path's `readTrialUsage`, which fails closed; the matrix is analysis, not money.) */
export interface MatrixTrialStats {
  readonly usage: RunStatusUsageT;
  /** The kernel `stop` reason from the last `run_status`, or `null` when no ledger synced. */
  readonly reason: StopReasonT | null;
  /** Assistant turns taken. */
  readonly turns: number;
  /** Tool calls the model issued (summed across assistant turns). */
  readonly toolCalls: number;
  /** Wall time from the first to the last ledger timestamp, or `null` if < 2 timestamped events. */
  readonly wallTimeMs: number | null;
}

export async function readTrialMatrixStats(trialDir: string): Promise<MatrixTrialStats> {
  const events = await readTrialSessionEvents(trialDir);
  let usage: RunStatusUsageT | null = null;
  let reason: StopReasonT | null = null;
  let turns = 0;
  let toolCalls = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  for (const ev of events) {
    const tsRaw = ev["ts"];
    const ts = typeof tsRaw === "string" ? Date.parse(tsRaw) : NaN;
    if (Number.isFinite(ts)) {
      firstTs ??= ts;
      lastTs = ts;
    }
    if (ev["type"] === "run_status") {
      const u = RunStatusUsage.safeParse(ev["usage"]);
      if (u.success) usage = addRunStatusUsage(usage, u.data);
      const r = StopReason.safeParse(ev["reason"]);
      if (r.success) reason = r.data;
    } else if (ev["type"] === "assistant") {
      turns += 1;
      const tc = ev["toolCalls"];
      if (Array.isArray(tc)) toolCalls += tc.length;
    }
  }
  return {
    usage: usage ?? { inputTokens: 0, outputTokens: 0 },
    reason,
    turns,
    toolCalls,
    wallTimeMs: firstTs !== null && lastTs !== null ? lastTs - firstTs : null,
  };
}

/** A trial dir's `result.json`, read ONCE for both the spend and analysis parsers (EVAL-5): `absent` =
 *  no result.json (not a trial dir), `malformed` = present but unparseable / wrong shape, `ok` = a
 *  zod-validated `TrialResult`. The CALLER applies its own policy (spend throws on malformed; analysis
 *  skips), so the two parsers can no longer diverge on what counts as a trial. */
type TrialResultRead =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" }
  | { readonly kind: "ok"; readonly result: z.infer<typeof TrialResult> };

export async function readTrialResult(trialDir: string): Promise<TrialResultRead> {
  let raw: string;
  try {
    raw = await readFile(join(trialDir, "result.json"), "utf8");
  } catch {
    return { kind: "absent" };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "malformed" };
  }
  const parsed = TrialResult.safeParse(json);
  return parsed.success ? { kind: "ok", result: parsed.data } : { kind: "malformed" };
}

/** A trial's verifier reward, read ONCE for both parsers (EVAL-5). The caller applies its policy: the
 *  spend path throws on `missing`/`non-numeric` and treats `empty` as a 0 reward (preserving its prior
 *  `Number("")===0` behavior); the analysis path maps any non-`ok` to its -1 "no verdict" sentinel. */
type RewardRead =
  | { readonly ok: true; readonly value: number }
  | {
      readonly ok: false;
      readonly reason: "missing" | "empty" | "non-numeric";
      readonly raw: string;
    };

export async function readTrialReward(trialDir: string): Promise<RewardRead> {
  let raw: string;
  try {
    raw = (await readFile(join(trialDir, "verifier", "reward.txt"), "utf8")).trim();
  } catch {
    return { ok: false, reason: "missing", raw: "" };
  }
  if (raw === "") return { ok: false, reason: "empty", raw };
  const value = Number(raw);
  return Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: "non-numeric", raw };
}

/** Spend policy over a (pre-read) trial: fail closed on absent/malformed result.json or a missing/
 *  non-numeric reward (never record an unknown verdict's cost); an EMPTY reward.txt is a 0 reward. */
async function spendOutcome(trialDir: string, read: TrialResultRead): Promise<HarborTaskOutcome> {
  if (read.kind === "absent") throw new HarborParseError(`missing result.json in ${trialDir}`);
  if (read.kind === "malformed") throw new HarborParseError(`malformed result.json in ${trialDir}`);
  const reward = await readTrialReward(trialDir);
  if (!reward.ok && reward.reason === "missing") {
    throw new HarborParseError(
      `missing verifier/reward.txt in ${trialDir} (trial likely errored before verification)`,
    );
  }
  if (!reward.ok && reward.reason === "non-numeric") {
    throw new HarborParseError(`non-numeric reward "${reward.raw}" in ${trialDir}`);
  }
  const value = reward.ok ? reward.value : 0; // an empty reward.txt → 0 (prior Number("")===0 behavior)
  const usage = await readTrialUsage(trialDir);
  return {
    taskId: read.result.task_id.name,
    resolved: value > 0,
    failureMode: null,
    trial: read.result.trial_name,
    usage,
  };
}

/** Parse one harbor trial dir into a `HarborTaskOutcome`: bare task id + resolved verdict + token usage.
 *  `failureMode` is left null here — the §2.3 analyzer classifies failures from the trajectory. */
export async function parseHarborTrialDir(trialDir: string): Promise<HarborTaskOutcome> {
  return spendOutcome(trialDir, await readTrialResult(trialDir));
}

/** Parse a whole harbor job dir into `HarborRunOutcome`. Each subdirectory that has a `result.json` is a
 *  trial (ground truth); non-trial entries (job.log, config.json, lock.json) are skipped. Trials are
 *  sorted by dir name so the persisted `tasks[]` is byte-reproducible across filesystems rather than
 *  dependent on raw `readdir` order (EVAL-3). `readdirFn` is injectable for deterministic ordering tests. */
export async function parseHarborJobDir(
  jobDir: string,
  readdirFn: (p: string) => Promise<Dirent[]> = (p) => readdir(p, { withFileTypes: true }),
): Promise<HarborRunOutcome> {
  const entries = (await readdirFn(jobDir)).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const tasks: HarborTaskOutcome[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const trialDir = join(jobDir, e.name);
    const read = await readTrialResult(trialDir);
    if (read.kind === "absent") continue; // not a trial dir → skip (a single read; no re-read below)
    tasks.push(await spendOutcome(trialDir, read)); // throws on malformed / no-verdict (fail-closed)
  }
  if (tasks.length === 0) {
    throw new HarborParseError(`no trial dirs (with result.json) found under ${jobDir}`);
  }
  return { tasks };
}

/** How `makeHarborInvoker` runs the subprocess. Injected in tests; the default spawns the real harbor. */
export type HarborSpawn = (args: readonly string[]) => Promise<void>;

/** The real subprocess spawn. Spawns `bin` (default `harbor`, expected on PATH / venv-activated),
 *  inheriting stdio + env (ANTHROPIC_API_KEY, DOCKER_DEFAULT_PLATFORM, …) and rejecting on a non-zero
 *  exit or spawn error. `bin` is injectable so the spawn mechanism itself is testable (against `true`/
 *  `false`); the harbor-specific behavior is the part validated only by the bounded live Harbor
 *  validation run. */
export function defaultHarborSpawn(cwd?: string, bin = "harbor"): HarborSpawn {
  return (args) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(bin, [...args], { cwd, stdio: "inherit", env: process.env });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`${bin} run exited ${String(code)}`)),
      );
    });
}

/** Wire a real `HarborInvoker` for `runGuardedBenchmark`: build the argv, spawn harbor, parse the
 *  resulting (deterministic) job dir. `spawn` is injectable so the wiring is testable without harbor. */
export function makeHarborInvoker(
  opts: HarborRunOpts,
  spawnFn: HarborSpawn = defaultHarborSpawn(),
): HarborInvoker {
  const jobDir = join(opts.jobsDir ?? "jobs", opts.jobName);
  return async () => {
    await spawnFn(buildHarborRunArgs(opts));
    return parseHarborJobDir(jobDir);
  };
}
