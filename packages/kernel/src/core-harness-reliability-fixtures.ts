import type { ModelStreamChunkT, ModelUsageT } from "@keel/shared";
import type {
  LoopDetectionReplayCorpusRequirements,
  LoopDetectionReplayFixture,
} from "./loop-detection-replay.js";

/**
 * Internal fixture corpus for Epic 2.28 replay and regression tests. This module is intentionally
 * not exported from `packages/kernel/src/index.ts`; it is buildable TypeScript only so tests and
 * future slice-local validators can share one typed corpus without introducing a new public contract.
 */

export type CoreHarnessReliabilitySuite = "tb2" | "non-tb";

export type CoreHarnessReliabilityPrimitive =
  | "context-pressure"
  | "observation-shaping"
  | "service-lifecycle"
  | "acceptance-contract"
  | "loop-progress"
  | "recovery-feedback";

export const REQUIRED_SLICE_0_FIXTURE_IDS = [
  "tb2-dense-context-under-count",
  "tb2-newly-appended-giant-observation",
  "tb2-service-killed-on-teardown",
  "tb2-required-artifact-missing",
  "tb2-empty-malformed-model-stop",
  "tb2-high-burn-varied-nonprogress-loop",
  "tb2-known-good-preemption",
  "non-tb-slow-legitimate-progress",
  "non-tb-long-compile-repeated-output",
  "non-tb-local-service-handoff",
  "non-tb-generated-artifact",
  "non-tb-broad-scalar-metric",
  "non-tb-monotonic-noisy-improvement",
  "non-tb-edit-anchor-churn",
] as const;

export type Slice0FixtureId = (typeof REQUIRED_SLICE_0_FIXTURE_IDS)[number];

export interface CoreHarnessGapFixture {
  readonly id: Slice0FixtureId;
  readonly suite: CoreHarnessReliabilitySuite;
  readonly primitive: CoreHarnessReliabilityPrimitive;
  readonly currentDeficiency: string;
  readonly futureGate: string;
}

export type ContextPressureSource =
  | "provider-usage"
  | "new-observation-estimate"
  | "overhead-window"
  | "local-estimate";

export interface CoreHarnessContextPressureFixture {
  readonly id: string;
  readonly rootCauseId: Slice0FixtureId;
  readonly provider: string;
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly localEstimateTokens: number;
  readonly providerLastRequestInputTokens: number;
  readonly cumulativeInputTokens: number;
  readonly newlyAppendedObservationEstimateTokens: number;
  readonly unshrinkableOverheadTokens: number;
  readonly softWindowTokens: number;
  readonly desiredPressureSource: ContextPressureSource;
  readonly expectedAction: "compact" | "shape" | "compact-or-shape";
}

export type ServiceExpectedDisposition =
  | "preserve-until-probe"
  | "reap-unleased"
  | "fail-closed-reap";

export interface CoreHarnessServiceLifecycleFixture {
  readonly id: string;
  readonly rootCauseId: Slice0FixtureId;
  readonly commandShape: string;
  readonly boundary: "eval-direct" | "kernel-runtime" | "warden-sandbox";
  readonly trustedLeaseSource: boolean;
  readonly preservationScope: "until-verifier-handoff" | "none";
  readonly requiredLeaseFields: readonly string[];
  readonly mustSurviveRuntimeDispose: boolean;
  readonly mustCleanupAfterProbe: boolean;
  readonly expectedDisposition: ServiceExpectedDisposition;
}

export type ArtifactContentKind =
  | "missing"
  | "zero-byte"
  | "whitespace-only"
  | "tiny-stub"
  | "semantic-unknown";

export type AcceptanceSource =
  | "explicit-task-path"
  | "structured-metadata"
  | "model-authored-path"
  | "project-authored-script";

export type AcceptanceConfidence = "high" | "advisory" | "denied";

export interface CoreHarnessAcceptanceArtifactFixture {
  readonly id: string;
  readonly rootCauseId: Slice0FixtureId;
  readonly path: string;
  readonly source: AcceptanceSource;
  readonly confidence: AcceptanceConfidence;
  readonly modifiedByModel: boolean;
  readonly hiddenGraderLike: boolean;
  readonly contentKind: ArtifactContentKind;
  readonly virtualState: { readonly exists: boolean; readonly content: string };
  readonly expectedVerdict: "block" | "warn" | "deny-source";
  readonly semanticCorrectnessClaim: "not-proven-by-existence";
}

export type ProviderTerminalKind =
  | "empty-stop"
  | "unknown-finish"
  | "content-filter"
  | "malformed-chunk";

export type ProviderTerminalChunkFixture =
  | ModelStreamChunkT
  | {
      readonly type: "finish";
      readonly reason: "unknown" | "content-filter";
      readonly usage: ModelUsageT;
    }
  | { readonly type: "malformed"; readonly raw: string };

export interface CoreHarnessProviderTerminalFixture {
  readonly id: string;
  readonly rootCauseId: Slice0FixtureId;
  readonly terminalKind: ProviderTerminalKind;
  readonly chunk: ProviderTerminalChunkFixture;
  readonly mustNotMapTo: "model-stop";
  readonly desiredHandling: "retry-once" | "fail-closed";
}

