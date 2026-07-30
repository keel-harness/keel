/**
 * UIPort — the seam between the kernel/runner and the terminal renderer (ADR-0003).
 *
 * The kernel never imports Ink directly: it builds a `ViewModel` (what to show) and hands
 * it to a `UIPort` (how to show it). An Ink renderer draws it interactively; a headless
 * renderer serializes it to deterministic plain text for `keel run -p`, CI, and goldens.
 * New interaction patterns extend these types — never a direct Ink import in the kernel.
 *
 * Types-only by design (no runtime code) so `@keel/shared`'s 100% coverage gate is unaffected.
 * The original transport seam froze at Epic 1.5 close. Additive presentation fields may still
 * evolve under ADR-0036; frozen wire schemas and behavioral contracts require their own versioning.
 */

export interface UiStreamDelta {
  readonly start: number;
  readonly text: string;
}

/** A conversation message. Tool results are NOT messages — they fold into `UiToolActivity`. */
export interface UiMessage {
  readonly kind: "message";
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  /** Internal renderer provenance. A UI notice is visible conversation chrome, not hidden model
   *  scaffolding, even when it is the first system item in a fresh session. */
  readonly presentation?: "notice";
  /** Bounded exact tail used to project coalesced streaming updates without rescanning history. */
  readonly streamDeltas?: readonly UiStreamDelta[];
}

/** One line of a rendered diff. */
export interface DiffLine {
  readonly kind: "context" | "add" | "del";
  readonly text: string;
  readonly observedBeforeLine?: number;
  readonly installedAfterLine?: number;
  /** Presentation-only boundary retained from the producer's already-redacted hunk structure. */
  readonly hunkStart?: boolean;
}

export type UiMutationPresentationUnavailableReason =
  | "unsupported-peer"
  | "capability-unavailable"
  | "executor-no-resolver"
  | "capture-unavailable"
  | "capture-budget"
  | "redaction-failed"
  | "not-found-or-consumed"
  | "invalid-response"
  | "presentation-timeout"
  | "transport-failed"
  | "occurrence-ended"
  | "workspace-effects-not-captured"
  | "live-observations-not-persisted";

export interface UiMutationPresentationFileImage {
  readonly status: "file-observed";
  readonly bytes: number;
  readonly mode: number;
  readonly contentClass: "text" | "binary";
  readonly finalNewline: boolean;
}

export type UiMutationPresentationObservedBefore =
  | UiMutationPresentationFileImage
  | { readonly status: "absent-observed" }
  | { readonly status: "not-inspected" };

export type UiMutationPresentation =
  | { readonly status: "pending" }
  | {
      readonly status: "unavailable";
      readonly reason: UiMutationPresentationUnavailableReason;
    }
  | {
      readonly status: "available";
      readonly operation: "write" | "edit";
      readonly displayPath: string;
      /** Non-content producer metadata only. Hashes and path identity stay out of the UIPort. */
      readonly observedBefore: UiMutationPresentationObservedBefore;
      readonly verifiedInstalledAfter: UiMutationPresentationFileImage;
      readonly coverage: "complete" | "truncated" | "summary-only" | "unknown";
      readonly observedBeforeLines: number | "unknown";
      readonly installedAfterLines: number | "unknown";
      readonly shownLines: number | "unknown";
      readonly hiddenLines: number | "unknown";
      readonly transitionBinding: "not-atomic";
      readonly concurrentMutation: "not-excluded";
    };

/** One tool call, shown compactly: `⋯/✓/✗ name  summary`. A call starts "running"; its result
 *  flips it to "ok"/"error" with a summary. An `edit` carries a `diff` preview of the change. */
export interface UiToolActivity {
  readonly kind: "tool";
  readonly id: string;
  readonly name: string;
  readonly status: "running" | "ok" | "error";
  readonly summary: string;
  /** Bounded, control-stripped invocation target derived from typed tool arguments. This keeps
   *  calm evidence labels factual without replacing the result summary used by diagnostic views. */
  readonly subject?: string;
  readonly diff?: readonly DiffLine[];
  /** Redacted, presentation-only projection of a Warden mutation-review artifact. It is never a
   * model, RPC, session, audit, or eval carrier. `pending` is a renderer commit barrier. */
  readonly mutationPresentation?: UiMutationPresentation;
  /** The latest output line of a *running* tool, control-stripped (Epic 1.5c — purposeful liveness).
   *  Set by the reducer from `tool-output-delta` events; cleared once the tool settles. Only the
   *  interactive (Ink) renderer reads it — the headless renderer ignores it, so deterministic
   *  `keel run -p` / golden output is unchanged. */
  readonly liveOutput?: string;
  /** Controller-owned, presentation-only execution liveness. Relative durations avoid wall-clock
   * disclosure and are never a progress estimate. The interactive runner supplies this only while
   * the exact tool occurrence is executing; settlement reconstructs the activity without it. */
  readonly liveness?: UiToolLiveness;
}

