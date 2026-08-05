import { describe, expect, it } from "vitest";
import type { UiToolActivity, ViewItem } from "@keel/shared";
import { markToolPresentationOutcome } from "../tool-presentation-outcome.js";
import {
  associateToolRecoveryIdentity,
  reconciledToolAttempts,
  recoveredExploratoryFailureIndexes,
  toolRecoveryIdentityForCall,
} from "./recovered-tool.js";

describe("recovered exploratory failures", () => {
  it("reconciles one successful bounded correction without hiding original non-execution truth", () => {
    const blocked = markToolPresentationOutcome(
      {
        kind: "tool",
        id: "reviewed-composite",
        name: "bash",
        status: "error",
        summary:
          "blocked (not executed): no live decision available · POL-003 review: use a simpler command",
      } as const,
      "blocked",
    );
    const items: ViewItem[] = [
      { kind: "message", role: "user", content: "verify pytest" },
      blocked,
      {
        kind: "tool",
        id: "atomic-correction",
        name: "bash",
        status: "ok",
        summary: "pytest 9.1.1",
      },
      {
        kind: "message",
        role: "assistant",
        content: "The atomic check passed; the reviewed composite command was not executed.",
      },
    ];

    expect(reconciledToolAttempts(items)).toEqual({
      failureIndexes: new Set([1]),
      recoveredCount: 1,
      receiptLines: [
        "recovered · bash completed one bounded correction; original reviewed action was not executed",
      ],
    });
  });

  it("reconciles the immediate successful correction after later ordinary work", () => {
    const blocked = markToolPresentationOutcome(
      {
        kind: "tool",
        id: "reviewed-composite",
        name: "bash",
        status: "error",
        summary:
          "blocked (not executed): no live decision available · POL-003 review: use a simpler command",
      } as const,
      "blocked",
    );
    const laterFailure = markToolPresentationOutcome(
      {
        kind: "tool",
        id: "later-failure",
        name: "bash",
        status: "error",
        summary: "exit 1 · later verification failed",
      } as const,
      "failed",
    );
    const items: ViewItem[] = [
      { kind: "message", role: "user", content: "implement and verify the feature" },
      blocked,
      {
        kind: "tool",
        id: "atomic-correction",
        name: "bash",
        status: "ok",
        summary: "pytest 9.1.1",
      },
      {
        kind: "tool",
        id: "ordinary-edit",
        name: "edit",
        status: "ok",
        summary: "updated tests/test_termui.py",
        subject: "tests/test_termui.py",
      },
      laterFailure,
      {
        kind: "tool",
        id: "ordinary-verification",
        name: "bash",
        status: "ok",
        summary: "1 passed",
      },
      {
        kind: "message",
        role: "assistant",
        content: "Implemented the feature and verified the focused test.",
      },
    ];

    expect(reconciledToolAttempts(items)).toEqual({
      failureIndexes: new Set([1]),
      recoveredCount: 1,
      receiptLines: [
        "recovered · bash completed one bounded correction; original reviewed action was not executed",
      ],
    });
    expect(reconciledToolAttempts(items).failureIndexes).not.toContain(4);
  });

  it("does not reconcile a terminal review when the bounded correction fails or has siblings", () => {
    const blocked = markToolPresentationOutcome(
      {
        kind: "tool",
        id: "reviewed-composite",
        name: "bash",
        status: "error",
        summary:
          "blocked (not executed): no live decision available · POL-003 review: use a simpler command",
      } as const,
      "blocked",
    );
    const answer = {
      kind: "message" as const,
      role: "assistant" as const,
      content: "The correction failed; exact work remains.",
    };
    const failed: ViewItem[] = [
      blocked,
      markToolPresentationOutcome(
        {
          kind: "tool",
          id: "failed-correction",
          name: "bash",
          status: "error",
          summary: "exit 1",
        } as const,
        "failed",
      ),
      answer,
    ];
    const siblings: ViewItem[] = [
      blocked,
      { kind: "tool", id: "correction", name: "bash", status: "ok", summary: "passed" },
      markToolPresentationOutcome(
        {
          kind: "tool",
          id: "skipped-sibling",
          name: "bash",
          status: "error",
          summary: "bounded recovery permits one tool call; not executed",
        } as const,
        "skipped",
      ),
      answer,
    ];

    expect(reconciledToolAttempts(failed).failureIndexes).toEqual(new Set());
    expect(reconciledToolAttempts(siblings).failureIndexes).toEqual(new Set());
  });

  it("does not reconcile a terminal review across a later user turn", () => {
    const blocked = markToolPresentationOutcome(
      {
        kind: "tool",
        id: "reviewed-composite",
        name: "bash",
        status: "error",
        summary:
          "blocked (not executed): no live decision available · POL-003 review: use a simpler command",
      } as const,
      "blocked",
    );
    const items: ViewItem[] = [
      blocked,
      { kind: "message", role: "user", content: "start a new attempt" },
      { kind: "tool", id: "later-success", name: "bash", status: "ok", summary: "passed" },
      { kind: "message", role: "assistant", content: "The later attempt passed." },
    ];

    expect(reconciledToolAttempts(items)).toEqual({
      failureIndexes: new Set(),
      recoveredCount: 0,
      receiptLines: [],
    });
  });

  it("keeps same-recovery assistant narration transparent to the immediate correction", () => {
    const blocked = markToolPresentationOutcome(
      {
        kind: "tool",
        id: "reviewed-composite",
        name: "bash",
        status: "error",
        summary:
          "blocked (not executed): no live decision available · POL-003 review: use a simpler command",
      } as const,
      "blocked",
    );
    const items: ViewItem[] = [
      blocked,
      { kind: "message", role: "assistant", content: "I will run one atomic check." },
      {
        kind: "tool",
        id: "atomic-correction",
        name: "bash",
        status: "ok",
        summary: "pytest 9.1.1",
      },
      { kind: "message", role: "assistant", content: "The correction succeeded." },
    ];

    expect(reconciledToolAttempts(items)).toEqual({
      failureIndexes: new Set([0]),
      recoveredCount: 1,
      receiptLines: [
        "recovered · bash completed one bounded correction; original reviewed action was not executed",
      ],
    });
  });

  it("never hides a binary refusal merely because another read later succeeds", () => {
    const binaryRefusal = markToolPresentationOutcome(
      {
        kind: "tool",
        id: "binary",
        name: "read",
        status: "error",
        summary: "read: 'binary-fixture.bin' appears to be a binary file; refusing to read",
        subject: "binary-fixture.bin",
      } as const,
      "failed",
    );
    const items: ViewItem[] = [
      { kind: "message", role: "user", content: "inspect each requested file" },
      binaryRefusal,
      {
        kind: "tool",
        id: "text",
        name: "read",
        status: "ok",
        summary: "plain text",
        subject: "README.md",
      },
      { kind: "message", role: "assistant", content: "I inspected both requested files." },
    ];

    expect(recoveredExploratoryFailureIndexes(items)).not.toContain(1);
  });

  it("never hides an invalid UTF-8 refusal merely because another read later succeeds", () => {
    const invalidUtf8 = markToolPresentationOutcome(
      {
        kind: "tool",
        id: "invalid-utf8",
        name: "read",
        status: "error",
        summary: "read: 'bytes.txt' is not complete UTF-8 text; refusing to read",
      } as const,
      "failed",
    );
    const items: ViewItem[] = [
      { kind: "message", role: "user", content: "inspect each requested file" },
      invalidUtf8,
      { kind: "tool", id: "text", name: "read", status: "ok", summary: "README.md" },
      { kind: "message", role: "assistant", content: "I inspected the readable target." },
    ];

    expect(recoveredExploratoryFailureIndexes(items)).not.toContain(1);
  });

  it("classifies a large turn in one reverse pass", () => {
    const items: ViewItem[] = Array.from({ length: 10_000 }, (_, index) =>
      markToolPresentationOutcome(
        {
          kind: "tool",
          id: `read-${index}`,
          name: "read",
          status: "error",
          summary: "ordinary read miss",
        },
        "failed",
      ),
    );
    items.push(
      { kind: "tool", id: "read-ok", name: "read", status: "ok", summary: "README.md" },
      { kind: "message", role: "assistant", content: "I found the requested context." },
    );
    let indexedReads = 0;
    const observed = new Proxy(items, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) indexedReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const recovered = recoveredExploratoryFailureIndexes(observed);
    expect(recovered.size).toBe(10_000);
    expect(indexedReads).toBeLessThanOrEqual(items.length + 2);
  });

  it("bounds recovered mutation receipts while retaining the exact recovered count", () => {
    const items: ViewItem[] = [];
    for (let index = 0; index < 6; index += 1) {
      const args = { path: `src/file-${String(index)}.ts` };
      const identity = toolRecoveryIdentityForCall("edit", args);
      const blocked = markToolPresentationOutcome(
        {
          kind: "tool",
          id: `blocked-${String(index)}`,
          name: "edit",
          status: "error",
          summary: "blocked by warden (not executed)",
          subject: args.path,
        } as const,
        "blocked",
      );
      const successful: UiToolActivity = {
        kind: "tool",
        id: `successful-${String(index)}`,
        name: "edit",
        status: "ok",
        summary: "edited",
        subject: args.path,
      };
      associateToolRecoveryIdentity(blocked, identity);
      associateToolRecoveryIdentity(successful, identity);
      items.push(blocked, successful);
    }

    const reconciliation = reconciledToolAttempts(items);
    expect(reconciliation.failureIndexes).toHaveLength(6);
    expect(reconciliation.recoveredCount).toBe(6);
    expect(reconciliation.receiptLines).toHaveLength(4);
    expect(reconciliation.receiptLines.at(-1)).toBe(
      "recovered · 3 more exact retries; inspect verbose history",
    );
  });
});
