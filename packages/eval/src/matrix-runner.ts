import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { assertCacheWeightConsistent, estimateCostUSD, type TokenPricing } from "./cost-cap.js";
import {
  buildHarborRunArgs,
  makeHarborInvoker,
  readTrialMatrixStats,
  readTrialResult,
  readTrialReward,
  type HarborRunOpts,
  type HarborSpawn,
} from "./harbor-invoker.js";
import {
  terminalBenchInteractiveConsoleConfigB64ForTasks,
  terminalBenchInteractiveConsoleGrantEnvForTaskSync,
  type TerminalBenchInteractiveConsoleConfigOptions,
} from "./interactive-console-config.js";
import {
  MatrixRun,
  buildMatrixTaskRecord,
  variantHarborCaps,
  writeMatrixRun,
  type MatrixRunT,
  type MatrixTaskRecordT,
  type MatrixVariant,
} from "./matrix.js";
import {
  estimateBenchmarkCostUB,
  runGuardedBenchmark,
  type GuardedBenchmarkRequest,
} from "./runner.js";
import { assertRunMatchesSubset } from "./tb2/subsets.js";

/**
 * The Epic 1.11 A/B/C matrix ORCHESTRATION runner (ER-038). It ties the merged building blocks
 * (`variantHarborCaps` → `buildHarborRunArgs` → `runGuardedBenchmark` → `readTrialMatrixStats` →
 * `buildMatrixTaskRecord` → `writeMatrixRun`) into one path: plan → preflight-estimate → (dry-run OR
 * guarded paid run) → persist a `MatrixRun` per variant.
 *
 * Design for de-risking a paid run BEFORE spending:
 * - **Dry-run is first-class** (`dryRunMatrix`): variant expansion, batch planning, the exact harbor
 *   argv, the spend estimate, and the output paths are all produced with ZERO spend / ZERO Anthropic /
 *   ZERO harbor execution.
 * - **The paid per-batch op is injected** (`BatchExecutor`), so the orchestration (planning,
 *   persistence, per-variant runs, batch sizing) is unit-tested at $0 with a fake; the real spend edge
 *   (`defaultBatchExecutor` = guarded harbor spawn + job-dir parse) is the only un-unit-tested part.
 * - **Fail closed:** a variant with no explicit cap is refused; a single task whose UB exceeds the
 *   per-run guard is refused; `runGuardedBenchmark` refuses any batch over the cap before any paid call.
 *
 * NOT here (matrix-prep scope): prompt changes, convergence heuristics, cap tuning, output-policy.
 */

/** Mirrors `estimateBenchmarkCostUB`'s defaults — the same conservative UB the spend guard applies (input
 *  charged un-cached, output 5×). Kept here so the preflight estimate equals the guard's; a test pins it. */
export const UB_OVERSHOOT_FACTOR = 1.3;
export const UB_OUTPUT_FRACTION = 0.25;

/** Upper-bound USD for `taskCount` tasks each capped at `perTaskTokenCap`. Same math as
 *  `estimateBenchmarkCostUB` (cap × overshoot, split input/output, priced un-cached) so the runner's
 *  preflight matches what `guardedRun` will compute at call time. */
export function estimateBatchUB(
  perTaskTokenCap: number,
  taskCount: number,
  pricing: TokenPricing,
): number {
  const perTaskTotal = perTaskTokenCap * UB_OVERSHOOT_FACTOR;
  const perTask = estimateCostUSD(
    {
      inputTokens: perTaskTotal * (1 - UB_OUTPUT_FRACTION),
      outputTokens: perTaskTotal * UB_OUTPUT_FRACTION,
    },
    pricing,
  );
  return perTask * taskCount;
}

/** The worst-case per-task token consumption used for the estimate: the GROSS bound (raw input+output)
 *  the run can reach — `maxGrossTokens` if set (B/C's 1.2M backstop, A's 400k cap), else the effective
 *  `maxTokens`. Throws if a variant resolves to NO token cap at all (fail-closed — an unbounded paid run
 *  must never be planned; requirement 7). */
export function worstCaseTokenCap(caps: {
  maxTokens?: number;
  maxGrossTokens?: number;
  maxOutputTokens?: number;
}): number {
  const cap = caps.maxGrossTokens ?? caps.maxTokens;
  if (cap === undefined) {
    throw new Error(
      "matrix-runner: a variant resolved to NO token cap (no effective and no gross cap) — refusing " +
        "to plan an unbounded paid run (fail-closed). Every variant must set maxEffectiveTokens and/or " +
        "maxGrossTokens.",
    );
  }
  return cap;
}