export interface UiToolLiveness {
  readonly elapsedMs: number;
  readonly quietMs: number;
  /** The controller's effective infrastructure deadline, not a model-requested tool argument. */
  readonly timeoutMs?: number;
}

/** The ordered conversation stream — messages and tool activity interleaved as they occurred. */
export type ViewItem = UiMessage | UiToolActivity;

/**
 * Enforcement posture for the trust HUD. Each flag is whether that guarantee is *actually
 * enforced*. Phase 1 has no warden, so all are `false` (honest no-enforcement); the renderer
 * must never show a posture stronger than these flags (§4.9.1 honesty invariant).
 */
export interface UiPosture {
  readonly sandbox: boolean;
  readonly egress: boolean;
  readonly audit: boolean;
}

/** Git state for the cockpit HUD. Omitted fields render as "n/a"; renderers must not infer them. */
export interface UiGitStatus {
  readonly branch?: string;
  readonly added?: number;
  readonly modified?: number;
  readonly deleted?: number;
}

/** Provider/context-window utilization. `percent` is active-window occupancy only, never cumulative
 *  run usage. If no active-window percent is known, the HUD renders "ctx n/a". */
export interface UiContextStatus {
  readonly percent?: number;
  readonly maxTokens?: number;
}

/** Provider cost telemetry. If the adapter has not reported cost, the HUD renders "cost n/a". */
export interface UiCostStatus {
  readonly usd?: number;
}

/** Policy/warden posture for the cockpit HUD. Phase 1 leaves this absent/false. */
export interface UiPolicyStatus {
  readonly active: boolean;
  readonly label?: string;
}

/** One recent session row shown in the first-run cockpit. Rows are already scoped/sanitized upstream. */
export interface UiRecentSession {
  readonly id: string;
  readonly age: string;
  readonly summary: string;
  readonly resumeCommand: string;
  readonly tokens?: number;
  readonly outcome?: "done" | "stopped" | "needs attention";
}

/** A factual token total for a recent time window. This is usage, not spend/cost. */
export interface UiUsageWindow {
  readonly label: string;
  readonly tokens: number;
  readonly runs: number;
}

/** Opening-screen usage context, derived from session ledger `run_status` events. */
export interface UiUsageDigest {
  readonly scope: "workspace";
  readonly windows: readonly UiUsageWindow[];
}

/** Governed model-routing status shown in cockpit and `/model` panels. */
export interface UiModelRouteStatus {
  readonly mode: "locked" | "auto-cost" | "auto-balanced" | "auto-quality";
  readonly status: "selected" | "denied" | "unknown";
  readonly selected?: string;
  readonly reason?: string;
  readonly lastDecisionId?: string;
}

/** UI-only protection lifecycle status. It never substitutes for a warden verdict or status payload. */
export interface UiStartupStatus {
  readonly phase: "starting-protections" | "protections-unavailable";
}

/** Controller-owned execution route for honest TUI presentation (ADR-0080). Presentation only: it
 * grants no authority and is never a substitute for a warden verdict or individual posture facts. */
export type UiProtectionRoute = "governed" | "deliberately-unenforced";

export interface UiTurnFileEvidence {
  readonly status: "available" | "unavailable";
  readonly text: string;
}

/** A compact factual receipt for the just-finished turn. `changed`/`checked` remain as additive-
 * presentation compatibility fields for existing UIPort implementations; the production receipt
 * producer uses `fileEvidence` and controller-owned verification rows instead. */
export interface UiTurnSummary {
  readonly title: "done" | "needs attention";
  readonly answer?: string;
  readonly changed: readonly string[];
  readonly checked: readonly string[];
  /** Bounded-source file observations from ADR-0078. These are not operation-effect claims. */
  readonly fileEvidence?: readonly UiTurnFileEvidence[];
  readonly ran?: readonly string[];
  readonly automatic?: readonly string[];
  /** Controller-owned semantic receipt rows (for example goal/check/verification/evidence/next).
   * Labels are part of each bounded row and must not be flattened into generic checked/notices. */
  readonly receipt?: readonly string[];
  readonly attention: readonly string[];
}

/** One tick in the attention rail / event mini-map. Glyph + label make it readable without color. */
export interface UiAttentionMark {
  readonly glyph: string;
  readonly label: string;
  readonly tone: "user" | "assistant" | "tool" | "success" | "error" | "queue" | "system";
}

/** A queued mid-run follow-up, already single-line sanitized for display. */
export interface UiQueuedInput {
  readonly class: "queued" | "urgent";
  readonly content: string;
}

