import type {
  UiApprovalChoice,
  UiApprovalFact,
  UiApprovalInformation,
  UserInput,
} from "@keel/shared";
import type {
  WardenReviewDecision,
  WardenReviewDecisionHandler,
  WardenReviewDecisionRequest,
  WardenReviewSettlement,
} from "../warden/executor.js";
import { reviewApprovalOptions, reviewApprovalPresentation } from "../warden/approval.js";
import { oneLineText } from "../control-strip.js";
import { isToolDeadlineAbort } from "../infra.js";
import {
  associateExactProcessRunReviewInformation,
  processRunReviewSummaryForRequest,
} from "../warden/process-run-review-presentation.js";

export type ReviewInputDecision =
  | { readonly kind: "decision"; readonly decision: WardenReviewDecision }
  | { readonly kind: "explain" };

export type ReviewPresentationEvent =
  | {
      readonly kind: "opened";
      readonly detail: string;
      readonly sessionAvailable: boolean;
      readonly information: UiApprovalInformation;
      readonly losslessProcessRunSummary?: string;
    }
  | { readonly kind: "message"; readonly content: string }
  | { readonly kind: "submitted"; readonly content: string; readonly choice?: UiApprovalChoice }
  | { readonly kind: "confirmed"; readonly content: string }
  | { readonly kind: "governed-deny"; readonly content: string }
  | { readonly kind: "denied"; readonly content: string }
  | { readonly kind: "indeterminate"; readonly content: string }
  | { readonly kind: "failed"; readonly content: string }
  | { readonly kind: "closed"; readonly content?: string };

export interface InteractiveReviewDecisionController {
  readonly onReviewRequired: WardenReviewDecisionHandler;
  handleInput(input: UserInput): boolean;
  cancelPending(): boolean;
  awaitTimedOutReviewSettlement(): Promise<WardenReviewSettlement | undefined>;
  connect(callbacks: {
    readonly presentation: (event: ReviewPresentationEvent) => void;
  }): () => void;
}

interface PendingReview {
  readonly request: WardenReviewDecisionRequest;
  readonly resolve: (decision: WardenReviewDecision | undefined) => void;
  readonly cleanup: () => void;
  submitted: boolean;
  revoked: boolean;
  decision?: WardenReviewDecision;
}

function normalizeInputText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/gu, " ");
}

/**
 * Whether a submitted line is the user's next INSTRUCTION rather than an attempt at a decision.
 *
 * The test is deliberately structural, not a vocabulary list: a single token is someone reaching for
 * an answer ("maybe", "approve", "y") and deserves the corrective hint; a multi-word line is prose,
 * and prose is never a decision. A word list would need endless maintenance and would still be wrong
 * in the next language a user types in.
 */
function looksLikeInstruction(normalized: string): boolean {
  return normalized.includes(" ");
}

function oneLine(value: string): string {
  return oneLineText(value);
}

function displayFact(value: string, unavailableReason: string): UiApprovalFact {
  const normalized = oneLine(value);
  return normalized === ""
    ? { status: "unavailable", reason: unavailableReason }
    : { status: "available", value: normalized };
}

function approvalInformation(
  request: WardenReviewDecisionRequest,
  exactProcessRunSummary: string | undefined,
): UiApprovalInformation {
  const presentation = reviewApprovalPresentation(request.review);
  const effectiveTarget =
    exactProcessRunSummary === undefined
      ? displayFact(request.review.summary, "effective target unavailable from the Warden review")
      : ({ status: "available", value: exactProcessRunSummary } as const);
  const information: UiApprovalInformation = {
    requestedAction: displayFact(request.toolCall.name, "requested tool name unavailable"),
    effectiveTarget:
      effectiveTarget.status === "available"
        ? {
            ...effectiveTarget,
            // The strict ADR-0090 envelope and lossless predicate authenticate these exact Warden
            // bytes. A literal argv segment such as "[123 chars omitted]" is data, not evidence
            // that the Warden abbreviated the summary.
            completeness:
              exactProcessRunSummary === undefined ? presentation.summaryCompleteness : "complete",
          }
        : effectiveTarget,
    reason: {
      status: "available",
      value: "Warden requires human authorization before execution",
    },
    policyDetail: {
      status: "unavailable",
      reason: "matched policy rule not reported by protocol 1.1",
    },
    exactResource: presentation.exactResource,
  };
  return exactProcessRunSummary === undefined
    ? information
    : (associateExactProcessRunReviewInformation(information, exactProcessRunSummary) ??
        information);
}

function isInterruptInput(input: UserInput): boolean {
  return input.kind === "interrupt" || (input.kind === "command" && input.name === "/interrupt");
}