/** One harbor invocation: a slice of the task set sized so its UB estimate stays under the per-run guard. */
export interface MatrixBatchPlan {
  readonly variantId: MatrixVariant["id"];
  readonly batchIndex: number;
  readonly jobName: string;
  readonly taskNames: readonly string[];
  /** The gross token bound used for the estimate (the run's worst-case consumption). */
  readonly perTaskTokenCap: number;
  readonly estimateUSD: number;
  /** The exact harbor opts (incl. caps) — `buildHarborRunArgs(harborOpts)` is the argv this batch runs. */
  readonly harborOpts: HarborRunOpts;
}

export interface MatrixVariantPlan {
  readonly variant: MatrixVariant;
  readonly caps: { maxTokens?: number; maxGrossTokens?: number; maxOutputTokens?: number };
  readonly batches: readonly MatrixBatchPlan[];
  readonly estimateUSD: number;
  /** Where this variant's `MatrixRun` JSON is written. */
  readonly outFile: string;
}

export interface MatrixPlan {
  readonly variants: readonly MatrixVariantPlan[];
  readonly totalEstimateUSD: number;
}

/** Everything the runner needs. `pricing` + `perRunUSD` come from the owner-set eval config; the run
 *  identity fields (`ranAt`) are passed in (no clock in this module — determinism). */
export interface MatrixRunnerConfig {
  readonly variants: readonly MatrixVariant[];
  readonly taskNames: readonly string[];
  /** The subset this run CLAIMS to be (e.g. `keel-tb2-25`). For a pinned subset, `runMatrix` binds
   *  `taskNames` to its committed task set fail-closed before any paid batch (EVAL-1). A custom name
   *  is unconstrained. */
  readonly subset: string;
  readonly model: string;
  readonly suite: string;
  /** Provider cache-read weight for the per-task effective-token metric (anthropic 0.1×). */
  readonly cacheReadWeight: number;
  readonly dataset: string;
  readonly agentImportPath: string;
  readonly binaryUrl: string;
  /** SHA-256 for the exact owner-built evaluation binary served at `binaryUrl`. */
  readonly binarySha256: string;
  /** Harbor writes job dirs under here; the runner reads them back for the per-task records. */
  readonly jobsDir: string;
  /** Where `matrix-<id>.json` files are written. */
  readonly outDir: string;
  readonly pricing: TokenPricing;
  /** Per-run spend guard (e.g. $25) — batches are sized so each invocation's UB stays strictly under it. */
  readonly perRunUSD: number;
  /** ISO timestamp stamped onto each MatrixRun (passed in — no clock here). */
  readonly ranAt: string;
  readonly keelHome?: string;
  readonly nAttempts?: number;
  readonly nConcurrent?: number;
  /** Opt-in reviewed interactive-console product config for Terminal-Bench QEMU tasks. Omitted by
   *  default so ordinary eval batches do not silently require SRT/tmux/QEMU. */
  readonly interactiveConsole?: TerminalBenchInteractiveConsoleConfigOptions;
  /** Shared turn cap (ER-038): the SAME KEEL_MAX_TURNS for every variant, so the token caps stay the
   *  only difference between A/B/C while the turn cap is raised high enough that the BUDGET — not
   *  DEFAULT_MAX_TURNS=50 — bounds the cost-aware variants' runway. Threaded into every batch's argv and
   *  stamped onto every task record. Unset → the in-container kernel default applies to all variants. */
  readonly maxTurns?: number;
}

/** Split a variant's task set into batches each strictly under `perRunUSD`, and build the exact harbor
 *  opts for each. Refuses (throws) if a SINGLE task's UB already exceeds the per-run guard. */
function taskNeedsInteractiveConsole(
  taskName: string,
  interactiveConsole: TerminalBenchInteractiveConsoleConfigOptions | undefined,
): boolean {
  return (
    interactiveConsole !== undefined &&
    terminalBenchInteractiveConsoleConfigB64ForTasks([taskName], interactiveConsole) !== undefined
  );
}

function taskBatchesFor(
  taskNames: readonly string[],
  batchSize: number,
  interactiveConsole: TerminalBenchInteractiveConsoleConfigOptions | undefined,
): readonly string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
    }
  };
  for (const taskName of taskNames) {
    if (taskNeedsInteractiveConsole(taskName, interactiveConsole)) {
      flush();
      batches.push([taskName]);
      continue;
    }
    current.push(taskName);
    if (current.length >= batchSize) flush();
  }
  flush();
  return batches;
}