export interface CoreHarnessLoopReplayMetadata {
  readonly id: string;
  readonly rootCauseId: Slice0FixtureId;
  readonly suite: CoreHarnessReliabilitySuite;
  readonly heldOut: boolean;
  readonly highBurn: boolean;
  readonly usageSource: "synthetic" | "provider-measured";
  readonly costExpectation: "gross-context-not-effective-cost" | "ordinary-gross";
  readonly knownGoodProvenance?: "explicit-fixture-oracle";
  readonly sourceArtifact?: string;
  readonly originalTerminalReason?: string;
  readonly currentReplayExpectation?: "warn-or-terminal" | "no-terminal";
  readonly targetReplayExpectation?: "warn-or-terminal" | "no-terminal";
}

export const SLICE_2_5_LOOP_FIXTURE_IDS = [
  "pool-custom-memory-heap-crash-silent-verifier-success",
  "pool-build-cython-edit-retry-traceback-progress",
  "pool-mailman-idempotent-control-output",
  "pool-crack-7z-background-job-poll",
  "pool-compile-compcert-long-make-progress",
  "pool-true-high-burn-no-progress-traceback",
] as const;

export const CORE_HARNESS_GAP_FIXTURES = [
  {
    id: "tb2-dense-context-under-count",
    suite: "tb2",
    primitive: "context-pressure",
    currentDeficiency:
      "local chars/4 pressure estimate under-counts dense/minified/numeric content before provider rejection",
    futureGate:
      "typed ContextPressure distinguishes provider usage, local estimate, new observation estimate, overhead, and model window",
  },
  {
    id: "tb2-newly-appended-giant-observation",
    suite: "tb2",
    primitive: "observation-shaping",
    currentDeficiency:
      "provider usage from the previous turn arrives too late to protect the next request from a giant new tool observation",
    futureGate:
      "source-side observation shaping runs before the next provider call and records ledger-backed truncation metadata",
  },
  {
    id: "tb2-service-killed-on-teardown",
    suite: "tb2",
    primitive: "service-lifecycle",
    currentDeficiency:
      "session/runtime teardown can kill a detached service before an external verifier probes it",
    futureGate:
      "leased service identity survives runtime dispose, is externally probeable, and is explicitly cleaned up",
  },
  {
    id: "tb2-required-artifact-missing",
    suite: "tb2",
    primitive: "acceptance-contract",
    currentDeficiency:
      "a clean stop can be accepted even when a high-confidence required output artifact was never written",
    futureGate:
      "missing, zero-byte, whitespace-only, and tiny-stub artifacts are classified before stop acceptance",
  },
  {
    id: "tb2-empty-malformed-model-stop",
    suite: "tb2",
    primitive: "recovery-feedback",
    currentDeficiency:
      "empty, malformed, unknown, or content-filter terminal chunks can collapse into a clean stop path",
    futureGate:
      "provider adapters retry or fail closed with explicit terminal classification instead of model-stop",
  },
  {
    id: "tb2-high-burn-varied-nonprogress-loop",
    suite: "tb2",
    primitive: "loop-progress",
    currentDeficiency:
      "varied commands can produce equivalent high-burn outcomes long after the useful stall started",
    futureGate:
      "replay-calibrated loop detection reclaims burn only with zero clear-progress false positives",
  },
  {
    id: "tb2-known-good-preemption",
    suite: "tb2",
    primitive: "loop-progress",
    currentDeficiency:
      "aggressive repeated-outcome settings can halt before a known-good evidence turn appears",
    futureGate:
      "known-good preemption count must be zero before any threshold or default-on blocking change",
  },
  {
    id: "non-tb-slow-legitimate-progress",
    suite: "non-tb",
    primitive: "loop-progress",
    currentDeficiency:
      "slow compiles and installs can look repetitive while still making bounded forward progress",
    futureGate:
      "non-TB slow-progress replay remains clear of terminal loop stops under proposed thresholds",
  },
  {
    id: "non-tb-long-compile-repeated-output",
    suite: "non-tb",
    primitive: "loop-progress",
    currentDeficiency:
      "long compiles can repeat phase-shaped output while still advancing across build units",
    futureGate:
      "high-burn non-TB compile negatives run long enough to trip unsafe patience settings",
  },
  {
    id: "non-tb-local-service-handoff",
    suite: "non-tb",
    primitive: "service-lifecycle",
    currentDeficiency:
      "ordinary local app tasks need a service to stay alive long enough for a fresh-process probe",
    futureGate:
      "service lease tests cover start, stop acceptance, runtime dispose, external probe, and cleanup",
  },
  {
    id: "non-tb-generated-artifact",
    suite: "non-tb",
    primitive: "acceptance-contract",
    currentDeficiency:
      "generic artifact tasks need visible required-path handling without benchmark-specific rules",
    futureGate: "required artifact gates distinguish explicit visible paths from advisory guesses",
  },
  {
    id: "non-tb-broad-scalar-metric",
    suite: "non-tb",
    primitive: "loop-progress",
    currentDeficiency:
      "broad scalar metrics can fluctuate while the real optimization is still improving",
    futureGate:
      "scalar progress fixtures report false positives separately before stop-blocking behavior ships",
  },
  {
    id: "non-tb-monotonic-noisy-improvement",
    suite: "non-tb",
    primitive: "loop-progress",
    currentDeficiency:
      "one metric can wobble while another improves monotonically toward the real objective",
    futureGate:
      "monotonic-but-noisy replay negatives stay clear of terminal loop stops under proposed thresholds",
  },
  {
    id: "non-tb-edit-anchor-churn",
    suite: "non-tb",
    primitive: "recovery-feedback",
    currentDeficiency:
      "stale edit anchors can cause noisy reread/edit cycles that need better feedback, not blind halts",
    futureGate:
      "edit failure feedback remains bounded and separates stale-anchor churn from legitimate edits",
  },
] as const satisfies readonly CoreHarnessGapFixture[];

