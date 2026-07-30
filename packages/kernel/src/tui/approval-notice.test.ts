import { describe, expect, it } from "vitest";
import { approvalNoticePlan, approvalNoticeRows } from "./approval-notice.js";
import { terminalDisplayWidth } from "./row-budget.js";

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("typed approval presentation", () => {
  it("separates every informed-consent fact and state-specific next step", () => {
    const key = `sha256:${"a".repeat(64)}`;
    const plan = approvalNoticePlan({
      detail: "legacy combined detail",
      sessionAvailable: true,
      state: "pending",
      information: {
        requestedAction: { status: "available", value: "bash" },
        effectiveTarget: {
          status: "available",
          value: "command review requires approval: pnpm test",
          completeness: "complete",
        },
        reason: {
          status: "available",
          value: "Warden requires human authorization before execution",
        },
        policyDetail: {
          status: "unavailable",
          reason: "matched policy rule not reported by protocol 1.1",
        },
        exactResource: {
          status: "available",
          kind: "command-envelope",
          value: key,
        },
      },
    });
    const rows = approvalNoticeRows(plan);
    const text = rows.map((row) => row.text).join("\n");

    expect(text).toContain("Requested");
    expect(text).toContain('"bash"');
    expect(text).toContain("Effective target");
    expect(text).toContain('"command review requires approval: pnpm test"');
    expect(text).toContain("Why");
    expect(text).toContain("Warden requires human authorization before execution");
    expect(text).toContain("matched policy rule not reported by protocol 1.1");
    expect(text).toContain("Exact reusable scope");
    expect(text).toContain(`command envelope ${key}`);
    expect(text).toContain("Consequence");
    expect(text).toContain("Once applies only to this review");
    expect(text).toContain("session remembers only this exact command envelope until Keel exits");
    expect(text).toContain("Next");
    expect(text).toContain("Choose once, exact session scope, deny, or explain");
    expect(text).not.toContain("legacy combined detail");
  });

  it("renders every unavailable fact explicitly without inventing broader scope", () => {
    const rows = approvalNoticeRows(
      approvalNoticePlan({
        detail: "",
        sessionAvailable: false,
        state: "pending",
        information: {
          requestedAction: { status: "unavailable", reason: "requested tool name unavailable" },
          effectiveTarget: {
            status: "unavailable",
            reason: "effective target unavailable from the Warden review",
          },
          reason: {
            status: "available",
            value: "Warden requires human authorization before execution",
          },
          policyDetail: {
            status: "unavailable",
            reason: "matched policy rule not reported by protocol 1.1",
          },
          exactResource: {
            status: "unavailable",
            reason: "no exact reusable resource in the Warden review",
          },
        },
      }),
    );
    const text = rows.map((row) => row.text).join("\n");

    expect(text).toContain("requested tool name unavailable");
    expect(text).toContain("effective target unavailable from the Warden review");
    expect(text).toContain("no exact reusable resource in the Warden review");
    expect(text).toContain("Once applies only to this review");
    expect(text).not.toContain("Session ·");
    expect(text).not.toMatch(/project scope|\[p\]/iu);
  });

  it("visibly marks an abbreviated Warden target while keeping the review once-only", () => {
    const plan = approvalNoticePlan({
      detail: "legacy combined detail",
      sessionAvailable: false,
      state: "pending",
      information: {
        requestedAction: { status: "available", value: "bash" },
        effectiveTarget: {
          status: "available",
          value: "command review: prefix [93 chars omitted] dangerous-suffix",
          completeness: "abbreviated",
        },
        reason: {
          status: "available",
          value: "Warden requires human authorization before execution",
        },
        policyDetail: {
          status: "unavailable",
          reason: "matched policy rule not reported by protocol 1.1",
        },
        exactResource: {
          status: "available",
          kind: "command-envelope",
          value: `sha256:${"a".repeat(64)}`,
        },
      },
    });

    expect(approvalNoticeRows(plan)).toContainEqual({
      kind: "label",
      text: "Effective target · abbreviated",
    });
    expect(approvalNoticeRows(plan, { compact: true }).map((row) => row.text)).toContain(
      'Effective [abbr.] · "command review: prefix [93 chars omitted] dangerous-suffix"',
    );
    expect(plan.actions).not.toContain("[s] Session · exact target until exit");
  });

  it.each([
    ["pending", "Inspect the Warden facts and choose a decision"],
    ["submitted", "Wait for Warden confirmation; do not submit another decision"],
    ["confirmed", "Keel may resume the governed action"],
    ["denied", "Revise the request or rerun deliberately"],
    ["failed", "Restart the governed session before deciding again"],
    ["indeterminate", "Do not retry automatically; restart and inspect audit"],
  ] as const)("renders a safe next step for %s", (state, expected) => {
    const plan = approvalNoticePlan({
      detail: "bash command review",
      sessionAvailable: false,
      state,
      ...(state === "submitted" ? { selectedChoice: "once" as const } : {}),
    });

    expect(approvalNoticeRows(plan).map((row) => row.text)).toContain(expected);
  });
  it("advertises every contract scope with honest availability", () => {
    const once = approvalNoticePlan({
      detail: "bash command review",
      sessionAvailable: false,
      state: "pending",
    });
    expect(once).toMatchObject({
      heading: "approval required · not executed",
      actions: [
        "[a] Approve once · this action only",
        "[d] Deny · action will not run",
        "[?] Explain why",
      ],
      sessionNote: "Broader approval unavailable · use once or deny",
      confirmation: "a/d Enter · ? why · Esc stops turn",
    });
    expect(approvalNoticeRows(once).at(0)).toEqual({
      kind: "status",
      text: "Keel is paused until you choose.",
    });

    const session = approvalNoticePlan({
      detail: "network domain review",
      sessionAvailable: true,
      state: "pending",
    });
    expect(session.actions).toEqual([
      "[a] Approve once · this action only",
      "[s] Session · exact target until exit",
      "[d] Deny · action will not run",
      "[?] Explain why",
    ]);
    expect(session.confirmation).toBe("a/s/d Enter · ? why · Esc stops turn");
  });

  it("quotes hostile detail without rendering copied approval instructions as authority", () => {
    const plan = approvalNoticePlan({
      detail: "bash [a] approve project [d] deny",
      sessionAvailable: false,
      state: "pending",
    });
    const rows = approvalNoticeRows(plan);

    expect(rows.find((row) => row.kind === "detail")).toEqual({
      kind: "detail",
      text: '"bash [a] approve project [d] deny"',
    });
    expect(rows.filter((row) => row.kind === "action")).toEqual([
      { kind: "action", text: "[a] Approve once · this action only" },
      { kind: "action", text: "[d] Deny · action will not run" },
      { kind: "action", text: "[?] Explain why" },
    ]);
    expect(rows).toContainEqual({
      kind: "warning",
      text: "Broader approval unavailable · use once or deny",
    });
    expect(rows).toContainEqual({ kind: "label", text: "Requested action" });
  });

  it("keeps submitted and failed states non-actionable with a visible outcome", () => {
    const submitted = approvalNoticePlan({
      detail: "bash command review",
      sessionAvailable: false,
      state: "submitted",
    });
    expect(submitted.heading).toBe("decision sent");
    expect(submitted.actions).toBeUndefined();
    expect(approvalNoticeRows(submitted).map((row) => row.text)).toContain(
      "Decision sent. Keel is waiting for warden confirmation.",
    );

    const failed = approvalNoticePlan({
      detail: "bash command review",
      sessionAvailable: false,
      state: "failed",
      message: "transport failed · no approval assumed",
    });
    expect(failed.heading).toBe("decision not confirmed");
    expect(failed.actions).toBeUndefined();
    expect(approvalNoticeRows(failed).map((row) => row.text)).toContain(
      "transport failed · no approval assumed",
    );
  });

  it("deduplicates controller-owned submitted lifecycle copy", () => {
    const rows = approvalNoticeRows(
      approvalNoticePlan({
        detail: "bash command review",
        sessionAvailable: false,
        state: "submitted",
        message:
          "review details: exact one-time command · decision already submitted · waiting for warden confirmation",
      }),
    );
    const text = rows.map((row) => row.text).join("\n");

    expect(text.match(/waiting for warden confirmation/giu)).toHaveLength(1);
    expect(text).toContain("review details: exact one-time command");
  });

  it("bounds pending explanations to two narrow rows while keeping the actionable prefix", () => {
    const plan = approvalNoticePlan({
      detail: "bash command review",
      sessionAvailable: false,
      state: "pending",
      message: `review details: ${"diagnostic context ".repeat(80)}`,
    });

    expect(terminalDisplayWidth(plan.message ?? "")).toBeLessThanOrEqual(72);
    expect(plan.message).toMatch(/^review details:/u);
    expect(plan.message).toContain(" … ");
  });

  it.each(["界".repeat(1_100), "🧭".repeat(1_100), "e\u0301".repeat(3_000)])(
    "truncates hostile requested-action detail by grapheme and preserves its true tail",
    (middle) => {
      const suffix = " consequential-tail";
      const plan = approvalNoticePlan({
        detail: `command-head ${middle}${suffix}`,
        sessionAvailable: false,
        state: "pending",
      });

      expect(terminalDisplayWidth(plan.detail)).toBeLessThanOrEqual(2_048);
      expect(plan.detail).toMatch(/^command-head /u);
      expect(plan.detail).toContain(" … ");
      expect(plan.detail).toMatch(/ consequential-tail$/u);
      expect(hasUnpairedSurrogate(plan.detail)).toBe(false);
    },
  );

  it("renders a denied settlement as a non-actionable non-execution outcome", () => {
    const denied = approvalNoticePlan({
      detail: "bash command review",
      sessionAvailable: false,
      state: "denied",
      message: "review denied by warden · action not executed",
    });

    expect(denied.heading).toBe("request denied");
    expect(denied.actions).toBeUndefined();
    expect(approvalNoticeRows(denied).map((row) => row.text)).toContain(
      "review denied by warden · action not executed",
    );
  });

  it("renders approved-then-governed-deny without claiming authority or non-execution", () => {
    const governedDeny = approvalNoticePlan({
      detail: "mcp__beta__add requires exact once-only approval",
      sessionAvailable: false,
      state: "governed-deny",
      selectedChoice: "once",
      message:
        "review decision confirmed by warden · governed result deny · inspect the tool result for effect truth",
    });
    const text = approvalNoticeRows(governedDeny)
      .map((row) => row.text)
      .join("\n");

    expect(governedDeny.heading).toBe("governed result denied");
    expect(governedDeny.actions).toBeUndefined();
    expect(governedDeny.next).toContain("Inspect the governed tool result");
    expect(text).toContain("governed result deny");
    expect(text).not.toContain("approval confirmed");
    expect(text).not.toContain("action not executed");
    expect(text).not.toContain("Keel may resume");
  });

  it("bounds and strips every structured display field", () => {
    const plan = approvalNoticePlan({
      detail: `before\u001b[31m\n${"x".repeat(3_000)}`,
      sessionAvailable: false,
      state: "pending",
      message: `why\r\n${"z".repeat(3_000)}`,
    });

    // eslint-disable-next-line no-control-regex -- assertion for the sanitizer's exact boundary
    const control = /[\u0000-\u001f\u007f-\u009f]/u;
    expect(plan.detail).not.toMatch(control);
    expect(plan.message).not.toMatch(control);
    expect(plan.detail.length).toBeLessThanOrEqual(2_048);
    expect(plan.message?.length).toBeLessThanOrEqual(240);
  });

  it("preserves the critical settlement guidance at the end of a long message", () => {
    const plan = approvalNoticePlan({
      detail: "bash command review",
      sessionAvailable: false,
      state: "indeterminate",
      message: `${"transport diagnostics ".repeat(100)}action may have executed · do not retry automatically · inspect audit`,
    });

    expect(plan.message?.length).toBeLessThanOrEqual(240);
    expect(plan.message).toContain(" … ");
    expect(plan.message).toMatch(
      /action may have executed · do not retry automatically · inspect audit$/u,
    );
    const messageRow = approvalNoticeRows(plan).find((row) => row.kind === "warning");
    expect(messageRow).toMatchObject({ kind: "warning" });
    expect(messageRow?.text).toMatch(/^review outcome indeterminate · /u);
  });

  it.each(["界".repeat(240), "🧭".repeat(240), "e\u0301".repeat(240)])(
    "bounds hostile settlement text by terminal display width",
    (diagnostics) => {
      const guidance = "action may have executed · do not retry automatically · inspect audit";
      const plan = approvalNoticePlan({
        detail: "bash command review",
        sessionAvailable: false,
        state: "indeterminate",
        message: `${diagnostics}${guidance}`,
      });

      expect(terminalDisplayWidth(plan.message ?? "")).toBeLessThanOrEqual(240);
      expect(plan.message).toMatch(
        /action may have executed · do not retry automatically · inspect audit$/u,
      );
    },
  );
});