const SESSION_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function deterministicSessionIdForJob(jobName: string): string {
  let state = 0x811c9dc5;
  for (const char of jobName) {
    state ^= char.codePointAt(0) ?? 0;
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  let suffix = "";
  for (let index = 0; index < 26; index += 1) {
    state ^= index + 0x9e3779b9;
    state = Math.imul(state, 0x85ebca6b) >>> 0;
    suffix += SESSION_ID_ALPHABET[state & 31]!;
  }
  return `ses_${suffix}`;
}

function planVariant(config: MatrixRunnerConfig, variant: MatrixVariant): MatrixVariantPlan {
  // Requirement 7: refuse a variant that declares no explicit cap (don't run on an implicit default).
  if (
    variant.maxEffectiveTokens === undefined &&
    variant.maxGrossTokens === undefined &&
    variant.maxOutputTokens === undefined
  ) {
    throw new Error(
      `matrix-runner: variant ${variant.id} declares no cap — refusing (fail-closed). Set at least ` +
        `one of maxEffectiveTokens / maxGrossTokens / maxOutputTokens.`,
    );
  }
  const caps = variantHarborCaps(variant);
  const perTaskTokenCap = worstCaseTokenCap(caps); // throws if no token cap (output-only is not a bound)
  const perTaskUB = estimateBatchUB(perTaskTokenCap, 1, config.pricing);
  if (perTaskUB >= config.perRunUSD) {
    throw new Error(
      `matrix-runner: variant ${variant.id} — a single task's UB ($${perTaskUB.toFixed(2)}) is not ` +
        `under the $${String(config.perRunUSD)}/run guard; it cannot be batched. Lower the cap or raise the guard.`,
    );
  }
  // Largest batch that stays STRICTLY under the per-run guard (explicit sizing — requirement 8).
  let batchSize = Math.max(1, Math.floor(config.perRunUSD / perTaskUB));
  while (
    batchSize > 1 &&
    estimateBatchUB(perTaskTokenCap, batchSize, config.pricing) >= config.perRunUSD
  ) {
    batchSize -= 1;
  }
  const batches: MatrixBatchPlan[] = [];
  for (const taskNames of taskBatchesFor(config.taskNames, batchSize, config.interactiveConsole)) {
    const batchIndex = batches.length;
    const jobName = `matrix-${variant.id}-b${String(batchIndex)}`;
    const interactiveConsoleGrant =
      config.interactiveConsole === undefined || taskNames.length !== 1
        ? undefined
        : terminalBenchInteractiveConsoleGrantEnvForTaskSync(taskNames[0]!, {
            ...config.interactiveConsole,
            ...(config.keelHome === undefined ? {} : { keelHome: config.keelHome }),
            sessionId: deterministicSessionIdForJob(jobName),
            reviewedAt: config.ranAt,
            expiresAt: new Date(Date.parse(config.ranAt) + 24 * 60 * 60 * 1000).toISOString(),
          });
    const interactiveConsoleConfigB64 =
      interactiveConsoleGrant?.configB64 ??
      (config.interactiveConsole === undefined
        ? undefined
        : terminalBenchInteractiveConsoleConfigB64ForTasks(taskNames, config.interactiveConsole));
    const harborKeelHome = interactiveConsoleGrant?.keelHome ?? config.keelHome;
    const harborOpts: HarborRunOpts = {
      dataset: config.dataset,
      agentImportPath: config.agentImportPath,
      model: config.model,
      taskNames,
      binaryUrl: config.binaryUrl,
      binarySha256: config.binarySha256,
      jobName,
      jobsDir: config.jobsDir,
      ...(caps.maxTokens !== undefined ? { maxTokens: caps.maxTokens } : {}),
      ...(caps.maxGrossTokens !== undefined ? { maxGrossTokens: caps.maxGrossTokens } : {}),
      ...(caps.maxOutputTokens !== undefined ? { maxOutputTokens: caps.maxOutputTokens } : {}),
      ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
      ...(harborKeelHome !== undefined ? { keelHome: harborKeelHome } : {}),
      ...(config.nAttempts !== undefined ? { nAttempts: config.nAttempts } : {}),
      ...(config.nConcurrent !== undefined ? { nConcurrent: config.nConcurrent } : {}),
      ...(interactiveConsoleConfigB64 === undefined ? {} : { interactiveConsoleConfigB64 }),
      ...(interactiveConsoleGrant === undefined
        ? {}
        : {
            interactiveConsoleGrantB64: interactiveConsoleGrant.grantB64,
            interactiveConsoleSessionId: interactiveConsoleGrant.sessionId,
            interactiveConsoleHome: interactiveConsoleGrant.home,
            interactiveConsoleGrantEligibility: interactiveConsoleGrant.eligibility,
          }),
    };
    batches.push({
      variantId: variant.id,
      batchIndex,
      jobName,
      taskNames,
      perTaskTokenCap,
      estimateUSD: estimateBatchUB(perTaskTokenCap, taskNames.length, config.pricing),
      harborOpts,
    });
  }
  return {
    variant,
    caps,
    batches,
    estimateUSD: batches.reduce((s, b) => s + b.estimateUSD, 0),
    outFile: join(config.outDir, `matrix-${variant.id}.json`),
  };
}

/** Expand the config into the full plan: per-variant batches + the total spend estimate. Pure; refuses
 *  an uncapped variant. This IS the preflight — the caller reads `totalEstimateUSD` before any paid call. */
export function planMatrix(config: MatrixRunnerConfig): MatrixPlan {
  // PERMANENT assumed-vs-actual guard (Epic 1.14): fail closed BEFORE any plan/spend if the budget
  // controller's cache discount (`cacheReadWeight`, ADR-0044) has drifted from the real price ratio
  // (`cacheReadPerMTok / inputPerMTok`). Both are config the operator sets; if they disagree, the
  // effective-cost cap no longer tracks real billing — the exact self-deception this epic exists to end.
  assertCacheWeightConsistent(config.cacheReadWeight, config.pricing);
  const variants = config.variants.map((v) => planVariant(config, v));
  return { variants, totalEstimateUSD: variants.reduce((s, v) => s + v.estimateUSD, 0) };
}

/** The exact harbor argv a batch will run (for the dry-run report). `buildHarborRunArgs` re-throws on an
 *  uncapped batch (defense in depth) — so a dry-run surfaces a bad plan before any spend. */
export function batchArgv(batch: MatrixBatchPlan): string[] {
  return buildHarborRunArgs(batch.harborOpts);
}

export interface MatrixDryRun {
  readonly plan: MatrixPlan;
  /** The exact argv per batch (keyed by jobName) — proves cap wiring with no spend. */
  readonly argvByJob: Record<string, string[]>;
  readonly outFiles: readonly string[];
  readonly totalEstimateUSD: number;
}

/** Produce the full dry-run report: plan + exact argv + output paths + total estimate. ZERO spend, ZERO
 *  Anthropic, ZERO harbor execution — the first-class no-spend validation surface (requirement 6). */
export function dryRunMatrix(config: MatrixRunnerConfig): MatrixDryRun {
  const plan = planMatrix(config);
  const argvByJob: Record<string, string[]> = {};
  for (const v of plan.variants) for (const b of v.batches) argvByJob[b.jobName] = batchArgv(b);
  return {
    plan,
    argvByJob,
    outFiles: plan.variants.map((v) => v.outFile),
    totalEstimateUSD: plan.totalEstimateUSD,
  };
}

/** The PAID per-batch operation: run the batch through the guarded benchmark path and return its
 *  per-task matrix records. Injected so the orchestration is testable at $0 (a fake returns canned
 *  records); production wires `defaultBatchExecutor`. */
export type BatchExecutor = (batch: MatrixBatchPlan) => Promise<MatrixTaskRecordT[]>;

export interface MatrixRunResult {
  readonly runs: readonly MatrixRunT[];
  readonly totalEstimateUSD: number;
}

/**
 * Run the matrix: preflight the plan, then for each variant run its batches via `execBatch`, assemble a
 * `MatrixRun`, and persist it. The caller controls WHICH variants run (pass `[A,B]` first, then `[C]`
 * after the early-stop decision) — the runner runs exactly `config.variants`. NO paid call happens here
 * directly; `execBatch` owns the spend (and in production goes through `runGuardedBenchmark`, which
 * refuses an over-cap batch before spending).
 */
export async function runMatrix(
  config: MatrixRunnerConfig,
  execBatch: BatchExecutor,
  writeRun: (file: string, run: MatrixRunT) => Promise<void> = writeMatrixRun,
): Promise<MatrixRunResult> {
  // EVAL-1: bind the run to its claimed subset BEFORE any paid batch — refuse fail-closed if the task
  // set doesn't match the pinned subset it's labeled as (a custom subset name is unconstrained).
  assertRunMatchesSubset(config.subset, config.taskNames);
  const plan = planMatrix(config); // preflight (throws on uncapped / un-batchable)
  const runs: MatrixRunT[] = [];
  for (const vp of plan.variants) {
    const tasks: MatrixTaskRecordT[] = [];
    for (const batch of vp.batches) tasks.push(...(await execBatch(batch)));
    const run: MatrixRunT = MatrixRun.parse({
      schemaVersion: 1,
      variant: vp.variant.id,
      label: vp.variant.label,
      model: config.model,
      suite: config.suite,
      ranAt: config.ranAt,
      tasks,
    });
    await writeRun(vp.outFile, run);
    runs.push(run);
  }
  return { runs, totalEstimateUSD: plan.totalEstimateUSD };
}

/** Parse a finished harbor job dir into per-task matrix records (fail-open per trial — the matrix is
 *  analysis, not the spend path). For each trial dir: task id + numeric reward + the ledger stats →
 *  `buildMatrixTaskRecord`. A trial missing its result/reward is recorded as a reward `-1` (resolved
 *  false) so it is never silently a 0-cost success. */
export async function parseJobDirMatrixRecords(
  jobDir: string,
  variant: MatrixVariant,
  cacheReadWeight: number,
  maxTurns?: number,
  pricing?: TokenPricing,
): Promise<MatrixTaskRecordT[]> {
  // Sort by dir name so the persisted records are byte-reproducible across filesystems, not dependent
  // on raw `readdir` order (EVAL-3) — matching parseHarborJobDir's discipline.
  const entries = (await readdir(jobDir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const records: MatrixTaskRecordT[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const trialDir = join(jobDir, e.name);
    // Use the SHARED trial readers (EVAL-5) so the analysis path classifies trials and parses rewards
    // identically to the spend path — only the POLICY differs and is explicit here: a non-trial or
    // malformed result.json is skipped (fail-open; now strict-zod-validated, EVAL-6), and a missing/
    // empty/non-numeric reward becomes the -1 "no verdict" sentinel (never a silent 0-cost success).
    const read = await readTrialResult(trialDir);
    if (read.kind !== "ok") continue;
    const rewardRead = await readTrialReward(trialDir);
    const reward = rewardRead.ok ? rewardRead.value : -1;
    const stats = await readTrialMatrixStats(trialDir);
    records.push(
      buildMatrixTaskRecord({
        taskId: read.result.task_id.name,
        reward,
        variant,
        cacheReadWeight,
        stats,
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(pricing !== undefined ? { pricing } : {}),
      }),
    );
  }
  return records;
}

/** The production `BatchExecutor`: run a batch through `runGuardedBenchmark` (the guard refuses an
 *  over-cap batch before any paid call) and then parse its job dir into matrix records. This is the only
 *  un-unit-tested edge (real spawn + guarded spend + fs), validated by the live run — exactly like
 *  `defaultHarborSpawn`. */
export function defaultBatchExecutor(deps: {
  spawn: HarborSpawn;
  guardConfig: GuardedBenchmarkRequest["config"];
  ledgerPath: string;
  descriptorFor: (batch: MatrixBatchPlan) => GuardedBenchmarkRequest["descriptor"];
  variantById: (id: MatrixVariant["id"]) => MatrixVariant;
  cacheReadWeight: number;
  pricing: TokenPricing;
  now: Date;
}): BatchExecutor {
  return async (batch) => {
    const req: GuardedBenchmarkRequest = {
      config: deps.guardConfig,
      ledgerPath: deps.ledgerPath,
      descriptor: deps.descriptorFor(batch),
      taskIds: batch.taskNames,
      perTaskTokenCap: batch.perTaskTokenCap,
      pricing: deps.pricing,
    };
    // The guard refuses BEFORE the paid call if the UB breaches the cap; otherwise spawns harbor.
    await runGuardedBenchmark(req, makeHarborInvoker(batch.harborOpts, deps.spawn), deps.now);
    // Re-read the same job dir for the richer per-task matrix records. The configured turn cap rides on
    // the batch's harbor opts (ER-038), so it is stamped onto every record (turn-bound is self-describing).
    const jobDir = join(batch.harborOpts.jobsDir ?? "jobs", batch.harborOpts.jobName);
    return parseJobDirMatrixRecords(
      jobDir,
      deps.variantById(batch.variantId),
      deps.cacheReadWeight,
      batch.harborOpts.maxTurns,
      deps.pricing,
    );
  };
}

/** Assert the preflight estimate is consistent with the guard's own formula (so the runner never
 *  under-estimates what `guardedRun` will charge). Exposed for the spend-check test. */
export function estimateMatchesGuard(req: GuardedBenchmarkRequest): boolean {
  return (
    Math.abs(
      estimateBatchUB(req.perTaskTokenCap, req.taskIds.length, req.pricing) -
        estimateBenchmarkCostUB(req),
    ) < 1e-9
  );
}
