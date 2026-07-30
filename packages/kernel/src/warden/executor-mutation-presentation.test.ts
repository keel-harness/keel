import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  WARDEN_METHODS,
  type JsonObjectT,
  type MutationPresentationTakeParamsV1T,
  type ToolResultT,
} from "@keel/shared";
import { ScopedEgressApprovals } from "./approval.js";
import type { WardenCallOptions } from "./approval.js";
import {
  WardenExecutor,
  type WardenExecuteClient,
  type WardenExecutorOptions,
} from "./executor.js";
import { mutationPresentationResolverFor } from "./mutation-presentation-resolver.js";
import type { ResolvedAutonomyPosture } from "../autopilot/posture.js";

const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const COMMAND_KEY = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PRINCIPAL = {
  osUser: "tester",
  configuredId: null,
  authProvider: "local" as const,
  assurance: "local-os-user" as const,
};
const AUTOPILOT: ResolvedAutonomyPosture = {
  accepted: true,
  explicitRequest: true,
  mode: "autopilot",
  requestedMode: "autopilot",
  requestedSource: "human",
  source: "human",
};

type ExecuteParams = z.infer<(typeof WARDEN_METHODS)["warden.execute"]["params"]>;
type ExecuteResult = z.infer<(typeof WARDEN_METHODS)["warden.execute"]["result"]>;
type ResolveReviewParams = z.infer<(typeof WARDEN_METHODS)["warden.resolveReview"]["params"]>;
type ResolveReviewResult = z.infer<(typeof WARDEN_METHODS)["warden.resolveReview"]["result"]>;

const REVIEW = {
  reviewId: "review_edit_1",
  summary: "command review for governed edit in workspace /repo",
  allowCommand: `keel approve review_edit_1 --scope once --command-key ${COMMAND_KEY}`,
};

class FakeClient implements WardenExecuteClient {
  readonly calls: Array<{
    readonly method: "warden.execute" | "warden.resolveReview";
    readonly options?: WardenCallOptions;
  }> = [];

  constructor(
    private readonly executeResult: ExecuteResult,
    private readonly resolveResult?: ResolveReviewResult,
  ) {}

  async call(
    method: "warden.execute",
    params: ExecuteParams,
    options?: WardenCallOptions,
  ): Promise<ExecuteResult>;
  async call(
    method: "warden.resolveReview",
    params: ResolveReviewParams,
    options?: WardenCallOptions,
  ): Promise<ResolveReviewResult>;
  async call(
    method: "warden.execute" | "warden.resolveReview",
    _params: ExecuteParams | ResolveReviewParams,
    options?: WardenCallOptions,
  ): Promise<ExecuteResult | ResolveReviewResult> {
    this.calls.push(options === undefined ? { method } : { method, options });
    if (method === "warden.execute") return this.executeResult;
    if (this.resolveResult === undefined) throw new Error("missing resolve-review fixture");
    return this.resolveResult;
  }
}

function call(name: string, args: JsonObjectT = {}): ExecuteParams["toolCall"] {
  return { id: `call_${name}`, name, args };
}

function successResult(verdict: "allow" | "warn" | "modify", auditSeq: number): ExecuteResult {
  return {
    verdict,
    result: "typed mutation completed",
    auditSeq,
    ...(verdict === "warn" ? { guidance: "review warning" } : {}),
    ...(verdict === "modify"
      ? { guidance: "normalized mutation", modifiedArgs: { path: "example.ts" } }
      : {}),
  };
}

function reviewResult(auditSeq: number): ExecuteResult {
  return { verdict: "review", review: REVIEW, auditSeq };
}

function takeFixture(): {
  readonly calls: Array<{
    readonly params: MutationPresentationTakeParamsV1T;
    readonly options: WardenCallOptions | undefined;
  }>;
  readonly take: NonNullable<WardenExecutorOptions["takeMutationPresentation"]>;
} {
  const calls: Array<{
    readonly params: MutationPresentationTakeParamsV1T;
    readonly options: WardenCallOptions | undefined;
  }> = [];
  return {
    calls,
    take: async (params, options) => {
      calls.push({ params, options });
      return { status: "unavailable", reason: "capture-unavailable" };
    },
  };
}

async function resolvePresentation(result: ToolResultT): Promise<unknown> {
  const resolver = mutationPresentationResolverFor(result);
  expect(resolver).toBeTypeOf("function");
  if (resolver === undefined) throw new Error("expected mutation presentation resolver");
  return await resolver();
}