export const CORE_HARNESS_CONTEXT_PRESSURE_FIXTURES = [
  {
    id: "tb2-dense-context-under-count",
    rootCauseId: "tb2-dense-context-under-count",
    provider: "laguna",
    model: "laguna-2026-06",
    contextWindowTokens: 262_000,
    localEstimateTokens: 82_000,
    providerLastRequestInputTokens: 214_000,
    cumulativeInputTokens: 214_000,
    newlyAppendedObservationEstimateTokens: 0,
    unshrinkableOverheadTokens: 18_000,
    softWindowTokens: 183_400,
    desiredPressureSource: "provider-usage",
    expectedAction: "compact",
  },
  {
    id: "tb2-newly-appended-giant-observation",
    rootCauseId: "tb2-newly-appended-giant-observation",
    provider: "laguna",
    model: "laguna-2026-06",
    contextWindowTokens: 262_000,
    localEstimateTokens: 54_000,
    providerLastRequestInputTokens: 72_000,
    cumulativeInputTokens: 410_000,
    newlyAppendedObservationEstimateTokens: 190_000,
    unshrinkableOverheadTokens: 16_000,
    softWindowTokens: 183_400,
    desiredPressureSource: "new-observation-estimate",
    expectedAction: "shape",
  },
  {
    id: "non-tb-128k-window-dense-output",
    rootCauseId: "non-tb-slow-legitimate-progress",
    provider: "openai",
    model: "coding-model-128k",
    contextWindowTokens: 128_000,
    localEstimateTokens: 64_000,
    providerLastRequestInputTokens: 105_000,
    cumulativeInputTokens: 580_000,
    newlyAppendedObservationEstimateTokens: 0,
    unshrinkableOverheadTokens: 22_000,
    softWindowTokens: 89_600,
    desiredPressureSource: "provider-usage",
    expectedAction: "compact",
  },
] as const satisfies readonly CoreHarnessContextPressureFixture[];

export const CORE_HARNESS_SERVICE_LIFECYCLE_FIXTURES = [
  {
    id: "tb2-service-killed-on-teardown",
    rootCauseId: "tb2-service-killed-on-teardown",
    commandShape: "setsid qemu-system-i386 ... >/tmp/vm.log 2>&1 &",
    boundary: "kernel-runtime",
    trustedLeaseSource: true,
    preservationScope: "until-verifier-handoff",
    requiredLeaseFields: ["ownerToolCallId", "pid", "pgid", "startIdentity", "cleanupOwner"],
    mustSurviveRuntimeDispose: true,
    mustCleanupAfterProbe: true,
    expectedDisposition: "preserve-until-probe",
  },
  {
    id: "non-tb-local-service-handoff",
    rootCauseId: "non-tb-local-service-handoff",
    commandShape: "python -m http.server PORT >/tmp/service.log 2>&1 &",
    boundary: "kernel-runtime",
    trustedLeaseSource: true,
    preservationScope: "until-verifier-handoff",
    requiredLeaseFields: ["ownerToolCallId", "pid", "port", "startIdentity", "cleanupOwner"],
    mustSurviveRuntimeDispose: true,
    mustCleanupAfterProbe: true,
    expectedDisposition: "preserve-until-probe",
  },
  {
    id: "service-unleased-background-reaped",
    rootCauseId: "tb2-service-killed-on-teardown",
    commandShape: "bash -c 'while true; do sleep 1; done' &",
    boundary: "kernel-runtime",
    trustedLeaseSource: false,
    preservationScope: "none",
    requiredLeaseFields: ["ownerToolCallId", "pid", "startIdentity", "cleanupOwner"],
    mustSurviveRuntimeDispose: false,
    mustCleanupAfterProbe: false,
    expectedDisposition: "reap-unleased",
  },
  {
    id: "service-warden-abort-fail-closed",
    rootCauseId: "tb2-service-killed-on-teardown",
    commandShape: "sandboxed command aborted while child process is still running",
    boundary: "warden-sandbox",
    trustedLeaseSource: false,
    preservationScope: "none",
    requiredLeaseFields: ["ownerToolCallId", "pid", "startIdentity", "cleanupOwner"],
    mustSurviveRuntimeDispose: false,
    mustCleanupAfterProbe: false,
    expectedDisposition: "fail-closed-reap",
  },
  {
    id: "service-pid-reuse-rejected",
    rootCauseId: "tb2-service-killed-on-teardown",
    commandShape: "stale pid file points at a newer unrelated process",
    boundary: "kernel-runtime",
    trustedLeaseSource: false,
    preservationScope: "none",
    requiredLeaseFields: ["ownerToolCallId", "pid", "startIdentity", "cleanupOwner"],
    mustSurviveRuntimeDispose: false,
    mustCleanupAfterProbe: false,
    expectedDisposition: "fail-closed-reap",
  },
  {
    id: "service-fork-during-kill-reaped",
    rootCauseId: "tb2-service-killed-on-teardown",
    commandShape: "unleased child forks while cleanup sweep is in progress",
    boundary: "kernel-runtime",
    trustedLeaseSource: false,
    preservationScope: "none",
    requiredLeaseFields: ["ownerToolCallId", "pid", "startIdentity", "cleanupOwner"],
    mustSurviveRuntimeDispose: false,
    mustCleanupAfterProbe: false,
    expectedDisposition: "reap-unleased",
  },
] as const satisfies readonly CoreHarnessServiceLifecycleFixture[];