/** Focus pane for the active turn. This is explanatory chrome, not a model/security claim. */
export interface UiCurrentTurn {
  readonly doing: string;
  readonly why: string;
  readonly last?: string;
  readonly next: string;
  /** Relative, controller-owned presentation facts. Renderers must not derive a percentage. */
  readonly elapsedMs?: number;
  readonly quietMs?: number;
  readonly timeoutMs?: number;
}

/**
 * Controller-owned presentation for the one live warden review. This is deliberately separate from
 * transcript items: replayed or model-authored text can never recreate an actionable approval. The
 * warden request retained by the review controller remains the authority for any decision.
 */
export type UiApprovalFact =
  | { readonly status: "available"; readonly value: string }
  | { readonly status: "unavailable"; readonly reason: string };

export type UiApprovalEffectiveTarget =
  | {
      readonly status: "available";
      readonly value: string;
      readonly completeness: "complete" | "abbreviated";
    }
  | { readonly status: "unavailable"; readonly reason: string };

export type UiApprovalExactResource =
  | { readonly status: "available"; readonly kind: "domain"; readonly value: string }
  | { readonly status: "available"; readonly kind: "command-envelope"; readonly value: string }
  | {
      readonly status: "available";
      readonly kind: "console";
      readonly target: string;
      readonly key: string;
    }
  | { readonly status: "unavailable"; readonly reason: string };

export interface UiApprovalInformation {
  /** Model-requested tool name only; the reducer bounds it before storage. Raw arguments never enter. */
  readonly requestedAction: UiApprovalFact;
  /** Human display supplied by the retained Warden review, not inferred from requested arguments. */
  readonly effectiveTarget: UiApprovalEffectiveTarget;
  /** Fixed controller interpretation of the Warden's `review` verdict. */
  readonly reason: UiApprovalFact;
  /** Protocol 1.1 does not currently identify the matched policy rule. */
  readonly policyDetail: UiApprovalFact;
  /** Strictly parsed Warden resource identity. Presentation is never authority. */
  readonly exactResource: UiApprovalExactResource;
}

export type UiApprovalChoice = "once" | "session" | "deny";

export interface UiActiveApproval {
  /** Backward-compatible combined display for renderers that predate ADR-0081. */
  readonly detail: string;
  readonly sessionAvailable: boolean;
  readonly state:
    | "pending"
    | "submitted"
    | "confirmed"
    | "governed-deny"
    | "denied"
    | "indeterminate"
    | "failed";
  /** Additive, process-local informed-consent facts. Never reconstructed from transcript/resume. */
  readonly information?: UiApprovalInformation;
  /** The human choice submitted to the Warden, retained only for live lifecycle presentation. */
  readonly selectedChoice?: UiApprovalChoice;
  readonly message?: string;
}

/** Presentation density, not an autonomy/security mode. */
export type UiDensity = "quiet" | "normal" | "verbose" | "debug";

/** The ambient status shown in the HUD: model, cwd, cumulative total tokens, and the honest posture. */
export interface UiStatus {
  readonly model?: string;
  readonly cwd?: string;
  readonly git?: UiGitStatus;
  readonly context?: UiContextStatus;
  readonly cost?: UiCostStatus;
  readonly policy?: UiPolicyStatus;
  readonly modelRoute?: UiModelRouteStatus;
  readonly startup?: UiStartupStatus;
  /** Optional for additive UIPort compatibility. Absence means `status not reported`, never an
   * inferred route. Startup lifecycle states take presentation precedence while active. */
  readonly protectionRoute?: UiProtectionRoute;
  /** Resolved workspace-context trust. Presentation only; it grants no tool authority. */
  readonly workspaceTrust?: "trusted" | "untrusted";
  readonly tokens: number;
  readonly posture: UiPosture;
}

/** A transient discoverability overlay: the `/` command palette, `?` help, local read-only panels,
 *  the `Ctrl-R` reverse-search line, or `@file` completions. Set by interactive input and local TUI
 *  commands; the renderers draw it when present. Additive view extension (ADR-0036) — not a
 *  frozen-schema change. User-derived text is control-stripped by the view layer before rendering
 *  (ER-020); local panel content is reducer-owned and stripped before storage. */
export type Overlay =
  | { readonly kind: "palette"; readonly query: string }
  | { readonly kind: "help" }
  | { readonly kind: "panel"; readonly content: string }
  | { readonly kind: "reverse-search"; readonly query: string; readonly match?: string }
  // `@file` path completion (Epic 1.23 slice 5). The reducer sets `query` (the text after `@`); the
  // interactive driver augments it with `matches` from the TRUST-GATED completer (SEC-012) — the
  // reducer stays pure and never touches the filesystem. `matches` are workspace-relative paths.
  | { readonly kind: "at-complete"; readonly query: string; readonly matches?: readonly string[] };