describe("WardenExecutor mutation presentation decoration", () => {
  it.each([
    { tool: "edit", verdict: "allow" as const, auditSeq: 11 },
    { tool: "edit", verdict: "warn" as const, auditSeq: 12 },
    { tool: "edit", verdict: "modify" as const, auditSeq: 13 },
    { tool: "write", verdict: "allow" as const, auditSeq: 14 },
    { tool: "write", verdict: "warn" as const, auditSeq: 15 },
    { tool: "write", verdict: "modify" as const, auditSeq: 16 },
  ])("decorates a direct successful $verdict $tool with its final audit sequence", async (row) => {
    const fixture = takeFixture();
    const executor = new WardenExecutor({
      client: new FakeClient(successResult(row.verdict, row.auditSeq)),
      sessionId: SESSION_ID,
      takeMutationPresentation: fixture.take,
    });

    const result = await executor.execute(call(row.tool, { path: "example.ts" }));
    expect(result.ok).toBe(true);
    expect(fixture.calls).toEqual([]);
    await expect(resolvePresentation(result)).resolves.toEqual({
      status: "unavailable",
      reason: "capture-unavailable",
    });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toMatchObject({
      params: {
        sessionId: SESSION_ID,
        toolCallId: `call_${row.tool}`,
        auditSeq: row.auditSeq,
      },
      options: { timeoutMs: 100 },
    });
    expect(fixture.calls[0]?.options).not.toHaveProperty("signal");
  });

  it.each(
    (["session-grant", "plan-approval", "autopilot", "human-review"] as const).flatMap((route) =>
      (["edit", "write"] as const).map((tool) => ({ route, tool })),
    ),
  )(
    "uses the common decorator and final resolve-review audit sequence for $route $tool",
    async ({ route, tool }) => {
      const fixture = takeFixture();
      const client = new FakeClient(reviewResult(20), {
        verdict: "allow",
        result: "edit: replaced 1 occurrence",
        auditSeq: 21,
      });
      const base: WardenExecutorOptions = {
        client,
        sessionId: SESSION_ID,
        principal: PRINCIPAL,
        takeMutationPresentation: fixture.take,
      };
      let options: WardenExecutorOptions;
      switch (route) {
        case "session-grant": {
          const approvals = new ScopedEgressApprovals();
          expect(approvals.rememberSessionGrant(REVIEW)).toBe(true);
          options = { ...base, egressApprovals: approvals };
          break;
        }
        case "plan-approval":
          options = {
            ...base,
            planApproval: {
              planId: "plan_edit",
              trustedWorkspace: true,
              resources: [{ kind: "command-key", value: COMMAND_KEY }],
            },
          };
          break;
        case "autopilot":
          options = { ...base, autonomy: AUTOPILOT };
          break;
        case "human-review":
          options = {
            ...base,
            onReviewRequired: () => ({ approved: true, scope: "once" }),
          };
          break;
      }
      const executor = new WardenExecutor(options);

      const result = await executor.execute(call(tool, { path: "example.ts" }));
      expect(result.ok).toBe(true);
      await expect(resolvePresentation(result)).resolves.toEqual({
        status: "unavailable",
        reason: "capture-unavailable",
      });
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.calls[0]?.params).toEqual({
        sessionId: SESSION_ID,
        toolCallId: `call_${tool}`,
        auditSeq: 21,
      });
      expect(client.calls.map((entry) => entry.method)).toEqual([
        "warden.execute",
        "warden.resolveReview",
      ]);
    },
  );

  it.each([
    {
      name: "denied mutation",
      call: call("edit", { path: "example.ts" }),
      execute: { verdict: "deny" as const, auditSeq: 30 },
    },
    {
      name: "successful non-mutation",
      call: call("read", { path: "example.ts" }),
      execute: { verdict: "allow" as const, result: "contents", auditSeq: 31 },
    },
    {
      name: "typed mutation failure",
      call: call("write", { path: "example.ts" }),
      execute: {
        verdict: "allow" as const,
        result: {
          kind: "typed_tool_error",
          code: "TOOL_ERROR",
          message: "write failed",
          mutationPossible: false,
        },
        auditSeq: 32,
      },
    },
    {
      name: "mutation-uncertain typed failure",
      call: call("edit", { path: "example.ts" }),
      execute: {
        verdict: "allow" as const,
        result: {
          kind: "typed_tool_error",
          code: "TOOL_ERROR",
          message: "edit outcome is indeterminate",
          mutationPossible: true,
        },
        auditSeq: 33,
      },
    },
  ])("does not attach success evidence to a $name", async (row) => {
    const fixture = takeFixture();
    const executor = new WardenExecutor({
      client: new FakeClient(row.execute),
      sessionId: SESSION_ID,
      takeMutationPresentation: fixture.take,
    });

    const result = await executor.execute(row.call);
    expect(mutationPresentationResolverFor(result)).toBeUndefined();
    expect(fixture.calls).toEqual([]);
  });

  it("does not attach a resolver when the final reviewed verdict is denied", async () => {
    const fixture = takeFixture();
    const executor = new WardenExecutor({
      client: new FakeClient(reviewResult(40), { verdict: "deny", auditSeq: 41 }),
      sessionId: SESSION_ID,
      principal: PRINCIPAL,
      onReviewRequired: () => ({ approved: true, scope: "once" }),
      takeMutationPresentation: fixture.take,
    });

    const result = await executor.execute(call("edit", { path: "example.ts" }));
    expect(result.ok).toBe(false);
    expect(mutationPresentationResolverFor(result)).toBeUndefined();
    expect(fixture.calls).toEqual([]);
  });
});