function commandText(input: Extract<UserInput, { readonly kind: "command" }>): string | undefined {
  if (input.name === "/approve") {
    const arg = normalizeInputText(input.args);
    return arg === "" ? "approve" : `approve ${arg}`;
  }
  if (input.name === "/deny") return "deny";
  return undefined;
}

export function parseReviewDecisionInput(input: UserInput): ReviewInputDecision | undefined {
  if (input.kind === "interrupt") return undefined;
  if (input.kind === "line") {
    const line = normalizeInputText(input.text);
    if (line === "?" || line === "why" || line === "explain") return { kind: "explain" };
    return undefined;
  }
  if (input.name === "/interrupt") return undefined;
  if (input.name === "/why") return { kind: "explain" };
  const text = normalizeInputText(commandText(input));
  if (text === "") return undefined;
  if (text === "deny") {
    return { kind: "decision", decision: { approved: false } };
  }
  if (text === "approve" || text === "approve once") {
    return { kind: "decision", decision: { approved: true, scope: "once" } };
  }
  if (text === "approve project") {
    return { kind: "decision", decision: { approved: true, scope: "project" } };
  }
  if (text === "approve session") {
    return { kind: "decision", decision: { approved: true, scope: "session" } };
  }
  return undefined;
}

function promptFor(
  request: WardenReviewDecisionRequest,
): Extract<ReviewPresentationEvent, { readonly kind: "opened" }> {
  const options = reviewApprovalOptions(request.review);
  const exactProcessRunSummary = processRunReviewSummaryForRequest(
    request.toolCall,
    request.review,
  );
  return {
    kind: "opened",
    detail: exactProcessRunSummary ?? reviewedTarget(request),
    sessionAvailable: options.sessionAvailable,
    information: approvalInformation(request, exactProcessRunSummary),
    ...(exactProcessRunSummary === undefined
      ? {}
      : { losslessProcessRunSummary: exactProcessRunSummary }),
  };
}

function reviewedTarget(request: WardenReviewDecisionRequest): string {
  // The review summary is warden-owned and describes the effective target after policy rewrites.
  // The model-authored ToolInvocation may be stale and must never substitute for informed consent.
  return [oneLine(request.toolCall.name), oneLine(request.review.summary)]
    .filter((part) => part.length > 0)
    .join(" ");
}

function explainFor(request: WardenReviewDecisionRequest): string {
  void request;
  return "explanation shown above · still pending · no authority granted";
}

function choiceFor(decision: WardenReviewDecision): UiApprovalChoice | undefined {
  if (!decision.approved) return "deny";
  if (decision.scope === "once") return "once";
  if (decision.scope === "session") return "session";
  return undefined;
}