export const CORE_HARNESS_ACCEPTANCE_ARTIFACT_FIXTURES = [
  {
    id: "artifact-missing",
    rootCauseId: "tb2-required-artifact-missing",
    path: "answer.txt",
    source: "explicit-task-path",
    confidence: "high",
    modifiedByModel: false,
    hiddenGraderLike: false,
    contentKind: "missing",
    virtualState: { exists: false, content: "" },
    expectedVerdict: "block",
    semanticCorrectnessClaim: "not-proven-by-existence",
  },
  {
    id: "artifact-zero-byte",
    rootCauseId: "tb2-required-artifact-missing",
    path: "answer.txt",
    source: "explicit-task-path",
    confidence: "high",
    modifiedByModel: false,
    hiddenGraderLike: false,
    contentKind: "zero-byte",
    virtualState: { exists: true, content: "" },
    expectedVerdict: "block",
    semanticCorrectnessClaim: "not-proven-by-existence",
  },
  {
    id: "artifact-whitespace-only",
    rootCauseId: "tb2-required-artifact-missing",
    path: "answer.txt",
    source: "explicit-task-path",
    confidence: "high",
    modifiedByModel: false,
    hiddenGraderLike: false,
    contentKind: "whitespace-only",
    virtualState: { exists: true, content: "   \n\t" },
    expectedVerdict: "block",
    semanticCorrectnessClaim: "not-proven-by-existence",
  },
  {
    id: "artifact-tiny-stub",
    rootCauseId: "tb2-required-artifact-missing",
    path: "answer.txt",
    source: "explicit-task-path",
    confidence: "high",
    modifiedByModel: false,
    hiddenGraderLike: false,
    contentKind: "tiny-stub",
    virtualState: { exists: true, content: "TODO\n" },
    expectedVerdict: "block",
    semanticCorrectnessClaim: "not-proven-by-existence",
  },
  {
    id: "artifact-semantic-unknown",
    rootCauseId: "non-tb-generated-artifact",
    path: "artifacts/report.html",
    source: "structured-metadata",
    confidence: "advisory",
    modifiedByModel: false,
    hiddenGraderLike: false,
    contentKind: "semantic-unknown",
    virtualState: { exists: true, content: "<html><body>report</body></html>\n" },
    expectedVerdict: "warn",
    semanticCorrectnessClaim: "not-proven-by-existence",
  },
  {
    id: "artifact-generated-required-path-present",
    rootCauseId: "non-tb-generated-artifact",
    path: "artifacts/report.html",
    source: "explicit-task-path",
    confidence: "high",
    modifiedByModel: false,
    hiddenGraderLike: false,
    contentKind: "semantic-unknown",
    virtualState: { exists: true, content: "<html><body>report</body></html>\n" },
    expectedVerdict: "warn",
    semanticCorrectnessClaim: "not-proven-by-existence",
  },
  {
    id: "artifact-model-authored-path-denied",
    rootCauseId: "tb2-required-artifact-missing",
    path: "answer.txt",
    source: "model-authored-path",
    confidence: "denied",
    modifiedByModel: true,
    hiddenGraderLike: false,
    contentKind: "semantic-unknown",
    virtualState: { exists: true, content: "model says this is enough\n" },
    expectedVerdict: "deny-source",
    semanticCorrectnessClaim: "not-proven-by-existence",
  },
  {
    id: "artifact-project-fake-pass-script-denied",
    rootCauseId: "non-tb-generated-artifact",
    path: "scripts/pass.sh",
    source: "project-authored-script",
    confidence: "denied",
    modifiedByModel: false,
    hiddenGraderLike: false,
    contentKind: "semantic-unknown",
    virtualState: { exists: true, content: "echo PASS\n" },
    expectedVerdict: "deny-source",
    semanticCorrectnessClaim: "not-proven-by-existence",
  },
  {
    id: "artifact-mutated-package-script-denied",
    rootCauseId: "non-tb-generated-artifact",
    path: "package.json",
    source: "project-authored-script",
    confidence: "denied",
    modifiedByModel: true,
    hiddenGraderLike: false,
    contentKind: "semantic-unknown",
    virtualState: { exists: true, content: '{"scripts":{"test":"echo PASS"}}\n' },
    expectedVerdict: "deny-source",
    semanticCorrectnessClaim: "not-proven-by-existence",
  },
  {
    id: "artifact-hidden-grader-path-denied",
    rootCauseId: "tb2-required-artifact-missing",
    path: "/tests/hidden/grade.py",
    source: "project-authored-script",
    confidence: "denied",
    modifiedByModel: false,
    hiddenGraderLike: true,
    contentKind: "semantic-unknown",
    virtualState: { exists: true, content: "print('PASS')\n" },
    expectedVerdict: "deny-source",
    semanticCorrectnessClaim: "not-proven-by-existence",
  },
] as const satisfies readonly CoreHarnessAcceptanceArtifactFixture[];

