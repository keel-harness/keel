import { describe, expect, it } from "vitest";
import { KERNEL_STRINGS, budgetWarningMessage, infraTimeoutMessage } from "./strings.js";

describe("kernel strings", () => {
  it("budgetWarningMessage states used, max, and remaining tokens", () => {
    const m = budgetWarningMessage(6, 10);
    expect(m).toContain("effective-cost");
    expect(m).toContain("6");
    expect(m).toContain("10");
    expect(m).toContain("4"); // remaining = 10 - 6
  });

  it("budgetWarningMessage clamps remaining at 0 when over budget", () => {
    expect(budgetWarningMessage(12, 10)).toContain("0");
  });

  it("infraTimeoutMessage names the tool and the deadline", () => {
    const m = infraTimeoutMessage("bash", 1500);
    expect(m).toContain("bash");
    expect(m).toContain("1500");
  });

  it("static strings are present and the YOLO banner is honest about no enforcement", () => {
    expect(KERNEL_STRINGS.yoloBanner).toContain("NO ENFORCEMENT");
    expect(KERNEL_STRINGS.verificationPrompt.length).toBeGreaterThan(0);
    expect(KERNEL_STRINGS.loopGuidance.length).toBeGreaterThan(0);
    expect(KERNEL_STRINGS.loopSkipped.length).toBeGreaterThan(0);
    expect(KERNEL_STRINGS.toolAborted.length).toBeGreaterThan(0);
    expect(KERNEL_STRINGS.reviewDeadlineLateOutcome).toContain("may have executed");
    expect(KERNEL_STRINGS.reviewDeadlineOutcomeUnavailable).toContain("do not retry automatically");
    expect(KERNEL_STRINGS.reviewResolutionStillPending).toContain("remains pending");
    expect(KERNEL_STRINGS.reviewResolutionStillPending).toContain("do not retry automatically");
  });

  it("run-end settlement copy does not invent execution truth", () => {
    const message = KERNEL_STRINGS.toolResultMissingAtRunEnd.toLowerCase();
    expect(message).toContain("tool result");
    expect(message).toContain("indeterminate");
    expect(message).toContain("inspect");
    expect(message).not.toContain("not executed");
    expect(message).not.toContain("did not execute");
  });

  it("routes read-only terminal-review recovery to typed observations", () => {
    const message = KERNEL_STRINGS.terminalReviewRecovery;
    expect(message).toMatch(/read-only file discovery.{0,80}typed `search` or `read`/is);
    expect(message).toMatch(/not bash.{0,80}`find`.{0,40}`grep`.{0,40}`xargs`/is);
    expect(message).toContain("`search: no matches.`");
    expect(message).toMatch(/no matches.{0,80}completed observation/is);
    expect(message).toMatch(/requested test, check, or command.{0,80}atomic bash/is);
    expect(message).toMatch(/at most one.{0,80}(?:model-authored|model-driven)/is);
    expect(message).toContain("Warden-gated");
  });

  // Epic 1.16 golden: the verification prompt MUST be STOP-biased + execution-grounded. The prior
  // CONTINUE-biased prompt was measured net-negative — it pushed cleanly-stopped models into open-ended
  // re-work until they burned the gross cap (claim-ledger 2026-06-18: clean-stops 7→2, +49% output). This
  // pins the redesign so it cannot silently drift back toward "otherwise continue and fix it".
  it("verificationPrompt is STOP-biased + execution-grounded (Epic 1.16), not continue-biased", () => {
    const p = KERNEL_STRINGS.verificationPrompt;
    // execution-grounded: PROVE by running, not assert/review
    expect(p.toLowerCase()).toContain("prove");
    expect(p.toLowerCase()).toMatch(/run the concrete check|actually execute|run the .* check/);
    // STOP-biased: confirm-and-stop is the default outcome
    expect(p.toLowerCase()).toMatch(/you are done.*stop|say so and stop/);
    // bounded continuation only — smallest fix for a demonstrated failure, then stop
    expect(p.toLowerCase()).toContain("smallest fix");
    expect(p.toLowerCase()).toMatch(/demonstrably fails|fails a check you just ran/);
    // MUST NOT carry the old open-ended continue-bias that caused the churn regression
    expect(p.toLowerCase()).not.toContain("otherwise continue and fix it");
    expect(p.toLowerCase()).not.toContain("continue and fix it");
  });
});