export function createInteractiveReviewDecisionController(): InteractiveReviewDecisionController {
  let pending: PendingReview | undefined;
  let timedOutReview:
    | {
        readonly request: WardenReviewDecisionRequest;
        readonly settlement: Promise<WardenReviewSettlement>;
      }
    | undefined;
  let presentation: ((event: ReviewPresentationEvent) => void) | undefined;

  const timedOutReviewMessage =
    "review expired at the tool deadline · late decisions are rejected · waiting for authoritative warden denial";
  const submittedTimeoutMessage =
    "tool deadline reached after review decision submission · late decisions are rejected · waiting for authoritative warden outcome";

  const rememberTimedOutSettlement = (request: WardenReviewDecisionRequest): boolean => {
    const settlement = request.settlement;
    timedOutReview = {
      request,
      settlement:
        settlement ??
        Promise.resolve({
          status: "failed",
          message: "authoritative review settlement channel is unavailable",
        }),
    };
    return settlement !== undefined;
  };

  const clearPending = (
    decision: WardenReviewDecision | undefined,
    resolveDecision = true,
    content?: string,
  ): void => {
    const activeReview = pending;
    pending = undefined;
    activeReview?.cleanup();
    if (resolveDecision) activeReview?.resolve(decision);
    if (activeReview !== undefined)
      presentation?.({ kind: "closed", ...(content !== undefined ? { content } : {}) });
  };

  const submitPending = (decision: WardenReviewDecision): void => {
    const activeReview = pending;
    if (activeReview === undefined || activeReview.submitted || activeReview.revoked) return;
    const choice = choiceFor(decision);
    if (choice === undefined) {
      presentation?.({
        kind: "message",
        content:
          "project approval is unavailable in live reviews; use /approve session or configure Project Autopilot",
      });
      return;
    }
    activeReview.submitted = true;
    activeReview.decision = decision;
    if (activeReview.request.settlement === undefined) {
      // Backward-compatible injected/test hooks without an executor settlement channel complete at
      // submission. Production WardenExecutor always supplies the channel below.
      clearPending(decision);
      return;
    }
    presentation?.({
      kind: "submitted",
      content: "review decision submitted · waiting for warden confirmation",
      choice,
    });
    activeReview.resolve(decision);
  };

  const failPending = (request: WardenReviewDecisionRequest, content: string): void => {
    if (pending?.request !== request) return;
    const activeReview = pending;
    pending = undefined;
    activeReview.cleanup();
    presentation?.({ kind: "failed", content });
  };

  const markPendingIndeterminate = (
    request: WardenReviewDecisionRequest,
    content: string,
  ): void => {
    if (pending?.request !== request) return;
    const activeReview = pending;
    pending = undefined;
    activeReview.cleanup();
    presentation?.({ kind: "indeterminate", content });
  };

  return {
    onReviewRequired: (request) => {
      if (request.signal?.aborted === true) return undefined;
      if (
        request.toolCall.name === "process.run" &&
        processRunReviewSummaryForRequest(request.toolCall, request.review) === undefined
      ) {
        return undefined;
      }
      if (pending !== undefined) {
        presentation?.({
          kind: "message",
          content:
            "another warden review is active; this review cannot open here and will not execute",
        });
        return undefined;
      }
      return new Promise<WardenReviewDecision | undefined>((resolve) => {
        const abort = (): void => {
          if (pending?.request !== request) return;
          if (!isToolDeadlineAbort(request.signal)) {
            if (!pending.submitted && !pending.revoked) clearPending(undefined);
            return;
          }
          const activeReview = pending;
          activeReview.cleanup();
          const hasSettlement = rememberTimedOutSettlement(request);
          presentation?.({
            kind: "submitted",
            content: activeReview.submitted ? submittedTimeoutMessage : timedOutReviewMessage,
          });
          if (activeReview.submitted) return;
          activeReview.revoked = true;
          activeReview.resolve(undefined);
          if (!hasSettlement) {
            failPending(
              request,
              "review deadline revocation could not be confirmed: authoritative settlement channel unavailable · no approval assumed · restart the governed session before deciding again",
            );
          }
        };
        const cleanup = (): void => request.signal?.removeEventListener("abort", abort);
        pending = { request, resolve, cleanup, submitted: false, revoked: false };
        request.signal?.addEventListener("abort", abort, { once: true });
        presentation?.(promptFor(request));
        void request.settlement?.then(
          (settlement) => {
            if (pending?.request !== request) return;
            if (settlement.status === "resolved") {
              const activeReview = pending;
              pending = undefined;
              activeReview.cleanup();
              switch (settlement.verdict) {
                case "deny":
                  presentation?.(
                    activeReview.decision?.approved === true
                      ? {
                          kind: "governed-deny",
                          content:
                            "review decision confirmed by warden · governed result deny · inspect the tool result for effect truth",
                        }
                      : {
                          kind: "denied",
                          content:
                            activeReview.decision?.approved === false
                              ? "review denied by you · action not executed · rerun the request to reconsider"
                              : "review denied by warden · action not executed · revise the request before retrying",
                        },
                  );
                  break;
                case "allow":
                case "warn":
                case "modify":
                  presentation?.({
                    kind: "confirmed",
                    content: `review decision confirmed by warden · verdict ${settlement.verdict}`,
                  });
                  break;
                case "review":
                  presentation?.({
                    kind: "failed",
                    content:
                      "warden did not authorize the action · approval not confirmed · action did not run",
                  });
                  break;
              }
              return;
            }
            if (settlement.status === "cancelled") {
              if (pending.submitted) {
                markPendingIndeterminate(
                  request,
                  "review decision outcome unavailable after interruption · action may have executed · do not retry automatically · inspect audit after restarting the governed session",
                );
              } else {
                clearPending(undefined, false, "review prompt closed without a decision");
              }
              return;
            }
            if (settlement.status === "indeterminate") {
              markPendingIndeterminate(
                request,
                `review outcome indeterminate: ${oneLine(settlement.message)} · action may have executed · do not retry automatically · inspect audit after restarting the governed session`,
              );
              return;
            }
            failPending(
              request,
              `review decision not confirmed: ${oneLine(settlement.message)} · no approval assumed · restart the governed session before deciding again`,
            );
          },
          () => {
            if (pending?.request !== request) return;
            if (pending.submitted) {
              markPendingIndeterminate(
                request,
                "review decision outcome unavailable · action may have executed · do not retry automatically · inspect audit after restarting the governed session",
              );
            } else {
              failPending(
                request,
                "review decision not confirmed · no approval assumed · restart the governed session before deciding again",
              );
            }
          },
        );
      });
    },
    handleInput: (input) => {
      const active = pending;
      if (active === undefined) return false;
      if (isInterruptInput(input)) {
        if (!active.submitted && !active.revoked) clearPending(undefined);
        return false;
      }
      if (active.revoked) {
        presentation?.({ kind: "submitted", content: timedOutReviewMessage });
        return true;
      }
      if (active.submitted) {
        const shortcut =
          input.kind === "line"
            ? normalizeInputText(input.text)
            : input.kind === "command"
              ? normalizeInputText(input.name)
              : "";
        if (
          shortcut === "?" ||
          shortcut === "why" ||
          shortcut === "explain" ||
          shortcut === "/why"
        ) {
          presentation?.({
            kind: "submitted",
            content: `${explainFor(active.request)} · decision already submitted · waiting for warden confirmation`,
          });
          return true;
        }
        if (
          shortcut === "a" ||
          shortcut === "d" ||
          shortcut === "s" ||
          shortcut === "p" ||
          shortcut === "/approve" ||
          shortcut === "/deny"
        ) {
          presentation?.({
            kind: "submitted",
            content: "review decision already submitted · waiting for warden confirmation",
          });
          return true;
        }
      }
      if (input.kind === "line") {
        const shortcut = normalizeInputText(input.text);
        if (shortcut === "a") {
          submitPending({ approved: true, scope: "once" });
          return true;
        }
        if (shortcut === "d") {
          submitPending({ approved: false });
          return true;
        }
        if (shortcut === "s") {
          if (reviewApprovalOptions(active.request.review).sessionAvailable) {
            submitPending({ approved: true, scope: "session" });
          } else {
            presentation?.({
              kind: "message",
              content:
                "session approval is unavailable: no exact domain/key; use /approve once or /deny",
            });
          }
          return true;
        }
        if (shortcut === "p") {
          presentation?.({
            kind: "message",
            content:
              "project approval is unavailable in live reviews; use /approve session or configure Project Autopilot",
          });
          return true;
        }
      }
      const parsed = parseReviewDecisionInput(input);
      if (parsed === undefined) {
        if (input.kind === "command" && input.name === "/approve") {
          presentation?.({
            kind: "message",
            content:
              "review approval needs an explicit scope here: use /approve once, /deny, or /why",
          });
          return true;
        }
        // Text that is plainly NOT a decision attempt is the user's next instruction, typed ahead
        // while the prompt was open. Consuming it here discarded it outright; falling through lets
        // the runner classify it as steering and queue it with a visible ack (ADR-0034), which is
        // the machinery that already exists for exactly this.
        //
        // The security property is untouched: every decision shortcut and near-miss decision word is
        // consumed ABOVE this point, so no prose can reach a decision path — "add a README" is
        // queued, never read as the `a` approve shortcut.
        // Only while the review is still awaiting a decision. Once a decision is submitted the turn
        // is in its settle window, where "non-actionable until the warden confirms" is the stronger
        // property — everything typed there keeps the explicit already-submitted acknowledgement.
        if (
          input.kind === "line" &&
          !active.submitted &&
          looksLikeInstruction(normalizeInputText(input.text))
        ) {
          return false;
        }
        presentation?.({
          kind: active.submitted ? "submitted" : "message",
          content: active.submitted
            ? "review decision already submitted · waiting for warden confirmation"
            : "approval is active · choose approve once, an available wider scope, deny, or ? for why",
        });
        return true;
      }
      if (parsed.kind === "explain") {
        presentation?.({ kind: "message", content: explainFor(active.request) });
        return true;
      }
      if (
        parsed.decision.approved &&
        parsed.decision.scope === "session" &&
        !reviewApprovalOptions(active.request.review).sessionAvailable
      ) {
        presentation?.({
          kind: "message",
          content:
            "session approval is unavailable: no exact domain/key; use /approve once or /deny",
        });
        return true;
      }
      if (parsed.decision.approved && parsed.decision.scope === "project") {
        presentation?.({
          kind: "message",
          content:
            "project approval is unavailable in live reviews; use /approve session or configure Project Autopilot",
        });
        return true;
      }
      submitPending(parsed.decision);
      return true;
    },
    cancelPending: () => {
      const active = pending;
      if (active === undefined) return false;
      if (active.submitted) {
        markPendingIndeterminate(
          active.request,
          "review decision outcome unavailable because input closed · action may have executed · do not retry automatically · inspect audit after restarting the governed session",
        );
      } else {
        clearPending(undefined);
      }
      return true;
    },
    awaitTimedOutReviewSettlement: async () => {
      const active = timedOutReview;
      if (active === undefined) return undefined;
      let settlement: WardenReviewSettlement;
      try {
        settlement = await active.settlement;
      } catch (error) {
        settlement = {
          status: "indeterminate",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (timedOutReview === active) timedOutReview = undefined;
      return settlement;
    },
    connect: (callbacks) => {
      const previous = presentation;
      presentation = callbacks.presentation;
      return () => {
        if (presentation === callbacks.presentation) presentation = previous;
      };
    },
  };
}
