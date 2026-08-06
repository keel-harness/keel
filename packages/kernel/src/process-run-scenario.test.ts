import { describe, expect, it } from "vitest";
import type {
  ExecutorPort,
  ModelPort,
  ModelStreamChunkT,
  ModelTurnInput,
  ToolInvocationT,
} from "@keel/shared";
import { BLOCKED_AFTER_SYNTHESIS_CODE, type KernelEventT } from "./events.js";
import { R26_PROCESS_RUN_ORACLE as oracle } from "./fixtures/r26-process-run-oracle.js";
import { runAgentLoop } from "./loop.js";
import { PROCESS_RESULT_MARKER, VERIFIED_PROCESS_CONTAINMENT } from "./tool-command.js";
import { recoverableTerminalReviewResult } from "./warden/terminal-review.js";

const advertisedTools = [
  { name: "bash", parameters: { type: "object" } },
  { name: "process.run", parameters: { type: "object" } },
  { name: "edit", parameters: { type: "object" } },
] as const;

function modelFromTurns(
  turns: readonly ((input: ModelTurnInput) => readonly ModelStreamChunkT[])[],
): ModelPort {
  let index = 0;
  return {
    async *stream(input) {
      const turn = turns[index++];
      if (turn === undefined) throw new Error("unexpected model turn");
      yield* turn(input);
    },
  };
}

async function collect(model: ModelPort, executor: ExecutorPort): Promise<KernelEventT[]> {
  const events: KernelEventT[] = [];
  for await (const event of runAgentLoop(model, executor, {
    messages: [
      { role: "user", content: "finish the Click refactor and its strict three-file gate" },
    ],
    tools: advertisedTools,
  })) {
    events.push(event);
  }
  return events;
}

describe("ADR-0089 deterministic external Click scenario oracle", () => {
  it("preserves the #149 wrapper block, then continues through exact argv to the third-file edit", async () => {
    const baselineCalls: ToolInvocationT[] = [];
    const baseline = await collect(
      modelFromTurns([
        () => [
          {
            type: "tool-call",
            id: "reviewed-wrapper",
            name: "bash",
            args: { command: oracle.reviewedWrapper },
          },
          { type: "finish", reason: "tool-calls", usage: { inputTokens: 10, outputTokens: 2 } },
        ],
        () => [
          {
            type: "text-delta",
            text: "The shell assignment remains blocked; no correction is claimed.",
          },
          { type: "finish", reason: "stop", usage: { inputTokens: 10, outputTokens: 7 } },
        ],
      ]),
      {
        async execute(call) {
          baselineCalls.push(call);
          return recoverableTerminalReviewResult(
            "warden review required (not executed): POL-003 shell assignment; no live review",
          );
        },
      },
    );

    expect(baselineCalls).toEqual([
      expect.objectContaining({
        name: "bash",
        args: { command: oracle.reviewedWrapper },
      }),
    ]);
    expect(baseline.filter((event) => event.type === "stop")).toEqual([
      expect.objectContaining({ code: BLOCKED_AFTER_SYNTHESIS_CODE }),
    ]);

    const calls: ToolInvocationT[] = [];
    const modifiedFiles = new Set<string>(oracle.alreadyChangedFiles);
    const seenInputs: ModelTurnInput[] = [];
    const continuation = await collect(
      modelFromTurns([
        (input) => {
          seenInputs.push(input);
          return [
            {
              type: "tool-call",
              id: "local-tree-test",
              name: "process.run",
              args: { argv: [...oracle.directArgv] },
            },
            { type: "finish", reason: "tool-calls", usage: { inputTokens: 10, outputTokens: 3 } },
          ];
        },
        (input) => {
          seenInputs.push(input);
          return [
            {
              type: "tool-call",
              id: "third-file",
              name: "edit",
              args: {
                path: oracle.requiredThirdFile,
                oldString: "Unreleased\n",
                newString: "Unreleased\n- Preserve PathLike values at the filesystem boundary.\n",
              },
            },
            { type: "finish", reason: "tool-calls", usage: { inputTokens: 10, outputTokens: 3 } },
          ];
        },
        (input) => {
          seenInputs.push(input);
          return [
            {
              type: "text-delta",
              text: "The local-tree tests passed and all three files changed.",
            },
            { type: "finish", reason: "stop", usage: { inputTokens: 10, outputTokens: 8 } },
          ];
        },
      ]),
      {
        async execute(call) {
          calls.push(call);
          if (call.name === "process.run") {
            expect(call.args["argv"]).toEqual(oracle.directArgv);
            return {
              ok: true,
              output:
                `${VERIFIED_PROCESS_CONTAINMENT}\n\n${PROCESS_RESULT_MARKER}\n` +
                JSON.stringify({
                  exitCode: 0,
                  signal: null,
                  stdout: `${oracle.expectedSummary}\n`,
                  stderr: "",
                }),
            };
          }
          if (call.name === "edit") {
            const path = call.args["path"];
            if (typeof path !== "string") throw new Error("expected edit path");
            modifiedFiles.add(path);
            return { ok: true, output: `edited ${path}` };
          }
          return { ok: false, output: "unexpected tool" };
        },
      },
    );

    expect(calls.map((call) => call.name)).toEqual(["process.run", "edit"]);
    expect(calls[0]?.args["argv"]).toEqual(oracle.directArgv);
    expect([...modifiedFiles].sort()).toEqual(
      [...oracle.alreadyChangedFiles, oracle.requiredThirdFile].sort(),
    );
    expect(
      seenInputs.some((input) =>
        input.messages.some(
          (message) =>
            message.role === "user" &&
            /bounded recovery|remove.*wrapper|correction lane/iu.test(message.content),
        ),
      ),
    ).toBe(false);
    expect(continuation.some((event) => event.type === "loop-detected")).toBe(false);
    expect(continuation.filter((event) => event.type === "stop")).toEqual([
      { type: "stop", reason: "model-stop" },
    ]);
    expect(continuation.filter((event) => event.type === "text-delta").at(-1)).toEqual({
      type: "text-delta",
      text: "The local-tree tests passed and all three files changed.",
    });
  });
});
