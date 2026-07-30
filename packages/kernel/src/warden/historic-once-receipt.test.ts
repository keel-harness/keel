import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  GENESIS_PREV_HASH,
  hashAuditRecord,
  type AnyAuditRecordT,
  type JsonObjectT,
  type JsonValueT,
} from "@keel/shared";
import {
  historicOnceApprovalReceiptFromAudit,
  historicOnceApprovalReceipts,
  renderHistoricOnceApprovalReceipt,
} from "./historic-once-receipt.js";

const SESSION_ID = "ses_01BX5ZZKBKACTAV9WEVGEMMVRZ";
const COMMAND_KEY = `sha256:${"a".repeat(64)}`;

function auditRecord(
  records: readonly AnyAuditRecordT[],
  eventType: "review.requested" | "review.resolved" | "tool.execute",
  payload: JsonObjectT,
): AnyAuditRecordT {
  const seq = records.length;
  const draft = {
    seq,
    ts: `2026-07-27T00:00:0${String(seq)}.000Z`,
    sessionId: SESSION_ID,
    principal: {
      osUser: "operator",
      configuredId: null,
      authProvider: "local",
      assurance: "local-os-user",
    },
    eventType,
    payload,
    prevHash: records.at(-1)?.hash ?? GENESIS_PREV_HASH,
    hash: GENESIS_PREV_HASH,
    ...(eventType === "tool.execute"
      ? {
          sideEffect: {
            taxonomyVersion: "side-effect-taxonomy/v1",
            staticCapability: {
              toolName: "bash",
              effectEnvelope: ["fs_write"],
              broad: true,
            },
            dynamic: {
              effectKinds: ["fs_write"],
              scopes: ["workspace"],
              targets: [],
              modifiers: ["destructive"],
              composition: { kind: "atomic", segments: [], edges: [] },
            },
            classifier: {
              name: "test-classifier",
              version: "1",
              confidence: "exact",
              reasons: ["test"],
            },
          },
        }
      : {}),
  } as unknown as AnyAuditRecordT;
  const hash = hashAuditRecord(draft as unknown as Record<string, JsonValueT>);
  return { ...draft, hash };
}

function settledOnceRecords(): AnyAuditRecordT[] {
  const records: AnyAuditRecordT[] = [];
  records.push(
    auditRecord(records, "review.requested", {
      reviewId: "command_review_1",
      command: "rm review-delete.txt",
      commandGrant: {
        key: COMMAND_KEY,
        scope: "once",
        kind: "once-only-command-review",
      },
    }),
  );
  records.push(
    auditRecord(records, "review.resolved", {
      reviewId: "command_review_1",
      approved: true,
      requestedApproval: true,
      requestedScope: "once",
      terminal: true,
      commandGrant: {
        key: COMMAND_KEY,
        scope: "once",
        kind: "once-only-command-review",
        applied: false,
        authorizationRecorded: true,
        reviewId: "command_review_1",
      },
    }),
  );
  records.push(
    auditRecord(records, "tool.execute", {
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "rm review-delete.txt" },
      commandGrant: {
        key: COMMAND_KEY,
        scope: "once",
        kind: "once-only-command-review",
        applied: true,
        reviewId: "command_review_1",
      },
      execution: "requested",
    }),
  );
  return records;
}