export const CORE_HARNESS_PROVIDER_TERMINAL_FIXTURES = [
  {
    id: "provider-empty-stop",
    rootCauseId: "tb2-empty-malformed-model-stop",
    terminalKind: "empty-stop",
    chunk: { type: "finish", reason: "stop", usage: { inputTokens: 10, outputTokens: 0 } },
    mustNotMapTo: "model-stop",
    desiredHandling: "retry-once",
  },
  {
    id: "provider-unknown-finish",
    rootCauseId: "tb2-empty-malformed-model-stop",
    terminalKind: "unknown-finish",
    chunk: { type: "finish", reason: "unknown", usage: { inputTokens: 10, outputTokens: 0 } },
    mustNotMapTo: "model-stop",
    desiredHandling: "fail-closed",
  },
  {
    id: "provider-content-filter",
    rootCauseId: "tb2-empty-malformed-model-stop",
    terminalKind: "content-filter",
    chunk: {
      type: "finish",
      reason: "content-filter",
      usage: { inputTokens: 10, outputTokens: 0 },
    },
    mustNotMapTo: "model-stop",
    desiredHandling: "fail-closed",
  },
  {
    id: "provider-malformed-chunk",
    rootCauseId: "tb2-empty-malformed-model-stop",
    terminalKind: "malformed-chunk",
    chunk: { type: "malformed", raw: '{"type":"finish"' },
    mustNotMapTo: "model-stop",
    desiredHandling: "fail-closed",
  },
] as const satisfies readonly CoreHarnessProviderTerminalFixture[];

const usage = (
  inputTokens: number,
  outputTokens: number,
  extra: Partial<ModelUsageT> = {},
): ModelUsageT => ({ inputTokens, outputTokens, ...extra });

export const CORE_HARNESS_KNOWN_GOOD_PREEMPTION_COUNTERFACTUAL_FIXTURE = {
  id: "tb2-known-good-preemption-counterfactual",
  label: "ambiguous",
  knownGoodTurn: 6,
  detector: {
    maxToolRepeats: 99,
    maxOutcomeRepeats: 8,
    highBurnOutcomeRepeats: 2,
    highBurnOutputBytes: 16,
  },
  steps: Array.from({ length: 6 }, (_, i) => ({
    call: { name: "bash", args: { command: `benchmark --attempt=${String(i + 1)}` } },
    output: "same noisy benchmark failure\n",
    usage: usage(100, 100),
  })),
} as const satisfies LoopDetectionReplayFixture;