/** The render model — the single source of "what to show". Renderers are dumb maps over this. */
export interface ViewModel {
  readonly items: readonly ViewItem[];
  readonly status: UiStatus;
  /** True while the assistant is actively producing text (drives the liveness indicator). */
  readonly streaming: boolean;
  /** The active discoverability overlay, if any. */
  readonly overlay?: Overlay;
  /** Count of queued mid-run inputs not yet applied — drives the `… input:N queued` indicator
   *  (§4.10). Absent/0 = none pending. */
  readonly pendingInputs?: number;
  /** Count of warden review items waiting for human action. Presentation only; the warden remains the
   *  authority for the queue and every resolution. Absent/0 = none pending. */
  readonly pendingReviews?: number;
  /** The live controller-owned approval surface. Never persisted or reconstructed from transcript. */
  readonly activeApproval?: UiActiveApproval;
  /** Last pending-review count returned by warden.status. Presentation only; this is not a live queue
   *  subscription and renderers must not present it as a current pending-review count. */
  readonly lastWardenPendingReviews?: number;
  /** Visible queued follow-ups. Presentation only; the ledger remains canonical. */
  readonly queuedInputs?: readonly UiQueuedInput[];
  /** Attention rail / event mini-map derived from the visible ViewModel stream. */
  readonly attentionRail?: readonly UiAttentionMark[];
  /** Current-turn focus pane derived from real loop/input events. */
  readonly currentTurn?: UiCurrentTurn;
  /** Diff disclosure level (Epic 1.5b · tui-principles §8): `full` (default — the edit diff is the
   *  core artifact, shown per-line) or `compact` (a calm `+A −D` summary). Toggled by `/diff`.
   *  Absent = `full`. The large-diff cap applies in `full` regardless (never silent truncation). */
  readonly diffMode?: "compact" | "full";
  /** True while the multi-turn REPL is idle between turns, awaiting the next user prompt (Epic 1.23).
   *  The hint footer turns this into the idle "type to continue · /exit" affordance — it is how the
   *  loop signals "the turn finished and the session stayed open". Absent/false = a turn is active (or
   *  a single-turn run). */
  readonly awaitingInput?: boolean;
  /** Presentation-only confirmation state after the first idle Ctrl-C. The next Ctrl-C exits; any
   *  other input disarms it. Kept outside transcript history so the live composer cannot hide it. */
  readonly exitArmed?: boolean;
  /** True only on the first-run / empty-state opening view (before any prompt). The renderers draw the
   *  brand banner (wordmark + tagline + key affordances) FROM this flag — not as a transcript item, so it
   *  never lingers in the conversation after the first turn. The banner carries NO posture words; the
   *  always-rendered posture line keeps the honest §4.9.1 truth on screen. Absent/false = no banner.
   *  Additive view extension (ADR-0036) — not a frozen-schema change. */
  readonly firstRun?: boolean;
  /** Recent sessions for this workspace, scoped by cwdHash (ADR-0054) and rendered only as an opening
   *  affordance. Empty/absent means no prior sessions are shown. */
  readonly recentSessions?: readonly UiRecentSession[];
  /** Opening-screen token usage context for this workspace. Derived only from recorded provider usage;
   *  it is not a cost/spend estimate. */
  readonly usageDigest?: UiUsageDigest;
  /** Factual card for the last completed turn: answer headline, bounded file evidence,
   *  controller-owned verification, commands run, and failed tools / terminal notices. It is a
   *  presentation receipt, not an enforcement claim. */
  readonly turnSummary?: UiTurnSummary;
  /** Presentation density only. This must never imply a trust/autonomy mode. */
  readonly density?: UiDensity;
}

/**
 * A resolved user input from the UIPort: a prompt line, a slash command, or an interrupt. The
 * runner (Epic 1.5 slice 7) maps these to §4.10 mid-run steering: a `line` is a queued comment;
 * an urgent slash verb (`/now`·`/before-next-edit`·`/stop-after-current`) carries its instruction
 * in `args`; `interrupt` (or `/interrupt`) hard-stops the run.
 */
export type UserInput =
  | { readonly kind: "line"; readonly text: string }
  | { readonly kind: "command"; readonly name: string; readonly args?: string }
  | { readonly kind: "interrupt" };

/** The renderer seam. `render`/`close` ship from slice 1; `inputs()` lands with interactive input
 *  (slice 7): the runner consumes it concurrently with the loop to apply mid-run steering. */
export interface UIPort {
  /** Draw the current view. Idempotent: called on every view change; renderers diff internally. */
  render(view: ViewModel): void;
  /**
   * The mid-run user-input stream, consumed concurrently with the run (§4.10). A non-interactive
   * UIPort (headless `keel run -p`, CI) yields nothing and completes. The runner stops pulling when
   * the run ends, so an interactive stream that never completes does not block teardown.
   */
  inputs(): AsyncIterable<UserInput>;
  /** Release the terminal / flush. */
  close(): Promise<void>;
}
