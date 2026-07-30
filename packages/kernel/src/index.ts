// @keel/kernel — the thin agent loop (Epic 1.1) + the five core tools (Epic 1.2).
export { runAgentLoop, DEFAULT_MAX_TURNS } from "./loop.js";
export type { AgentLoopInput, AgentLoopStop } from "./loop.js";
export { LocalExecutor } from "./local-executor.js";
export type { ToolHandler } from "./local-executor.js";
export { KernelEvent, StopReason } from "./events.js";
export type { KernelEventT, StopReasonT } from "./events.js";
export { KERNEL_STRINGS } from "./strings.js";

// Epic 1.2 — the five core tools (read · write · edit · bash · search) + their assembly.
export * from "./tools/index.js";

// Epic 1.3 — the Vercel-AI-SDK provider adapters behind the frozen `ModelPort`.
export * from "./providers/index.js";

// Epic 1.4 — sessions: append-only JSONL ledger (store + tolerant reader), the
// event-stream recorder, resume, and keel-dir path resolution. Branch + CLI are
// later slices.
export {
  SessionStore,
  readSession,
  readSessionFile,
  SessionCorruptError,
  SessionNewerVersionError,
  SessionRedactionConflictError,
} from "./session/store.js";
export type { SessionFile, SessionMetaT, SessionCreateOpts } from "./session/store.js";
export { record } from "./session/recorder.js";
export type { RecordConfig } from "./session/recorder.js";
export { rebuild } from "./session/resume.js";
export type { ResumeState } from "./session/resume.js";
export { branch } from "./session/branch.js";
export { recordSteering, applySteering } from "./session/steering.js";
export type { SteeringInput, AppliedSteering } from "./session/steering.js";
export { listSessions } from "./session/list.js";
export type { SessionSummary } from "./session/list.js";
export { keelHome, sessionsDir, sessionPath } from "./session/paths.js";
export { runKeelCli } from "./cli/keel.js";
export { InputQueue } from "./cli/input-queue.js";
export { createToolRuntime, createModelPort, resolveModelConfig } from "./cli/runtime.js";
export type { ToolRuntime, ModelConfig, ProviderId } from "./cli/runtime.js";
export {
  selectRenderer,
  buildUI,
  parseKeelArgs,
  runKeelSession,
  runKeelCommand,
  runAuditExportCommand,
} from "./cli/session-entry.js";
export type {
  Renderer,
  RendererEnv,
  KeelCommand,
  KeelSessionOpts,
  KeelCommandDeps,
} from "./cli/session-entry.js";

// Epic 1.5 — TUI: the pure view-model reducer, the headless renderer, and the session runner.
// (The Ink interactive renderer + interactive entrypoints land in later slices.)
export { initialView, firstRunView, reduce, stripControl } from "./tui/view-model.js";
export type { UiInputEventT } from "./tui/view-model.js";
export { renderFrame, HeadlessUI } from "./tui/headless.js";
export { runSession } from "./tui/runner.js";

// Epic 1.6b — context discipline (§4.7): the system prompt, environment snapshot, and the
// factual task scaffold derived from the ledger.
export { SYSTEM_PROMPT, estimateTokens } from "./context/system-prompt.js";
export { environmentSnapshot } from "./context/environment.js";
export type { SnapshotDeps } from "./context/environment.js";

// Epic 1.7 — trust-before-parse (§3.2(4), SEC-012): the workspace-trust decision + the single
// trust-gated project-metadata fs chokepoint + the post-trust project-context loader.
export { resolveWorkspaceTrust } from "./trust/resolve.js";
export type { TrustDecision, ResolveTrustDeps } from "./trust/resolve.js";
export { loadTrustDecision, saveTrustDecision, trustFilePath } from "./trust/trust-store.js";
export { ProjectReader, defaultProjectFs } from "./context/project-reader.js";
export type { ProjectFs, ProjectAccess } from "./context/project-reader.js";
export { gatherProjectContext, loadProjectContext, systemInfo } from "./context/project-context.js";
export type { ProjectContext, SystemInfo, GatherContextDeps } from "./context/project-context.js";
export { loadAgentsInstructions } from "./context/agents-md.js";
export {
  buildSkillRegistry,
  defaultBuiltinSkillsDir,
  discoverSkillsIn,
  parseSkillFrontmatter,
  renderSkillStubs,
  skillBody,
  capBuiltins,
  BUILTIN_SKILL_CAP,
} from "./context/skills.js";
export type { SkillStub, SkillRegistry, SkillSources } from "./context/skills.js";

// Epic 1.9 — secrets handling (§3.2(6), SEC-014/ADR-0039): redaction at the session-write chokepoint;
// the `SecretStore` port + a pure-TS `0600` file store (no native dep in the credential path) + `keel auth`.
export { redactText } from "./secrets/redact.js";
export {
  FileSecretStore,
  defaultSecretStore,
  credentialsFilePath,
} from "./secrets/secret-store.js";
export type { SecretStore } from "./secrets/secret-store.js";
export { runAuthCli } from "./cli/auth.js";
export { deriveTaskFacts } from "./context/derive.js";
export type { DerivedFacts } from "./context/derive.js";
export { classify } from "./context/retention.js";
export type { RetentionClass } from "./context/retention.js";
export { assembleActiveContext } from "./context/assemble.js";
export type { AssembleInput } from "./context/assemble.js";
export { validateTaskState } from "./context/validate.js";
export type { ValidationResult } from "./context/validate.js";
export { renderCompactionSummary } from "./context/summary.js";
export { compact, estimateMessagesTokens } from "./context/compact.js";
export type {
  CompactInput,
  CompactResult,
  CompactionTrigger,
  Summarize,
  SummarizeInput,
} from "./context/compact.js";

// Epic 1.6b slice 9 — §4.9.6 intent-alignment heuristics (non-security advisory signals).
export { evaluateAlignment } from "./autonomy/alignment.js";
export type { AlignmentInput, AlignmentSignal, ScopeTier } from "./autonomy/alignment.js";
export type { RunSessionOpts } from "./tui/runner.js";
export * from "./model-routing/index.js";
export { WardenExecutor } from "./warden/executor.js";
export type { WardenExecuteClient, WardenExecutorOptions } from "./warden/executor.js";
export {
  startProductionWardenClient,
  shutdownProductionWarden,
  createProductionWardenRuntime,
  exportAuditSession,
} from "./warden/runtime.js";
export type {
  ProductionWardenStartOptions,
  ProductionWardenClientOptions,
  ProductionWardenRuntimeOptions,
  ProductionWardenRuntime,
  AuditExportCommandOptions,
} from "./warden/runtime.js";
export { wardenStatusViewConfig } from "./warden/status.js";
export type { WardenStatusViewConfig } from "./warden/status.js";