export const CORE_HARNESS_LOOP_REPLAY_FIXTURES = [
  {
    id: "tb2-overfull-hbox-minimized",
    label: "true-loop",
    historical: { terminalTurn: 200, terminalTokens: 50_000 },
    steps: [
      54.68654, 16.90868, 16.90868, 16.90868, 16.90868, 16.90868, 16.90868, 16.90868, 16.90868,
      16.90868, 16.90868, 16.90868,
    ].map((pt, i) => ({
      call: { name: "bash", args: { command: `pdflatex main.tex # ${String(i + 1)}` } },
      output: `Overfull \\hbox (${pt.toFixed(5)}pt too wide) in paragraph at lines 7--8\n`,
      usage: usage(1500, 500),
    })),
  },
  {
    id: "tb2-large-scale-text-editing-minimized",
    label: "true-loop",
    historical: { terminalTurn: 183, terminalTokens: 1_000_000 },
    steps: Array.from({ length: 8 }, (_, i) => ({
      call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
      output: "FAILED tests/test_large_scale.py::test_output_matches\n".repeat(96),
      usage: usage(40_000, 20_000),
    })),
  },
  {
    id: "tb2-largest-eigenval-post-solution-churn",
    label: "true-loop",
    knownGoodTurn: 2,
    historical: { terminalTurn: 80, terminalTokens: 900_000 },
    steps: Array.from({ length: 8 }, (_, i) => ({
      call: {
        name: "bash",
        args: { command: `python benchmark_solution.py --run=${String(i + 1)}` },
      },
      output:
        "timing variance within tolerance; explicit fixture oracle marks turn 2 known-good\n".repeat(
          80,
        ),
      usage: usage(30_000, 15_000),
    })),
  },
  {
    id: "tb2-high-burn-varied-nonprogress-loop",
    label: "true-loop",
    historical: { terminalTurn: 72, terminalTokens: 21_600_000 },
    steps: Array.from({ length: 10 }, (_, i) => ({
      call: {
        name: "bash",
        args: { command: `python search_candidates.py --seed=${String(1000 + i)}` },
      },
      output: "candidate set unchanged; no passing verifier found\n".repeat(32),
      usage: usage(250_000, 50_000),
    })),
  },
  {
    id: "tb2-known-good-preemption",
    label: "ambiguous",
    knownGoodTurn: 6,
    steps: Array.from({ length: 6 }, (_, i) => ({
      call: { name: "bash", args: { command: `benchmark --attempt=${String(i + 1)}` } },
      output: `noisy benchmark still failing before explicit oracle turn ${String(i + 1)}\n`,
      usage: usage(100, 100),
    })),
  },
  {
    id: "non-tb-slow-legitimate-progress",
    label: "legit-progress",
    steps: [
      "Compiling parser v0.1.0 (1/5)",
      "Compiling runtime v0.1.0 (2/5)",
      "Compiling cli v0.1.0 (3/5)",
      "Running integration tests (4/5)",
      "Finished release profile (5/5)",
    ].map((output, i) => ({
      call: { name: "bash", args: { command: `cargo build --release # phase ${String(i + 1)}` } },
      output: `${output}\n`,
      usage: usage(5000, 500),
    })),
  },
  {
    id: "non-tb-long-compile-repeated-output",
    label: "legit-progress",
    steps: Array.from({ length: 12 }, (_, i) => ({
      call: {
        name: "bash",
        args: { command: `ninja -C build target_${String(i + 1).padStart(2, "0")}` },
      },
      output: `still compiling shared objects; completed ${String(i + 1)}/12 build units\n`,
      usage: usage(65_000, 5_000),
    })),
  },
  {
    id: "non-tb-local-service-handoff",
    label: "legit-progress",
    steps: (
      [
        ["python -m http.server 8732 >/tmp/app.log 2>&1 &", "server started on :8732"],
        ["curl -fsS http://127.0.0.1:8732/health", "ok"],
        ["curl -fsS http://127.0.0.1:8732/ready", "ready"],
        ["cat /tmp/app.log", "GET /health 200\nGET /ready 200"],
      ] as const
    ).map(([command, output]) => ({
      call: { name: "bash", args: { command } },
      output: `${output}\n`,
      usage: usage(1000, 200),
    })),
  },
  {
    id: "non-tb-background-job-poll",
    label: "legit-progress",
    steps: Array.from({ length: 5 }, (_, i) => ({
      call: { name: "bash", args: { command: "jobs -l %1" } },
      output: `indexer job still running; completed ${String((i + 1) * 200)}/1000 documents\n`,
      usage: usage(20_000, 1000),
    })),
  },
  {
    id: "non-tb-generated-artifact",
    label: "legit-progress",
    steps: (
      [
        ["mkdir -p artifacts", "created artifacts directory"],
        [
          "node scripts/render-report.js > artifacts/report.html",
          "rendered report.html bytes=4300",
        ],
        ["test -s artifacts/report.html", "artifact exists and is non-empty"],
        ["npm test -- --report", "report tests passed"],
      ] as const
    ).map(([command, output]) => ({
      call: { name: "bash", args: { command } },
      output: `${output}\n`,
      usage: usage(1200, 200),
    })),
  },
  {
    id: "non-tb-silent-successful-verifier",
    label: "legit-progress",
    steps: Array.from({ length: 4 }, (_, i) => ({
      call: {
        name: "bash",
        args: { command: `pytest -q tests/verifier/test_contract.py # shard ${String(i + 1)}` },
      },
      output: "(command produced no output; exit code 0)\n",
      usage: usage(30_000, 2000),
    })),
  },
  {
    id: "non-tb-idempotent-service-control",
    label: "legit-progress",
    steps: Array.from({ length: 4 }, (_, i) => ({
      call: {
        name: "bash",
        args: { command: "service local-mailer reload" },
      },
      output: `reloaded local-mailer service with current configuration; generation ${String(
        i + 1,
      )}\n`.repeat(80),
      usage: usage(8000, 1000),
    })),
  },
  {
    id: "non-tb-broad-scalar-metric",
    label: "legit-progress",
    steps: (
      [
        [0.62, 0.41, 12],
        [0.64, 0.39, 10],
        [0.63, 0.35, 7],
        [0.66, 0.34, 4],
        [0.65, 0.31, 1],
      ] as const
    ).map(([accuracy, loss, failures], i) => ({
      call: { name: "bash", args: { command: `python tune.py --round=${String(i + 1)}` } },
      output: `accuracy=${accuracy.toFixed(2)} loss=${loss.toFixed(2)} failures=${String(failures)}\n`,
      usage: usage(4000, 400),
    })),
  },
  {
    id: "non-tb-monotonic-noisy-improvement",
    label: "legit-progress",
    steps: (
      [
        [0.51, 0.9],
        [0.49, 0.82],
        [0.54, 0.76],
        [0.52, 0.69],
        [0.56, 0.61],
        [0.55, 0.54],
        [0.58, 0.47],
        [0.57, 0.41],
      ] as const
    ).map(([accuracy, loss], i) => ({
      call: { name: "bash", args: { command: `python tune.py --trial=${String(i + 1)}` } },
      output: `accuracy=${accuracy.toFixed(2)} validation_loss=${loss.toFixed(2)}\n`,
      usage: usage(45_000, 2000),
    })),
  },
  {
    id: "non-tb-cache-heavy-progress",
    label: "legit-progress",
    steps: Array.from({ length: 6 }, (_, i) => ({
      call: {
        name: "bash",
        args: { command: `pytest tests/integration --shard=${String(i + 1)}` },
      },
      output: `${String(6 - i)} flaky integration shards remaining\n`,
      usage: usage(120_000, 400, { cachedInputTokens: 118_000 }),
    })),
  },
  {
    id: "non-tb-edit-anchor-churn",
    label: "legit-progress",
    steps: (
      [
        ["src/render.ts", "edited export name; 8 tests failing"],
        ["src/render.ts", "edited import path; 5 tests failing"],
        ["src/render.ts", "edited stale anchor after reread; 2 tests failing"],
        ["src/render.ts", "edited final call site; 0 tests failing"],
      ] as const
    ).map(([path, output], i) => ({
      call: {
        name: "edit",
        args: {
          path,
          oldString: `old anchor ${String(i + 1)}`,
          newString: `new anchor ${String(i + 1)}`,
        },
      },
      output: `${output}\n`,
      usage: usage(1500, 200),
    })),
  },
  {
    id: "pool-custom-memory-heap-crash-silent-verifier-success",
    label: "legit-progress",
    steps: Array.from({ length: 4 }, () => ({
      call: {
        name: "bash",
        args: { command: "pytest -q" },
      },
      output: "(command produced no output; exit code 0)\n",
      usage: usage(55_000, 5_000),
    })),
  },
  {
    id: "pool-build-cython-edit-retry-traceback-progress",
    label: "legit-progress",
    steps: [
      {
        call: { name: "bash", args: { command: "pytest -q --attempt=1" } },
        output: "Traceback (most recent call last):\nAssertionError: same bug\n".repeat(96),
        usage: usage(20_000, 5_000),
      },
      {
        call: {
          name: "edit",
          args: { path: "src/ext.pyx", oldString: "before 1", newString: "after 1" },
        },
        output: "edited src/ext.pyx\n",
        usage: usage(2000, 300),
      },
      {
        call: { name: "bash", args: { command: "pytest -q --attempt=2" } },
        output: "Traceback (most recent call last):\nAssertionError: same bug\n".repeat(96),
        usage: usage(20_000, 5_000),
      },
      {
        call: {
          name: "edit",
          args: { path: "src/ext.pyx", oldString: "before 2", newString: "after 2" },
        },
        output: "edited src/ext.pyx\n",
        usage: usage(2000, 300),
      },
      {
        call: { name: "bash", args: { command: "pytest -q --attempt=3" } },
        output: "Traceback (most recent call last):\nAssertionError: same bug\n".repeat(96),
        usage: usage(20_000, 5_000),
      },
    ],
  },
  {
    id: "pool-mailman-idempotent-control-output",
    label: "legit-progress",
    steps: Array.from({ length: 4 }, (_, i) => ({
      call: {
        name: "bash",
        args: { command: `service postfix reload # ${String(i + 1)}` },
      },
      output: "refreshing the postfix mail system\n".repeat(200),
      usage: usage(4000, 1000),
    })),
  },
  {
    id: "pool-crack-7z-background-job-poll",
    label: "legit-progress",
    steps: Array.from({ length: 4 }, () => ({
      call: {
        name: "bash",
        args: { command: "john --show hash.txt" },
      },
      output: "0 password hashes cracked, 1 left\n",
      usage: usage(55_000, 5_000),
    })),
  },
  {
    id: "pool-compile-compcert-long-make-progress",
    label: "legit-progress",
    steps: Array.from({ length: 8 }, (_, i) => ({
      call: {
        name: "bash",
        args: { command: "make -j2 world" },
      },
      output: `make: still building CompCert; completed ${String(i + 1)}/8 units\n`,
      usage: usage(120_000, 20_000),
    })),
  },
  {
    id: "pool-true-high-burn-no-progress-traceback",
    label: "true-loop",
    historical: { terminalTurn: 20, terminalTokens: 2_000_000 },
    steps: Array.from({ length: 5 }, (_, i) => ({
      call: {
        name: "bash",
        args: { command: `pytest -q --attempt=${String(i + 1)}` },
      },
      output: "Traceback (most recent call last):\nAssertionError: unchanged failure\n".repeat(96),
      usage: usage(120_000, 20_000),
    })),
  },
] as const satisfies readonly LoopDetectionReplayFixture[];

