// @keel/eval — benchmark scaffolding + trajectory store (Epic 0.4, §5.3).
export { EvalConfig, ReasoningEffort, loadEvalConfig } from "./config.js";
export type { EvalConfigT, ReasoningEffortT } from "./config.js";
export { defaultEvalConfig } from "./config.default.js";
export {
  CostCapError,
  SONNET_4_6_PRICING,
  assertCacheWeightConsistent,
  assertConfigCostCap,
  assertConfigMonthlyCap,
  assertWithinCostCap,
  assertWithinMonthlyCap,
  cacheReadRatio,
  estimateCostUSD,
  realCostUSD,
} from "./cost-cap.js";
export type { RunUsage, TokenPricing } from "./cost-cap.js";
export { Trajectory, TrajectoryEvent } from "./trajectory.js";
export type { TrajectoryEventT, TrajectoryT } from "./trajectory.js";
export { ingestTrajectory, readTrajectory, writeTrajectory } from "./store.js";
export { replayModelToTrajectory, replayToTrajectory } from "./replay.js";
export type { ReplayOptions } from "./replay.js";
export {
  BenchmarkResult,
  ResultMismatchError,
  TaskResult,
  parseTerminalBenchResults,
} from "./results.js";
export type { BenchmarkResultT, TaskResultT } from "./results.js";
export {
  DEFAULT_SPEND_LEDGER_PATH,
  SpendLedgerCorruptError,
  SpendRecord,
  appendSpendRecord,
  assertRunWithinCaps,
  guardedRun,
  monthToDateUSD,
  readMonthToDateUSD,
  readSpendRecords,
  withExclusiveLedgerLock,
} from "./spend-ledger.js";
export type { SpendDescriptor, SpendOutcome, SpendRecordT } from "./spend-ledger.js";
export {
  CatalogTask,
  KEEL_TB2_FULL_89,
  KEEL_TB2_HELDOUT,
  KEEL_TB2_SMOKE,
  KEEL_TB2_TUNED,
  SubsetIntegrityError,
  Tb2Catalog,
  Tb2TaskList,
  assertSubsetIntegrity,
  checkSubsetIntegrity,
  loadCatalog,
  loadTaskList,
} from "./tb2/subsets.js";
export type { CatalogTaskT, Tb2CatalogT, Tb2TaskListT } from "./tb2/subsets.js";
export {
  AggregateQualityMetrics,
  TrajectoryQualityMetrics,
  aggregateQualityMetrics,
  trajectoryQualityMetrics,
} from "./trajectory-metrics.js";
export type { AggregateQualityMetricsT, TrajectoryQualityMetricsT } from "./trajectory-metrics.js";
export {
  FailureMode,
  FailureModeReport,
  FailureSignature,
  TrajectoryRef,
  analyzeFailures,
  classifyFailure,
} from "./failure-modes.js";
export type {
  FailureModeReportT,
  FailureModeT,
  FailureSignatureT,
  TrajectoryRefT,
} from "./failure-modes.js";
export {
  estimateBenchmarkCostUB,
  measureBenchmarkCost,
  runGuardedBenchmark,
  toBenchmarkResult,
} from "./runner.js";
export type {
  GuardedBenchmarkOutcome,
  GuardedBenchmarkRequest,
  HarborInvoker,
  HarborRunOutcome,
  HarborTaskOutcome,
} from "./runner.js";
export {
  HarborParseError,
  buildHarborRunArgs,
  defaultHarborSpawn,
  makeHarborInvoker,
  parseHarborJobDir,
  parseHarborTrialDir,
} from "./harbor-invoker.js";
export type { HarborRunOpts, HarborSpawn } from "./harbor-invoker.js";
export {
  terminalBenchInteractiveConsoleGrantEnvForTask,
  terminalBenchInteractiveConsoleGrantEnvForTaskSync,
  terminalBenchInteractiveConsoleConfigB64ForTasks,
  terminalBenchInteractiveConsoleConfigForTasks,
} from "./interactive-console-config.js";
export type {
  TerminalBenchInteractiveConsoleConfigOptions,
  TerminalBenchInteractiveConsoleGrantEnvBundle,
  TerminalBenchInteractiveConsoleGrantEnvOptions,
} from "./interactive-console-config.js";
export {
  HarnessConfig,
  RunEvidence,
  Scoreboard,
  ScoreboardChange,
  ScoreboardEntry,
  addEntry,
  emptyScoreboard,
  loadScoreboard,
  writeScoreboard,
} from "./scoreboard.js";
export type {
  HarnessConfigT,
  Regression,
  RunEvidenceT,
  ScoreboardChangeT,
  ScoreboardEntryT,
  ScoreboardT,
} from "./scoreboard.js";
export { BudgetEndKind, reconstructBudgetEndKind } from "./budget-end-kind.js";
export type { BudgetCaps, BudgetEndKindT } from "./budget-end-kind.js";
export {
  DEFAULT_MATRIX_VARIANTS,
  MatrixRun,
  MatrixTaskRecord,
  MatrixVariantId,
  buildMatrixTaskRecord,
  readMatrixRun,
  variantHarborCaps,
  writeMatrixRun,
} from "./matrix.js";
export type { MatrixRunT, MatrixTaskRecordT, MatrixVariant, MatrixVariantIdT } from "./matrix.js";
export {
  defaultBatchExecutor,
  dryRunMatrix,
  estimateBatchUB,
  parseJobDirMatrixRecords,
  planMatrix,
  runMatrix,
  worstCaseTokenCap,
} from "./matrix-runner.js";
export type {
  BatchExecutor,
  MatrixBatchPlan,
  MatrixDryRun,
  MatrixPlan,
  MatrixRunnerConfig,
  MatrixRunResult,
  MatrixVariantPlan,
} from "./matrix-runner.js";
export {
  DOGFOOD_SCORE_AXES,
  DOGFOOD_WORKFLOW_IDS,
  DogfoodEvidenceIssue,
  DogfoodEvidenceObservation,
  DogfoodScenarioManifest,
  compareDogfoodEvidence,
} from "./dogfood-evidence.js";
export type {
  DogfoodEvidenceIssueT,
  DogfoodEvidenceObservationT,
  DogfoodScenarioManifestT,
} from "./dogfood-evidence.js";