describe("historic once-approval receipts", () => {
  it("binds an approved once-only review to its applied execution and labels authority spent", () => {
    const receipts = historicOnceApprovalReceipts(settledOnceRecords(), SESSION_ID);

    expect(receipts).toEqual([
      {
        reviewId: "command_review_1",
        toolName: "bash",
        approvalAuditSeq: 1,
        executionAuditSeq: 2,
      },
    ]);
    expect(renderHistoricOnceApprovalReceipt(receipts)).toBe(
      [
        "Historic once-approval receipt · authority spent",
        "- bash · approved once at audit #1 · applied at audit #2 · review command_review_1",
        "Resume restored no authority; repeating the action requires a fresh review.",
      ].join("\n"),
    );
  });

  it("bounds hostile audit labels before projecting them into resumed terminal history", () => {
    const content = renderHistoricOnceApprovalReceipt([
      {
        reviewId: `review_${"x".repeat(10_000)}`,
        toolName: `tool_${"y".repeat(10_000)}`,
        approvalAuditSeq: 1,
        executionAuditSeq: 2,
      },
    ]);

    expect(content).toBeDefined();
    expect(content!.length).toBeLessThan(1_000);
    expect(content).toContain("…");
    expect(content).not.toContain("x".repeat(1_000));
    expect(content).not.toContain("y".repeat(1_000));
  });

  it("does not invent a receipt for an unspent, denied, session-scoped, or mismatched grant", () => {
    const cases = [
      settledOnceRecords().slice(0, 2),
      settledOnceRecords().map((record) =>
        record.eventType === "review.resolved"
          ? { ...record, payload: { ...record.payload, approved: false } }
          : record,
      ),
      settledOnceRecords().map((record) =>
        record.eventType === "review.resolved"
          ? {
              ...record,
              payload: { ...record.payload, requestedScope: "session" },
            }
          : record,
      ),
      settledOnceRecords().map((record) =>
        record.eventType === "tool.execute"
          ? {
              ...record,
              payload: {
                ...record.payload,
                commandGrant: {
                  key: `sha256:${"b".repeat(64)}`,
                  scope: "once",
                  kind: "once-only-command-review",
                  applied: true,
                  reviewId: "command_review_1",
                },
              },
            }
          : record,
      ),
      settledOnceRecords().map((record) => ({
        ...record,
        payload: {
          ...record.payload,
          commandGrant: {
            ...(record.payload["commandGrant"] as JsonObjectT),
            kind: "session-command-review",
          },
        },
      })),
    ];

    for (const records of cases) {
      expect(historicOnceApprovalReceipts(records, SESSION_ID)).toEqual([]);
    }
  });

  it("treats the first terminal resolution as final when a late duplicate claims approval", () => {
    const records: AnyAuditRecordT[] = [];
    records.push(settledOnceRecords()[0]!);
    records.push(
      auditRecord(records, "review.resolved", {
        reviewId: "command_review_1",
        approved: false,
        requestedApproval: false,
        requestedScope: "once",
        terminal: true,
        commandGrant: {
          key: COMMAND_KEY,
          scope: "once",
          kind: "once-only-command-review",
          applied: false,
          authorizationRecorded: false,
          reviewId: "command_review_1",
        },
      }),
    );
    records.push(
      auditRecord(records, "review.resolved", {
        reviewId: "command_review_1",
        approved: true,
        requestedApproval: true,
        requestedScope: "once",
        terminal: true,
        commandGrant: {
          key: COMMAND_KEY,
          scope: "once",
          kind: "once-only-command-review",
          applied: false,
          authorizationRecorded: true,
          reviewId: "command_review_1",
        },
      }),
    );
    records.push(
      auditRecord(records, "tool.execute", {
        toolCallId: "call-late",
        toolName: "bash",
        args: { command: "rm review-delete.txt" },
        commandGrant: {
          key: COMMAND_KEY,
          scope: "once",
          kind: "once-only-command-review",
          applied: true,
          reviewId: "command_review_1",
        },
        execution: "requested",
      }),
    );

    expect(historicOnceApprovalReceipts(records, SESSION_ID)).toEqual([]);
  });

  it("loads only a complete verified single-session audit chain and fails closed on corruption", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-historic-once-receipt-"));
    const path = join(dir, `${SESSION_ID}.jsonl`);
    const records = settledOnceRecords();
    writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

    expect(historicOnceApprovalReceiptFromAudit(dir, SESSION_ID)).toEqual({
      status: "ready",
      content: renderHistoricOnceApprovalReceipt(historicOnceApprovalReceipts(records, SESSION_ID)),
    });

    writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n{"seq":3`);
    expect(historicOnceApprovalReceiptFromAudit(dir, SESSION_ID)).toEqual({
      status: "unavailable",
      content:
        "Historic once-approval receipt unavailable: the audit chain could not be verified. No authority was restored; repeating an action requires a fresh review.",
    });

    const corrupted = records.map((record) => ({ ...record }));
    corrupted[1] = {
      ...corrupted[1]!,
      payload: { ...corrupted[1]!.payload, approved: false },
    };
    writeFileSync(path, `${corrupted.map((record) => JSON.stringify(record)).join("\n")}\n`);
    expect(historicOnceApprovalReceiptFromAudit(dir, SESSION_ID)).toEqual({
      status: "unavailable",
      content:
        "Historic once-approval receipt unavailable: the audit chain could not be verified. No authority was restored; repeating an action requires a fresh review.",
    });

    // A present file with no complete record is not equivalent to an absent audit. It can be an
    // empty/truncated/corrupt writer artifact, so receipt projection must fail closed explicitly.
    for (const noCompleteRecord of ["", '{"seq":0']) {
      writeFileSync(path, noCompleteRecord);
      expect(historicOnceApprovalReceiptFromAudit(dir, SESSION_ID)).toEqual({
        status: "unavailable",
        content:
          "Historic once-approval receipt unavailable: the audit chain could not be verified. No authority was restored; repeating an action requires a fresh review.",
      });
    }
  });
});