export const CORE_HARNESS_LOOP_REPLAY_METADATA = [
  {
    id: "tb2-overfull-hbox-minimized",
    rootCauseId: "tb2-high-burn-varied-nonprogress-loop",
    suite: "tb2",
    heldOut: false,
    highBurn: false,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
  },
  {
    id: "tb2-large-scale-text-editing-minimized",
    rootCauseId: "tb2-high-burn-varied-nonprogress-loop",
    suite: "tb2",
    heldOut: false,
    highBurn: true,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
  },
  {
    id: "tb2-largest-eigenval-post-solution-churn",
    rootCauseId: "tb2-known-good-preemption",
    suite: "tb2",
    heldOut: false,
    highBurn: true,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
    knownGoodProvenance: "explicit-fixture-oracle",
  },
  {
    id: "tb2-high-burn-varied-nonprogress-loop",
    rootCauseId: "tb2-high-burn-varied-nonprogress-loop",
    suite: "tb2",
    heldOut: false,
    highBurn: true,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
  },
  {
    id: "tb2-known-good-preemption",
    rootCauseId: "tb2-known-good-preemption",
    suite: "tb2",
    heldOut: false,
    highBurn: false,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
    knownGoodProvenance: "explicit-fixture-oracle",
  },
  {
    id: "non-tb-slow-legitimate-progress",
    rootCauseId: "non-tb-slow-legitimate-progress",
    suite: "non-tb",
    heldOut: true,
    highBurn: false,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
  },
  {
    id: "non-tb-long-compile-repeated-output",
    rootCauseId: "non-tb-long-compile-repeated-output",
    suite: "non-tb",
    heldOut: true,
    highBurn: true,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
  },
  {
    id: "non-tb-local-service-handoff",
    rootCauseId: "non-tb-local-service-handoff",
    suite: "non-tb",
    heldOut: true,
    highBurn: false,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
  },
  {
    id: "non-tb-background-job-poll",
    rootCauseId: "non-tb-local-service-handoff",
    suite: "non-tb",
    heldOut: true,
    highBurn: false,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
  },
  {
    id: "non-tb-generated-artifact",
    rootCauseId: "non-tb-generated-artifact",
    suite: "non-tb",
    heldOut: true,
    highBurn: false,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
  },
  {
    id: "non-tb-silent-successful-verifier",
    rootCauseId: "non-tb-slow-legitimate-progress",
    suite: "non-tb",
    heldOut: true,
    highBurn: true,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
  },
  {
    id: "non-tb-idempotent-service-control",
    rootCauseId: "non-tb-local-service-handoff",
    suite: "non-tb",
    heldOut: true,
    highBurn: true,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
  },
  {
    id: "non-tb-broad-scalar-metric",
    rootCauseId: "non-tb-broad-scalar-metric",
    suite: "non-tb",
    heldOut: true,
    highBurn: false,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
  },
  {
    id: "non-tb-monotonic-noisy-improvement",
    rootCauseId: "non-tb-monotonic-noisy-improvement",
    suite: "non-tb",
    heldOut: true,
    highBurn: true,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
  },
  {
    id: "non-tb-cache-heavy-progress",
    rootCauseId: "non-tb-broad-scalar-metric",
    suite: "non-tb",
    heldOut: true,
    highBurn: true,
    usageSource: "synthetic",
    costExpectation: "gross-context-not-effective-cost",
  },
  {
    id: "non-tb-edit-anchor-churn",
    rootCauseId: "non-tb-edit-anchor-churn",
    suite: "non-tb",
    heldOut: true,
    highBurn: false,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
  },
  {
    id: "pool-custom-memory-heap-crash-silent-verifier-success",
    rootCauseId: "tb2-high-burn-varied-nonprogress-loop",
    suite: "tb2",
    heldOut: false,
    highBurn: true,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
    sourceArtifact: "fixture-source:reliability-calibration-v1#custom-memory-heap-crash",
    originalTerminalReason: "loop-detector + ctx 100% on all failing keel runs",
    currentReplayExpectation: "warn-or-terminal",
    targetReplayExpectation: "no-terminal",
  },
  {
    id: "pool-build-cython-edit-retry-traceback-progress",
    rootCauseId: "tb2-high-burn-varied-nonprogress-loop",
    suite: "tb2",
    heldOut: false,
    highBurn: true,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
    sourceArtifact: "fixture-source:reliability-calibration-v1#build-cython-ext",
    originalTerminalReason: "loop-halt on edit-retry after tool/test feedback",
    currentReplayExpectation: "warn-or-terminal",
    targetReplayExpectation: "no-terminal",
  },
  {
    id: "pool-mailman-idempotent-control-output",
    rootCauseId: "tb2-high-burn-varied-nonprogress-loop",
    suite: "tb2",
    heldOut: false,
    highBurn: true,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
    sourceArtifact: "fixture-source:reliability-calibration-v1#mailman",
    originalTerminalReason: "loop-detector on repeated idempotent postfix/mailman output",
    currentReplayExpectation: "warn-or-terminal",
    targetReplayExpectation: "no-terminal",
  },
  {
    id: "pool-crack-7z-background-job-poll",
    rootCauseId: "tb2-high-burn-varied-nonprogress-loop",
    suite: "tb2",
    heldOut: false,
    highBurn: true,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
    sourceArtifact: "fixture-source:reliability-calibration-v1#crack-7z-hash",
    originalTerminalReason: "loop-halt while polling a background john job",
    currentReplayExpectation: "warn-or-terminal",
    targetReplayExpectation: "no-terminal",
  },
  {
    id: "pool-compile-compcert-long-make-progress",
    rootCauseId: "non-tb-long-compile-repeated-output",
    suite: "tb2",
    heldOut: false,
    highBurn: true,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
    sourceArtifact: "fixture-source:reliability-calibration-v1#compile-compcert",
    originalTerminalReason: "loop-halt + turn cap during long Makefile/from-source build",
    currentReplayExpectation: "warn-or-terminal",
    targetReplayExpectation: "no-terminal",
  },
  {
    id: "pool-true-high-burn-no-progress-traceback",
    rootCauseId: "tb2-high-burn-varied-nonprogress-loop",
    suite: "tb2",
    heldOut: false,
    highBurn: true,
    usageSource: "synthetic",
    costExpectation: "ordinary-gross",
    sourceArtifact: "fixture-source:reliability-calibration-v1#true-no-progress-control",
    originalTerminalReason: "same action and same error with no edit/env/process/metric novelty",
    currentReplayExpectation: "warn-or-terminal",
    targetReplayExpectation: "warn-or-terminal",
  },
] as const satisfies readonly CoreHarnessLoopReplayMetadata[];

export const CORE_HARNESS_LOOP_REPLAY_REQUIRED_ROOT_CAUSE_IDS = [
  "tb2-high-burn-varied-nonprogress-loop",
  "tb2-known-good-preemption",
  "non-tb-slow-legitimate-progress",
  "non-tb-long-compile-repeated-output",
  "non-tb-local-service-handoff",
  "non-tb-generated-artifact",
  "non-tb-broad-scalar-metric",
  "non-tb-monotonic-noisy-improvement",
  "non-tb-edit-anchor-churn",
] as const;

export const CORE_HARNESS_LOOP_REPLAY_CORPUS_REQUIREMENTS = {
  minNonTbHeldOutFixtures: 6,
  requiredRootCauseIds: CORE_HARNESS_LOOP_REPLAY_REQUIRED_ROOT_CAUSE_IDS,
  requiredNonTbHeldOutRootCauseIds: CORE_HARNESS_LOOP_REPLAY_REQUIRED_ROOT_CAUSE_IDS.filter((id) =>
    id.startsWith("non-tb-"),
  ),
  requireKnownGoodFixture: true,
} as const satisfies LoopDetectionReplayCorpusRequirements;
