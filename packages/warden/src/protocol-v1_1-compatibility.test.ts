import { describe, expect, it } from "vitest";
import { JsonRpcSuccessResponse, WARDEN_METHODS } from "@keel/shared";
import { createEgressReviewState } from "./egress-review.js";
import { handleRpcLine } from "./rpc-server.js";
import type { SandboxPort } from "./sandbox.js";

const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function request(id: string, method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

describe("warden RPC protocol 1.0 peer compatibility under server 1.1", () => {
  it("reports server 1.1 while preserving the frozen execute and resolve-review response bytes", async () => {
    const reviewState = createEgressReviewState();
    const sandbox: SandboxPort = {
      status: () => ({
        available: true,
        backend: "compat-fixture",
        enforcementTier: "sandbox:compat-fixture",
      }),
      execute: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    };
    const options = { reviewState, sandbox };
    const hello = JsonRpcSuccessResponse.parse(
      await handleRpcLine(
        request("compat-hello", "warden.hello", {
          kernelVersion: "0.0.0",
          protocolVersion: "1.0.0",
        }),
      ),
    );
    const helloResult = WARDEN_METHODS["warden.hello"].result.parse(hello.result);
    expect(helloResult.protocolVersion).toBe("1.1.0");
    expect(helloResult.capabilities).not.toContain("mutation-presentation/v1");

    const execute = await handleRpcLine(
      request("compat-execute", "warden.execute", {
        sessionId: SESSION_ID,
        toolCall: {
          id: "tc_compat",
          name: "bash",
          args: { command: "curl https://example.com" },
        },
        provenanceContext: { inputTags: ["workspace"] },
      }),
      options,
    );
    expect(JSON.stringify(execute)).toBe(
      '{"jsonrpc":"2.0","id":"compat-execute","result":{"verdict":"review","review":{"reviewId":"egress_review_1","summary":"egress to example.com requires review: curl https://example.com","allowCommand":"keel approve egress_review_1 --scope once --domain example.com"},"auditSeq":0}}',
    );

    const resolveReview = await handleRpcLine(
      request("compat-resolve", "warden.resolveReview", {
        reviewId: "egress_review_1",
        approved: false,
        principal: {
          osUser: "compat",
          configuredId: null,
          authProvider: "local",
          assurance: "local-os-user",
        },
      }),
      options,
    );
    expect(JSON.stringify(resolveReview)).toBe(
      '{"jsonrpc":"2.0","id":"compat-resolve","result":{"verdict":"deny","auditSeq":0}}',
    );
  });

  it("keeps the registered take carrier opaque and unavailable until Slice 2B installs capture", async () => {
    const response = JsonRpcSuccessResponse.parse(
      await handleRpcLine(
        request("compat-take", "warden.presentation.take", {
          sessionId: SESSION_ID,
          toolCallId: "tc_compat",
          auditSeq: 0,
        }),
      ),
    );
    expect(WARDEN_METHODS["warden.presentation.take"].result.parse(response.result)).toEqual({
      status: "unavailable",
      reason: "not-found-or-consumed",
    });
  });
});
